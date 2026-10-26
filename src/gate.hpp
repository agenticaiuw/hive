#pragma once

// The engage/disengage state machine.
//
//   disengaged --(double-tap Right Option)--> arming --(hands off for quiet_period)--> engaged
//   disengaged --(agent asks, within talk_grant of a talk hold)--> arming
//   engaged    --(any real key, touch, click, or mouse motion)--> disengaged
//   engaged    --(agent says it is done)--> disengaged
//   arming     --(any real input before the quiet period ends)--> disengaged
//
// The agent can never move itself out of `disengaged` on its own: it needs either the
// double-tap or, for a spoken task, the human having just held the talk key (one grant per hold).

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

  // The human asked to hand control to the agent.
  void engage_gesture() {
    std::lock_guard<std::mutex> lock(mutex_);
    begin_arming_locked("engage_requested");
  }

  // The human started (down) or finished (up) holding the talk key. Finishing lets the voice
  // agent ask for control once in the next talk_grant, so a spoken task can start without the double-tap.
  void talk(bool down) {
    std::lock_guard<std::mutex> lock(mutex_);
    talk_grant_until_ = down ? clock::time_point{} : clock::now() + talk_grant;
    notify_locked(std::string("event talk=") + (down ? "down" : "up"));
  }

  // Spends the grant from the last talk hold and starts arming. False if there is no grant.
  bool engage_after_talk() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (talk_grant_until_ == clock::time_point{} || clock::now() > talk_grant_until_) {
      return false;
    }
    talk_grant_until_ = {};
    return begin_arming_locked("engage_requested_by_voice");
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
      transition_locked(state::engaged, reason_ == "engage_requested_by_voice" ? "engaged_by_voice" : "engaged_by_human");
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

  // How long after a talk hold the voice agent may ask for control.
  static constexpr std::chrono::seconds talk_grant{30};

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
  clock::time_point talk_grant_until_;
  std::map<int, listener> listeners_;
  int next_listener_id_ = 1;
};

} // namespace agent_vhid
