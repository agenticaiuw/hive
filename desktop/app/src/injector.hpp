#pragma once

// Sends keyboard and mouse reports to Karabiner's virtual HID devices.
// macOS sees these devices as real hardware, so the input goes through the
// same path as a physical keyboard and mouse.

#include <atomic>
#include <cstdint>
#include <filesystem> // needed by Karabiner's headers
#include <iostream>
#include <memory>
#include <mutex>
#include <pqrs/karabiner/driverkit/virtual_hid_device_driver.hpp>
#include <pqrs/karabiner/driverkit/virtual_hid_device_service.hpp>
#include <sstream>
#include <string>
#include <vector>

namespace agent_vhid {

namespace hid_report = pqrs::karabiner::driverkit::virtual_hid_device_driver::hid_report;
namespace vhid_service = pqrs::karabiner::driverkit::virtual_hid_device_service;

class injector {
public:
  virtual ~injector() = default;

  virtual bool ready() const = 0;
  virtual std::string describe() const = 0;

  // Relative pointer motion in HID counts, plus wheel detents.
  // Values outside int8 range are split into several reports.
  void pointing(int dx, int dy, int vertical_wheel, int horizontal_wheel) {
    std::lock_guard<std::mutex> lock(mutex_);

    do {
      int step_x = clamp_int8(dx);
      int step_y = clamp_int8(dy);
      int step_v = clamp_int8(vertical_wheel);
      int step_h = clamp_int8(horizontal_wheel);

      hid_report::pointing_input report;
      report.buttons = buttons_;
      report.x = static_cast<uint8_t>(static_cast<int8_t>(step_x));
      report.y = static_cast<uint8_t>(static_cast<int8_t>(step_y));
      report.vertical_wheel = static_cast<uint8_t>(static_cast<int8_t>(step_v));
      report.horizontal_wheel = static_cast<uint8_t>(static_cast<int8_t>(step_h));
      post(report);

      dx -= step_x;
      dy -= step_y;
      vertical_wheel -= step_v;
      horizontal_wheel -= step_h;
    } while (dx != 0 || dy != 0 || vertical_wheel != 0 || horizontal_wheel != 0);
  }

  // Sets which mouse buttons are held (bit 0 = left, bit 1 = right, bit 2 = middle).
  void set_buttons(uint32_t mask) {
    std::lock_guard<std::mutex> lock(mutex_);

    buttons_.clear();
    for (uint8_t button = 1; button <= 32; ++button) {
      if (mask & (1u << (button - 1))) {
        buttons_.insert(button);
      }
    }

    hid_report::pointing_input report;
    report.buttons = buttons_;
    post(report);
  }

  // Sets the full keyboard state: modifier bits plus every keyboard-page usage held down.
  void set_keys(uint8_t modifiers, const std::vector<uint16_t>& usages) {
    std::lock_guard<std::mutex> lock(mutex_);

    hid_report::keyboard_input report;
    for (uint8_t bit = 0; bit < 8; ++bit) {
      if (modifiers & (1u << bit)) {
        report.modifiers.insert(static_cast<hid_report::modifier>(1u << bit));
      }
    }
    for (auto usage : usages) {
      report.keys.insert(usage);
    }
    post(report);
  }

  // Lets go of every key and button. Called when the human takes over.
  void release_all() {
    std::lock_guard<std::mutex> lock(mutex_);

    buttons_.clear();
    post(hid_report::keyboard_input());
    post(hid_report::pointing_input());
  }

protected:
  virtual void post(const hid_report::keyboard_input& report) = 0;
  virtual void post(const hid_report::pointing_input& report) = 0;

private:
  static int clamp_int8(int value) {
    return std::max(-127, std::min(127, value));
  }

  std::mutex mutex_;
  hid_report::buttons buttons_;
};

// Talks to Karabiner-VirtualHIDDevice-Daemon. Must run as root.
class karabiner_injector final : public injector {
public:
  karabiner_injector() {
    client_ = std::make_unique<vhid_service::client>();

    client_->connected.connect([this] {
      log("connected to Karabiner-VirtualHIDDevice-Daemon");
      vhid_service::virtual_hid_keyboard_parameters parameters;
      parameters.set_country_code(pqrs::hid::country_code::us);
      client_->async_virtual_hid_keyboard_initialize(parameters);
      client_->async_virtual_hid_pointing_initialize();
    });
    client_->connect_failed.connect([this](auto&& error_code) {
      if (!connect_failed_logged_.exchange(true)) {
        // Normal for a moment when run.sh starts the daemon and helper together.
        log("waiting for Karabiner-VirtualHIDDevice-Daemon (" + error_code.message() +
            "); retrying every second. If this never connects, start the daemon as root.");
      }
    });
    client_->closed.connect([this] {
      keyboard_ready_ = false;
      pointing_ready_ = false;
      log("connection to the daemon closed; reconnecting");
    });
    client_->error_occurred.connect([](auto&& error_code) {
      log("daemon error: " + error_code.message());
    });
    client_->warning_reported.connect([](auto&& message) {
      log("daemon warning: " + message);
    });
    client_->driver_activated.connect([this](bool value) {
      driver_activated_ = value;
    });
    client_->driver_connected.connect([this](bool value) {
      driver_connected_ = value;
    });
    client_->driver_version_mismatched.connect([this](bool value) {
      if (value && !driver_version_mismatched_) {
        log("driver version mismatch: rebuild against the headers matching the installed daemon");
      }
      driver_version_mismatched_ = value;
    });
    client_->virtual_hid_keyboard_ready.connect([this](bool value) {
      if (value && !keyboard_ready_) {
        log("virtual keyboard ready");
      }
      keyboard_ready_ = value;
    });
    client_->virtual_hid_pointing_ready.connect([this](bool value) {
      if (value && !pointing_ready_) {
        log("virtual mouse ready");
      }
      pointing_ready_ = value;
    });

    client_->async_start();
  }

  ~karabiner_injector() override {
    client_ = nullptr;
  }

  bool ready() const override {
    return keyboard_ready_ && pointing_ready_;
  }

  std::string describe() const override {
    std::ostringstream s;
    s << "vhid=" << (ready() ? "ready" : "not_ready")
      << " keyboard=" << keyboard_ready_.load()
      << " mouse=" << pointing_ready_.load()
      << " driver_activated=" << driver_activated_.load()
      << " driver_connected=" << driver_connected_.load()
      << " driver_version_mismatched=" << driver_version_mismatched_.load();
    return s.str();
  }

protected:
  void post(const hid_report::keyboard_input& report) override {
    if (client_) {
      client_->async_post_report(report);
    }
  }

  void post(const hid_report::pointing_input& report) override {
    if (client_) {
      client_->async_post_report(report);
    }
  }

private:
  static void log(const std::string& message) {
    std::cerr << "[vhid] " << message << std::endl;
  }

  std::unique_ptr<vhid_service::client> client_;
  std::atomic<bool> keyboard_ready_ = false;
  std::atomic<bool> pointing_ready_ = false;
  std::atomic<bool> driver_activated_ = false;
  std::atomic<bool> driver_connected_ = false;
  std::atomic<bool> driver_version_mismatched_ = false;
  std::atomic<bool> connect_failed_logged_ = false;
};

// Logs reports instead of sending them. For testing without root.
class dry_run_injector final : public injector {
public:
  explicit dry_run_injector(bool verbose) : verbose_(verbose) {}

  bool ready() const override { return true; }
  std::string describe() const override { return "vhid=dry_run"; }

protected:
  void post(const hid_report::keyboard_input& report) override {
    if (verbose_) {
      std::ostringstream s;
      s << "[dry-run] keyboard mods=0x" << std::hex << int(report.modifiers.get_raw_value()) << " keys=";
      for (auto key : report.keys.get_raw_value()) {
        if (key) {
          s << " 0x" << std::hex << key;
        }
      }
      std::cerr << s.str() << std::endl;
    }
  }

  void post(const hid_report::pointing_input& report) override {
    if (verbose_) {
      std::cerr << "[dry-run] pointing buttons=" << report.buttons.get_raw_value()
                << " x=" << int(static_cast<int8_t>(report.x))
                << " y=" << int(static_cast<int8_t>(report.y))
                << " wheel=" << int(static_cast<int8_t>(report.vertical_wheel))
                << "," << int(static_cast<int8_t>(report.horizontal_wheel)) << std::endl;
    }
  }

private:
  bool verbose_;
};

} // namespace agent_vhid
