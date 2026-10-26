#pragma once

// Unix-socket server the agent talks to. One request per line, one reply per line.
//
//   ping                       -> ok pong
//   status                     -> ok state=... reason=... vhid=... watch=...
//   move DX DY                 -> relative mouse motion in HID counts
//   scroll V H                 -> wheel detents (V > 0 is away from the user)
//   buttons MASK               -> held mouse buttons (1 = left, 2 = right, 4 = middle)
//   keys MODS [USAGE ...]      -> full keyboard state: modifier bits + keyboard-page usages held
//   release                    -> let go of every key and button (always allowed)
//   disengage                  -> the agent is done: hand control back (always allowed)
//   engage_after_talk          -> start handing control over, allowed once per talk hold (hold Right Option)
//   engage_by_voice            -> start handing control over for a spoken task; only with --hands-free
//   watch                      -> stream "event state=... reason=..." and "event talk=down|up" lines
//                                 until the client closes
//
// Input commands reply "err disengaged <reason>" while the human has control.
// With --dry-run, three extra commands simulate the human: "human SOURCE", "engage" (the
// double-tap) and "talk down|up" (holding and letting go of Right Option).
//
// Only the user who started the helper (and root) may connect.

#include "gate.hpp"
#include "injector.hpp"
#include <atomic>
#include <cerrno>
#include <cstring>
#include <functional>
#include <iostream>
#include <sstream>
#include <string>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <thread>
#include <unistd.h>
#include <vector>

namespace agent_vhid {

class server final {
public:
  server(std::string path, uid_t owner_uid, gid_t owner_gid, gate& gate, injector& injector, bool dry_run,
         std::function<std::string()> watch_status)
      : path_(std::move(path)),
        owner_uid_(owner_uid),
        owner_gid_(owner_gid),
        gate_(gate),
        injector_(injector),
        dry_run_(dry_run),
        watch_status_(std::move(watch_status)) {}

  ~server() { stop(); }

  bool start() {
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    if (path_.size() >= sizeof(address.sun_path)) {
      std::cerr << "[server] socket path too long: " << path_ << std::endl;
      return false;
    }
    std::strncpy(address.sun_path, path_.c_str(), sizeof(address.sun_path) - 1);

    struct stat existing{};
    if (lstat(path_.c_str(), &existing) == 0) {
      if (!S_ISSOCK(existing.st_mode)) {
        std::cerr << "[server] " << path_ << " exists and is not a socket; refusing to replace it" << std::endl;
        return false;
      }
      unlink(path_.c_str());
    }

    listen_fd_ = socket(AF_UNIX, SOCK_STREAM, 0);
    if (listen_fd_ < 0) {
      std::cerr << "[server] socket: " << std::strerror(errno) << std::endl;
      return false;
    }

    // Create the socket file with no access, then hand it to the owner.
    auto old_umask = umask(0177);
    int bound = bind(listen_fd_, reinterpret_cast<sockaddr*>(&address), sizeof(address));
    umask(old_umask);
    if (bound != 0) {
      std::cerr << "[server] bind " << path_ << ": " << std::strerror(errno) << std::endl;
      return false;
    }
    if (chown(path_.c_str(), owner_uid_, owner_gid_) != 0 || chmod(path_.c_str(), 0600) != 0) {
      std::cerr << "[server] cannot set socket owner: " << std::strerror(errno) << std::endl;
      return false;
    }
    if (listen(listen_fd_, 16) != 0) {
      std::cerr << "[server] listen: " << std::strerror(errno) << std::endl;
      return false;
    }

    accept_thread_ = std::thread([this] { accept_loop(); });
    return true;
  }

  void stop() {
    if (stopping_.exchange(true)) {
      return;
    }
    if (listen_fd_ >= 0) {
      shutdown(listen_fd_, SHUT_RDWR);
      close(listen_fd_);
      unlink(path_.c_str());
    }
    if (accept_thread_.joinable()) {
      accept_thread_.join();
    }
  }

private:
  void accept_loop() {
    while (!stopping_) {
      int fd = accept(listen_fd_, nullptr, nullptr);
      if (fd < 0) {
        if (errno == EINTR) {
          continue;
        }
        return;
      }

      uid_t peer_uid = 0;
      gid_t peer_gid = 0;
      if (getpeereid(fd, &peer_uid, &peer_gid) != 0 || (peer_uid != owner_uid_ && peer_uid != 0)) {
        close(fd);
        continue;
      }
      int one = 1;
      setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));

      std::thread([this, fd] { handle(fd); }).detach();
    }
  }

  static bool send_all(int fd, const std::string& data, int flags = 0) {
    size_t sent = 0;
    while (sent < data.size()) {
      auto n = send(fd, data.data() + sent, data.size() - sent, flags);
      if (n <= 0) {
        if (n < 0 && errno == EINTR) {
          continue;
        }
        return false;
      }
      sent += static_cast<size_t>(n);
    }
    return true;
  }

  void handle(int fd) {
    bool sent_input = false;
    std::string buffer;
    char chunk[4096];

    while (true) {
      auto n = recv(fd, chunk, sizeof(chunk), 0);
      if (n <= 0) {
        break;
      }
      buffer.append(chunk, static_cast<size_t>(n));
      if (buffer.size() > 65536) {
        break;
      }

      size_t newline;
      while ((newline = buffer.find('\n')) != std::string::npos) {
        auto line = buffer.substr(0, newline);
        buffer.erase(0, newline + 1);
        if (!line.empty() && line.back() == '\r') {
          line.pop_back();
        }

        if (line == "watch") {
          watch(fd);
          close(fd);
          return;
        }
        if (!send_all(fd, execute(line, sent_input) + "\n")) {
          goto done;
        }
      }
    }

  done:
    // Never leave a key or button held by a client that went away.
    if (sent_input) {
      injector_.release_all();
    }
    close(fd);
  }

  void watch(int fd) {
    send_all(fd, "ok watching\nevent " + gate_.describe() + "\n");
    // Non-blocking so a slow reader can never stall the gate.
    int id = gate_.subscribe([fd](const std::string& line) {
      send_all(fd, line + "\n", MSG_DONTWAIT);
    });
    char chunk[256];
    while (recv(fd, chunk, sizeof(chunk), 0) > 0) {
    }
    gate_.unsubscribe(id);
  }

  std::string execute(const std::string& line, bool& sent_input) {
    std::istringstream in(line);
    std::string command;
    in >> command;

    if (command.empty()) {
      return "err bad_request empty";
    }
    if (command == "ping") {
      return "ok pong";
    }
    if (command == "status") {
      return "ok " + gate_.describe() + " " + injector_.describe() + " " + watch_status_() +
             " dry_run=" + (dry_run_ ? "1" : "0") + " talk=1 hands_free=" + (gate_.hands_free() ? "1" : "0");
    }
    if (command == "release") {
      injector_.release_all();
      return "ok";
    }
    if (command == "disengage") {
      gate_.release_control();
      return "ok";
    }
    if (command == "engage_after_talk") {
      if (!gate_.engage_after_talk()) {
        return "err forbidden no talk hold in the last " + std::to_string(gate::talk_grant.count()) +
               " s; double-tap Right Option instead";
      }
      return "ok";
    }
    if (command == "engage_by_voice") {
      if (!gate_.engage_by_voice()) {
        return std::string("err forbidden ") + (gate_.hands_free() ? "the safety watcher isn't working"
                                                                   : "the helper wasn't started with --hands-free") +
               "; double-tap Right Option instead";
      }
      return "ok";
    }
    if (dry_run_ && command == "human") {
      std::string source = "simulated";
      in >> source;
      gate_.human_input(source);
      return "ok";
    }
    if (dry_run_ && command == "engage") {
      gate_.engage_gesture();
      return "ok";
    }
    if (dry_run_ && command == "talk") {
      std::string direction;
      in >> direction;
      if (direction != "down" && direction != "up") {
        return "err bad_request usage: talk down|up";
      }
      gate_.talk(direction == "down");
      return "ok";
    }

    std::function<void()> action;
    if (command == "move" || command == "scroll") {
      int a = 0, b = 0;
      if (!(in >> a >> b)) {
        return "err bad_request usage: " + command + " A B";
      }
      action = command == "move"
                   ? std::function<void()>([this, a, b] { injector_.pointing(a, b, 0, 0); })
                   : std::function<void()>([this, a, b] { injector_.pointing(0, 0, a, b); });
    } else if (command == "buttons") {
      uint32_t mask = 0;
      if (!(in >> mask)) {
        return "err bad_request usage: buttons MASK";
      }
      action = [this, mask] { injector_.set_buttons(mask); };
    } else if (command == "keys") {
      int modifiers = 0;
      if (!(in >> modifiers) || modifiers < 0 || modifiers > 255) {
        return "err bad_request usage: keys MODS [USAGE ...]";
      }
      std::vector<uint16_t> usages;
      int usage = 0;
      while (in >> usage) {
        if (usage <= 0 || usage > 0xffff) {
          return "err bad_request bad usage";
        }
        usages.push_back(static_cast<uint16_t>(usage));
      }
      if (usages.size() > 32) {
        return "err bad_request at most 32 keys";
      }
      action = [this, modifiers, usages] { injector_.set_keys(static_cast<uint8_t>(modifiers), usages); };
    } else {
      return "err bad_request unknown command: " + command;
    }

    if (!injector_.ready()) {
      return "err not_ready " + injector_.describe();
    }
    if (!gate_.run_if_engaged(action)) {
      return "err disengaged " + gate_.describe();
    }
    sent_input = true;
    return "ok";
  }

  std::string path_;
  uid_t owner_uid_;
  gid_t owner_gid_;
  gate& gate_;
  injector& injector_;
  bool dry_run_;
  std::function<std::string()> watch_status_;
  int listen_fd_ = -1;
  std::atomic<bool> stopping_ = false;
  std::thread accept_thread_;
};

} // namespace agent_vhid
