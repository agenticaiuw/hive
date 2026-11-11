#ifndef PENDANT_BT_H_
#define PENDANT_BT_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/*
 * Bluetooth policy on the nRF9160, spoken over a UART to the audio module.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * The ESP32 on the bench is a stand-in for a BM83-class Bluetooth audio
 * module, and the standing architecture rule is that it may only do what
 * such a module could do. A module has exactly one control surface: a UART
 * carrying short commands and unsolicited events. So "which speaker do we
 * play through" is not the module's decision to make — it is POLICY, and
 * policy belongs to the main chip. The module discovers and connects; this
 * file decides who, when, and what the owner is offered.
 *
 * That split is also what makes the ESP32 replaceable: everything here is
 * written against a newline-delimited JSON command set on a 115200 8N1
 * line, not against the ESP32. Swapping in a real module changes the
 * strings in pendant_bt_send_command(), nothing else.
 *
 * WIRING (see firmware/CONTROLS_WIRING.md for the full rationale)
 *   nRF P0.00 TX -> module RX   (ESP32 GPIO16 / UART2 RX)
 *   nRF P0.05 RX <- module TX   (ESP32 GPIO17 / UART2 TX)
 *
 * RAM
 * ---
 * One 4-entry sink table (name + address), one UART line buffer, a handful
 * of flags. The table persists to a ~200 B file on the microSD card, so a
 * power cycle does not forget the owner's headphones — and neither the
 * settings subsystem nor NVS is dragged in for it.
 */

/* Remembered sinks. Four is an owner's real device count (earbuds, desk
 * speaker, car, one spare); the fifth push evicts the least recently used. */
#define PENDANT_BT_SLOTS 4U
#define PENDANT_BT_NAME_MAX 24U
#define PENDANT_BT_ADDR_MAX 18U /* "aa:bb:cc:dd:ee:ff" + NUL */

/*
 * Open the UART and load the remembered sink table from the card. Safe to
 * call with no module attached and with no card: both degrade to "no
 * Bluetooth policy", never to a boot failure.
 */
void pendant_bt_init(void);

/*
 * Service the link: consume whatever the module said, run the reconnect
 * cadence, and act on any queued request. Main thread only — it writes the
 * UART, the card, and the sink table. Call it from the idle wait; it never
 * blocks for more than one short command's worth of TX.
 */
void pendant_bt_poll(void);

/*
 * Ask for the preferred (most recently used) sink to be connected. Callable
 * from any thread — it only raises a flag that pendant_bt_poll() acts on, so
 * the WebSocket thread can hand over an {"audio_sink":"bluetooth"} without
 * ever touching a UART or the filesystem.
 */
void pendant_bt_request_connect(void);

/* Ask the module to run an inquiry. Same deferred-to-main contract. */
void pendant_bt_request_scan(void);

/*
 * Owner picked entry N from the relay-side device menu (0 = preferred).
 * Promotes it to most-recently-used and connects. Deferred to main.
 */
void pendant_bt_request_select(int index);

/* Deferred requests are pending — the idle loop has work to do. */
bool pendant_bt_work_pending(void);

/*
 * Render {"type":"bt_devices","devices":[...]} for the converse socket.
 * Returns the string length, or 0 if it would not fit. Main thread only
 * (it reads the table); the caller sends it under the usual ws_lock.
 */
size_t pendant_bt_devices_frame(char *out, size_t out_size);

/* Parse an inbound control frame. Returns true when the frame was ours
 * ({"type":"bt_list"} / {"type":"bt_select","index":N}), which also queues
 * the work. Safe from the WebSocket thread. */
bool pendant_bt_offer_frame(const char *frame);

/* The relay asked for the device list and has not been answered yet. */
bool pendant_bt_list_requested(void);
void pendant_bt_list_answered(void);

/* Module reports an A2DP sink connected. */
bool pendant_bt_link_up(void);

/*
 * Bench telemetry: the sink, and whether it is actually connected RIGHT NOW.
 *
 * Returns the module's own connection state — never "we have one in the
 * table". A remembered speaker is one the owner once used; it says nothing
 * about whether anything is paged and streaming, and reporting the two the
 * same way would show a connected speaker to an owner holding a silent
 * pendant. `name`/`addr` are filled with the most-recently-used entry (empty
 * when the table is), so a disconnected sink can still be NAMED.
 */
bool pendant_bt_current_sink(char *name, size_t name_size, char *addr,
			     size_t addr_size);

/*
 * Bench telemetry: has the module's TX wire ever produced anything?
 *
 *   "ok"      a whole line arrived — wires, baud and module firmware all work
 *   "partial" bytes arrived but never a newline — half a link, not none
 *   "silent"  uart1 is up and the module has said nothing
 *   NULL      no uart1 at all, so there is nothing to have an opinion about
 *
 * Diagnostic only. Nothing in the Bluetooth policy reads this: a module that
 * has gone quiet is handled by the reconnect timer, not by a health string.
 */
const char *pendant_bt_module_state(void);

#endif /* PENDANT_BT_H_ */
