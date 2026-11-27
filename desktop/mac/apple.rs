//! Single-Source-of-Truth (SSOT) read-through / write-through bridge to Apple Reminders & Apple Calendar via macOS EventKit.
//! Never duplicates reminder/calendar state in SQLite (avoids 2-way sync echo loops, RRULE splits, and tombstone resurrection):
//! reads use a short 15s TTL cache, and every write commits directly to EventKit first and invalidates the cache.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const CACHE_TTL: Duration = Duration::from_secs(15);

static CACHE: Mutex<Option<HashMap<String, (Instant, Value)>>> = Mutex::new(None);

const ACTIONS: &[&str] = &[
    "list_reminders", "create_reminder", "complete_reminder", "delete_reminder",
    "list_events", "create_event", "delete_event",
];

fn validate(a: &Value) -> Result<String, String> {
    let action = a["action"].as_str().unwrap_or("").trim().to_ascii_lowercase();
    if !ACTIONS.contains(&action.as_str()) {
        return Err(format!("Unknown mac_apple action '{action}'. Use: {}", ACTIONS.join(", ")));
    }
    match action.as_str() {
        "create_reminder" if a["title"].as_str().unwrap_or("").trim().is_empty() => {
            return Err("create_reminder requires title.".into());
        }
        "complete_reminder" if a["external_id"].as_str().unwrap_or("").trim().is_empty()
            && a["title"].as_str().unwrap_or("").trim().is_empty() => {
            return Err("complete_reminder requires external_id (or exact title).".into());
        }
        "delete_reminder" | "delete_event" if a["external_id"].as_str().unwrap_or("").trim().is_empty() => {
            return Err(format!("{action} requires external_id."));
        }
        "create_event" => {
            if a["title"].as_str().unwrap_or("").trim().is_empty() { return Err("create_event requires title.".into()); }
            if a["start"].as_str().unwrap_or("").trim().is_empty() || a["end"].as_str().unwrap_or("").trim().is_empty() {
                return Err("create_event requires ISO-8601 start and end timestamps.".into());
            }
        }
        _ => {}
    }
    Ok(action)
}

fn cache_key(action: &str, a: &Value) -> Option<String> {
    match action {
        "list_reminders" | "list_events" => Some(format!("{action}:{}", a)),
        _ => None,
    }
}

fn cache_get(key: &str) -> Option<Value> {
    let mut guard = CACHE.lock().unwrap();
    let map = guard.as_mut()?;
    let (at, val) = map.get(key)?;
    if at.elapsed() <= CACHE_TTL { Some(val.clone()) } else { map.remove(key); None }
}

fn cache_set(key: String, val: Value) {
    let mut guard = CACHE.lock().unwrap();
    guard.get_or_insert_with(HashMap::new).insert(key, (Instant::now(), val));
}

fn cache_clear() {
    if let Some(map) = CACHE.lock().unwrap().as_mut() { map.clear(); }
}

/// Execute one read-through or write-through EventKit operation on macOS.
pub fn run(a: &Value) -> Result<Value, String> {
    let action = validate(a)?;
    if let Some(k) = cache_key(&action, a) {
        if let Some(hit) = cache_get(&k) { return Ok(hit); }
    }
    let out = Command::new("/usr/bin/osascript")
        .args(["-l", "JavaScript", "-e", JXA_EVENTKIT])
        .env("HIVE_APPLE_REQ", a.to_string())
        .output()
        .map_err(|e| format!("Failed to invoke macOS EventKit via osascript: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !out.status.success() {
        return Err(if stderr.is_empty() { "EventKit call failed.".into() } else { stderr });
    }
    let parsed: Value = serde_json::from_str(&stdout)
        .map_err(|e| format!("Unexpected EventKit response ({e}): {stdout}"))?;
    if let Some(err) = parsed["error"].as_str().filter(|e| !e.is_empty()) {
        return Err(err.to_string());
    }
    let mut res = json!({ "text": serde_json::to_string(&parsed).unwrap_or(stdout) });
    if let Some(ext) = parsed["external_id"].as_str().filter(|s| !s.is_empty()) {
        res["external_id"] = json!(ext);
        res["apple_kind"] = json!(if action.contains("event") { "event" } else { "reminder" });
    }
    if let Some(k) = cache_key(&action, a) {
        cache_set(k, res.clone());
    } else {
        cache_clear();
    }
    Ok(res)
}

/// JXA EventKit script reading JSON request from `HIVE_APPLE_REQ` env var (zero shell/JS injection).
const JXA_EVENTKIT: &str = r#"
ObjC.import("Foundation");
ObjC.import("EventKit");
ObjC.import("stdlib");

function run() {
  const raw = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey("HIVE_APPLE_REQ") || "");
  const req = JSON.parse(raw || "{}");
  const action = String(req.action || "").trim().toLowerCase();
  const store = $.EKEventStore.alloc.init;
  const iso = $.NSISO8601DateFormatter.alloc.init;
  const isoFrac = $.NSISO8601DateFormatter.alloc.init;
  isoFrac.formatOptions = $.NSISO8601DateFormatWithInternetDateTime | $.NSISO8601DateFormatWithFractionalSeconds;

  function s(ns) { return ns && !ns.isNil() ? ObjC.unwrap(ns) : ""; }
  function parseDate(str) {
    if (!str) return null;
    const t = String(str).trim();
    let d = isoFrac.dateFromString(t) || iso.dateFromString(t);
    if (!d || d.isNil()) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(t)) d = iso.dateFromString(t + "T09:00:00Z");
    }
    return d && !d.isNil() ? d : null;
  }
  function fmtDate(d) { return d && !d.isNil() ? s(iso.stringFromDate(d)) : ""; }
  function waitUntil(check, secs) {
    const end = Date.now() + secs * 1000;
    while (!check() && Date.now() < end) {
      $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
    }
  }
  function ensureAuth(isEvent) {
    const entity = isEvent ? $.EKEntityTypeEvent : $.EKEntityTypeReminder;
    const status = Number($.EKEventStore.authorizationStatusForEntityType(entity));
    // 3 = Authorized / FullAccess
    if (status === 3) return null;
    if (status === 1 || status === 2) {
      const label = isEvent ? "Calendars" : "Reminders";
      return `macOS denied ${label} access: enable Hive in System Settings > Privacy & Security > ${label}.`;
    }
    let done = false, granted = false, errMsg = "";
    const cb = (ok, err) => { granted = Boolean(ok); if (err && !err.isNil()) errMsg = s(err.localizedDescription); done = true; };
    if (isEvent && store.respondsToSelector("requestFullAccessToEventsWithCompletion:")) {
      store.requestFullAccessToEventsWithCompletion(cb);
    } else if (!isEvent && store.respondsToSelector("requestFullAccessToRemindersWithCompletion:")) {
      store.requestFullAccessToRemindersWithCompletion(cb);
    } else {
      store.requestAccessToEntityTypeCompletion(entity, cb);
    }
    waitUntil(() => done, 25);
    if (!granted) {
      const label = isEvent ? "Calendars" : "Reminders";
      return errMsg || `${label} permission not granted yet. Approve the macOS prompt or enable Hive in System Settings > Privacy & Security > ${label}.`;
    }
    return null;
  }
  function findCal(entity, name) {
    if (!name) return null;
    const want = String(name).trim().toLowerCase();
    const arr = store.calendarsForEntityType(entity);
    const n = Number(arr.count);
    for (let i = 0; i < n; i++) {
      const c = arr.objectAtIndex(i);
      if (s(c.title).toLowerCase() === want) return c;
    }
    return null;
  }
  function fetchReminders(cals) {
    const pred = store.predicateForRemindersInCalendars(cals);
    let done = false, list = [];
    store.fetchRemindersMatchingPredicateCompletion(pred, (rems) => {
      if (rems && !rems.isNil()) {
        const n = Number(rems.count);
        for (let i = 0; i < n; i++) list.push(rems.objectAtIndex(i));
      }
      done = true;
    });
    waitUntil(() => done, 15);
    return list;
  }
  function dueFromComps(comps) {
    if (!comps || comps.isNil()) return "";
    const cal = $.NSCalendar.currentCalendar;
    const d = cal.dateFromComponents(comps);
    return fmtDate(d);
  }
  function compsFromDate(d) {
    const cal = $.NSCalendar.currentCalendar;
    const units = $.NSCalendarUnitYear | $.NSCalendarUnitMonth | $.NSCalendarUnitDay | $.NSCalendarUnitHour | $.NSCalendarUnitMinute;
    return cal.componentsFromDate(units, d);
  }

  try {
    const isEvent = action.indexOf("event") !== -1;
    const authErr = ensureAuth(isEvent);
    if (authErr) return JSON.stringify({ error: authErr });

    if (action === "list_reminders") {
      const cal = findCal($.EKEntityTypeReminder, req.list);
      const cals = cal ? $.NSArray.arrayWithObject(cal) : null;
      const includeDone = Boolean(req.include_completed);
      const limit = Math.max(1, Math.min(Number(req.limit) || 50, 100));
      const items = [];
      for (const r of fetchReminders(cals)) {
        const done = Boolean(r.completed);
        if (!includeDone && done) continue;
        items.push({
          external_id: s(r.calendarItemExternalIdentifier) || s(r.calendarItemIdentifier),
          title: s(r.title),
          list: s(r.calendar.title),
          due: dueFromComps(r.dueDateComponents),
          completed: done,
          priority: Number(r.priority || 0),
          notes: s(r.notes).slice(0, 300),
        });
        if (items.length >= limit) break;
      }
      return JSON.stringify({ ok: true, count: items.length, reminders: items });
    }

    if (action === "create_reminder") {
      const r = $.EKReminder.reminderWithEventStore(store);
      r.title = String(req.title).trim();
      const cal = findCal($.EKEntityTypeReminder, req.list) || store.defaultCalendarForNewReminders;
      if (!cal || cal.isNil()) return JSON.stringify({ error: "No default Apple Reminders list found." });
      r.calendar = cal;
      if (req.notes) r.notes = String(req.notes);
      if (req.priority) r.priority = Number(req.priority);
      if (req.due) {
        const d = parseDate(req.due);
        if (!d) return JSON.stringify({ error: "Invalid ISO-8601 due date: " + req.due });
        r.dueDateComponents = compsFromDate(d);
      }
      const err = Ref();
      if (!store.saveReminderCommitError(r, true, err)) {
        return JSON.stringify({ error: err[0] ? s(err[0].localizedDescription) : "Failed to save reminder." });
      }
      return JSON.stringify({
        ok: true,
        external_id: s(r.calendarItemExternalIdentifier) || s(r.calendarItemIdentifier),
        title: s(r.title),
        list: s(r.calendar.title),
        due: dueFromComps(r.dueDateComponents),
      });
    }

    if (action === "complete_reminder" || action === "delete_reminder") {
      const wantId = String(req.external_id || "").trim();
      const wantTitle = String(req.title || "").trim().toLowerCase();
      const all = fetchReminders(null);
      const matches = all.filter((r) => {
        if (wantId) return s(r.calendarItemExternalIdentifier) === wantId || s(r.calendarItemIdentifier) === wantId;
        return s(r.title).trim().toLowerCase() === wantTitle;
      });
      if (matches.length === 0) return JSON.stringify({ error: "Reminder not found in Apple Reminders." });
      if (matches.length > 1 && !wantId) return JSON.stringify({ error: "Multiple reminders match that title; pass external_id from list_reminders." });
      const r = matches[0];
      const ext = s(r.calendarItemExternalIdentifier) || s(r.calendarItemIdentifier);
      const err = Ref();
      if (action === "delete_reminder") {
        if (!store.removeReminderCommitError(r, true, err)) {
          return JSON.stringify({ error: err[0] ? s(err[0].localizedDescription) : "Failed to delete reminder." });
        }
        return JSON.stringify({ ok: true, deleted: ext, title: s(r.title) });
      }
      const completed = req.completed === undefined ? true : Boolean(req.completed);
      r.completed = completed;
      if (!store.saveReminderCommitError(r, true, err)) {
        return JSON.stringify({ error: err[0] ? s(err[0].localizedDescription) : "Failed to update reminder." });
      }
      return JSON.stringify({ ok: true, external_id: ext, title: s(r.title), completed });
    }

    if (action === "list_events") {
      const start = parseDate(req.start) || $.NSDate.date;
      const end = parseDate(req.end) || $.NSDate.dateWithTimeIntervalSinceDate(7 * 86400, start);
      const cal = findCal($.EKEntityTypeEvent, req.calendar);
      const cals = cal ? $.NSArray.arrayWithObject(cal) : null;
      const pred = store.predicateForEventsWithStartDateEndDateCalendars(start, end, cals);
      const arr = store.eventsMatchingPredicate(pred);
      const limit = Math.max(1, Math.min(Number(req.limit) || 50, 100));
      const events = [];
      if (arr && !arr.isNil()) {
        const n = Math.min(Number(arr.count), limit);
        for (let i = 0; i < n; i++) {
          const ev = arr.objectAtIndex(i);
          events.push({
            external_id: s(ev.calendarItemExternalIdentifier) || s(ev.eventIdentifier),
            title: s(ev.title),
            calendar: s(ev.calendar.title),
            start: fmtDate(ev.startDate),
            end: fmtDate(ev.endDate),
            all_day: Boolean(ev.allDay),
            location: s(ev.location),
            notes: s(ev.notes).slice(0, 300),
          });
        }
      }
      return JSON.stringify({ ok: true, count: events.length, events });
    }

    if (action === "create_event") {
      const start = parseDate(req.start);
      const end = parseDate(req.end);
      if (!start || !end) return JSON.stringify({ error: "Invalid ISO-8601 start or end timestamp." });
      const ev = $.EKEvent.eventWithEventStore(store);
      ev.title = String(req.title).trim();
      ev.startDate = start;
      ev.endDate = end;
      ev.allDay = Boolean(req.all_day);
      if (req.location) ev.location = String(req.location);
      if (req.notes) ev.notes = String(req.notes);
      const cal = findCal($.EKEntityTypeEvent, req.calendar) || store.defaultCalendarForNewEvents;
      if (!cal || cal.isNil()) return JSON.stringify({ error: "No default Apple Calendar found." });
      ev.calendar = cal;
      const err = Ref();
      if (!store.saveEventSpanCommitError(ev, $.EKSpanThisEvent, true, err)) {
        return JSON.stringify({ error: err[0] ? s(err[0].localizedDescription) : "Failed to save calendar event." });
      }
      return JSON.stringify({
        ok: true,
        external_id: s(ev.calendarItemExternalIdentifier) || s(ev.eventIdentifier),
        title: s(ev.title),
        calendar: s(ev.calendar.title),
        start: fmtDate(ev.startDate),
        end: fmtDate(ev.endDate),
      });
    }

    if (action === "delete_event") {
      const wantId = String(req.external_id || "").trim();
      let ev = store.eventWithIdentifier(wantId);
      if (!ev || ev.isNil()) {
        const items = store.calendarItemsWithExternalIdentifier(wantId);
        if (items && !items.isNil() && Number(items.count) > 0) ev = items.objectAtIndex(0);
      }
      if (!ev || ev.isNil()) return JSON.stringify({ error: "Event not found in Apple Calendar." });
      const err = Ref();
      if (!store.removeEventSpanCommitError(ev, $.EKSpanThisEvent, true, err)) {
        return JSON.stringify({ error: err[0] ? s(err[0].localizedDescription) : "Failed to delete calendar event." });
      }
      return JSON.stringify({ ok: true, deleted: wantId, title: s(ev.title) });
    }

    return JSON.stringify({ error: "Unsupported action: " + action });
  } catch (e) {
    return JSON.stringify({ error: String(e) });
  }
}
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_apple_actions_and_cache_keys() {
        assert!(validate(&json!({ "action": "bogus" })).is_err());
        assert!(validate(&json!({ "action": "create_reminder" })).is_err());
        assert!(validate(&json!({ "action": "create_reminder", "title": "Buy milk" })).is_ok());
        assert!(validate(&json!({ "action": "complete_reminder" })).is_err());
        assert!(validate(&json!({ "action": "complete_reminder", "external_id": "abc" })).is_ok());
        assert!(validate(&json!({ "action": "create_event", "title": "Sync" })).is_err());
        assert!(validate(&json!({ "action": "create_event", "title": "Sync", "start": "2026-11-27T10:00:00Z", "end": "2026-11-27T11:00:00Z" })).is_ok());
        assert!(cache_key("list_reminders", &json!({})).is_some());
        assert!(cache_key("create_reminder", &json!({})).is_none());
    }
}
