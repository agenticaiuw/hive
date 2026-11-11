/*
 * Reflex layer mechanism — design rationale, schema and threading contract
 * are in pendant_reflex.h.  This file owns: the recipe table, the bounded
 * JSON matcher, the canonical serializer, recipes.json persistence, the
 * trigger tick and the SWD debug hooks.  It touches NO hardware: actions
 * go out through the executor callbacks main.c registered.
 */
#include <errno.h>
#include <stdio.h>
#include <string.h>

#include <zephyr/fs/fs.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/printk.h>
#include <zephyr/sys/util.h>

#include "haptic.h"
#include "pendant_cloud.h"
#include "pendant_reflex.h"

#define REFLEX_MOUNT "/SD:"
#define REFLEX_FILE REFLEX_MOUNT "/recipes.json"
/* Rewrite goes through a temp + rename so a power cut mid-write cannot eat
 * the whole table; boot recovers a stranded temp (see reflex_load). */
#define REFLEX_FILE_TMP REFLEX_MOUNT "/recipes.tmp"

#define REFLEX_MAX_RECIPES 16U
#define REFLEX_MAX_ACTIONS 4U
/* Serialized cap per recipe. This is a WIRE budget, not a style choice: a
 * downlink WS text frame must stay well under the relay's 500 B frame
 * ceiling, and envelope + 400 B recipe object lands at ~425 B. */
#define REFLEX_RECIPE_JSON_MAX 400U
/* Parse/serialize staging: one recipe object + NUL, rounded up. */
#define REFLEX_SCRATCH_BYTES (REFLEX_RECIPE_JSON_MAX + 8U)
/* Pending downlink frame slot: envelope + recipe object. */
#define REFLEX_PENDING_BYTES 512U
/* Countdown sanity ceiling: one week. */
#define REFLEX_COUNTDOWN_MAX_S 604800U
/*
 * Voice-trigger slot ceiling. The on-device keyword matcher that fired
 * these (pendant_local, removed) enrolled up to four words; keeping the
 * same bound means an existing recipes.json with voice recipes still
 * parses and persists — the recipes are simply inert until a matcher
 * exists again.
 */
#define REFLEX_VOICE_SLOTS 4U
/* Daily alarms poll the modem clock at most this often. */
#define REFLEX_CLOCK_POLL_MS 10000
/*
 * A daily alarm still fires up to this late: the tick only runs on the
 * idle loop, so a conversation spanning the alarm minute must delay the
 * alarm, not eat it.
 */
#define REFLEX_DAILY_GRACE_MIN 5U

enum reflex_trigger {
	REFLEX_TRIG_NONE = 0,
	REFLEX_TRIG_COUNTDOWN,
	REFLEX_TRIG_DAILY,
	REFLEX_TRIG_GESTURE,
	/*
	 * An enrolled word, recognized on-device during a button-initiated
	 * capture.  The matcher that fired this (pendant_local) has been
	 * removed; the trigger kind is kept so stored recipes stay valid.
	 */
	REFLEX_TRIG_VOICE,
};

enum reflex_action_kind {
	REFLEX_ACT_NONE = 0,
	REFLEX_ACT_LED,
	REFLEX_ACT_HAPTIC,
	REFLEX_ACT_CHIME,
};

/* Only gesture the detector recognizes; the field exists so a second
 * gesture can be added without a schema change. */
#define REFLEX_GESTURE_B2_DOUBLE 1U

struct reflex_action {
	uint8_t kind; /* enum reflex_action_kind */
	uint8_t arg;  /* led/haptic pattern index, or chime index */
};

struct reflex_recipe {
	uint32_t id;          /* 0 = empty slot */
	uint32_t countdown_s; /* countdown trigger only */
	/* Runtime only — never serialized. fire_at_ms==0 means "not armed"
	 * for a countdown (uptime restarts at boot, so a persisted deadline
	 * would be a lie; see header). */
	int64_t fire_at_ms;
	uint32_t last_daily_key; /* (day<<16)|minute of last daily fire */
	uint16_t daily_minute;   /* minutes since local midnight */
	uint8_t trigger;         /* enum reflex_trigger */
	uint8_t armed;           /* persisted for daily/gesture/voice */
	/*
	 * Trigger sub-selector, shared because the two triggers that need
	 * one are mutually exclusive per recipe and a fifth byte here would
	 * cost 8 B of padding x 16 recipes on a build with 6.6 kB free:
	 *   GESTURE  which gesture (REFLEX_GESTURE_B2_DOUBLE)
	 *   VOICE    which enrolled keyword slot, 1..REFLEX_VOICE_SLOTS
	 */
	uint8_t gesture;
	uint8_t action_count;
	struct reflex_action actions[REFLEX_MAX_ACTIONS];
};

static struct reflex_recipe recipes[REFLEX_MAX_RECIPES];
static struct pendant_reflex_ops reflex_ops;
static bool reflex_ready;
static int64_t reflex_next_clock_poll_ms;
static bool reflex_no_clock_logged;

/*
 * Downlink hand-off: WS I/O thread writes, main thread consumes.  True
 * SPSC through one slot: the producer writes the buffer, THEN sets the
 * flag; the consumer copies the buffer out, THEN clears the flag.  A frame
 * arriving while the slot is full is dropped and counted — the relay's
 * contract is one recipe per ack (it resends on a missing ack), so a
 * dropped frame costs a retry, never a torn parse.
 */
static char reflex_pending[REFLEX_PENDING_BYTES]; /* ws thread writes  */
static atomic_t reflex_pending_full;
static char reflex_scratch[REFLEX_SCRATCH_BYTES]; /* main thread only  */

/* SWD debug hooks (contract in the header). */
volatile uint32_t pendant_reflex_reload;
volatile uint32_t pendant_reflex_arm;
volatile uint32_t pendant_reflex_disarm;
volatile uint32_t pendant_reflex_fire;

/* Counters, printed by reflex_print_stats whenever the table changes. */
static uint32_t reflex_stat_loaded;   /* recipes accepted from SD at load */
static uint32_t reflex_stat_stored;   /* recipes accepted over the air    */
static uint32_t reflex_stat_rejected; /* frames/lines that failed parse   */
static uint32_t reflex_stat_fired;    /* trigger firings                  */
static uint32_t reflex_stat_dropped;  /* frames lost to a full slot       */

/* Pattern vocabularies.  Haptic names map 1:1 onto enum haptic_pattern and
 * onto the LED pattern used when the motor is absent (degrade path). */
static const char *const reflex_led_names[] = {
	[REFLEX_LED_SINGLE] = "single", [REFLEX_LED_DOUBLE] = "double",
	[REFLEX_LED_TRIPLE] = "triple", [REFLEX_LED_BURST] = "burst",
	[REFLEX_LED_LONG] = "long",
};
static const char *const reflex_haptic_names[] = {
	[HAPTIC_PATTERN_SINGLE] = "single",
	[HAPTIC_PATTERN_DOUBLE] = "double",
	[HAPTIC_PATTERN_LONG] = "long",
	[HAPTIC_PATTERN_TICK] = "tick",
	[HAPTIC_PATTERN_CLICK] = "click",
	[HAPTIC_PATTERN_STRONG] = "strong",
};
static const uint8_t reflex_haptic_led_fallback[] = {
	[HAPTIC_PATTERN_SINGLE] = REFLEX_LED_SINGLE,
	[HAPTIC_PATTERN_DOUBLE] = REFLEX_LED_DOUBLE,
	[HAPTIC_PATTERN_LONG] = REFLEX_LED_LONG,
	[HAPTIC_PATTERN_TICK] = REFLEX_LED_SINGLE,
	[HAPTIC_PATTERN_CLICK] = REFLEX_LED_SINGLE,
	[HAPTIC_PATTERN_STRONG] = REFLEX_LED_LONG,
};

static uint32_t reflex_count(void)
{
	uint32_t count = 0U;

	for (size_t index = 0U; index < REFLEX_MAX_RECIPES; ++index) {
		if (recipes[index].id != 0U) {
			++count;
		}
	}
	return count;
}

static void reflex_print_stats(const char *reason)
{
	printk("Reflex stats: %s recipes=%u loaded=%u stored=%u rejected=%u "
	       "fired=%u dropped=%u\n",
	       reason, reflex_count(), reflex_stat_loaded, reflex_stat_stored,
	       reflex_stat_rejected, reflex_stat_fired, reflex_stat_dropped);
}

/* ---- Bounded JSON matcher ------------------------------------------- */

/*
 * Same species as pendant_store's alert reader: targeted matching over a
 * small NUL-terminated buffer whose shape this firmware and the relay both
 * control.  A JSON tree library would cost kilobytes of flash and a heap
 * this image does not have.  Keys are passed WITH their quotes so a key
 * can never match inside a longer key.
 */
static const char *json_find_value(const char *text, const char *quoted_key)
{
	const char *cursor = text;

	/*
	 * Loop, do not stop at the first hit: the bytes of a key can appear
	 * first as a VALUE — {"type":"recipe","recipe":{...}} contains
	 * "recipe" twice and only the occurrence followed by ':' is the key.
	 */
	for (;;) {
		const char *found = strstr(cursor, quoted_key);

		if (found == NULL) {
			return NULL;
		}
		cursor = found + 1;
		found += strlen(quoted_key);
		while (*found == ' ' || *found == '\t') {
			++found;
		}
		if (*found != ':') {
			continue;
		}
		++found;
		while (*found == ' ' || *found == '\t') {
			++found;
		}
		return found;
	}
}

/* True when the value at `value` is the string EXACTLY `expect` — a prefix
 * ("recipe" vs "recipe_ack") does not match. */
static bool json_value_is_string(const char *value, const char *expect)
{
	size_t length = strlen(expect);

	return value[0] == '"' && strncmp(value + 1, expect, length) == 0 &&
	       value[1U + length] == '"';
}

/* Parse a bare unsigned integer value.  Returns false on non-digits. */
static bool json_parse_u32(const char *value, uint32_t *out)
{
	uint32_t result = 0U;
	size_t digits = 0U;

	while (*value >= '0' && *value <= '9') {
		if (result > (UINT32_MAX - 9U) / 10U) {
			return false;
		}
		result = result * 10U + (uint32_t)(*value - '0');
		++value;
		++digits;
	}
	if (digits == 0U) {
		return false;
	}
	*out = result;
	return true;
}

/*
 * Step over one {...} or [...] starting at *p (which must point at `open`),
 * honoring strings and escapes, and return the character AFTER the closing
 * brace — or NULL when unbalanced/truncated.  Bounded by the NUL.
 */
static const char *json_skip_container(const char *p, char open, char close)
{
	int depth = 0;
	bool in_string = false;

	for (; *p != '\0'; ++p) {
		char c = *p;

		if (in_string) {
			if (c == '\\' && p[1] != '\0') {
				++p;
			} else if (c == '"') {
				in_string = false;
			}
			continue;
		}
		if (c == '"') {
			in_string = true;
		} else if (c == open) {
			++depth;
		} else if (c == close) {
			if (--depth == 0) {
				return p + 1;
			}
		}
	}
	return NULL;
}

/* Map a quoted pattern-name value onto a vocabulary table index. */
static bool json_match_name(const char *value, const char *const *names,
			    size_t name_count, uint8_t *out)
{
	for (size_t index = 0U; index < name_count; ++index) {
		if (json_value_is_string(value, names[index])) {
			*out = (uint8_t)index;
			return true;
		}
	}
	return false;
}

/* ---- Recipe parser ---------------------------------------------------- */

/*
 * Parse one recipe OBJECT (not the WS envelope) into *out.  `text` is the
 * bounded NUL-terminated scratch copy.  Key layout is flat by design: the
 * only "type" inside a recipe object is the trigger's, so no sub-object
 * cursor is needed — every lookup is one bounded scan.  Returns 0 or a
 * negative reason.
 */
static int reflex_parse_recipe(const char *text, struct reflex_recipe *out)
{
	const char *value;
	uint32_t number;

	memset(out, 0, sizeof(*out));

	value = json_find_value(text, "\"id\"");
	if (value == NULL || !json_parse_u32(value, &number) || number == 0U) {
		return -EINVAL;
	}
	out->id = number;

	value = json_find_value(text, "\"type\"");
	if (value == NULL) {
		return -EINVAL;
	}
	if (json_value_is_string(value, "countdown")) {
		out->trigger = REFLEX_TRIG_COUNTDOWN;
		value = json_find_value(text, "\"seconds\"");
		if (value == NULL || !json_parse_u32(value, &number) ||
		    number == 0U || number > REFLEX_COUNTDOWN_MAX_S) {
			return -EINVAL;
		}
		out->countdown_s = number;
	} else if (json_value_is_string(value, "daily")) {
		out->trigger = REFLEX_TRIG_DAILY;
		value = json_find_value(text, "\"at\"");
		/* "HH:MM", 24 h local (the NITZ clock is local time). */
		if (value == NULL || value[0] != '"' || value[3] != ':' ||
		    value[6] != '"') {
			return -EINVAL;
		}
		{
			uint32_t hour, minute;

			if (value[1] < '0' || value[1] > '9' ||
			    value[2] < '0' || value[2] > '9' ||
			    value[4] < '0' || value[4] > '9' ||
			    value[5] < '0' || value[5] > '9') {
				return -EINVAL;
			}
			hour = (uint32_t)(value[1] - '0') * 10U +
			       (uint32_t)(value[2] - '0');
			minute = (uint32_t)(value[4] - '0') * 10U +
				 (uint32_t)(value[5] - '0');
			if (hour > 23U || minute > 59U) {
				return -EINVAL;
			}
			out->daily_minute = (uint16_t)(hour * 60U + minute);
		}
	} else if (json_value_is_string(value, "gesture")) {
		out->trigger = REFLEX_TRIG_GESTURE;
		out->gesture = REFLEX_GESTURE_B2_DOUBLE;
		value = json_find_value(text, "\"gesture\"");
		if (value != NULL &&
		    !json_value_is_string(value, "b2_double")) {
			return -EINVAL; /* only gesture this hardware has */
		}
	} else if (json_value_is_string(value, "voice")) {
		/*
		 * {"trigger":{"type":"voice","voice":1}} — fires when the
		 * on-device matcher recognizes enrolled slot 1 during a
		 * press.  The slot must exist as a number: defaulting it
		 * would bind a recipe to whichever word happened to be
		 * enrolled first, and firing the wrong recipe silently is
		 * the one failure this whole path is built to avoid.
		 */
		out->trigger = REFLEX_TRIG_VOICE;
		value = json_find_value(text, "\"voice\"");
		if (value == NULL || !json_parse_u32(value, &number) ||
		    number == 0U || number > REFLEX_VOICE_SLOTS) {
			return -EINVAL;
		}
		out->gesture = (uint8_t)number;
	} else {
		return -EINVAL;
	}

	/* Optional; daily/gesture/voice default to armed — a stored alarm
	 * nobody armed is surprising, a stored alarm that runs is the point. */
	out->armed = 1U;
	value = json_find_value(text, "\"armed\"");
	if (value != NULL) {
		if (!json_parse_u32(value, &number) || number > 1U) {
			return -EINVAL;
		}
		out->armed = (uint8_t)number;
	}

	value = json_find_value(text, "\"action\"");
	if (value == NULL || *value != '[') {
		return -EINVAL;
	}
	{
		const char *array_end =
			json_skip_container(value, '[', ']');
		const char *cursor = value + 1;

		if (array_end == NULL) {
			return -EINVAL;
		}
		while (cursor < array_end) {
			const char *object_end;
			const char *step;
			struct reflex_action *action;

			/* Find the next action object inside the array. */
			while (cursor < array_end && *cursor != '{') {
				++cursor;
			}
			if (cursor >= array_end) {
				break;
			}
			object_end = json_skip_container(cursor, '{', '}');
			if (object_end == NULL || object_end > array_end) {
				return -EINVAL;
			}
			if (out->action_count >= REFLEX_MAX_ACTIONS) {
				return -E2BIG;
			}
			action = &out->actions[out->action_count];

			/* One key per action object; the span check keeps a
			 * key found in a LATER object from counting here. */
			step = json_find_value(cursor, "\"led\"");
			if (step != NULL && step < object_end) {
				if (!json_match_name(
					    step, reflex_led_names,
					    ARRAY_SIZE(reflex_led_names),
					    &action->arg)) {
					return -EINVAL;
				}
				action->kind = REFLEX_ACT_LED;
			} else if ((step = json_find_value(
					    cursor, "\"haptic\"")) != NULL &&
				   step < object_end) {
				if (!json_match_name(
					    step, reflex_haptic_names,
					    ARRAY_SIZE(reflex_haptic_names),
					    &action->arg)) {
					return -EINVAL;
				}
				action->kind = REFLEX_ACT_HAPTIC;
			} else if ((step = json_find_value(
					    cursor, "\"chime\"")) != NULL &&
				   step < object_end) {
				if (!json_parse_u32(step, &number) ||
				    number == 0U || number > 255U) {
					return -EINVAL;
				}
				action->kind = REFLEX_ACT_CHIME;
				action->arg = (uint8_t)number;
			} else {
				return -EINVAL;
			}
			++out->action_count;
			cursor = object_end;
		}
	}
	if (out->action_count == 0U) {
		return -EINVAL;
	}
	return 0;
}

/* ---- Canonical serializer --------------------------------------------- */

/*
 * Emit the canonical single-line form this module also accepts, so the SD
 * file round-trips through the same parser that admitted the recipe.
 * Countdown recipes always serialize armed:0 — arming is a runtime act
 * whose deadline lives on the uptime clock, and uptime does not survive
 * reboot (header rationale).
 */
static int reflex_serialize(const struct reflex_recipe *recipe, char *out,
			    size_t capacity)
{
	size_t used = 0U;
	int wrote;

	switch (recipe->trigger) {
	case REFLEX_TRIG_COUNTDOWN:
		wrote = snprintf(out, capacity,
				 "{\"id\":%u,\"trigger\":{\"type\":"
				 "\"countdown\",\"seconds\":%u},\"armed\":0",
				 recipe->id, recipe->countdown_s);
		break;
	case REFLEX_TRIG_DAILY:
		wrote = snprintf(out, capacity,
				 "{\"id\":%u,\"trigger\":{\"type\":\"daily\","
				 "\"at\":\"%02u:%02u\"},\"armed\":%u",
				 recipe->id, recipe->daily_minute / 60U,
				 recipe->daily_minute % 60U, recipe->armed);
		break;
	case REFLEX_TRIG_GESTURE:
		wrote = snprintf(out, capacity,
				 "{\"id\":%u,\"trigger\":{\"type\":"
				 "\"gesture\",\"gesture\":\"b2_double\"},"
				 "\"armed\":%u",
				 recipe->id, recipe->armed);
		break;
	case REFLEX_TRIG_VOICE:
		wrote = snprintf(out, capacity,
				 "{\"id\":%u,\"trigger\":{\"type\":"
				 "\"voice\",\"voice\":%u},\"armed\":%u",
				 recipe->id, recipe->gesture, recipe->armed);
		break;
	default:
		return -EINVAL;
	}
	if (wrote < 0 || (size_t)wrote >= capacity) {
		return -EOVERFLOW;
	}
	used = (size_t)wrote;

	wrote = snprintf(out + used, capacity - used, ",\"action\":[");
	if (wrote < 0 || used + (size_t)wrote >= capacity) {
		return -EOVERFLOW;
	}
	used += (size_t)wrote;

	for (size_t index = 0U; index < recipe->action_count; ++index) {
		const struct reflex_action *action = &recipe->actions[index];
		const char *separator = index == 0U ? "" : ",";

		switch (action->kind) {
		case REFLEX_ACT_LED:
			wrote = snprintf(out + used, capacity - used,
					 "%s{\"led\":\"%s\"}", separator,
					 reflex_led_names[action->arg]);
			break;
		case REFLEX_ACT_HAPTIC:
			wrote = snprintf(out + used, capacity - used,
					 "%s{\"haptic\":\"%s\"}", separator,
					 reflex_haptic_names[action->arg]);
			break;
		case REFLEX_ACT_CHIME:
			wrote = snprintf(out + used, capacity - used,
					 "%s{\"chime\":%u}", separator,
					 action->arg);
			break;
		default:
			return -EINVAL;
		}
		if (wrote < 0 || used + (size_t)wrote >= capacity) {
			return -EOVERFLOW;
		}
		used += (size_t)wrote;
	}

	wrote = snprintf(out + used, capacity - used, "]}");
	if (wrote < 0 || used + (size_t)wrote >= capacity) {
		return -EOVERFLOW;
	}
	used += (size_t)wrote;
	if (used > REFLEX_RECIPE_JSON_MAX) {
		return -EOVERFLOW;
	}
	return (int)used;
}

/* ---- Table ------------------------------------------------------------ */

static struct reflex_recipe *reflex_find(uint32_t id)
{
	for (size_t index = 0U; index < REFLEX_MAX_RECIPES; ++index) {
		if (recipes[index].id == id) {
			return &recipes[index];
		}
	}
	return NULL;
}

static struct reflex_recipe *reflex_free_slot(void)
{
	return reflex_find(0U);
}

static const char *reflex_trigger_name(uint8_t trigger)
{
	switch (trigger) {
	case REFLEX_TRIG_COUNTDOWN:
		return "countdown";
	case REFLEX_TRIG_DAILY:
		return "daily";
	case REFLEX_TRIG_GESTURE:
		return "gesture";
	case REFLEX_TRIG_VOICE:
		return "voice";
	default:
		return "?";
	}
}

/* ---- Persistence ------------------------------------------------------ */

static int reflex_save(void)
{
	struct fs_file_t file;
	struct fs_dirent entry;
	int error;

	fs_file_t_init(&file);
	error = fs_open(&file, REFLEX_FILE_TMP,
			FS_O_CREATE | FS_O_WRITE | FS_O_TRUNC);
	if (error != 0) {
		printk("Reflex save open failed: %d\n", error);
		return error;
	}
	for (size_t index = 0U; index < REFLEX_MAX_RECIPES && error == 0;
	     ++index) {
		int length;

		if (recipes[index].id == 0U) {
			continue;
		}
		length = reflex_serialize(&recipes[index], reflex_scratch,
					  sizeof(reflex_scratch) - 1U);
		if (length < 0) {
			/* A table entry this module admitted must serialize;
			 * failing one entry must not lose the rest. */
			printk("Reflex save skip id=%u: %d\n",
			       recipes[index].id, length);
			continue;
		}
		reflex_scratch[length] = '\n';
		if (fs_write(&file, reflex_scratch, (size_t)length + 1U) !=
		    (ssize_t)(length + 1)) {
			error = -EIO;
		}
	}
	if (error == 0) {
		error = fs_sync(&file);
	}
	(void)fs_close(&file);
	if (error != 0) {
		printk("Reflex save write failed: %d\n", error);
		return error;
	}

	/* Stat first — see pendant_store: unlink on a missing path logs an
	 * error-level line that would train people to ignore errors. */
	if (fs_stat(REFLEX_FILE, &entry) == 0) {
		(void)fs_unlink(REFLEX_FILE);
	}
	error = fs_rename(REFLEX_FILE_TMP, REFLEX_FILE);
	if (error != 0) {
		printk("Reflex save rename failed: %d\n", error);
	}
	return error;
}

/*
 * Admit one parsed recipe into the table (upsert by id).  `from_wire`
 * recipes may arm a countdown on receipt (the "timer" special case) and
 * are persisted; boot-loaded recipes never self-arm a countdown and are
 * not re-saved (the file is already the truth).
 */
static int reflex_admit(const struct reflex_recipe *incoming, bool from_wire)
{
	struct reflex_recipe *slot = reflex_find(incoming->id);

	if (slot == NULL) {
		slot = reflex_free_slot();
	}
	if (slot == NULL) {
		printk("Reflex table full (%u) — rejecting id=%u\n",
		       REFLEX_MAX_RECIPES, incoming->id);
		return -ENOSPC;
	}
	*slot = *incoming;
	if (slot->trigger == REFLEX_TRIG_COUNTDOWN) {
		if (from_wire && slot->armed != 0U) {
			/* Timer case: countdown starts at receipt. */
			slot->fire_at_ms = k_uptime_get() +
					   (int64_t)slot->countdown_s * 1000;
		} else {
			slot->armed = 0U;
			slot->fire_at_ms = 0;
		}
	}
	printk("Reflex recipe %s: id=%u trigger=%s armed=%u actions=%u\n",
	       from_wire ? "stored" : "loaded", slot->id,
	       reflex_trigger_name(slot->trigger), slot->armed,
	       slot->action_count);
	if (from_wire) {
		++reflex_stat_stored;
		return reflex_save();
	}
	++reflex_stat_loaded;
	return 0;
}

static void reflex_load(const char *why)
{
	struct fs_file_t file;
	struct fs_dirent entry;
	size_t length = 0U;
	uint32_t lines = 0U;
	bool overlong = false;
	int error;

	memset(recipes, 0, sizeof(recipes));

	/* Crash recovery: a save that died between unlink and rename left
	 * the new table stranded in the temp file. */
	if (fs_stat(REFLEX_FILE, &entry) != 0 &&
	    fs_stat(REFLEX_FILE_TMP, &entry) == 0) {
		printk("Reflex: recovering interrupted save\n");
		(void)fs_rename(REFLEX_FILE_TMP, REFLEX_FILE);
	}

	fs_file_t_init(&file);
	error = fs_open(&file, REFLEX_FILE, FS_O_READ);
	if (error != 0) {
		printk("Reflex: no recipes.json (%d) — table empty (%s)\n",
		       error, why);
		return;
	}

	/* Byte-at-a-time line assembly, same pattern as the alert inbox:
	 * boot-only cost, zero extra buffers. */
	for (;;) {
		char byte;
		ssize_t got = fs_read(&file, &byte, 1U);
		bool flush = false;

		if (got != 1) {
			flush = length > 0U;
			byte = '\n';
			if (!flush) {
				break;
			}
		}
		if (byte == '\n') {
			flush = length > 0U;
		} else if (byte != '\r') {
			if (length + 1U < sizeof(reflex_scratch)) {
				reflex_scratch[length++] = byte;
			} else {
				overlong = true;
			}
		}
		if (flush) {
			struct reflex_recipe parsed;

			reflex_scratch[length] = '\0';
			++lines;
			if (overlong) {
				printk("Reflex: line %u exceeds %u B cap — "
				       "skipped\n",
				       lines, REFLEX_RECIPE_JSON_MAX);
				++reflex_stat_rejected;
			} else if (reflex_parse_recipe(reflex_scratch,
						       &parsed) != 0) {
				printk("Reflex: line %u failed to parse — "
				       "skipped\n",
				       lines);
				++reflex_stat_rejected;
			} else {
				(void)reflex_admit(&parsed, false);
			}
			length = 0U;
			overlong = false;
		}
		if (got != 1) {
			break;
		}
	}
	(void)fs_close(&file);
	printk("Reflex: recipes.json read (%s): %u line(s), %u recipe(s)\n",
	       why, lines, reflex_count());
}

/* ---- Action execution ------------------------------------------------- */

static void reflex_run_actions(const struct reflex_recipe *recipe,
			       const char *cause)
{
	printk("REFLEX fire: id=%u trigger=%s cause=%s actions=%u\n",
	       recipe->id, reflex_trigger_name(recipe->trigger), cause,
	       recipe->action_count);
	++reflex_stat_fired;

	for (size_t index = 0U; index < recipe->action_count; ++index) {
		const struct reflex_action *action = &recipe->actions[index];

		switch (action->kind) {
		case REFLEX_ACT_LED:
			if (reflex_ops.led != NULL) {
				reflex_ops.led(action->arg);
			}
			break;
		case REFLEX_ACT_HAPTIC:
			/*
			 * The degrade contract: an absent DRV2605L was
			 * logged ONCE at probe time; every haptic step
			 * quietly becomes the LED pattern of the same name
			 * rather than failing the recipe or poking a dead
			 * bus again.
			 */
			if (reflex_ops.haptic == NULL ||
			    reflex_ops.haptic(action->arg) != 0) {
				if (reflex_ops.led != NULL) {
					reflex_ops.led(
						reflex_haptic_led_fallback
							[action->arg]);
				}
			}
			break;
		case REFLEX_ACT_CHIME:
			if (reflex_ops.chime != NULL) {
				(void)reflex_ops.chime(action->arg);
			}
			break;
		default:
			break;
		}
	}
}

/* ---- Arm / disarm ----------------------------------------------------- */

static int reflex_set_armed(uint32_t id, bool armed, const char *who)
{
	struct reflex_recipe *recipe = reflex_find(id);

	if (id == 0U || recipe == NULL) {
		printk("Reflex %s: no recipe id=%u\n", who, id);
		return -ENOENT;
	}
	recipe->armed = armed ? 1U : 0U;
	if (recipe->trigger == REFLEX_TRIG_COUNTDOWN) {
		recipe->fire_at_ms =
			armed ? k_uptime_get() +
					(int64_t)recipe->countdown_s * 1000
			      : 0;
		printk("Reflex %s: id=%u countdown %s (%u s)\n", who, id,
		       armed ? "armed" : "disarmed", recipe->countdown_s);
		/* Runtime state only — nothing to persist for a timer. */
		return 0;
	}
	printk("Reflex %s: id=%u %s %s\n", who, id,
	       reflex_trigger_name(recipe->trigger),
	       armed ? "armed" : "disarmed");
	/* Daily/gesture arm state is part of the stored recipe. */
	return reflex_save();
}

/* ---- Daily clock ------------------------------------------------------ */

/*
 * Read the modem's NITZ wall clock ("yy/MM/dd,hh:mm:ss±zz", local time —
 * the same source X-Device-Time uses).  Returns false while the carrier
 * has never delivered time; the modem RTC keeps the value ticking across
 * radio-off periods once it has one.
 */
static bool reflex_wall_clock(uint32_t *day_out, uint32_t *minute_out)
{
	char clock_text[32];

	pendant_cloud_copy_device_time(clock_text, sizeof(clock_text));
	if (strlen(clock_text) < 17U || clock_text[2] != '/' ||
	    clock_text[5] != '/' || clock_text[8] != ',' ||
	    clock_text[11] != ':' || clock_text[14] != ':') {
		return false;
	}
	if (clock_text[6] < '0' || clock_text[6] > '9' ||
	    clock_text[7] < '0' || clock_text[7] > '9' ||
	    clock_text[9] < '0' || clock_text[9] > '9' ||
	    clock_text[10] < '0' || clock_text[10] > '9' ||
	    clock_text[12] < '0' || clock_text[12] > '9' ||
	    clock_text[13] < '0' || clock_text[13] > '9') {
		return false;
	}
	*day_out = (uint32_t)(clock_text[6] - '0') * 10U +
		   (uint32_t)(clock_text[7] - '0');
	*minute_out = ((uint32_t)(clock_text[9] - '0') * 10U +
		       (uint32_t)(clock_text[10] - '0')) *
			      60U +
		      (uint32_t)(clock_text[12] - '0') * 10U +
		      (uint32_t)(clock_text[13] - '0');
	return true;
}

static void reflex_tick_daily(void)
{
	bool any_daily = false;
	uint32_t day = 0U;
	uint32_t now_minute = 0U;
	int64_t now = k_uptime_get();

	for (size_t index = 0U; index < REFLEX_MAX_RECIPES; ++index) {
		if (recipes[index].id != 0U &&
		    recipes[index].trigger == REFLEX_TRIG_DAILY &&
		    recipes[index].armed != 0U) {
			any_daily = true;
			break;
		}
	}
	if (!any_daily || now < reflex_next_clock_poll_ms) {
		return;
	}
	reflex_next_clock_poll_ms = now + REFLEX_CLOCK_POLL_MS;

	if (!reflex_wall_clock(&day, &now_minute)) {
		if (!reflex_no_clock_logged) {
			printk("Reflex: no NITZ wall clock yet — daily "
			       "recipes wait for the carrier\n");
			reflex_no_clock_logged = true;
		}
		return;
	}

	for (size_t index = 0U; index < REFLEX_MAX_RECIPES; ++index) {
		struct reflex_recipe *recipe = &recipes[index];
		uint32_t key;
		uint32_t late;

		if (recipe->id == 0U ||
		    recipe->trigger != REFLEX_TRIG_DAILY ||
		    recipe->armed == 0U) {
			continue;
		}
		/*
		 * Grace window: the tick only runs while idle, so a
		 * conversation spanning the alarm minute delays firing;
		 * within REFLEX_DAILY_GRACE_MIN the alarm still counts.
		 */
		late = (now_minute + 1440U - recipe->daily_minute) % 1440U;
		if (late >= REFLEX_DAILY_GRACE_MIN) {
			continue;
		}
		key = (day << 16) | recipe->daily_minute;
		if (recipe->last_daily_key == key) {
			continue; /* already fired this occurrence */
		}
		recipe->last_daily_key = key;
		reflex_run_actions(recipe, late == 0U ? "daily"
						      : "daily(late)");
	}
}

/* ---- Public API ------------------------------------------------------- */

void pendant_reflex_init(const struct pendant_reflex_ops *ops)
{
	reflex_ops = *ops;
	reflex_load("boot");
	reflex_ready = true;

#ifdef CONFIG_PENDANT_REFLEX_SELFTEST
	/*
	 * Boot self-test (debug builds): with no recipes.json on the card,
	 * install a RAM-ONLY armed 10 s countdown exercising all three
	 * action kinds.  RAM-only on purpose: it is never written to the
	 * card, so it cannot masquerade as an owner-installed recipe, and
	 * the moment a real recipes.json exists it stops appearing.  The
	 * countdown deadline starts NOW but the tick runs on the idle
	 * loop, so the burst lands on the first idle pass after LTE init
	 * (later than 10 s of uptime; the fire log carries the uptime).
	 */
	if (reflex_count() == 0U) {
		struct reflex_recipe test = {
			.id = 1U,
			.trigger = REFLEX_TRIG_COUNTDOWN,
			.countdown_s = 10U,
			.armed = 1U,
			.action_count = 3U,
			.actions = {
				{ .kind = REFLEX_ACT_LED,
				  .arg = REFLEX_LED_BURST },
				{ .kind = REFLEX_ACT_HAPTIC,
				  .arg = HAPTIC_PATTERN_DOUBLE },
				{ .kind = REFLEX_ACT_CHIME, .arg = 1U },
			},
		};

		test.fire_at_ms = k_uptime_get() + 10000;
		recipes[0] = test;
		printk("REFLEX_SELFTEST: installed RAM-only 10 s countdown "
		       "id=1 (led burst + haptic double + chime)\n");
	}
#endif
	reflex_print_stats("init");
}

bool pendant_reflex_offer_frame(const char *frame)
{
	const char *value = json_find_value(frame, "\"type\"");
	size_t length;

	if (value == NULL || !json_value_is_string(value, "recipe")) {
		return false;
	}
	/*
	 * Ours from here on, even if it cannot be queued: a recipe frame
	 * falling through to the legacy substring matching could contain
	 * "end" anywhere in its body and kill a live conversation.
	 */
	if (atomic_get(&reflex_pending_full) != 0) {
		++reflex_stat_dropped;
		return true; /* relay resends on missing ack */
	}
	length = strlen(frame);
	if (length >= sizeof(reflex_pending)) {
		length = sizeof(reflex_pending) - 1U; /* parse will reject */
	}
	memcpy(reflex_pending, frame, length);
	reflex_pending[length] = '\0';
	/* Payload lands before the flag flips — the consumer never sees a
	 * half-written frame. */
	compiler_barrier();
	atomic_set(&reflex_pending_full, 1);
	return true;
}

int pendant_reflex_process_pending(char *ack_out, size_t ack_capacity)
{
	struct reflex_recipe parsed;
	const char *value;
	const char *object_end;
	uint32_t ack_id = 0U;
	size_t length;
	int error = -EINVAL;

	if (!reflex_ready || atomic_get(&reflex_pending_full) == 0) {
		return 0;
	}

	/* Consume the slot: extract the recipe OBJECT out of the envelope
	 * into scratch, then free the slot for the WS thread. */
	value = json_find_value(reflex_pending, "\"recipe\"");
	if (value != NULL && *value == '{' &&
	    (object_end = json_skip_container(value, '{', '}')) != NULL &&
	    (length = (size_t)(object_end - value)) <=
		    REFLEX_RECIPE_JSON_MAX) {
		memcpy(reflex_scratch, value, length);
		reflex_scratch[length] = '\0';
		error = 0;
	}
	atomic_set(&reflex_pending_full, 0);

	if (error == 0) {
		error = reflex_parse_recipe(reflex_scratch, &parsed);
		if (error == 0) {
			ack_id = parsed.id;
			error = reflex_admit(&parsed, true);
		}
	}
	if (error != 0) {
		++reflex_stat_rejected;
		printk("Reflex: downlink recipe rejected: %d\n", error);
	}
	reflex_print_stats(error == 0 ? "recipe_stored" : "recipe_rejected");

	/*
	 * Ack (or nack) upstream so the relay can stop resending.  Well
	 * under the 500 B frame budget by construction.
	 */
	(void)snprintf(ack_out, ack_capacity,
		       "{\"type\":\"recipe_ack\",\"id\":%u,\"ok\":%u}",
		       ack_id, error == 0 ? 1U : 0U);
	return 1;
}

void pendant_reflex_tick(void)
{
	int64_t now;

	if (!reflex_ready) {
		return;
	}

	/* SWD debug hooks — consumed here so all table access stays on the
	 * main thread. */
	if (pendant_reflex_reload != 0U) {
		pendant_reflex_reload = 0U;
		printk("Reflex: SWD reload requested\n");
		reflex_load("swd_reload");
		reflex_print_stats("reload");
	}
	if (pendant_reflex_arm != 0U) {
		uint32_t id = pendant_reflex_arm;

		pendant_reflex_arm = 0U;
		(void)reflex_set_armed(id, true, "swd_arm");
	}
	if (pendant_reflex_disarm != 0U) {
		uint32_t id = pendant_reflex_disarm;

		pendant_reflex_disarm = 0U;
		(void)reflex_set_armed(id, false, "swd_disarm");
	}
	if (pendant_reflex_fire != 0U) {
		uint32_t id = pendant_reflex_fire;
		struct reflex_recipe *recipe;

		pendant_reflex_fire = 0U;
		recipe = reflex_find(id);
		if (id != 0U && recipe != NULL) {
			reflex_run_actions(recipe, "swd_fire");
		} else {
			printk("Reflex swd_fire: no recipe id=%u\n", id);
		}
	}

	/* Countdowns. One-shot: firing disarms; re-arming restarts. */
	now = k_uptime_get();
	for (size_t index = 0U; index < REFLEX_MAX_RECIPES; ++index) {
		struct reflex_recipe *recipe = &recipes[index];

		if (recipe->id == 0U ||
		    recipe->trigger != REFLEX_TRIG_COUNTDOWN ||
		    recipe->armed == 0U || recipe->fire_at_ms == 0 ||
		    now < recipe->fire_at_ms) {
			continue;
		}
		recipe->fire_at_ms = 0;
		recipe->armed = 0U;
		reflex_run_actions(recipe, "countdown");
	}

	reflex_tick_daily();
}

bool pendant_reflex_gesture_armed(void)
{
	if (!reflex_ready) {
		return false;
	}
	for (size_t index = 0U; index < REFLEX_MAX_RECIPES; ++index) {
		if (recipes[index].id != 0U &&
		    recipes[index].trigger == REFLEX_TRIG_GESTURE &&
		    recipes[index].armed != 0U) {
			return true;
		}
	}
	return false;
}

void pendant_reflex_fire_gesture(void)
{
	for (size_t index = 0U; index < REFLEX_MAX_RECIPES; ++index) {
		struct reflex_recipe *recipe = &recipes[index];

		if (recipe->id != 0U &&
		    recipe->trigger == REFLEX_TRIG_GESTURE &&
		    recipe->armed != 0U) {
			reflex_run_actions(recipe, "b2_double");
		}
	}
}

bool pendant_reflex_voice_armed(uint8_t slot)
{
	if (!reflex_ready || slot == 0U) {
		return false;
	}
	for (size_t index = 0U; index < REFLEX_MAX_RECIPES; ++index) {
		if (recipes[index].id != 0U &&
		    recipes[index].trigger == REFLEX_TRIG_VOICE &&
		    recipes[index].gesture == slot &&
		    recipes[index].armed != 0U) {
			return true;
		}
	}
	return false;
}

unsigned int pendant_reflex_fire_voice(uint8_t slot)
{
	unsigned int fired = 0U;

	if (slot == 0U) {
		return 0U;
	}
	for (size_t index = 0U; index < REFLEX_MAX_RECIPES; ++index) {
		struct reflex_recipe *recipe = &recipes[index];

		if (recipe->id != 0U &&
		    recipe->trigger == REFLEX_TRIG_VOICE &&
		    recipe->gesture == slot && recipe->armed != 0U) {
			reflex_run_actions(recipe, "voice");
			++fired;
		}
	}
	return fired;
}
