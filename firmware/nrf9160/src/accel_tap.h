#ifndef ACCEL_TAP_H_
#define ACCEL_TAP_H_

#include <stdbool.h>

/*
 * LSM6DSOX double-tap wake (I2C2 @ 0x6A/0x6B, INT1 -> P0.27).
 *
 * The part is identified by the owner's 2026-07-02 Adafruit invoice
 * (hardware/purchases/innovoice.webarchive: "Adafruit LSM6DSOX 6 DoF
 * Accelerometer and Gyroscope").  The register recipe is written against
 * the LSM6DSO datasheet on hand (DS12140) — the DSOX is register-identical
 * for everything used here, WHO_AM_I 0x6C included.  The full register map
 * sits in one block at the top of accel_tap.c so a different ST part
 * (LIS2DH12 etc.) is a swap of that block, nothing else.
 *
 * Hardware-only feature set, deliberately: double-tap detection runs inside
 * the sensor at 104 Hz low-power ODR (~26 uA), the gyroscope stays in
 * power-down, no data is ever streamed — the only traffic after boot
 * configuration is the INT1 edge itself.  A double tap behaves exactly like
 * a yellow-button press: the ISR-safe callback handed to accel_tap_init()
 * gives the same semaphore, so mute suppression, conversation start/stop
 * and every other press semantic apply unchanged.  Single-tap events are
 * not routed anywhere (config OFF).
 *
 * Probe-once contract, same as haptic.h: accel_tap_init() probes both I2C
 * addresses exactly once at boot; an absent breakout costs one log line and
 * the feature disappears (buttons still work).  No retries — re-probing is
 * a reboot.
 */

int accel_tap_init(void (*double_tap_isr_cb)(void));

bool accel_tap_available(void);

#endif /* ACCEL_TAP_H_ */
