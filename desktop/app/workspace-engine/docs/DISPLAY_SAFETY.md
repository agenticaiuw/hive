# Display lifecycle safeguards

SpaceO creates and retires virtual displays through private macOS APIs whose calls cannot be
cancelled once they enter the system. These safeguards bound how often SpaceO changes the display
graph, how long a caller waits, and what happens when a change cannot be verified.

## Current behavior

- The private shim checks runtime class/symbol availability on every supported OS version; the
  OS version alone never refuses creation.
- A successfully read zero-count display inventory is distinguished from provider failure.
  Empty/all-inactive user graphs receive a pre-mutation refusal while their attachment remains
  unqualified, without being mislabeled as an unreadable inventory or tripping the persistent
  failure latch. Creation also refuses malformed user display metadata and online SpaceO displays
  not owned by this process. Mirrored displays and any refresh rate are admitted.
- A per-user file lock admits one SpaceO display-owning process for that process's lifetime.
  Daemon, XCTest, and library users of Stage share the same journal. It does not coordinate old
  binaries, other users, third-party virtual-display software, or direct users of private APIs.
- Normal admission's persistent budget allows at most **4 creation attempts per minute, 12 per ten minutes,
  and 32 per rolling day**. Budget refusals report the actual remaining wait across all windows.
  CLI/MCP limits report the effective `maximumCreationsPerMinute` and the persistent
  `maximumCreationsPerTenMinutes` and `maximumCreationsPerDay`; stricter pool limits still apply.
  Attempts, including failures, count before creation; changing pools or restarting the process
  cannot reset the window. `SPACEO_UNRESTRICTED_RESOURCES` does not lift this safety budget.
  Only the [explicit diagnostic testing mode](#explicit-reserved-testing-host) bypasses its
  admission limit while retaining the bounded history.
- Before a mutation, the journal records it as pending. Success clears pending only after
  verification. Interrupted mutation, unknown removal, configuration drift, or a service timeout
  leaves a latch that prevents subsequent work and survives process restarts.
  Live cases separately persist a pending marker before their baseline or test body, including
  cases that create no display; only a successful teardown clears it.
  An assertion stops admission to later cases immediately, while the failing case can still
  retire its displays. Its failure is latched after cleanup verification. Unverified cleanup
  suspends the owner for inspection instead of allowing process exit to detach retained displays.
  `spaceo doctor` reports blocked or unknown lifecycle state in text and JSON, exits nonzero,
  and includes recovery guidance. Daemon health also reports an in-memory circuit failure even
  if its journal write has not completed. Ordinary daemon replies use a separately locked memory
  snapshot and never reopen the journal or wait for its I/O mutex. Before that process acquires
  a lifecycle lease the field is absent. Doctor inspects the journal on one dedicated worker,
  with a one-second read deadline (plus at most 100 ms of failure bookkeeping). A busy or
  timed-out inspection reports unknown; no replacement reader or late healthy result is accepted.
  Diagnostics never reset or acquire the lifecycle lease.
- Lifecycle callers wait on a bounded worker completion, rather than a deadline checked only
  after IPC returns. The underlying OS call **cannot be cancelled**. A timed-out worker and its
  display references are retained; no replacement worker or automatic mutation retry runs.
  Late results cannot publish success or trigger ARC teardown. Queries returning errors are
  unknown, never proof of removal. Cleanup uses cached Space IDs before the bounded path.
  Retirement uses one absolute total deadline, including queueing, preflight and verification.
  Allocation claims the Space IDs verified at publication and refuses a circuit-failed Stage.
  Geometry/Space queries use their last verified snapshot while another lifecycle operation
  owns the worker, avoiding short query deadlines expiring behind healthy mutations; idle queries
  refresh the snapshot. A read-only query that outlives its one-second deadline changes nothing,
  so it does not open the circuit: the caller keeps the snapshot, the daemon logs
  `display.query.slow`, and the read stays on the worker until it returns. Later queries defer
  to the snapshot meanwhile, and a mutation queued behind it still opens the circuit at its own
  deadline. A late read's display references are retained, never released by ARC. Cleanup preflight failure retains the backing even when no invalidation
  has started, including the deinitialization fallback.
  Failure persistence/logging runs separately with at most 100 ms of caller wait, so a worker
  stalled while holding the journal lock cannot also trap the timeout caller. If storage stalls,
  the failure write may remain outstanding; the already-persisted pending markers protect
  interrupted mutations and live cases.
- Display identities come from a bounded set (RA-057). macOS keeps a ColorSync device
  registration, a factory profile and WindowServer display mappings for every identity it has
  seen and never removes them; ColorSync re-reads that registry for every display request, so the
  former random serial per attachment slowed every display change on the Mac, a little more each
  time. A display's identity is now its geometry, a slot and a generation; its serial is derived
  from them and recorded with every other issued serial in
  `~/Library/Application Support/SpaceO/display-identities.json`, so two identities never share a
  serial. A slot is reused once no online display and no live display object holds it, so repeated
  creation of one geometry reuses one identity. A geometry has 32 slots and the record at most
  1,024 identities; creation refuses rather than mint more. An existing record that cannot be read
  or validated refuses creation instead of reissuing identities it may have retired; move it aside
  only when no SpaceO display is online. The random serial existed because a reused identity once restored a saved
  configuration that left the display online but inactive, without its own Space. Publication
  still rejects such a display, and that identity's slot advances to a new generation in the same
  record, so it is not offered again; if that cannot be saved, the creation error says so.
  A display whose mode settings are refused is retained and rejected, not released implicitly.
- The daemon keeps at most one idle display after a 15-second grace, reusing it for later tasks.
  Exact width and height must match an exclusive request. Idle displays still consume framebuffer
  memory and appear in macOS display settings. Explicit `spaceo pool trim --operator` (or MCP
  `spaceo_pool_trim` with `operator: true`) retires only idle displays under the allocation lock;
  full shutdown retires every display when health and cleanup can be verified.
- Production Stage use starts a native read-only health monitor before its first display creation.
  It requires observations about five seconds apart, normal memory pressure, no new swap and
  combined ColorSync CPU below 50%. These are conservative admission thresholds, not macOS
  diagnostic criteria. Earlier WindowServer diagnostic reports are not an input: by owner
  direction after the RA-057 fix, a past WindowServer crash or watchdog report no longer blocks
  display creation until the Mac restarts.
  On-demand ColorSync services contribute zero CPU only with verified launchd idle/never-started
  state and unchanged launch counts, reconciled with the process list. A single verified new
  launch contributes its whole lifetime CPU; hidden relaunches, exits, restarts and malformed
  or unavailable evidence remain unknown. All sampler work shares a bounded deadline.
  A known memory-pressure event or any observed swap-in or swap-out
  temporarily refuses work without permanently tripping the lifecycle. Three fresh normal
  observations must then form two quiet intervals with no swap before work resumes. Another
  swap event resets that quiet period. The triggering sample's swap deltas are reported.
  Unknown reports expose the unavailable input in `hostHealth.unavailableInput`.
  Display attachment waits up to 15 seconds for two consecutive assessed CPU intervals below
  **25%**. This settling gate is stricter than the ongoing-use 50% hard limit: a warm host
  refuses graph changes without treating the wait itself as an OS failure. After each graph
  change, both endpoints of the next two qualifying intervals must be newer than that change.
  Cached health reads do not count as new observations. Retirement uses the same gate before
  invalidation, with a default **30-second total budget**, reserving 10 seconds for removal.
  Explicit shorter deadlines require already-settled evidence without waiting. Bulk retirement
  shares one 25-second deadline and stops at the first refusal, reporting unattempted owners.
  A settling refusal before mutation keeps the display valid and owned; cleanup reports its ID as
  still attached. Deinitialization also retains the backing when settling cannot be verified.
  Pending or deferred fallback owners appear in `deferredRetirementDisplayIDs`, block new display creation
  without a sticky circuit fault, and remain in shutdown attachment reports until verified
  retirement. Fallback owners have no pool handle and no automatic retry after refusal.
  Retain the owning process and inspect safety; ending it removes its displays through macOS
  and is not evidence of orderly recovery. Failed publication also records its retained ID.
  JSON separately reports `hostHealth.reconfigurationSettled` and
  `hostHealth.reconfigurationCPUThresholdPercent`. Normal cleanup uses this gate. Forced
  process exit still removes owned virtual displays through macOS, so this cannot guarantee orderly retirement after SIGKILL or a crash.
  Multi-display stop may require retries after ColorSync settles.
  Observations continue every five seconds; a separate watchdog trips on a sampler exceeding
  three seconds or a passing result older than ten seconds. There is one sampler, no replacement
  worker, no automatic reset, and no acceptance of a late result after refusal.
  Active commands, reuse, janitor work, and retirement refuse after failure. The timed janitor
  stops after its first host-health refusal; passive diagnostics remain available without
  repeating the same maintenance admission every three seconds. The daemon retains
  display owners instead of exiting or attempting more graph changes. Cached diagnostics remain
  available; daemon replies and doctor JSON include `hostHealth` without report contents.
  This does not stop input or OS calls already in flight. A process killed externally still loses
  its displays. An older daemon must be replaced through the normal verified upgrade procedure
  before it gains these protections; building the source does not change the running host.

These bounds are application containment. They cannot cancel a call already inside Apple code, guarantee display preservation when an owner exits, or measure ColorSync's
internal backlog. Process exit still releases its virtual displays. General diagnostic queries
outside Stage's lifecycle are not all covered by its worker deadline.

## Display identity residue

SpaceO 1.0.8 and earlier gave every display a new identity, so a Mac that ran many sessions
holds hundreds of SpaceO ColorSync registrations and display profiles. `spaceo doctor` reports
them under `display identities` (JSON `displayIdentityResidue`), counting profiles by their
make-and-model tag. Above 64 it asks for cleanup. Bounded identities stop the growth but cannot
remove what is already there:

```sh
spaceo safety clean-display-identities --operator              # list; changes nothing
sudo spaceo safety clean-display-identities --apply --operator  # back up, then remove
```

Stop every SpaceO daemon, Viewer and MCP client first, then run it with `sudo` from the account
that uses SpaceO. It holds that account's display-lifecycle lock, which every SpaceO display
creator needs, from its first check until the last profile is removed. It refuses while any other
`spaceo` process or the Viewer runs, while a SpaceO display is online, when it sees no display at
all (run it from a Terminal in the logged-in session, not over SSH), when ColorSync's registry
file is missing, and when ColorSync or the profile directory lists more than it examines. If a
SpaceO display still appears while it works, it removes no profile, and a profile it cannot
remove is reported as a partial cleanup. It copies ColorSync's device registry and each SpaceO profile into
`/Library/Application Support/SpaceO/ColorSync backups/colorsync-<time>/`, unregisters only
devices whose factory profile names SpaceO's vendor and product (physical displays, Sidecar,
other virtual-display tools and displays a person assigned a SpaceO profile are untouched), lists the registry again and removes only SpaceO profiles
that no remaining registration references. ColorSync reports success to a normal account while removing nothing, so
root is required and the second listing, not the return value, decides the outcome. Listing
the registry can take tens of seconds on an affected Mac; a listing that has not finished after
three minutes refuses before any change, or reports the cleanup as unconfirmed after it. Log out and back in afterwards.
With the stale registrations present, WindowServer kept asking ColorSync about every display
attached since login, about two requests every five seconds per attachment, even after the
display was gone. On the one Mac measured, those requests stopped as soon as the cleanup finished
and a later attachment left none behind, but that is a single observation, so logging out
remains the procedure.
Do not delete WindowServer's display preferences; that resets the arrangement of physical
displays and is not needed.

## Live testing

Use a reserved host and follow [LIVE_TESTS.md](LIVE_TESTS.md). `SPACEO_LIVE_TESTS=1` is required
both by the shell wrapper and XCTest setup, before setup makes any display queries. The wrapper
rejects parallel workers; XCTest stops admitting cases after its first recorded failure and opens the persistent lifecycle
latch to refuse focused reruns. Cases
are paced by 90 seconds to avoid exhausting the shared creation budget. Pacing is not a health
certificate; lifecycle failures still stop the run.

The external supervisor retains an owner-only log. A case exceeding 180 seconds, a run exceeding
40 minutes, interruption (including terminal SIGHUP), or excessive output suspends the owned
process group and exits nonzero. A focused `--case` run requires exactly one passing result for
the named method; empty filters, skips, different cases, and extra results cannot pass.
It does **not** kill a display owner automatically: killing can itself reconfigure the display
graph. The log reports the suspended process-group ID. Stop the qualification attempt and inspect
it during a reserved recovery window; do not automatically rerun or resume it. A failed, stopped,
or skipped run is never release evidence. Direct `swift test` invocations do not have its external deadline.

## Explicit reserved testing host

When the operator explicitly designates this Mac for diagnostic testing, set both
`SPACEO_LIVE_TESTS=1` and `SPACEO_TESTING_HOST=1` on the source CLI and test commands.
This bypasses host-health admission, including memory pressure, swap, unavailable samples and
sticky health faults. It does **not** bypass measured
ColorSync load: display attachments can leave macOS polling ColorSync long after the display is
gone (RA-057), and
diagnostic runs that ignored that load saturated ColorSync until WindowServer's watchdog ended
the login session. The sampler keeps running. A display change waits (up to its normal
deadline) for combined ColorSync CPU below 25%: two measured intervals at process start or after
a busy interval, and one interval measured entirely after each earlier change. Saturation makes intervals
unmeasurable, so once a process has measured one, an unmeasurable interval never counts as quiet;
only a sampler that has never produced a measurement keeps the override's former admission. A
capture delivered more than three seconds late is not counted, and quiet evidence older than ten
seconds no longer admits a change. A
process therefore takes about ten seconds before its first display change, and five to ten
between changes. The live-test preflight and per-case health checks keep the normal 50%
ColorSync limit; a case that finds ColorSync at or above it after cleanup stops live work, and
recovery is the operator archive below. Native health reports carry `testingOverride: true`,
`testing_override` and the measured `colorsyncCPUPercent`, never an invented one. The
independent helper still samples and retains its actual reasons and counters as
`observedAdmitted`; it marks admission as overridden. One flag alone has no effect.

In this mode explicit `safety clear-host-health --operator` may archive any idle host-health
latch, including a diagnostic/timeout latch. It still requires the existing exclusive journal
lock, no pending mutation/live case, and no SpaceO display. Ownership, topology checks,
operation deadlines, pool resource limits, live-case pacing and failure cleanup remain enforced.
The same explicit mode bypasses the persistent rolling creation-rate admission limit for
diagnostic workloads. It still records the latest 12 ten-minute and 32 daily attempts, which
fully determine normal admission after the mode is removed. The bounded journal is not reset;
normal runs can remain rate-limited by these diagnostic attempts. Native safety status exposes
`creationRateTestingOverride: true`. Clock rollback and unfinished mutations remain refused.
Limits reports omit the inactive persistent ten-minute/daily caps, retain the pool's effective
minute cap, and expose the same override flag.
The flags apply only to processes which inherit them; an already-running daemon must exit
before starting the source daemon in this mode. Diagnostic results are retained as override
runs, not normal host-health or signed-release qualification. Neither diagnostic files nor
system preferences are erased.

## Recovery and requalification

The per-user journal is `~/Library/Application Support/SpaceO/display-safety.json`. A corrupt or
non-private journal fails closed. There is intentionally no automatic reset, expiry of failures,
or retry loop. Do not unlink it while any SpaceO owner is running or suspended: replacing a locked
file would defeat cross-process exclusion.

An idle `host health: host_health_unknown`, `host health: memory_pressure` or
`host health: swap_activity` latch can be recovered after the underlying condition resolves.
This includes the false unknown latch produced by 1.0.5 when on-demand ColorSync services
were absent, and a `host health: recent_windowserver_diagnostic` latch recorded by 1.0.9 or
earlier, whose WindowServer-report check is no longer an admission input. Upgrade to a CLI containing this recovery support, stop **all** SpaceO owners
(including Viewer, MCP clients and the supervised LaunchAgent), then run:

```sh
spaceo safety clear-host-health --operator
```

This local operator command locks the existing journal, refuses a pending mutation/live case
or any other failure class, requires no online SpaceO display and two consecutive healthy
ColorSync intervals below 25%, and archives the old journal before clearing only its failure.
Any combination of memory pressure, swap and the old WindowServer-report reason is eligible; a
combination containing another reason is refused. ColorSync incidents, sampler timeouts and
stale-health faults remain outside this recovery path. It preserves creation budgets
and the locked file's identity. An owner that relaunches or still holds the file lock prevents
recovery; stop its supervision first. Doctor remains read-only. Current memory pressure, swap
activity, incidents and unknown/stale health still refuse; this command neither qualifies the
host nor clears RA-057.

Recovery first saves a blocking marker, then commits a private, complete receipt. Its bounded
wait can end before a stalled filesystem operation returns. A confirmed abort retains the latch;
an unconfirmed abort reports an undecided outcome, and the recovery worker keeps the lifecycle
file locked until it finishes. Doctor may report `unknown` while that outcome is undecided.
Wait for the safety process to fully exit before treating a subsequent doctor result as final.
If a killed recovery left a staged receipt, doctor remains undecided until a new explicit
operator recovery takes the journal lock and removes that stale staged file.
New display creation still requires fresh host-health admission after taking the lifecycle lock.
This exclusion relies on Darwin retaining the process's file locks until outstanding kernel
operations finish or process teardown closes its descriptors.

Retain the journal's `.host-health-*.json` archives and `.recovery-*` decision files together
with the journal; receipts can be needed to interpret its recovery marker. A later owner saves
the resolved state into the journal. Rolling back to 1.0.5 before that save leaves its older
reader blocked by the marker and requires the documented operator recovery. Do not delete
these files during recovery or while any owner is running.

The LaunchAgent uses `KeepAlive`, and Viewer or MCP clients can start a daemon on demand.
Stopping one daemon PID does not stop those launchers. Quit Viewer and disconnect MCP clients,
and stop LaunchAgent supervision during the reserved recovery window. Repeated "already
listening" messages mean another daemon owns the socket; they do not authorize killing it or
removing its socket/journal. Restore the intended single daemon launcher after recovery.

After a trip, stop further display work, retain the log and journal, and plan recovery on a
reserved host. Establish that all display-owning SpaceO processes have exited, no orphan display
remains, and physical-only display operation is stable. Owner termination may itself trigger
teardown; it is an operator recovery decision, not a watchdog action. Only then may an operator
archive/remove the journal to permit a fresh admission. That does not make the host qualified or clear any release blocker. Do not erase WindowServer/ColorSync preferences as a
routine reset. Every newly observed swap-in or swap-out still refuses work; swap activity uses
the transient requalification path above. Recovering an idle latch does not allow live-owner teardown through an unhealthy
host, and no command automatically kills an owner to make recovery possible.

Release qualification requires the complete live and computer-use gates in
[RELEASE_POLICY.md](RELEASE_POLICY.md) for the candidate source.

## Verification without display mutation

`DisplayLifecycleContainmentTests` inject blocked queries, blocked backing invalidation, late
creation completion, inventory errors, lease contention, restart persistence, rolling budgets,
clock rollback, and bad journal files. `DisplaySafetyTests` tests display-graph admission.
`LiveTestSupervisorTests.py` exercises deadlines using disposable Python processes only.
`LiveTestGateTests.sh` checks opt-in, serial execution, retained logs, and complete-run evidence.
No live display creation is needed to run these tests.
