// agent-vhid-helper: lets an agent drive this Mac through Karabiner's virtual
// HID keyboard and mouse, and hands control back the instant the human touches
// a real key, trackpad, or mouse.

#include "gate.hpp"
#include "injector.hpp"
#include "server.hpp"
#include "watcher.hpp"
#include <csignal>
#include <cstdlib>
#include <iostream>
#include <spawn.h>
#include <string>

extern char** environ;

namespace {

std::atomic<bool> stop_requested = false;

struct options {
  std::string socket_path = "/tmp/agent-vhid.sock";
  bool dry_run = false;
  bool no_watch = false;
  bool start_engaged = false;
  bool sound = true;
  bool verbose = false;
  int quiet_ms = 400;
};

void usage() {
  std::cerr << "usage: sudo agent-vhid-helper [options]\n"
               "  --socket PATH     socket the agent connects to (default /tmp/agent-vhid.sock)\n"
               "  --start-engaged   start with the agent in control instead of waiting for the gesture\n"
               "  --quiet-ms N      how long your hands must be off before the agent takes over (default 400)\n"
               "  --no-sound        no chime on engage/disengage\n"
               "  --verbose         log every physical input event\n"
               "  --dry-run         no root, no virtual devices: log reports instead (for testing)\n"
               "  --no-watch        with --dry-run only: skip watching real input devices\n";
}

bool parse(int argc, char** argv, options& o) {
  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    if (a == "--socket" && i + 1 < argc) {
      o.socket_path = argv[++i];
    } else if (a == "--quiet-ms" && i + 1 < argc) {
      o.quiet_ms = std::atoi(argv[++i]);
    } else if (a == "--dry-run") {
      o.dry_run = true;
    } else if (a == "--no-watch") {
      o.no_watch = true;
    } else if (a == "--start-engaged") {
      o.start_engaged = true;
    } else if (a == "--no-sound") {
      o.sound = false;
    } else if (a == "--verbose") {
      o.verbose = true;
    } else {
      return false;
    }
  }
  if (o.no_watch && !o.dry_run) {
    std::cerr << "--no-watch is only allowed with --dry-run: without the watcher you could not take control back\n";
    return false;
  }
  return true;
}

void play(const char* sound) {
  std::string path = std::string("/System/Library/Sounds/") + sound + ".aiff";
  const char* args[] = {"/usr/bin/afplay", path.c_str(), nullptr};
  pid_t pid;
  posix_spawn(&pid, args[0], nullptr, nullptr, const_cast<char**>(args), environ);
}

int run(const options& o, uid_t owner_uid, gid_t owner_gid);

} // namespace

int main(int argc, char** argv) {
  options o;
  if (!parse(argc, argv, o)) {
    usage();
    return 64;
  }
  if (!o.dry_run && geteuid() != 0) {
    std::cerr << "agent-vhid-helper must run as root (Karabiner's virtual devices only accept root clients).\n"
                 "Run it with sudo, or use --dry-run to test without root.\n";
    return 1;
  }

  // The socket belongs to whoever ran sudo, so the agent can connect without root.
  uid_t owner_uid = getuid();
  gid_t owner_gid = getgid();
  if (geteuid() == 0) {
    if (auto sudo_uid = std::getenv("SUDO_UID")) {
      owner_uid = static_cast<uid_t>(std::strtoul(sudo_uid, nullptr, 10));
    }
    if (auto sudo_gid = std::getenv("SUDO_GID")) {
      owner_gid = static_cast<gid_t>(std::strtoul(sudo_gid, nullptr, 10));
    }
  }

  std::signal(SIGPIPE, SIG_IGN);
  std::signal(SIGCHLD, SIG_IGN); // afplay children reap themselves
  std::signal(SIGINT, [](int) { stop_requested = true; });
  std::signal(SIGTERM, [](int) { stop_requested = true; });

  pqrs::dispatcher::extra::initialize_shared_dispatcher();
  int code = run(o, owner_uid, owner_gid);
  pqrs::dispatcher::extra::terminate_shared_dispatcher();
  return code;
}

namespace {

int run(const options& o, uid_t owner_uid, gid_t owner_gid) {
  using namespace agent_vhid;
  {
    std::unique_ptr<injector> inj;
    if (o.dry_run) {
      inj = std::make_unique<dry_run_injector>(o.verbose);
    } else {
      inj = std::make_unique<karabiner_injector>();
    }

    gate g(
        o.start_engaged,
        std::chrono::milliseconds(o.quiet_ms),
        [&inj] { inj->release_all(); },
        [&o](gate::state s) {
          std::cerr << "[gate] " << gate::name(s) << std::endl;
          if (o.sound && s == gate::state::engaged) {
            play("Glass");
          } else if (o.sound && s == gate::state::disengaged) {
            play("Funk");
          }
        });

    watcher w(
        [&g](const std::string& source) { g.human_input(source); },
        [&g] { g.engage_gesture(); },
        [&g](bool down) { g.talk(down); },
        o.verbose);

    std::string watch_status = "watch=off";
    if (!o.no_watch) {
      bool hid_ok = w.start_hid(CFRunLoopGetMain());
      int trackpads = w.start_trackpads();
      watch_status = std::string("watch=") + (hid_ok ? "ok" : "failed") + " trackpads=" + std::to_string(trackpads);

      if (!hid_ok && !o.dry_run) {
        std::cerr << "Refusing to start: without keyboard/mouse monitoring you could not take control back.\n";
        return 2;
      }
      if (trackpads == 0) {
        std::cerr << "[watch] no trackpad found: touches won't disengage the agent (keys and mice still will)\n";
      }
    }

    server srv(o.socket_path, owner_uid, owner_gid, g, *inj, o.dry_run, [&watch_status] { return watch_status; });
    if (!srv.start()) {
      return 1;
    }

    std::cerr << "agent-vhid-helper listening on " << o.socket_path
              << (o.dry_run ? " (dry run)" : "") << "\n"
              << "Karabiner client protocol " << pqrs::karabiner::driverkit::client_protocol_version::embedded_client_protocol_version
              << "\n\n"
              << "  Double-tap Right Option to hand control to the agent.\n"
              << "  Hold Right Option and speak to give the voice agent a task.\n"
              << "  Touch any key, the trackpad, or the mouse to take it back.\n"
              << "  Ctrl-C to quit.\n"
              << std::endl;

    // Drives the arming timeout and the talk hold, and notices Ctrl-C. IOHIDManager callbacks run on this loop too.
    gate* gp = &g; // blocks copy C++ objects, so capture pointers
    watcher* wp = &w;
    CFRunLoopTimerRef timer = CFRunLoopTimerCreateWithHandler(
        kCFAllocatorDefault, CFAbsoluteTimeGetCurrent(), 0.05, 0, 0, ^(CFRunLoopTimerRef) {
          gp->tick();
          wp->tick();
          if (stop_requested) {
            CFRunLoopStop(CFRunLoopGetMain());
          }
        });
    CFRunLoopAddTimer(CFRunLoopGetMain(), timer, kCFRunLoopDefaultMode);
    CFRunLoopRun();
    CFRunLoopTimerInvalidate(timer);
    CFRelease(timer);

    std::cerr << "shutting down" << std::endl;
    srv.stop();
    inj->release_all();
    std::this_thread::sleep_for(std::chrono::milliseconds(200)); // let the release reports flush
  }
  return 0;
}

} // namespace
