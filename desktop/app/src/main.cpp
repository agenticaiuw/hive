// agent-vhid-helper: lets an agent drive this Mac through Karabiner's virtual
// HID keyboard and mouse, and hands control back the instant the human touches
// a real key, trackpad, or mouse.

#include "gate.hpp"
#include "injector.hpp"
#include "server.hpp"
#include "watcher.hpp"
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <fcntl.h>
#include <iostream>
#include <pwd.h>
#include <spawn.h>
#include <string>
#include <unistd.h>

extern char** environ;

namespace {

std::atomic<bool> stop_requested = false;

struct options {
  std::string socket_path = "/tmp/agent-vhid.sock";
  bool dry_run = false;
  bool no_watch = false;
  bool start_engaged = false;
  bool sound = true;
  std::string sound_setting; // Hive's sound switch; default: the owner's state folder
  bool verbose = false;
  std::string user; // owns the socket; default: whoever ran sudo
  int quiet_ms = 400;
};

void usage() {
  std::cerr << "usage: sudo agent-vhid-helper [options]\n"
               "  --socket PATH     socket the agent connects to (default /tmp/agent-vhid.sock)\n"
               "  --user NAME       the user whose agent may connect (default: whoever ran sudo; launchd\n"
               "                    has no sudo, so install.sh passes it)\n"
               "  --start-engaged   start with the agent in control instead of waiting for it to ask\n"
               "  --quiet-ms N      how long your hands must be off before the agent takes over (default 400)\n"
               "  --no-sound        no chime on engage/disengage\n"
               "  --sound-setting F Hive's sound switch: no chime while F says off (default: speak-aloud in\n"
               "                    the owner's ~/Library/Application Support/Personal Agent)\n"
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
    } else if (a == "--sound-setting" && i + 1 < argc) {
      o.sound_setting = argv[++i];
    } else if (a == "--verbose") {
      o.verbose = true;
    } else if (a == "--user" && i + 1 < argc) {
      o.user = argv[++i];
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

// Hive's sound switch (the Agent menu's Sound: Voice and Chimes, kept as "on"/"off" in its state
// folder) is read at each chime, so turning it off silences the chimes at once, as it does the
// voice. A missing or unreadable file is on, as it is for Hive.
bool sound_on(const std::string& setting) {
  if (setting.empty()) {
    return true;
  }
  int fd = open(setting.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) {
    return true;
  }
  char text[16] = {0};
  ssize_t n = read(fd, text, sizeof(text) - 1);
  close(fd);
  std::string word(text, n > 0 ? static_cast<size_t>(n) : 0);
  word.erase(0, word.find_first_not_of(" \t\r\n"));
  word.erase(word.find_last_not_of(" \t\r\n") + 1);
  return word != "off";
}

void play(const char* sound) {
  std::string path = std::string("/System/Library/Sounds/") + sound + ".aiff";
  const char* args[] = {"/usr/bin/afplay", path.c_str(), nullptr};
  pid_t pid;
  posix_spawn(&pid, args[0], nullptr, nullptr, const_cast<char**>(args), environ);
}

// Karabiner's package leaves starting its daemon to you, and macOS doesn't always load its launch
// daemon at boot (it has no RunAtLoad). This helper does start at boot, so it loads the daemon
// whenever the virtual keyboard and mouse aren't ready. (Already loaded: launchctl just says so.)
void load_karabiner_daemon(bool say) {
  static const char* plist = "/Library/LaunchDaemons/org.pqrs.service.daemon.Karabiner-VirtualHIDDevice-Daemon.plist";
  if (access(plist, R_OK) != 0) {
    return;
  }
  if (say) {
    std::cerr << "[vhid] not ready: loading Karabiner's daemon" << std::endl;
  }
  posix_spawn_file_actions_t quiet;
  posix_spawn_file_actions_init(&quiet);
  posix_spawn_file_actions_addopen(&quiet, 1, "/dev/null", O_WRONLY, 0);
  posix_spawn_file_actions_addopen(&quiet, 2, "/dev/null", O_WRONLY, 0);
  const char* args[] = {"/bin/launchctl", "bootstrap", "system", plist, nullptr};
  pid_t pid;
  posix_spawn(&pid, args[0], &quiet, nullptr, const_cast<char**>(args), environ);
  posix_spawn_file_actions_destroy(&quiet);
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

  // The socket belongs to whoever ran sudo (or --user), so the agent can connect without root.
  uid_t owner_uid = getuid();
  gid_t owner_gid = getgid();
  if (!o.user.empty()) {
    auto pw = getpwnam(o.user.c_str());
    if (!pw) {
      std::cerr << "no such user: " << o.user << "\n";
      return 64;
    }
    owner_uid = pw->pw_uid;
    owner_gid = pw->pw_gid;
  } else if (geteuid() == 0) {
    if (auto sudo_uid = std::getenv("SUDO_UID")) {
      owner_uid = static_cast<uid_t>(std::strtoul(sudo_uid, nullptr, 10));
    }
    if (auto sudo_gid = std::getenv("SUDO_GID")) {
      owner_gid = static_cast<gid_t>(std::strtoul(sudo_gid, nullptr, 10));
    }
  }

  if (o.sound_setting.empty()) {
    if (auto pw = getpwuid(owner_uid); pw && pw->pw_dir) {
      o.sound_setting = std::string(pw->pw_dir) + "/Library/Application Support/Personal Agent/speak-aloud";
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
      load_karabiner_daemon(false);
      inj = std::make_unique<karabiner_injector>();
    }

    gate g(
        o.start_engaged,
        std::chrono::milliseconds(o.quiet_ms),
        [&inj] { inj->release_all(); },
        [&o](gate::state s) {
          std::cerr << "[gate] " << gate::name(s) << std::endl;
          const char* chime = s == gate::state::engaged      ? "Glass"
                              : s == gate::state::disengaged ? "Funk"
                                                             : nullptr;
          if (!chime || !o.sound) {
            return;
          }
          if (!sound_on(o.sound_setting)) {
            if (o.verbose) {
              std::cerr << "[sound] muted: " << chime << std::endl;
            }
          } else if (o.dry_run) {
            std::cerr << "[sound] " << chime << std::endl; // a dry run says it instead of playing it
          } else {
            play(chime);
          }
        });
    watcher w(
        [&g](const std::string& source) { g.human_input(source); },
        [&g](const std::string& what) { g.fn(what); },
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
              << "  Tap fn to have the voice agent listen, and again to stop it.\n"
              << "  Hold fn and talk to type what you say into the app in front.\n"
              << "  The agent takes the mouse and keyboard for a task you give it;\n"
              << "  touch any key, the trackpad, or the mouse to take them back.\n"
              << "  Ctrl-C to quit.\n"
              << std::endl;

    // Drives the arming timeout and notices Ctrl-C. IOHIDManager callbacks run on this loop too.
    gate* gp = &g; // blocks copy C++ objects, so capture pointers
    injector* ip = inj.get();
    bool dry_run = o.dry_run;
    __block auto next_load = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    __block bool said = false;
    CFRunLoopTimerRef timer = CFRunLoopTimerCreateWithHandler(
        kCFAllocatorDefault, CFAbsoluteTimeGetCurrent(), 0.05, 0, 0, ^(CFRunLoopTimerRef) {
          gp->tick();
          if (!dry_run && !ip->ready() && std::chrono::steady_clock::now() >= next_load) {
            load_karabiner_daemon(!said);  // (every 10 s while it isn't ready; says so once)
            said = true;
            next_load = std::chrono::steady_clock::now() + std::chrono::seconds(10);
          }
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
