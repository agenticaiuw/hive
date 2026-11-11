#pragma once

// The engage/disengage state machine.
//
//   disengaged --(the agent asks, for a task the human gave it)--> arming
//   arming     --(hands off for quiet_period)--> engaged
//   arming     --(any real input before the quiet period ends)--> disengaged
//   engaged    --(any real key, touch, click, or mouse motion)--> disengaged
//   engaged    --(agent says it is done)--> disengaged
//
// The voice agent asks when it hears a task (it only listens after you tap fn) or when you say
// "continue" after taking over; agent.py asks for a typed task. Either way control only passes
// once the human's hands have been off for the quiet period, and any touch takes it back.
// What fn does is passed on to whoever is watching ("event fn=down", then "fn=tap" or "fn=up", and
// "fn=other" if another key is pressed with it); it never moves the gate.

#include <chrono>
#include <functional>
#include <map>
#include <mutex>
#include <sstream>
#include <string>

namespace agent_vhid {

class gate final {
public:
  enum class state { disengaged, arming, engaged };
  using clock = std::chrono::steady_clock;
  using listener = std::function<void(const std::string& event_line)>;

  gate(bool start_engaged,
       std::chrono::milliseconds quiet_period,
       std::function<void()> on_disengage,
       std::function<void(state)> on_change)
      : state_(start_engaged ? state::engaged : state::disengaged),
        reason_(start_engaged ? "start_engaged" : "startup"),
        quiet_period_(quiet_period),
        on_disengage_(std::move(on_disengage)),
        on_change_(std::move(on_change)) {}

  bool engaged() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return state_ == state::engaged;
  }

  // Runs `fn` only while engaged, holding the lock so a takeover can't slip in between
  // the check and the injected report.
  bool run_if_engaged(const std::function<void()>& fn) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (state_ != state::engaged) {
      return false;
    }
    fn();
    return true;
  }

  // When false, the gate refuses to engage (the safety watcher is not working).
  void set_watcher_healthy(bool healthy) {
    std::lock_guard<std::mutex> lock(mutex_);
    watcher_healthy_ = healthy;
    if (!healthy && state_ != state::disengaged) {
      transition_locked(state::disengaged, "watcher_unavailable");
    }
  }

  // Real input from the human: a key press, touch, click, or mouse motion.
  void human_input(const std::string& source) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (state_ == state::engaged) {
      transition_locked(state::disengaged, source);
    } else if (state_ == state::arming) {
      transition_locked(state::disengaged, "engage_cancelled_by_" + source);
    }
  }

  // The agent asks for control for a task the human gave it. False if the safety watcher isn't working.
  bool engage() {
    std::lock_guard<std::mutex> lock(mutex_);
    return begin_arming_locked("engage_requested");
  }

  // fn went down, up, or was part of a shortcut: a tap turns the voice agent's listening on or off,
  // and a hold dictates.
  void fn(const std::string& what) {
    std::lock_guard<std::mutex> lock(mutex_);
    notify_locked("event fn=" + what);
  }

  // The agent finished and hands control back.
  void release_control() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (state_ != state::disengaged) {
      transition_locked(state::disengaged, "released_by_agent");
    }
  }

  // Called periodically: finishes arming once the human's hands have been off long enough.
  void tick() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (state_ == state::arming && clock::now() - arming_started_ >= quiet_period_) {
      transition_locked(state::engaged, "engaged");
    }
  }

  std::string describe() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return "state=" + name(state_) + " reason=" + reason_;
  }

  int subscribe(listener l) {
    std::lock_guard<std::mutex> lock(mutex_);
    int id = next_listener_id_++;
    listeners_[id] = std::move(l);
    return id;
  }

  void unsubscribe(int id) {
    std::lock_guard<std::mutex> lock(mutex_);
    listeners_.erase(id);
  }

  static std::string name(state s) {
    switch (s) {
      case state::disengaged:
        return "disengaged";
      case state::arming:
        return "arming";
      case state::engaged:
        return "engaged";
    }
    return "unknown";
  }

private:
  // True if arming started or control is already on its way to the agent.
  bool begin_arming_locked(const std::string& reason) {
    if (state_ != state::disengaged) {
      return true;
    }
    if (!watcher_healthy_) {
      notify_locked("event state=disengaged reason=watcher_unavailable");
      return false;
    }
    arming_started_ = clock::now();
    transition_locked(state::arming, reason);
    return true;
  }

  void transition_locked(state next, const std::string& reason) {
    auto previous = state_;
    state_ = next;
    reason_ = reason;

    if (previous == state::engaged && next == state::disengaged && on_disengage_) {
      on_disengage_();
    }
    if (previous != next && on_change_) {
      on_change_(next);
    }
    notify_locked("event state=" + name(next) + " reason=" + reason);
  }

  void notify_locked(const std::string& line) {
    for (auto& [id, l] : listeners_) {
      l(line);
    }
  }

  mutable std::mutex mutex_;
  state state_;
  std::string reason_;
  std::chrono::milliseconds quiet_period_;
  std::function<void()> on_disengage_;
  std::function<void(state)> on_change_;
  bool watcher_healthy_ = true;
  clock::time_point arming_started_;
  std::map<int, listener> listeners_;
  int next_listener_id_ = 1;
};

} // namespace agent_vhid
