# Actinius Icarus SoM (nRF9160) — Datasheet

Source: https://docs.actinius.com/icarus-som/datasheet/ · Board files: https://docs.actinius.com/icarus-som/board-files/ · CAD symbols/footprints (KiCad/Eagle/etc.): https://www.snapeda.com/parts/Icarus%20SOM/Actinius/view-part/

## Overview
Coin-sized, easy-to-solder System-on-Module with global LTE-M & NB-IoT, GPS, a 3-axis accelerometer, and a SIM-switching circuit (onboard eSIM or external nano-SIM). 18.5 × 28.0 mm, castellated pins. Powered from a 3.3 V regulator or directly from a LiPo.

## Key features
- Processor: ARM Cortex-M33, 1 MB Flash, 256 kB RAM, TrustZone + CryptoCell 310
- Connectivity: LTE Cat-M1, Cat-NB1 (NB-IoT), GPS (L1 C/A); TLS + secure FOTA; PSM and eDRX
- SIM: onboard eSIM + switching circuit for external nano-SIM
- Sensor: LIS2DH12 3-axis low-power accelerometer (I2C addr 0x19; INT on P0.28/P0.29)
- Peripherals: I2C / UART / SPI / **I2S** with EasyDMA, up to 27 GPIO, up to 8× 12-bit ADC, up to 4 PWM, SWD
- Castellated pins + SMD footprint for easy integration

## External pin map (42 pins)
| # | Label | Description |
|---|-------|-------------|
| 1 | GND | Ground |
| 2 | VCC | Main power input (GPIO + onboard peripherals) |
| 3 | P25 | nRF9160 P0.25 |
| 4 | P22 | P0.22 |
| 5 | P21 | P0.21 |
| 6 | P4 | P0.04 |
| 7 | P5 | P0.05 |
| 8 | P2 | P0.02 |
| 9 | P1 | P0.01 |
| 10 | P0 | P0.00 |
| 11 | P26 | P0.26 |
| 12 | P27 | P0.27 |
| 13 | P30 | P0.30 |
| 14 | P31 | P0.31 |
| 15 | P7 | P0.07 |
| 16 | P6 | P0.06 |
| 17 | P3 | P0.03 |
| 18 | P8 | P0.08 |
| 19 | P9 | P0.09 |
| 20 | VIN | Direct battery / radio power input |
| 21 | GND | Ground |
| 22 | GND | Ground |
| 23 | SDA | I2C SDA (i2c2) |
| 24 | SCL | I2C SCL (i2c2) |
| 25 | A0 / P13 | AIN0 / P0.13 |
| 26 | A1 / P14 | AIN1 / P0.14 |
| 27 | A2 / P15 | AIN2 / P0.15 |
| 28 | A3 / P16 | AIN3 / P0.16 |
| 29 | A4 / P17 | AIN4 / P0.17 |
| 30 | A5 / P18 | AIN5 / P0.18 |
| 31 | A6 / P19 | AIN6 / P0.19 |
| 32 | A7 / P20 | AIN7 / P0.20 |
| 33 | RESET | nRF9160 reset |
| 34 | SWDCLK | Programming clock |
| 35 | SWDIO | Programming data |
| 36 | P23 | P0.23 |
| 37 | P24 | P0.24 |
| 38 | NANO_SIM_RST | External SIM reset |
| 39 | NANO_SIM_VCC | External SIM VCC |
| 40 | NANO_SIM_CLK | External SIM clock |
| 41 | NANO_SIM_IO | External SIM IO |
| 42 | GND | Ground |

### Reserved internal pins (do NOT reuse)
- P0.12 — SIM select (HIGH = eSIM, LOW = external nano-SIM)
- P0.28 — accelerometer INT2
- P0.29 — accelerometer INT1

## Recommended operating conditions
| Parameter | MIN | TYP | MAX | Unit |
|-----------|-----|-----|-----|------|
| Operating temperature | -20 | 25 | 85 | °C |
| VCC | 1.8 | – | 3.6 | V |
| VIN | 3.0* | 3.8 | 5.5 | V |

(*) RF/3GPP compliance requires VIN ≥ 3.3 V.

## Dimensions
28 mm (H) × 18.5 mm (W).

## Power notes
- VIN: can be driven directly by a LiPo battery (this also powers the radio).
- VCC: should come from a small 3.3 V regulator (sized to your GPIO/peripheral load).

## For our device — what to pull from this
- Free GPIOs for **I2S** (BCLK/LRCLK/DIN to MAX98357A) and **PDM** (CLK/DATA to the mic) — assign from the P0.xx pins above (e.g. P0–P9, P21–P27, P30/P31). Confirm none clash with reserved P0.12/0.28/0.29.
- **I2C (SDA/SCL, pins 23/24)** for the DRV2605L haptic driver and any extra IMU — note the onboard LIS2DH12 already sits on i2c2 at 0x19.
- A button on any spare GPIO (with interrupt); LED on a GPIO (or PWM).
- Power: LiPo → VIN; a 3.3 V LDO → VCC. Keep VIN ≥ 3.3 V for cellular compliance, and add bulk capacitance for TX bursts.
- Use the SnapEDA symbol/footprint (link above) so you don't draw the 42-pin part by hand.
