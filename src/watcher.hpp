#pragma once

// Watches the human's physical input devices and reports any activity.
//
// - Keyboards and mice: IOHIDManager, reading values straight from each device.
//   Karabiner's virtual devices (manufacturer "pqrs.org") are ignored, so the
//   agent's own input never counts as the human.
// - Trackpads (built-in and Magic Trackpad): the private MultitouchSupport
//   framework, which reports a finger the moment it touches, before the cursor moves.
//
// It also recognizes two gestures on Right Option:
//   double-tap: hand control to the agent
//   hold:       talk to the voice agent (reported on press and on release)

#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/hid/IOHIDKeys.h>
#include <IOKit/hid/IOHIDManager.h>
#include <IOKit/hidsystem/IOHIDLib.h>
#include <atomic>
#include <chrono>
#include <dlfcn.h>
#include <functional>
#include <iostream>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>

namespace agent_vhid {

// Double-tap of a single key with nothing else pressed in between.
class double_tap_detector final {
public:
  using clock = std::chrono::steady_clock;

  explicit double_tap_detector(uint32_t usage) : usage_(usage) {}

  // Returns true when this key event completes a double tap.
  bool feed(uint32_t usage, bool down, clock::time_point now) {
    using namespace std::chrono_literals;

    if (usage != usage_) {
      if (down) {
        taps_ = 0;
        pressed_ = false;
      }
      return false;
    }

    if (down) {
      if (taps_ == 1 && now - last_release_ > 400ms) {
        taps_ = 0;
      }
      pressed_ = true;
      press_time_ = now;
      return false;
    }

    if (!pressed_) {
      return false;
    }
    pressed_ = false;
    if (now - press_time_ > 350ms) {
      taps_ = 0; // held, not tapped
      return false;
    }
    last_release_ = now;
    if (++taps_ == 2) {
      taps_ = 0;
      return true;
    }
    return false;
  }

private:
  uint32_t usage_;
  int taps_ = 0;
  bool pressed_ = false;
  clock::time_point press_time_;
  clock::time_point last_release_;
};

// A single key held on its own. Reported once it has been down longer than any tap of the
// double-tap (so the two gestures never mix), and again when it is let go. Pressing another
// key first cancels it, so Option+key typing (é, ü, ...) never counts.
class hold_detector final {
public:
  using clock = std::chrono::steady_clock;

  hold_detector(uint32_t usage, clock::duration threshold) : usage_(usage), threshold_(threshold) {}

  // Returns true when this key event ends a hold that was already reported.
  bool feed(uint32_t usage, bool down, clock::time_point now) {
    if (usage != usage_) {
      if (down) {
        pending_ = false;
      }
      return false;
    }
    if (down) {
      pending_ = true;
      press_time_ = now;
      return false;
    }
    pending_ = false;
    return std::exchange(active_, false);
  }

  // Call periodically. Returns true once, when the key has been held long enough.
  bool poll(clock::time_point now) {
    if (pending_ && now - press_time_ >= threshold_) {
      pending_ = false;
      active_ = true;
      return true;
    }
    return false;
  }

private:
  uint32_t usage_;
  clock::duration threshold_;
  bool pending_ = false;
  bool active_ = false;
  clock::time_point press_time_;
};

class watcher final {
public:
  using human_input_callback = std::function<void(const std::string& source)>;
  using engage_callback = std::function<void()>;
  using talk_callback = std::function<void(bool down)>;

  static constexpr uint32_t right_option_usage = 0xe6;

  watcher(human_input_callback on_human_input, engage_callback on_engage, talk_callback on_talk, bool verbose)
      : on_human_input_(std::move(on_human_input)),
        on_engage_(std::move(on_engage)),
        on_talk_(std::move(on_talk)),
        verbose_(verbose),
        engage_detector_(right_option_usage),
        talk_detector_(right_option_usage, std::chrono::milliseconds(360)) {
    instance_ = this;
  }

  // Call periodically from the run loop the HID callbacks run on: reports a talk hold once it starts.
  void tick() {
    if (talk_detector_.poll(std::chrono::steady_clock::now())) {
      if (verbose_) {
        std::cerr << "[watch] talk gesture: down" << std::endl;
      }
      on_talk_(true);
    }
  }

  ~watcher() {
    if (manager_) {
      IOHIDManagerClose(manager_, kIOHIDOptionsTypeNone);
      CFRelease(manager_);
    }
    instance_ = nullptr;
  }

  // Starts watching keyboards and mice. Returns false if macOS denied Input Monitoring.
  bool start_hid(CFRunLoopRef run_loop) {
    auto access = IOHIDCheckAccess(kIOHIDRequestTypeListenEvent);
    if (access != kIOHIDAccessTypeGranted) {
      // Shows the system prompt the first time; afterwards the user must allow it in Settings.
      IOHIDRequestAccess(kIOHIDRequestTypeListenEvent);
      access = IOHIDCheckAccess(kIOHIDRequestTypeListenEvent);
    }
    if (access != kIOHIDAccessTypeGranted) {
      std::cerr << "[watch] Input Monitoring is not allowed for the app this runs in (Terminal, iTerm, ...).\n"
                << "[watch] Allow it in System Settings > Privacy & Security > Input Monitoring, then restart.\n";
      return false;
    }

    manager_ = IOHIDManagerCreate(kCFAllocatorDefault, kIOHIDOptionsTypeNone);

    CFMutableArrayRef matches = CFArrayCreateMutable(kCFAllocatorDefault, 0, &kCFTypeArrayCallBacks);
    const std::pair<int, int> usages[] = {
        {kHIDPage_GenericDesktop, kHIDUsage_GD_Keyboard},
        {kHIDPage_GenericDesktop, kHIDUsage_GD_Keypad},
        {kHIDPage_GenericDesktop, kHIDUsage_GD_Mouse},
        {kHIDPage_GenericDesktop, kHIDUsage_GD_Pointer},
        {kHIDPage_Consumer, kHIDUsage_Csmr_ConsumerControl},
    };
    for (auto [page, usage] : usages) {
      CFMutableDictionaryRef match = CFDictionaryCreateMutable(kCFAllocatorDefault, 0,
                                                               &kCFTypeDictionaryKeyCallBacks,
                                                               &kCFTypeDictionaryValueCallBacks);
      set_number(match, CFSTR(kIOHIDDeviceUsagePageKey), page);
      set_number(match, CFSTR(kIOHIDDeviceUsageKey), usage);
      CFArrayAppendValue(matches, match);
      CFRelease(match);
    }
    IOHIDManagerSetDeviceMatchingMultiple(manager_, matches);
    CFRelease(matches);

    IOHIDManagerRegisterDeviceMatchingCallback(manager_, device_matched, this);
    IOHIDManagerRegisterDeviceRemovalCallback(manager_, device_removed, this);
    IOHIDManagerRegisterInputValueCallback(manager_, input_value, this);
    IOHIDManagerScheduleWithRunLoop(manager_, run_loop, kCFRunLoopDefaultMode);

    auto result = IOHIDManagerOpen(manager_, kIOHIDOptionsTypeNone);
    if (result != kIOReturnSuccess) {
      std::cerr << "[watch] IOHIDManagerOpen failed: 0x" << std::hex << result << std::dec << std::endl;
      return false;
    }
    return true;
  }

  // Starts watching multitouch surfaces. Returns how many were found.
  int start_trackpads() {
    using device_ref = void*;
    using contact_callback = int (*)(device_ref, void*, int, double, int);

    void* framework = dlopen("/System/Library/PrivateFrameworks/MultitouchSupport.framework/MultitouchSupport", RTLD_NOW);
    if (!framework) {
      std::cerr << "[watch] MultitouchSupport not available: " << dlerror() << std::endl;
      return 0;
    }
    auto create_list = reinterpret_cast<CFArrayRef (*)()>(dlsym(framework, "MTDeviceCreateList"));
    auto register_callback = reinterpret_cast<void (*)(device_ref, contact_callback)>(dlsym(framework, "MTRegisterContactFrameCallback"));
    auto start = reinterpret_cast<int (*)(device_ref, int)>(dlsym(framework, "MTDeviceStart"));
    if (!create_list || !register_callback || !start) {
      std::cerr << "[watch] MultitouchSupport symbols missing" << std::endl;
      return 0;
    }

    // Kept for the life of the process; the framework holds the devices.
    trackpads_ = create_list();
    int count = trackpads_ ? static_cast<int>(CFArrayGetCount(trackpads_)) : 0;
    for (int i = 0; i < count; ++i) {
      auto device = const_cast<void*>(CFArrayGetValueAtIndex(trackpads_, i));
      register_callback(device, touch_frame);
      start(device, 0);
    }
    return count;
  }

private:
  static void set_number(CFMutableDictionaryRef dict, CFStringRef key, int value) {
    CFNumberRef number = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &value);
    CFDictionarySetValue(dict, key, number);
    CFRelease(number);
  }

  static std::string string_property(IOHIDDeviceRef device, CFStringRef key) {
    auto value = IOHIDDeviceGetProperty(device, key);
    if (!value || CFGetTypeID(value) != CFStringGetTypeID()) {
      return "";
    }
    char buffer[256] = {};
    CFStringGetCString(static_cast<CFStringRef>(value), buffer, sizeof(buffer), kCFStringEncodingUTF8);
    return buffer;
  }

  static bool is_agent_device(IOHIDDeviceRef device) {
    return string_property(device, CFSTR(kIOHIDManufacturerKey)) == "pqrs.org" ||
           string_property(device, CFSTR(kIOHIDProductKey)).find("Karabiner") != std::string::npos;
  }

  struct device_info {
    bool agent;
    std::string name;
  };

  const device_info& info(IOHIDDeviceRef device) {
    std::lock_guard<std::mutex> lock(devices_mutex_);
    auto it = devices_.find(device);
    if (it == devices_.end()) {
      auto product = string_property(device, CFSTR(kIOHIDProductKey));
      it = devices_.emplace(device, device_info{is_agent_device(device), product.empty() ? "unknown device" : product}).first;
    }
    return it->second;
  }

  static void device_matched(void* context, IOReturn, void*, IOHIDDeviceRef device) {
    auto self = static_cast<watcher*>(context);
    auto& i = self->info(device);
    std::cerr << "[watch] " << (i.agent ? "ignoring agent device: " : "watching: ") << i.name << std::endl;
  }

  static void device_removed(void* context, IOReturn, void*, IOHIDDeviceRef device) {
    auto self = static_cast<watcher*>(context);
    std::lock_guard<std::mutex> lock(self->devices_mutex_);
    self->devices_.erase(device);
  }

  static void input_value(void* context, IOReturn, void*, IOHIDValueRef value) {
    auto self = static_cast<watcher*>(context);
    auto element = IOHIDValueGetElement(value);
    auto device = IOHIDElementGetDevice(element);
    auto& i = self->info(device);
    if (i.agent) {
      return;
    }

    auto page = IOHIDElementGetUsagePage(element);
    auto usage = IOHIDElementGetUsage(element);
    auto integer = IOHIDValueGetIntegerValue(value);

    const char* source = nullptr;
    switch (page) {
      case kHIDPage_KeyboardOrKeypad: {
        if (usage < kHIDUsage_KeyboardA || usage > kHIDUsage_KeyboardRightGUI) {
          return;
        }
        auto now = std::chrono::steady_clock::now();
        if (self->talk_detector_.feed(usage, integer != 0, now)) {
          if (self->verbose_) {
            std::cerr << "[watch] talk gesture: up" << std::endl;
          }
          self->on_talk_(false);
        }
        if (self->engage_detector_.feed(usage, integer != 0, now)) {
          if (self->verbose_) {
            std::cerr << "[watch] engage gesture" << std::endl;
          }
          self->on_engage_();
          return;
        }
        source = "keyboard";
        break;
      }
      case kHIDPage_Consumer:
        source = "keyboard";
        break;
      case 0xff: // Apple vendor top case: the fn key
        if (usage != 0x03) {
          return;
        }
        source = "keyboard";
        break;
      case kHIDPage_Button:
        source = "mouse_button";
        break;
      case kHIDPage_GenericDesktop:
        if (usage != kHIDUsage_GD_X && usage != kHIDUsage_GD_Y && usage != kHIDUsage_GD_Wheel) {
          return;
        }
        source = "mouse";
        break;
      default:
        return;
    }

    // Key releases and zero deltas don't count; only something the human actively did.
    if (integer == 0) {
      return;
    }
    if (self->verbose_) {
      std::cerr << "[watch] " << source << " input from " << i.name
                << " (page 0x" << std::hex << page << " usage 0x" << usage << std::dec << ")" << std::endl;
    }
    self->on_human_input_(source);
  }

  static int touch_frame(void*, void*, int touches, double, int) {
    auto self = instance_.load();
    if (touches > 0 && self) {
      self->on_human_input_("trackpad");
    }
    return 0;
  }

  human_input_callback on_human_input_;
  engage_callback on_engage_;
  talk_callback on_talk_;
  bool verbose_;
  double_tap_detector engage_detector_;
  hold_detector talk_detector_;
  IOHIDManagerRef manager_ = nullptr;
  CFArrayRef trackpads_ = nullptr;
  std::mutex devices_mutex_;
  std::unordered_map<IOHIDDeviceRef, device_info> devices_;

  static inline std::atomic<watcher*> instance_ = nullptr;
};

} // namespace agent_vhid
