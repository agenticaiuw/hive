#pragma once

// Watches the human's physical input devices and reports any activity.
//
// - Keyboards and mice: IOHIDManager, reading values straight from each device.
//   Karabiner's virtual devices (manufacturer "pqrs.org") are ignored, so the
//   agent's own input never counts as the human.
// - Trackpads (built-in and Magic Trackpad): the private MultitouchSupport
//   framework, which reports a finger the moment it touches, before the cursor moves.
//
// It also follows fn (the 🌐 key) on its own: a tap turns the voice agent's listening on and
// off, and holding it down dictates. fn by itself doesn't count as the human taking over, so
// neither pauses a task.

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

// fn on its own. Pressed and let go quickly is a tap; held longer, it's a hold that ends when it's
// let go. With another key or button pressed while it's down (fn+arrow, fn+delete, fn+F1, a
// click) it's a shortcut instead, and neither.
class fn_key final {
public:
  using clock = std::chrono::steady_clock;

  explicit fn_key(clock::duration longest_tap) : longest_tap_(longest_tap) {}

  // fn went down or up: "down", then "tap" or "up"; "" for nothing new (a repeat).
  const char* key(bool down, clock::time_point now) {
    if (down) {
      if (pressed_) {
        return "";
      }
      pressed_ = true;
      shortcut_ = false;
      press_time_ = now;
      return "down";
    }
    if (!std::exchange(pressed_, false)) {
      return "";
    }
    return !shortcut_ && now - press_time_ <= longest_tap_ ? "tap" : "up";
  }

  // Something else was pressed: "other" the first time while fn is down.
  const char* other() {
    if (!pressed_ || std::exchange(shortcut_, true)) {
      return "";
    }
    return "other";
  }

private:
  clock::duration longest_tap_;
  bool pressed_ = false;
  bool shortcut_ = false;
  clock::time_point press_time_;
};

class watcher final {
public:
  using human_input_callback = std::function<void(const std::string& source)>;
  using fn_callback = std::function<void(const std::string& what)>; // down, tap, up or other

  watcher(human_input_callback on_human_input, fn_callback on_fn, bool verbose)
      : on_human_input_(std::move(on_human_input)),
        on_fn_(std::move(on_fn)),
        verbose_(verbose),
        fn_(std::chrono::milliseconds(400)) {
    instance_ = this;
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
      std::cerr << "[watch] Input Monitoring is not allowed for this helper: started by the Mac (./install.sh),\n"
                << "[watch] that's /Library/PrivilegedHelperTools/agent-vhid-helper; started by ./run.sh, it's the\n"
                << "[watch] app it runs in (Terminal, iTerm, ...). Allow it in System Settings > Privacy & Security >\n"
                << "[watch] Input Monitoring (add it with + if it isn't listed), then restart it.\n";
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
      case kHIDPage_KeyboardOrKeypad:
        if (usage < kHIDUsage_KeyboardA || usage > kHIDUsage_KeyboardRightGUI) {
          return;
        }
        source = "keyboard";
        break;
      case kHIDPage_Consumer:
        source = "keyboard";
        break;
      case 0xff:   // Apple vendor top case: the built-in keyboard's fn
      case 0xff01: // Apple vendor keyboard: a Magic Keyboard's fn
        if (usage == 0x03) {
          self->fn(self->fn_.key(integer != 0, std::chrono::steady_clock::now()));
        }
        return; // fn on its own isn't the human taking over
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
    if (page != kHIDPage_GenericDesktop) {
      self->fn(self->fn_.other()); // fn+key, fn+click
    }
    if (self->verbose_) {
      std::cerr << "[watch] " << source << " input from " << i.name
                << " (page 0x" << std::hex << page << " usage 0x" << usage << std::dec << ")" << std::endl;
    }
    self->on_human_input_(source);
  }

  void fn(const std::string& what) {
    if (what.empty()) {
      return;
    }
    if (verbose_) {
      std::cerr << "[watch] fn " << what << std::endl;
    }
    on_fn_(what);
  }

  static int touch_frame(void*, void*, int touches, double, int) {
    auto self = instance_.load();
    if (touches > 0 && self) {
      self->on_human_input_("trackpad");
    }
    return 0;
  }

  human_input_callback on_human_input_;
  fn_callback on_fn_;
  bool verbose_;
  fn_key fn_;
  IOHIDManagerRef manager_ = nullptr;
  CFArrayRef trackpads_ = nullptr;
  std::mutex devices_mutex_;
  std::unordered_map<IOHIDDeviceRef, device_info> devices_;

  static inline std::atomic<watcher*> instance_ = nullptr;
};

} // namespace agent_vhid
