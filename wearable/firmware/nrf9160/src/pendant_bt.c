/*
 * Bluetooth policy + the UART command link to the audio module.
 * The architecture argument is in pendant_bt.h; this file is the mechanism.
 */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <zephyr/device.h>
#include <zephyr/drivers/uart.h>
#include <zephyr/fs/fs.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/printk.h>
#include <zephyr/sys/util.h>

#include "pendant_bt.h"

#define BT_UART_NODE DT_NODELABEL(uart1)

#define BT_TABLE_PATH "/SD:/btsinks.idx"
#define BT_TABLE_MAGIC 0x42545331U /* "BTS1" */

/*
 * One event line. 128 B is not "most of a frame" — it is all of the part
 * that matters, and that is a contract with the module's firmware rather
 * than a hope: every event puts type/state and then the machine-readable
 * fields (device+address, or target) first and the human-readable message
 * last, precisely so a fixed-size receiver can truncate the prose and lose
 * nothing it acts on. A discovery frame reaches `address` by ~114 B with a
 * 32-character device name. See the field-order note in the ESP32 bridge's
 * main.cpp; anything past this cap is dropped to the next newline.
 */
#define BT_LINE_MAX 128U

/* Re-page the preferred sink while the link is down. Slower than the
 * module's own retry (30 s) on purpose: this is a backstop for the case
 * where the module forgot, not a second retry loop racing the first. */
#define BT_RECONNECT_INTERVAL_MS 60000

struct bt_sink {
	char name[PENDANT_BT_NAME_MAX];
	char addr[PENDANT_BT_ADDR_MAX];
};

/*
 * Index 0 is the preferred sink. Insertion at the front and eviction from
 * the back IS the LRU policy — with four entries a shift is four copies of
 * 42 bytes, which is cheaper than carrying an age byte and sorting on it.
 */
static struct bt_sink bt_sinks[PENDANT_BT_SLOTS];
static uint8_t bt_sink_count;
static bool bt_table_dirty;

struct bt_table_file {
	uint32_t magic;
	uint32_t count;
	struct bt_sink sinks[PENDANT_BT_SLOTS];
	uint32_t checksum;
};

static const struct device *bt_uart;
static bool bt_uart_ready;

/*
 * ISR side. ONE line buffer, deliberately: the ISR stops filling it the
 * moment a line is complete and simply discards bytes until main has taken
 * it, so producer and consumer can never be inside the buffer together and
 * a second buffer buys nothing but 256 B.
 *
 * The ISR also drops lines nobody acts on. The module emits a link-health
 * line every second; latching those would hold the single slot against the
 * discovery and connection events that actually drive policy. The filter is
 * a prefix compare because every frame from the module opens with its type.
 */
static char bt_line[BT_LINE_MAX];
static size_t bt_line_length;
static volatile bool bt_line_ready;
static bool bt_line_overflow;
static uint32_t bt_lines_dropped;
/*
 * Liveness, for the bench dashboard only — never for policy.
 *
 * "Is the ESP32 talking?" is one of the wires the owner cannot see, and it has
 * three genuinely different answers that a single boolean would flatten: a
 * whole line came back (the pair of wires and the module's firmware both
 * work), bytes came back but never a newline (a baud mismatch or a half-wired
 * link), or nothing at all. Counted in the ISR because that is the only place
 * that sees the bytes the line filter throws away.
 */
static volatile uint32_t bt_bytes_seen;
static volatile uint32_t bt_lines_seen;

static atomic_t bt_connect_req;
static atomic_t bt_scan_req;
static atomic_t bt_select_req = ATOMIC_INIT(-1);
static atomic_t bt_list_req;
static atomic_t bt_connected;
static int64_t bt_next_reconnect_ms;

/* ---- table persistence ---- */

static uint32_t bt_table_checksum(const struct bt_table_file *table)
{
	const uint32_t *words = (const uint32_t *)table;
	size_t count = offsetof(struct bt_table_file, checksum) /
		       sizeof(uint32_t);
	uint32_t sum = 0xA5A5A5A5U;

	for (size_t index = 0U; index < count; ++index) {
		sum = (sum << 1) ^ words[index];
	}
	return sum;
}

static void bt_table_load(void)
{
	struct fs_file_t file;
	struct bt_table_file table;

	fs_file_t_init(&file);
	if (fs_open(&file, BT_TABLE_PATH, FS_O_READ) != 0) {
		return;
	}
	if (fs_read(&file, &table, sizeof(table)) == (ssize_t)sizeof(table) &&
	    table.magic == BT_TABLE_MAGIC &&
	    table.checksum == bt_table_checksum(&table) &&
	    table.count <= PENDANT_BT_SLOTS) {
		memcpy(bt_sinks, table.sinks, sizeof(bt_sinks));
		bt_sink_count = (uint8_t)table.count;
		printk("BT sinks recovered: %u remembered, preferred=%s\n",
		       bt_sink_count,
		       bt_sink_count > 0U ? bt_sinks[0].name : "(none)");
	}
	(void)fs_close(&file);
}

static void bt_table_save(void)
{
	struct fs_file_t file;
	struct bt_table_file table;

	if (!bt_table_dirty) {
		return;
	}
	memset(&table, 0, sizeof(table));
	table.magic = BT_TABLE_MAGIC;
	table.count = bt_sink_count;
	memcpy(table.sinks, bt_sinks, sizeof(table.sinks));
	table.checksum = bt_table_checksum(&table);

	fs_file_t_init(&file);
	if (fs_open(&file, BT_TABLE_PATH,
		    FS_O_CREATE | FS_O_WRITE | FS_O_TRUNC) != 0) {
		/* No card, or a card that will not write: the table stays in
		 * RAM and works for this power cycle. Never a hard failure —
		 * losing the remembered speaker must not cost a boot. */
		return;
	}
	if (fs_write(&file, &table, sizeof(table)) == (ssize_t)sizeof(table)) {
		(void)fs_sync(&file);
		bt_table_dirty = false;
	}
	(void)fs_close(&file);
}

/* ---- table policy ---- */

static int bt_find(const char *name, const char *addr)
{
	for (uint8_t index = 0U; index < bt_sink_count; ++index) {
		if (addr[0] != '\0' && bt_sinks[index].addr[0] != '\0' &&
		    strcmp(bt_sinks[index].addr, addr) == 0) {
			return index;
		}
		if (name[0] != '\0' && strcmp(bt_sinks[index].name, name) == 0) {
			return index;
		}
	}
	return -1;
}

static void bt_promote(uint8_t index)
{
	struct bt_sink moved;

	if (index == 0U || index >= bt_sink_count) {
		return;
	}
	moved = bt_sinks[index];
	for (uint8_t slot = index; slot > 0U; --slot) {
		bt_sinks[slot] = bt_sinks[slot - 1U];
	}
	bt_sinks[0] = moved;
	bt_table_dirty = true;
}

/*
 * Remember a sink the module told us about. A scan result carries both name
 * and address; a bare connection event may carry only one of them, so a
 * later sighting fills in whatever the first one lacked instead of creating
 * a duplicate entry for the same pair of headphones.
 */
static void bt_remember(const char *name, const char *addr)
{
	int found;

	if (name[0] == '\0' && addr[0] == '\0') {
		return;
	}
	found = bt_find(name, addr);
	if (found >= 0) {
		if (name[0] != '\0') {
			strncpy(bt_sinks[found].name, name,
				PENDANT_BT_NAME_MAX - 1U);
			bt_sinks[found].name[PENDANT_BT_NAME_MAX - 1U] = '\0';
		}
		if (addr[0] != '\0') {
			strncpy(bt_sinks[found].addr, addr,
				PENDANT_BT_ADDR_MAX - 1U);
			bt_sinks[found].addr[PENDANT_BT_ADDR_MAX - 1U] = '\0';
		}
		bt_table_dirty = true;
		return;
	}

	if (bt_sink_count < PENDANT_BT_SLOTS) {
		++bt_sink_count;
	}
	/* Shift down; the oldest entry falls off the end. */
	for (uint8_t slot = bt_sink_count - 1U; slot > 0U; --slot) {
		bt_sinks[slot] = bt_sinks[slot - 1U];
	}
	memset(&bt_sinks[0], 0, sizeof(bt_sinks[0]));
	strncpy(bt_sinks[0].name, name, PENDANT_BT_NAME_MAX - 1U);
	strncpy(bt_sinks[0].addr, addr, PENDANT_BT_ADDR_MAX - 1U);
	bt_table_dirty = true;
	printk("BT sink remembered: %s [%s] (%u known)\n", bt_sinks[0].name,
	       bt_sinks[0].addr, bt_sink_count);
}

/* ---- UART ---- */

static void bt_uart_isr(const struct device *dev, void *user_data)
{
	uint8_t byte;

	ARG_UNUSED(user_data);

	if (!uart_irq_update(dev)) {
		return;
	}
	while (uart_irq_rx_ready(dev)) {
		if (uart_fifo_read(dev, &byte, 1) != 1) {
			break;
		}
		/*
		 * Counted before every filter below, including the
		 * drop-the-bytes path: this is the bench's evidence that the
		 * module's TX wire reaches this chip at all, which is a
		 * different question from whether anything it said was wanted.
		 */
		++bt_bytes_seen;
		if (bt_line_ready) {
			/* Main still owns the buffer. Keep draining the FIFO
			 * (an unread UARTE re-interrupts forever) but throw
			 * the bytes away. */
			continue;
		}
		if (byte == '\r') {
			continue;
		}
		if (byte != '\n') {
			if (bt_line_length + 1U < sizeof(bt_line)) {
				bt_line[bt_line_length++] = (char)byte;
			} else {
				bt_line_overflow = true;
			}
			continue;
		}
		bt_line[bt_line_length] = '\0';
		++bt_lines_seen;
		/*
		 * Type filter, in the ISR because it decides whether the one
		 * slot is spent. Only frames that change policy are latched:
		 * a discovery result (a sink to remember) and a bridge state
		 * (the link came up or went away). The once-a-second health
		 * line is read off the wire and dropped here.
		 */
		bool wanted = bt_line_length > 0U &&
			      (strncmp(bt_line, "{\"type\":\"discovery\"", 19) ==
				       0 ||
			       strncmp(bt_line, "{\"type\":\"bridge\"", 16) == 0);

		/*
		 * A truncated line is still latched: the prefix is where the
		 * machine-readable fields live by contract. The parser is the
		 * one that decides — it accepts only values that closed their
		 * quote, so a field the truncation cut in half is ignored
		 * rather than remembered wrong.
		 */
		if (wanted) {
			bt_line_ready = true;
		} else {
			++bt_lines_dropped;
		}
		bt_line_length = 0U;
		bt_line_overflow = false;
	}
}

static void bt_send_command(const char *command)
{
	if (!bt_uart_ready) {
		return;
	}
	for (const char *cursor = command; *cursor != '\0'; ++cursor) {
		uart_poll_out(bt_uart, (unsigned char)*cursor);
	}
	uart_poll_out(bt_uart, '\n');
	printk("BT module <- %s\n", command);
}

/* ---- JSON helpers (the same "we own both ends of this document" argument
 * pendant_store.c makes: a full parser is not worth kilobytes of flash) ---- */

static bool bt_json_string(const char *line, const char *key, char *out,
			   size_t out_size)
{
	char pattern[16];
	const char *found;
	size_t length = 0U;

	(void)snprintf(pattern, sizeof(pattern), "\"%s\":\"", key);
	found = strstr(line, pattern);
	out[0] = '\0';
	if (found == NULL) {
		return false;
	}
	found += strlen(pattern);
	while (*found != '\0' && *found != '"') {
		if (*found == '\\' && found[1] != '\0') {
			++found;
		}
		if (length + 1U < out_size) {
			out[length++] = *found;
		}
		++found;
	}
	out[length] = '\0';
	if (*found != '"') {
		/* The line ended inside the value — a truncated event. Half a
		 * Bluetooth address remembered as a whole one is worse than no
		 * entry, so this reads as "field absent". */
		out[0] = '\0';
		return false;
	}
	return true;
}

static void bt_json_escape(const char *in, char *out, size_t out_size)
{
	size_t length = 0U;

	for (const char *cursor = in; *cursor != '\0'; ++cursor) {
		char value = *cursor;

		/* Names come off a stranger's Bluetooth radio. Anything that
		 * could break the frame we are about to build is dropped
		 * rather than escaped — a speaker called `My"Bose` loses one
		 * character and the relay still gets valid JSON. */
		if (value == '"' || value == '\\' || (unsigned char)value < 0x20) {
			continue;
		}
		if (length + 1U >= out_size) {
			break;
		}
		out[length++] = value;
	}
	out[length] = '\0';
}

/* ---- inbound module events ---- */

static void bt_handle_line(const char *line)
{
	char name[PENDANT_BT_NAME_MAX];
	char addr[PENDANT_BT_ADDR_MAX];
	char state[16];

	(void)bt_json_string(line, "device", name, sizeof(name));
	(void)bt_json_string(line, "address", addr, sizeof(addr));
	(void)bt_json_string(line, "state", state, sizeof(state));

	if (name[0] != '\0' || addr[0] != '\0') {
		bt_remember(name, addr);
	}

	if (strcmp(state, "connected") == 0) {
		if (!atomic_set(&bt_connected, 1)) {
			printk("BT module: sink connected\n");
		}
		/*
		 * A connection is the only proof an entry is reachable, so it
		 * is the only event that reorders the table. Discovery just
		 * fills the menu.
		 */
		if (name[0] == '\0') {
			(void)bt_json_string(line, "target", name,
					     sizeof(name));
		}
		if (name[0] != '\0') {
			int found = bt_find(name, "");

			if (found > 0) {
				bt_promote((uint8_t)found);
			} else if (found < 0) {
				bt_remember(name, "");
			}
		}
		bt_next_reconnect_ms = 0;
	} else if (strcmp(state, "usb") == 0 ||
		   strcmp(state, "searching") == 0) {
		atomic_set(&bt_connected, 0);
	}
}

/* ---- public API ---- */

void pendant_bt_init(void)
{
	bt_uart = DEVICE_DT_GET(BT_UART_NODE);
	if (!device_is_ready(bt_uart)) {
		printk("BT module UART (P0.00/P0.05) not ready — Bluetooth "
		       "policy disabled\n");
		return;
	}
	uart_irq_rx_disable(bt_uart);
	uart_irq_tx_disable(bt_uart);
	if (uart_irq_callback_user_data_set(bt_uart, bt_uart_isr, NULL) != 0) {
		printk("BT module UART callback rejected — link disabled\n");
		return;
	}
	uart_irq_rx_enable(bt_uart);
	bt_uart_ready = true;

	bt_table_load();
	printk("BT module link up on uart1 (TX P0.00 -> module RX, "
	       "RX P0.05 <- module TX, 115200 8N1)\n");
	/*
	 * Boot policy: if the owner has ever connected a sink, go get it. The
	 * module is the only thing that can page it, and asking costs one
	 * short UART line.
	 */
	if (bt_sink_count > 0U) {
		atomic_set(&bt_connect_req, 1);
	}
	bt_send_command("{\"command\":\"status\"}");
}

void pendant_bt_request_connect(void)
{
	atomic_set(&bt_connect_req, 1);
}

void pendant_bt_request_scan(void)
{
	atomic_set(&bt_scan_req, 1);
}

void pendant_bt_request_select(int index)
{
	if (index < 0 || index >= (int)PENDANT_BT_SLOTS) {
		return;
	}
	atomic_set(&bt_select_req, index);
}

bool pendant_bt_work_pending(void)
{
	return bt_line_ready || atomic_get(&bt_connect_req) != 0 ||
	       atomic_get(&bt_scan_req) != 0 ||
	       atomic_get(&bt_select_req) >= 0 ||
	       atomic_get(&bt_list_req) != 0;
}

bool pendant_bt_link_up(void)
{
	return atomic_get(&bt_connected) != 0;
}

bool pendant_bt_current_sink(char *name, size_t name_size, char *addr,
			     size_t addr_size)
{
	/*
	 * CONNECTED is the module's own event, never "we have a sink in the
	 * table". A remembered speaker is one the owner once used; it says
	 * nothing about whether anything is paged and streaming right now, and
	 * a dashboard that conflated the two would show a connected speaker to
	 * an owner holding a silent pendant.
	 */
	bool connected = atomic_get(&bt_connected) != 0;

	if (name != NULL && name_size > 0U) {
		name[0] = '\0';
		if (bt_sink_count > 0U) {
			strncpy(name, bt_sinks[0].name, name_size - 1U);
			name[name_size - 1U] = '\0';
		}
	}
	if (addr != NULL && addr_size > 0U) {
		addr[0] = '\0';
		if (bt_sink_count > 0U) {
			strncpy(addr, bt_sinks[0].addr, addr_size - 1U);
			addr[addr_size - 1U] = '\0';
		}
	}
	return connected;
}

const char *pendant_bt_module_state(void)
{
	if (!bt_uart_ready) {
		return NULL;
	}
	if (bt_lines_seen > 0U) {
		return "ok";
	}
	if (bt_bytes_seen > 0U) {
		return "partial";
	}
	return "silent";
}

bool pendant_bt_list_requested(void)
{
	return atomic_get(&bt_list_req) != 0;
}

void pendant_bt_list_answered(void)
{
	atomic_set(&bt_list_req, 0);
}

bool pendant_bt_offer_frame(const char *frame)
{
	const char *index_key;

	if (strstr(frame, "\"bt_list\"") != NULL) {
		atomic_set(&bt_list_req, 1);
		return true;
	}
	if (strstr(frame, "\"bt_select\"") == NULL) {
		return false;
	}
	index_key = strstr(frame, "\"index\"");
	if (index_key != NULL) {
		const char *cursor = strchr(index_key, ':');

		if (cursor != NULL) {
			pendant_bt_request_select(atoi(cursor + 1));
		}
	}
	return true;
}

size_t pendant_bt_devices_frame(char *out, size_t out_size)
{
	char escaped[PENDANT_BT_NAME_MAX];
	int length;

	length = snprintf(out, out_size, "{\"type\":\"bt_devices\",\"devices\":[");
	if (length < 0 || (size_t)length >= out_size) {
		return 0U;
	}
	for (uint8_t index = 0U; index < bt_sink_count; ++index) {
		int written;

		bt_json_escape(bt_sinks[index].name, escaped, sizeof(escaped));
		written = snprintf(out + length, out_size - (size_t)length,
				   "%s{\"index\":%u,\"name\":\"%s\","
				   "\"address\":\"%s\",\"preferred\":%s}",
				   index == 0U ? "" : ",", index, escaped,
				   bt_sinks[index].addr,
				   index == 0U ? "true" : "false");
		if (written < 0 ||
		    (size_t)(length + written) >= out_size) {
			return 0U;
		}
		length += written;
	}
	int tail = snprintf(out + length, out_size - (size_t)length,
			    "],\"connected\":%s}",
			    pendant_bt_link_up() ? "true" : "false");

	if (tail < 0 || (size_t)(length + tail) >= out_size) {
		return 0U;
	}
	return (size_t)(length + tail);
}

static void bt_connect_preferred(void)
{
	char command[64];
	char escaped[PENDANT_BT_NAME_MAX];

	if (bt_sink_count == 0U || bt_sinks[0].name[0] == '\0') {
		/* Nothing remembered: an inquiry is the only useful move, and
		 * it is also what fills the owner's menu. */
		bt_send_command("{\"command\":\"scan\"}");
		return;
	}
	bt_json_escape(bt_sinks[0].name, escaped, sizeof(escaped));
	(void)snprintf(command, sizeof(command),
		       "{\"command\":\"connect\",\"target\":\"%s\"}", escaped);
	bt_send_command(command);
}

void pendant_bt_poll(void)
{
	if (!bt_uart_ready) {
		return;
	}

	if (bt_line_ready) {
		bt_handle_line(bt_line);
		/* Release the slot only after the parse: the ISR refills it
		 * the instant this clears. */
		bt_line_ready = false;
	}

	atomic_val_t select = atomic_set(&bt_select_req, -1);

	if (select >= 0) {
		if ((uint8_t)select < bt_sink_count) {
			bt_promote((uint8_t)select);
			bt_connect_preferred();
		}
		atomic_set(&bt_connect_req, 0);
	} else if (atomic_cas(&bt_connect_req, 1, 0)) {
		bt_connect_preferred();
		bt_next_reconnect_ms =
			k_uptime_get() + BT_RECONNECT_INTERVAL_MS;
	}

	if (atomic_cas(&bt_scan_req, 1, 0)) {
		bt_send_command("{\"command\":\"scan\"}");
	}

	/*
	 * Backstop re-page. The module retries on its own; this only covers
	 * the case where it was reset or never got the target, and it stops
	 * entirely once a sink answers.
	 */
	if (!pendant_bt_link_up() && bt_sink_count > 0U &&
	    bt_next_reconnect_ms != 0 &&
	    k_uptime_get() >= bt_next_reconnect_ms) {
		bt_next_reconnect_ms =
			k_uptime_get() + BT_RECONNECT_INTERVAL_MS;
		bt_connect_preferred();
	}

	bt_table_save();
}
