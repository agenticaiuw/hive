<script lang="ts">
  /*
   * The bench instrument.
   *
   * The owner is looking up from a breadboard with a wire in their hand, a
   * metre from the screen, asking one question: did that do anything? So the
   * page is nothing but live values at a size that reads from across the desk.
   * No controls, no tabs, no rows of buttons — there is nothing here to
   * operate, only something to watch.
   *
   * Two rules it will not bend:
   *  - A missing wire is not an error. Nothing on this page is red; unwired
   *    and unseen are amber or grey, because "this pin has not moved yet" is a
   *    question, not a fault.
   *  - Stale data never masquerades as live. Every tile carries its own age,
   *    and when the stream stops the whole grid visibly stands down.
   */
  import { onMount } from "svelte";
  import { agentRequest, audioHref, backend, fetchRuns, fetchSnapshot } from "$lib/dataSource";
  import { stageState, type JsonRecord } from "$lib/pipeline";

  type Button = {
    key: string;
    pin: number;
    colour: string;
    role: string | null;
    unwired: boolean;
    level: number | null;
    pressed: boolean | null;
    presses: number;
    edges: number;
    ageMs: number | null;
    pressedAgoMs: number | null;
    edgeAgoMs: number | null;
    watched: boolean;
    moved: boolean;
  };

  type Snapshot = {
    now: number;
    monitor: { available: boolean; endpoint: string | null; reason: string | null };
    link: {
      transport: string;
      port: string | null;
      state: string;
      detail: string | null;
      stub: boolean;
      ports: number;
      console: string | null;
      consoleOpen: boolean | null;
      missing: string[];
      bytes: number;
      parsed: number;
      openedAt: number | null;
    };
    stream: {
      connected: boolean;
      source: string | null;
      ageMs: number | null;
      linesSeen: number;
      linesParsed: number;
      continuityGapMs: number | null;
    };
    firmware: {
      name: string | null;
      uptimeMs: number | null;
      round: number | null;
      phase: string | null;
      watching: { controls: boolean; mic: boolean };
    };
    links: {
      lte: {
        reported: boolean;
        word: string | null;
        on: boolean | null;
        operator: string | null;
        rsrpDbm: number | null;
        band: number | null;
        mode: string | null;
        ageMs: number | null;
      };
      socket: { reported: boolean; up: boolean | null; idleMs: number | null; ageMs: number | null };
      bt: {
        reported: boolean;
        connected: boolean | null;
        name: string | null;
        address: string | null;
        note: string | null;
        ageMs: number | null;
      };
    };
    controls: {
      buttons: Button[];
      encoder: {
        a: number | null;
        b: number | null;
        position: number;
        detents: number;
        cw: number;
        ccw: number;
        direction: string | null;
        ageMs: number | null;
        watched: boolean;
        moved: boolean;
      };
      pot: {
        raw: number | null;
        percent: number | null;
        volts: number | null;
        min: number | null;
        max: number | null;
        span: number | null;
        /* The span as a share of full scale — the ratio IS the wiring fault. */
        spanPercent: number | null;
        swept: boolean;
        narrow: boolean;
        ageMs: number | null;
        watched: boolean;
        moved: boolean;
        history: number[];
      };
      micPower: {
        live: boolean | null;
        level: number | null;
        changes: number;
        ageMs: number | null;
      };
      micLevel: {
        peak: number | null;
        rms: number | null;
        band: string | null;
        flat: boolean;
        saturated: boolean;
        ageMs: number | null;
        watched: boolean;
        history: number[];
      };
      i2c: {
        addresses: { hex: string; name: string | null; expected: boolean }[];
        answered: number | null;
        note: string | null;
        ageMs: number | null;
      };
      sd: { present: boolean | null; bytes: number | null; mounted: boolean | null; note: string | null };
      amp: { enabled: boolean | null; toggles: number; ageMs: number | null };
      esp32: { state: string | null; ageMs: number | null };
    };
  };

  const LOCAL_ONLY = backend !== "agent";

  let snapshot = $state<Snapshot | null>(null);
  let receivedAt = $state(0);
  let tick = $state(Date.now());
  let error = $state("");

  /*
   * Ages arrive stamped at the moment the agent built the payload. Between
   * pushes the clock keeps moving, and a freshness indicator that only updates
   * when fresh data arrives is exactly the indicator that cannot tell you the
   * stream froze. So every age gets the local drift added to it.
   */
  const drift = $derived(receivedAt ? Math.max(0, tick - receivedAt) : 0);
  const streamAge = $derived(
    snapshot?.stream.ageMs == null ? null : snapshot.stream.ageMs + drift,
  );
  const live = $derived(streamAge !== null && streamAge < 2500);

  function ageOf(ms: number | null | undefined): number | null {
    return ms == null ? null : ms + drift;
  }

  function fmtAge(ms: number | null): string {
    if (ms == null) return "never";
    if (ms < 1000) return `${Math.round(ms / 100) / 10}s ago`;
    if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
    return `${Math.round(ms / 60_000)}m ago`;
  }

  function fmtBytes(bytes: number | null): string {
    if (!bytes) return "—";
    const gb = bytes / 1024 ** 3;
    return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
  }

  function fmtUptime(ms: number | null): string {
    if (ms == null) return "";
    const total = Math.round(ms / 1000);
    const minutes = Math.floor(total / 60);
    return minutes ? `${minutes}m ${total % 60}s` : `${total}s`;
  }

  /** A tile is dim when its own reading has gone quiet, not just the stream. */
  function dim(ms: number | null | undefined, limit = 3000): boolean {
    const age = ageOf(ms);
    return !live || age === null || age > limit;
  }

  /** Sparkline points, normalised to the values actually present. */
  function spark(values: number[], width = 260, height = 34): string {
    if (!values || values.length < 2) return "";
    const top = Math.max(...values, 1);
    const bottom = Math.min(...values, 0);
    const range = top - bottom || 1;
    const step = width / (values.length - 1);
    return values
      .map((value, index) => {
        const x = index * step;
        const y = height - ((value - bottom) / range) * height;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }

  /*
   * The five things that can actually be true, kept apart.
   *
   * The first version of this page collapsed them into "LISTENING", and the
   * owner read eleven grey dashes under it as wires he had broken. He had
   * broken nothing: the ports were open and healthy and the board had simply
   * never spoken, because no flashed image emits these values yet. "Ports open"
   * and "board talking" are different facts and a status line that renders them
   * identically is lying by omission — which is the one thing this page exists
   * not to do.
   *
   * `link.bytes` / `link.parsed` count the whole life of the link, not the
   * current boot: the per-boot counters reset on a reset, and "has this board
   * EVER said anything" is precisely the question here.
   */
  type Situation =
    | "local-only"
    | "opening"
    | "stub"
    | "live"
    | "idle"
    | "unparsed"
    | "silent"
    | "stood-down"
    | "console-missing"
    | "busy"
    | "off"
    | "unplugged";

  const OPEN_GRACE_MS = 6000;

  const situation = $derived.by<Situation>(() => {
    if (LOCAL_ONLY) return "local-only";
    if (!snapshot) return "opening";
    if (snapshot.link.stub) return "stub";
    if (live && snapshot.link.consoleOpen !== false) return "live";

    const link = snapshot.link;
    if (link.state === "disabled") return "off";
    if (link.state === "busy") return "busy";
    if (link.state === "stood-down") return "stood-down";
    /*
     * Checked BEFORE anything that could read as healthy. The bench once
     * reported "streaming" while holding two silent ports and never opening
     * VCOM0 — the only one the board prints to — so the owner pressed a button,
     * watched nothing move, and was told the link was fine. A green header over
     * an unread console is the precise failure this page exists to prevent.
     */
    if (link.state === "console-missing") return "console-missing";

    // Something arrived once. Silence after that is the console being idle —
    // the application only prints when a value moves — not a dead link.
    if (link.parsed > 0) return "idle";
    /*
     * A handful of bytes is not "the board is talking". An idle VCOM emits the
     * odd stray byte — the DK's interface MCU puts one on the line at open —
     * and calling that a format mismatch would send someone hunting a parser
     * bug that does not exist. One console line is the threshold.
     */
    if (link.bytes > 40) return "unparsed";

    if (link.ports > 0) {
      const openFor = link.openedAt ? Date.now() - link.openedAt : 0;
      return openFor > OPEN_GRACE_MS ? "silent" : "opening";
    }
    return "unplugged";
  });

  const STATE_WORD: Record<Situation, string> = {
    "local-only": "LOCAL ONLY",
    opening: "OPENING",
    stub: "BENCH STUB",
    live: "nRF CONNECTED",
    idle: "BOARD IDLE",
    unparsed: "UNRECOGNISED OUTPUT",
    silent: "NO DATA YET",
    "stood-down": "STOOD DOWN",
    "console-missing": "CONSOLE NOT OPEN",
    busy: "PORT BUSY",
    off: "READER OFF",
    unplugged: "nRF NOT CONNECTED",
  };

  const stateWord = $derived(STATE_WORD[situation]);

  /* Plain words for the same thing, and never the word "error". */
  const stateNote = $derived.by(() => {
    switch (situation) {
      case "silent":
        return `Serial ports are open (${snapshot?.link.ports ?? 0}) and healthy, but the board has sent nothing at all. The firmware that reports these values is not flashed yet — this is not a wiring fault.`;
      case "unparsed":
        return "The board is talking, but none of it matches a line this page knows how to read. That is a format mismatch, not a broken wire.";
      case "idle":
        return "The board is connected and quiet. Its console only prints when a value moves, so silence here is normal — turn the knob or press a button.";
      case "console-missing":
        return (
          snapshot?.link.detail ??
          "The console port is not open, so nothing the board says is being read."
        );
      case "busy":
      case "stood-down":
        return snapshot?.link.detail ?? "Another tool is using the console.";
      case "unplugged":
        return "No /dev/cu.usbmodem* — the DK is unplugged.";
      default:
        return snapshot?.link.detail ?? error;
    }
  });

  /*
   * A press is 120 ms long and the owner is looking at his hands, not at the
   * screen. His words: "when i pressed there should be like a flash and shows
   * when this button was pressed, like 2 seconds ago." So the tile has to carry
   * the press FORWARD in time — a flash for the instant it happens, and a
   * recency line that survives it. Watching the live level was only ever useful
   * to someone already staring at the right tile.
   */
  let flashUntil = $state<Record<string, number>>({});
  let seenPresses: Record<string, number> = {};

  $effect(() => {
    for (const button of snapshot?.controls.buttons ?? []) {
      const previous = seenPresses[button.key];
      if (previous !== undefined && button.presses > previous) {
        flashUntil[button.key] = Date.now() + 900;
      }
      seenPresses[button.key] = button.presses;
    }
  });

  function flashing(key: string): boolean {
    return (flashUntil[key] ?? 0) > tick;
  }

  /** "2s ago" — what the owner asked for, in his words. */
  function pressAgo(button: Button): string {
    const ms = ageOf(button.pressedAgoMs);
    if (ms == null) return "";
    if (ms < 1500) return "just now";
    if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
    return `${Math.round(ms / 3_600_000)}h ago`;
  }

  /*
   * One direction has decoded detents and the other has none. Both counters are
   * running totals since boot, so this is "never seen", not "not seen lately" —
   * and it is a question for the owner, not a verdict from us: he may simply
   * have spun it one way.
   */
  const oneWayOnly = $derived(
    !!snapshot?.controls.encoder.moved &&
      (snapshot.controls.encoder.cw === 0) !== (snapshot.controls.encoder.ccw === 0),
  );

  /* Powered has never been observed — not once, at any switch position. */
  const neverPowered = $derived(
    snapshot?.controls.micPower.level === 0 && snapshot?.controls.micPower.changes === 0,
  );

  /* Pinned or unvarying: either way the number is not measuring anything. */
  const micStuck = $derived(
    !!snapshot?.controls.micLevel.flat || !!snapshot?.controls.micLevel.saturated,
  );

  const micMeter = $derived(
    Math.max(0, Math.min(100, ((snapshot?.controls.micLevel.rms ?? 0) / 3000) * 100)),
  );

  /*
   * HEAR WHAT IT SHOULD HAVE PLAYED.
   *
   * A pendant with no speaker wired, or no Bluetooth link, is indistinguishable
   * from a pendant that was never sent anything to say — and the owner is on a
   * breadboard with neither. The reply speech is synthesised in the cloud and
   * streamed to the device, so the bytes exist independently of whether any
   * hardware ever moved air: the same recording the answer card plays is
   * reachable here through `audioHref`, which already picks the agent route or
   * the relay-proxying one per backend.
   *
   * The label matters as much as the sound. "Relay sent it" and "the pendant
   * played it" are different claims, and this codebase keeps them apart
   * everywhere else; a bench page that blurred them would let a working cloud
   * reply pass as a working speaker.
   */
  type Playable = {
    id: string;
    title: string;
    when: string;
    src: string;
    played: boolean;
  };

  let runs = $state<JsonRecord[]>([]);
  let runsError = $state("");

  /*
   * The remote agents come from the SAME snapshot the rest of the dashboard
   * reads (`fetchSnapshot` → the agent's /ops/snapshot). Deliberately not a
   * second source: two probes of the same three things drift, and then the
   * bench and the home page disagree about whether the bridge is up, which
   * makes both untrustworthy rather than one of them wrong.
   */
  let health = $state<JsonRecord | null>(null);

  type Remote = { key: string; label: string; up: boolean | null; detail: string };

  const remotes = $derived.by<Remote[]>(() => {
    if (!health) return [];
    const cloud = health.cloud ?? {};
    const extension = health.status?.agent?.browserExtension ?? {};
    const devices = Number(extension.connectedDevices || 0);
    return [
      {
        key: "bridge",
        label: "mac bridge",
        up: Boolean(cloud.macBridgeOnline),
        detail: cloud.macBridgeOnline ? "claiming work" : "not seen by the relay",
      },
      {
        key: "relay",
        label: "relay",
        up: Boolean(cloud.ok),
        // The store name alone ("d1") reads as noise on a bench page; what the
        // owner is asking is whether the cloud answered.
        detail: cloud.ok ? "reachable" : "unreachable",
      },
      {
        key: "extension",
        label: "browser ext",
        up: Boolean(extension.online),
        detail: extension.online
          ? `${devices} device${devices === 1 ? "" : "s"}`
          : "no socket",
      },
    ];
  });

  async function loadHealth() {
    try {
      health = await fetchSnapshot();
    } catch {
      // The links strip degrades to "not reported"; the controls are unaffected.
      health = null;
    }
  }

  function dbm(value: number | null): string {
    return value == null ? "—" : `${Math.round(value)} dBm`;
  }

  function idle(ms: number | null): string {
    if (ms == null) return "";
    if (ms < 1000) return `${ms} ms idle`;
    if (ms < 60_000) return `${Math.round(ms / 1000)}s idle`;
    return `${Math.round(ms / 60_000)}m idle`;
  }

  const playable = $derived<Playable[]>(
    runs
      .filter((run) => run?.audio?.replyCaptureId && run?.pipelineId)
      .slice(0, 4)
      .map((run) => ({
        id: String(run.pipelineId),
        title:
          String(run.reply || run.answer || run.command || "").slice(0, 90) ||
          "Spoken reply",
        when: String(run.createdAt || ""),
        src: audioHref(String(run.pipelineId), "reply"),
        played: stageState(run, "playback") === "done",
      })),
  );

  async function loadRuns() {
    try {
      runs = await fetchRuns();
      runsError = "";
    } catch (failure) {
      runsError = failure instanceof Error ? failure.message : String(failure);
    }
  }

  function clock(value: string): string {
    const at = Date.parse(value);
    if (!Number.isFinite(at)) return "";
    return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  function absorb(next: Snapshot) {
    snapshot = next;
    receivedAt = Date.now();
    tick = receivedAt;
    error = "";
  }

  function open() {
    if (LOCAL_ONLY) return;
    source?.close();
    source = new EventSource("/bench/stream", { withCredentials: true });
    source.onmessage = (event) => {
      try {
        absorb(JSON.parse(event.data) as Snapshot);
      } catch {
        /* a partial frame is a dropped frame */
      }
    };
    source.onerror = () => {
      source?.close();
      source = null;
      // The DK is unplugged constantly; so is the agent restarted. Keep asking.
      if (!retry) {
        retry = setTimeout(() => {
          retry = null;
          void prime();
        }, 2000);
      }
    };
  }

  /*
   * The agent's loopback session cookie is per-process, so a restarted agent
   * 401s every open tab. `agentRequest` knows how to re-prime it; EventSource
   * does not, so the snapshot call goes first and the stream follows it.
   */
  async function prime() {
    try {
      const payload = await agentRequest("/bench/snapshot");
      absorb(payload.bench as Snapshot);
      open();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
      if (!retry) {
        retry = setTimeout(() => {
          retry = null;
          void prime();
        }, 2000);
      }
    }
  }

  onMount(() => {
    if (!LOCAL_ONLY) void prime();
    void loadRuns();
    void loadHealth();
    /*
     * One tick a second. Every age on this page is rendered in whole seconds,
     * so a 250 ms clock re-evaluated every age, every dim() and every class
     * binding four times per second to produce identical text — pure churn
     * under the owner's hands while he tried to watch one value.
     */
    const ticker = setInterval(() => (tick = Date.now()), 1000);
    // Slow on purpose: a new reply is a human-paced event, not a wire.
    const reload = setInterval(() => {
      void loadRuns();
      void loadHealth();
    }, 15_000);
    return () => {
      clearInterval(ticker);
      clearInterval(reload);
      if (retry) clearTimeout(retry);
      source?.close();
    };
  });
</script>

<svelte:head><title>Bench — AI Pendant</title></svelte:head>

<main class="bn">
  <header class="bn-head">
    <div>
      <h1>BENCH</h1>
      <p class="bn-sub">
        nRF9160 DK
        {#if snapshot?.link.port}· {snapshot.link.port.replace("/dev/", "")}{/if}
        {#if snapshot?.firmware.uptimeMs != null}· up {fmtUptime(snapshot.firmware.uptimeMs)}{/if}
        {#if snapshot?.firmware.round != null}· round {snapshot.firmware.round}{/if}
      </p>
    </div>
    <div class="bn-status">
      <span class="bn-pill" class:on={live} class:stub={snapshot?.link.stub}>{stateWord}</span>
      <span class="bn-age">{live ? fmtAge(streamAge) : fmtAge(streamAge)}</span>
    </div>
  </header>

  {#if LOCAL_ONLY}
    <p class="bn-note">
      The bench reads a USB serial port on the Mac, so it only works on the copy the
      Mac agent serves. Open <code>http://127.0.0.1:8000/dashboard/bench</code> there.
    </p>
  {:else if snapshot?.link.stub}
    <p class="bn-note">
      Synthetic data — <code>BENCH_TRANSPORT=stub</code> is set on the agent. Nothing
      below comes from a board.
    </p>
  {:else if situation !== "live" && situation !== "opening"}
    <p class="bn-note">{stateNote}</p>
  {:else if snapshot && !snapshot.firmware.watching.controls}
    <p class="bn-note">
      The self-test is in its microphone window — the buttons, knob and pot are not
      being polled for a few seconds. Their tiles hold, they are not frozen.
    </p>
  {/if}

  <!-- On the hosted build there is no serial port within reach, so the tiles
       would render eleven dashes forever. A panel that can only ever show
       nothing is worse than a sentence explaining where the page does work, so
       the hardware grid is simply absent there. The recordings below it are
       NOT Mac-only — they come from the relay — so they stay. -->
  {#if !LOCAL_ONLY}
  <section class="bn-grid" class:standby={!live}>
    {#each snapshot?.controls.buttons ?? [] as button (button.key)}
      <article
        class="bn-tile"
        class:hot={button.pressed}
        class:flash={flashing(button.key)}
      >
        <p class="bn-label">
          {button.colour}{button.role ? ` · ${button.role}` : " · unused"}
        </p>
        <!--
          The big number is the LAST PRESS, not the resting level. A pin sitting
          high is the least interesting fact on this tile — it reads the same
          whether the button is wired, unwired, or simply untouched — while
          "when did this last do something" is the question he is actually
          asking when he looks up.
        -->
        <p class="bn-value" class:muted={!button.moved}>
          {#if button.pressed}
            PRESSED
          {:else if button.moved}
            {pressAgo(button)}
          {:else}
            —
          {/if}
        </p>
        <p class="bn-foot">
          P0.{button.pin} ·
          {#if button.moved}
            {button.presses} press{button.presses === 1 ? "" : "es"} · now {button.pressed
              ? "down"
              : "up"}
          {:else if button.unwired}
            <!-- A pin with its wires off floats HIGH against the internal
                 pull-up, which is exactly what an unpressed button reads. This
                 tile cannot answer either way, and saying "not seen yet" here
                 would imply it is being tested. -->
            <span class="bn-waiting">wires off — reads the same either way</span>
          {:else}
            <span class="bn-waiting">not seen yet</span>
          {/if}
        </p>
      </article>
    {/each}

    <article class="bn-tile">
      <p class="bn-label">encoder</p>
      <div class="bn-dial">
        <svg viewBox="0 0 72 72" aria-hidden="true">
          <circle cx="36" cy="36" r="30" class="bn-dial-ring" />
          <line
            x1="36"
            y1="36"
            x2="36"
            y2="10"
            class="bn-dial-hand"
            style="transform: rotate({(snapshot?.controls.encoder.position ?? 0) * 15}deg)"
          />
        </svg>
        <p class="bn-value bn-value-tight">{snapshot?.controls.encoder.position ?? 0}</p>
      </div>
      <p class="bn-foot">
        P0.24/25 ·
        {#if snapshot?.controls.encoder.moved}
          {snapshot.controls.encoder.cw} cw / {snapshot.controls.encoder.ccw} ccw
          <!-- The counters are independent totals, not a net, so a zero on one
               side means that direction has NEVER decoded. That is either "he
               only spun it one way" or a real finding, and the page must not
               pick: asking settles it in two seconds. -->
          {#if oneWayOnly}
            <span class="bn-waiting">· turn it the other way to check</span>
          {/if}
        {:else}
          <span class="bn-waiting">no detent yet</span>
        {/if}
      </p>
    </article>

    <article class="bn-tile bn-wide">
      <p class="bn-label">volume pot</p>
      <p class="bn-value" class:muted={snapshot?.controls.pot.percent == null}>
        {snapshot?.controls.pot.percent == null
          ? "—"
          : `${Math.round(snapshot.controls.pot.percent)}%`}
      </p>
      <div class="bn-bar"><span style="width: {snapshot?.controls.pot.percent ?? 0}%"></span></div>
      {#if (snapshot?.controls.pot.history.length ?? 0) > 1}
        <svg class="bn-spark" viewBox="0 0 260 34" preserveAspectRatio="none" aria-hidden="true">
          <polyline points={spark(snapshot?.controls.pot.history ?? [])} />
        </svg>
      {/if}
      <!--
        THE SPAN IS THE DIAGNOSTIC, NOT THE POSITION.

        This tile used to read "4% · swept 102 counts" and call that moved,
        because `moved` was gated on span >= 100 and the owner's mis-wired pot
        clears it by two counts. The page actively reassured him that a proven
        fault was fine — worse than any "not seen yet", because those at least
        ask a question.

        Two claims live here and one boolean could not carry both: the wiper
        responds monotonically and repeatably (proving the middle leg, its row,
        AIN2 and the SAADC), and the track covers 2.5% of a rail the ADC reads
        at full scale (proving it is not reaching that rail). Both are printed.
        WHICH outer leg, and how, is the owner's check order to run — the page
        reports the ratio and stops there.
      -->
      <p class="bn-foot">
        P0.15 · raw {snapshot?.controls.pot.raw ?? "—"} ·
        {#if snapshot?.controls.pot.span != null}
          <!-- The numbers are shown unconditionally; no threshold decides
               whether the owner is allowed to see the span. The only thing
               `narrow` decides is whether to add the sentence. -->
          seen {snapshot.controls.pot.min}–{snapshot.controls.pot.max} of 4095 ·
          {snapshot.controls.pot.spanPercent}% of range
          {#if snapshot.controls.pot.narrow}
            <span class="bn-waiting">— wiper responds, track not spanning the rail</span>
          {/if}
        {:else}
          <span class="bn-waiting">not read yet</span>
        {/if}
      </p>
    </article>

    <article class="bn-tile">
      <p class="bn-label">mic power</p>
      <p class="bn-value" class:muted={snapshot?.controls.micPower.live == null}>
        {snapshot?.controls.micPower.live == null
          ? "—"
          : snapshot.controls.micPower.live
            ? "LIVE"
            : "MUTED"}
      </p>
      <p class="bn-foot">
        P0.26 ·
        {#if neverPowered}
          <!-- Naming the switch names a cause we have not established: a pin
               that has never once read high is equally consistent with the
               switch being off and with the sense wire being shorted to ground,
               and hardware has since proven the latter on this board. Naming
               both stops him flipping a switch that cannot move this reading. -->
          <span class="bn-waiting">never read high — the switch or the wire</span>
        {:else}
          SPH0645 rail · red switch{(snapshot?.controls.micPower.changes ?? 0) > 0
            ? ` · ${snapshot?.controls.micPower.changes} flips`
            : ""}
        {/if}
      </p>
    </article>

    <article class="bn-tile bn-wide">
      <p class="bn-label">mic level (i2s)</p>
      <!--
        A band word is a label for a number, never a verdict on the microphone.
        On this board the level arrived as rms 29250 on all 43 samples with peak
        pinned exactly on the 16-bit ceiling, and the tile said LOUD — a pinned,
        unvarying reading rendering as a healthy one, which is the pot's
        threshold bug wearing different clothes. A number that never moves is
        not a level, so it does not get to wear the level's word.
      -->
      <p
        class="bn-value"
        class:muted={snapshot?.controls.micLevel.band == null || micStuck}
      >
        {#if micStuck}
          STUCK
        {:else}
          {(snapshot?.controls.micLevel.band ?? "—").toUpperCase()}
        {/if}
      </p>
      <div class="bn-bar"><span style="width: {micMeter}%"></span></div>
      {#if (snapshot?.controls.micLevel.history.length ?? 0) > 1}
        <svg class="bn-spark" viewBox="0 0 260 34" preserveAspectRatio="none" aria-hidden="true">
          <polyline points={spark(snapshot?.controls.micLevel.history ?? [])} />
        </svg>
      {/if}
      <p class="bn-foot">
        SPH0645 · P0.20 ·
        {#if micStuck}
          <span class="bn-waiting"
            >rms {snapshot?.controls.micLevel.rms} not moving{snapshot?.controls.micLevel
              .saturated
              ? ", peak pinned at full scale"
              : ""} — not a level</span
          >
        {:else if snapshot?.controls.micLevel.rms == null}
          <!-- "Muted" and "powered but hearing nothing" are different problems
               with different fixes. Until the firmware reports a live level the
               page can only answer the first, and it says so rather than
               leaving an empty dash to be read as silence. -->
          <span class="bn-waiting">level not reported yet</span>
        {:else}
          rms {snapshot.controls.micLevel.rms} · peak {snapshot.controls.micLevel.peak}
        {/if}
      </p>
    </article>

    <article class="bn-tile">
      <!-- Was "I2C BUS", which the owner read as I2S — the audio bus he cares
           about, one letter away. A tile named after a bus asks him to recall
           the topology; a tile named after the part he physically installed
           does not. Same reasoning for the amplifier and the mic below. -->
      <p class="bn-label">haptic (i2c)</p>
      <p class="bn-value" class:muted={!snapshot?.controls.i2c.answered}>
        {snapshot?.controls.i2c.answered
          ? snapshot.controls.i2c.addresses
              .map((entry) => `0x${entry.hex.slice(2).toUpperCase()}`)
              .join(" ")
          : snapshot?.controls.i2c.answered === 0
            ? "NONE"
            : "—"}
      </p>
      <p class="bn-foot">
        DRV2605L · P0.30/31 ·
        {#if snapshot?.controls.i2c.note}
          <span class="bn-waiting">{snapshot.controls.i2c.note}</span>
        {:else if snapshot?.controls.i2c.addresses.length}
          {snapshot.controls.i2c.addresses[0].name ?? "unlisted device"}
        {:else}
          <span class="bn-waiting">not scanned yet</span>
        {/if}
      </p>
    </article>

    <article class="bn-tile">
      <p class="bn-label">microSD</p>
      <p class="bn-value" class:muted={snapshot?.controls.sd.present == null}>
        {snapshot?.controls.sd.present == null
          ? "—"
          : snapshot.controls.sd.present
            ? fmtBytes(snapshot.controls.sd.bytes)
            : "NONE"}
      </p>
      <p class="bn-foot">
        P0.10–13 ·
        {#if snapshot?.controls.sd.note}
          <span class="bn-waiting">{snapshot.controls.sd.note}</span>
        {:else if snapshot?.controls.sd.mounted}
          mounted, read back
        {:else}
          <span class="bn-waiting">not probed yet</span>
        {/if}
      </p>
    </article>

    <article class="bn-tile">
      <p class="bn-label">speaker amp</p>
      <p class="bn-value" class:muted={snapshot?.controls.amp.enabled == null}>
        {snapshot?.controls.amp.enabled == null
          ? "—"
          : snapshot.controls.amp.enabled
            ? "ON"
            : "OFF"}
      </p>
      <p class="bn-foot">
        MAX98357A · P0.01 SD_MODE {snapshot?.controls.amp.enabled
          ? "high"
          : "low = shutdown"}
      </p>
    </article>

    <article class="bn-tile">
      <p class="bn-label">esp32 link</p>
      <p class="bn-value" class:muted={!snapshot?.controls.esp32.state}>
        {snapshot?.controls.esp32.state === "ok"
          ? "LINKED"
          : (snapshot?.controls.esp32.state ?? "—").toUpperCase()}
      </p>
      <p class="bn-foot">
        P0.00 tx / P0.05 rx ·
        {#if snapshot?.controls.esp32.state}
          uart1
        {:else}
          <!-- Absent means the firmware never got as far as probing it — right
               now it halts in show_error() before pendant_bt_init(). "Not
               probed" and "probed and silent" are different facts and only one
               of them is about a wire. -->
          <span class="bn-waiting">not probed yet</span>
        {/if}
      </p>
    </article>
  </section>
  {/if}

  <!--
    THE LINKS — "is this thing talking to anything", below the controls.

    Placement is a DESIGN.md call, not an accident. The controls are the main
    feature and must hold the most visual field: the owner reads them while
    looking up from a breadboard with a wire in his hand, several times a
    minute. Connectivity gets checked when something is wrong, which is far
    rarer, so a wall of status text above the tiles would invert the hierarchy
    for the sake of the less-used answer. Smaller type here says the same thing
    a second way — this row is secondary, and it reads as one glance rather
    than eleven.

    The mic is deliberately NOT repeated here even though it is a "status": it
    already owns the two largest tiles above (the sense pin and the level), and
    DESIGN.md is explicit about not repeating what adds no value.
  -->
  {#if !LOCAL_ONLY}
    <section class="bn-links" aria-label="Links and remote agents">
      <p class="bn-label">links</p>
      <div class="bn-linkgrid">
        <article class="bn-link" class:up={snapshot?.links.lte.on}>
          <p class="bn-linklabel">lte</p>
          <p class="bn-linkvalue" class:muted={!snapshot?.links.lte.reported}>
            {snapshot?.links.lte.reported ? (snapshot.links.lte.word ?? "—") : "—"}
          </p>
          <p class="bn-linkfoot">
            {#if !snapshot?.links.lte.reported}
              <span class="bn-waiting">not reported yet</span>
            {:else}
              {snapshot.links.lte.operator ?? "no operator"}
              {#if snapshot.links.lte.rsrpDbm != null}· {dbm(snapshot.links.lte.rsrpDbm)}{/if}
              {#if snapshot.links.lte.band != null}· b{snapshot.links.lte.band}{/if}
            {/if}
          </p>
        </article>

        <article class="bn-link" class:up={snapshot?.links.socket.up}>
          <p class="bn-linklabel">relay socket</p>
          <p class="bn-linkvalue" class:muted={!snapshot?.links.socket.reported}>
            {#if !snapshot?.links.socket.reported}
              —
            {:else}
              {snapshot.links.socket.up ? "UP" : "DOWN"}
            {/if}
          </p>
          <p class="bn-linkfoot">
            {#if !snapshot?.links.socket.reported}
              <span class="bn-waiting">not reported yet</span>
            {:else}
              {idle(snapshot.links.socket.idleMs) || "on the pendant"}
            {/if}
          </p>
        </article>

        <article class="bn-link" class:up={snapshot?.links.bt.connected}>
          <p class="bn-linklabel">bluetooth sink</p>
          <p class="bn-linkvalue" class:muted={!snapshot?.links.bt.reported}>
            {#if !snapshot?.links.bt.reported}
              —
            {:else if snapshot.links.bt.connected}
              PAIRED
            {:else if snapshot.links.bt.name}
              KNOWN
            {:else}
              NONE
            {/if}
          </p>
          <p class="bn-linkfoot">
            {#if !snapshot?.links.bt.reported}
              <span class="bn-waiting">not reported yet</span>
            {:else if snapshot.links.bt.note}
              <span class="bn-waiting">{snapshot.links.bt.note}</span>
            {:else if snapshot.links.bt.name}
              <!-- Remembered is not connected, and the wording keeps them apart. -->
              {snapshot.links.bt.name}{snapshot.links.bt.connected ? "" : " · remembered, not reached"}
            {:else}
              no sink remembered
            {/if}
          </p>
        </article>

        {#each remotes as remote (remote.key)}
          <article class="bn-link" class:up={remote.up}>
            <p class="bn-linklabel">{remote.label}</p>
            <p class="bn-linkvalue" class:muted={remote.up == null}>
              {remote.up == null ? "—" : remote.up ? "UP" : "DOWN"}
            </p>
            <p class="bn-linkfoot">{remote.detail}</p>
          </article>
        {/each}
      </div>
    </section>
  {/if}

  <!-- Same job as the tiles above: is the thing that should have happened
       happening. Quiet, and last, because it is checked after a wire is moved
       rather than while it is being moved. -->
  {#if playable.length}
    <section class="bn-heard" aria-label="What it should have played">
      <p class="bn-label">what it should have played</p>
      <ul>
        {#each playable as item (item.id)}
          <li>
            <div class="bn-heard-line">
              <span class="bn-heard-title">{item.title}</span>
              <span class="bn-heard-when">{clock(item.when)}</span>
            </div>
            <audio controls preload="none" src={item.src} aria-label={item.title}></audio>
            <p class="bn-foot">
              relay sent it ·
              {#if item.played}
                the pendant played it
              {:else}
                <span class="bn-waiting">no playback confirmed on the device</span>
              {/if}
            </p>
          </li>
        {/each}
      </ul>
      <p class="bn-foot">
        {#if snapshot?.monitor.available}
          Live monitor available at {snapshot.monitor.endpoint}
        {:else}
          Live monitoring while a reply streams is not wired yet — {snapshot?.monitor
            .reason ?? "the relay does not fan out device audio"}.
        {/if}
      </p>
    </section>
  {:else if runsError}
    <p class="bn-meta">Recent replies unavailable — {runsError}</p>
  {/if}

  {#if !LOCAL_ONLY}
  <p class="bn-meta">
    {snapshot?.stream.source === "bench-json"
      ? "machine telemetry"
      : snapshot?.stream.source === "selftest-text"
        ? "parsed from the self-test console"
        : "no source yet"}
    · {snapshot?.stream.linesParsed ?? 0} of {snapshot?.stream.linesSeen ?? 0} lines read
    {#if snapshot?.firmware.phase}· phase {snapshot.firmware.phase}{/if}
    <!-- Counts and spans are per-window, and a gap ends the window: the owner
         rewires while he watches, so evidence from before a gap may describe a
         circuit that no longer exists. Saying so beats letting the numbers read
         as the whole session. -->
    {#if snapshot?.stream.continuityGapMs}· counts restarted after a
      {Math.round(snapshot.stream.continuityGapMs / 1000)}s gap{/if}
  </p>
  {/if}
</main>

<style>
  /*
   * Scoped rather than added to globals.css: that stylesheet is 3,000 lines
   * and is being edited by other people this week, and none of these rules is
   * wanted anywhere but here.
   */
  .bn {
    min-height: 100vh;
    background: var(--background);
    color: var(--ink);
    font-family: var(--font-geist-sans);
    padding: var(--s5) var(--s5) var(--s6);
    display: flex;
    flex-direction: column;
    gap: var(--s4);
  }

  .bn-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--s4);
    flex-wrap: wrap;
  }

  h1 {
    font-size: var(--fs-title);
    font-weight: var(--w-heavy);
    letter-spacing: 0.18em;
  }

  .bn-sub {
    font-family: var(--font-geist-mono);
    font-size: var(--fs-small);
    color: var(--muted);
  }

  .bn-status {
    display: flex;
    align-items: center;
    gap: var(--s3);
  }

  .bn-pill {
    font-family: var(--font-geist-mono);
    font-size: var(--fs-small);
    letter-spacing: 0.1em;
    padding: var(--s1) var(--s3);
    border-radius: 999px;
    border: 1px solid var(--line-strong);
    color: var(--amber);
  }

  .bn-pill.on {
    color: var(--green);
    border-color: color-mix(in srgb, var(--green) 45%, transparent);
  }

  .bn-pill.stub {
    color: var(--amber);
  }

  .bn-age {
    font-family: var(--font-geist-mono);
    font-size: var(--fs-small);
    color: var(--muted);
  }

  .bn-note {
    font-size: var(--fs-body);
    color: var(--amber);
    background: var(--raise-1);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: var(--s3) var(--s4);
    max-width: var(--measure);
  }

  .bn-note code {
    font-family: var(--font-geist-mono);
    font-size: var(--fs-small);
  }

  /* The values are the page. Everything above is one line of chrome. */
  .bn-grid {
    flex: 1;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(228px, 1fr));
    gap: var(--s4);
    align-content: start;
    /* The two double-width tiles (pot, mic level) otherwise leave a hole beside
       whichever single tile lands next to them — worst at 375px, where the grid
       is two columns and a wide tile can never share a row. Dense packing pulls
       a later tile into the hole instead. DESIGN.md: no awkward empty spaces. */
    grid-auto-flow: dense;
  }

  /*
   * No transition. This animated the ENTIRE grid whenever `live` flipped, and
   * `live` flips on a threshold the sample jitter crosses — so the whole page
   * breathed while he turned the knob. A standby grid is dimmer; it does not
   * need to animate its way there.
   */
  .bn-grid.standby {
    opacity: 0.42;
  }

  .bn-tile {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 16px;
    padding: var(--s4);
    display: flex;
    flex-direction: column;
    gap: var(--s3);
    min-height: 168px;
  }

  .bn-wide {
    grid-column: span 2;
  }

  /*
   * The flash he asked for. A 120 ms press is invisible if the tile only shows
   * a live level, so the edge itself gets a short, unmissable pulse — and the
   * recency line in the tile carries it afterwards.
   */
  .bn-tile.flash {
    animation: bn-press 900ms ease-out;
  }

  @keyframes bn-press {
    0% {
      background: color-mix(in srgb, var(--green) 42%, var(--panel));
      border-color: var(--green);
    }
    100% {
      background: var(--panel);
      border-color: var(--line);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .bn-tile.flash {
      animation: none;
      border-color: color-mix(in srgb, var(--green) 55%, transparent);
    }
  }

  .bn-tile.hot {
    border-color: color-mix(in srgb, var(--green) 55%, transparent);
    background: color-mix(in srgb, var(--green) 9%, var(--panel));
  }

  .bn-label {
    font-family: var(--font-geist-mono);
    font-size: var(--fs-micro);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .bn-value {
    font-size: var(--fs-display);
    /* Proportional digits change width as values change, which resizes the
       tile, which reflows the grid — the "whole page moves" he reported. */
    font-variant-numeric: tabular-nums;
    font-weight: var(--w-heavy);
    line-height: 1.05;
    letter-spacing: -0.01em;
    margin-top: auto;
    /* Break between words only. A value split mid-word ("SHUTDO WN") is
       unreadable at a metre, which is the only distance this page is for. */
    overflow-wrap: break-word;
  }

  .bn-value-tight {
    margin: 0;
  }

  .bn-value.muted {
    color: var(--muted);
  }

  .bn-tile.hot .bn-value {
    color: var(--green);
  }

  .bn-foot {
    font-family: var(--font-geist-mono);
    font-size: var(--fs-small);
    color: var(--ink-2);
    font-variant-numeric: tabular-nums;
    /*
     * Two lines' worth, always. The foot is the text most likely to wrap from
     * one line to two as a value changes ("raw 171" -> "raw 1710"), and on a
     * dense auto-fit grid one tile growing a line shoves every tile after it.
     */
    min-height: 2.6em;
  }

  /* Amber, never red: an unwired pin is a question, not a failure. */
  .bn-waiting {
    color: var(--amber);
  }

  .bn-bar {
    height: 10px;
    border-radius: 999px;
    background: var(--raise-2);
    overflow: hidden;
  }

  .bn-bar span {
    display: block;
    height: 100%;
    background: var(--green);
    transition: width 120ms linear;
  }

  .bn-spark {
    width: 100%;
    height: 34px;
  }

  .bn-spark polyline {
    fill: none;
    stroke: var(--blue);
    stroke-width: 1.5;
    stroke-linejoin: round;
    vector-effect: non-scaling-stroke;
  }

  .bn-dial {
    display: flex;
    align-items: center;
    gap: var(--s4);
    margin-top: auto;
  }

  .bn-dial svg {
    width: 72px;
    height: 72px;
    flex: none;
  }

  .bn-dial-ring {
    fill: none;
    stroke: var(--line-strong);
    stroke-width: 2;
  }

  .bn-dial-hand {
    stroke: var(--green);
    stroke-width: 4;
    stroke-linecap: round;
    transform-origin: 36px 36px;
    transition: transform 120ms ease-out;
  }

  /* Secondary by design: smaller type and a tighter tile than the controls
     above, so the hierarchy is visible before any of it is read. */
  .bn-links {
    display: flex;
    flex-direction: column;
    gap: var(--s3);
    border-top: 1px solid var(--line);
    padding-top: var(--s4);
  }

  .bn-linkgrid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(148px, 1fr));
    gap: var(--s3);
  }

  .bn-link {
    background: var(--raise-1);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: var(--s3);
    display: flex;
    flex-direction: column;
    gap: var(--s1);
    min-width: 0;
  }

  .bn-link.up {
    border-color: color-mix(in srgb, var(--green) 40%, transparent);
  }

  .bn-linklabel {
    font-family: var(--font-geist-mono);
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .bn-linkvalue {
    font-size: var(--fs-headline);
    font-variant-numeric: tabular-nums;
    font-weight: var(--w-heavy);
    line-height: 1.1;
  }

  .bn-link.up .bn-linkvalue {
    color: var(--green);
  }

  .bn-linkvalue.muted {
    color: var(--muted);
  }

  .bn-linkfoot {
    font-family: var(--font-geist-mono);
    font-size: var(--fs-small);
    color: var(--ink-2);
    overflow-wrap: break-word;
  }

  .bn-heard {
    border-top: 1px solid var(--line);
    padding-top: var(--s4);
    display: flex;
    flex-direction: column;
    gap: var(--s3);
  }

  .bn-heard ul {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: var(--s4);
  }

  .bn-heard li {
    display: flex;
    flex-direction: column;
    gap: var(--s2);
    min-width: 0;
  }

  .bn-heard-line {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--s3);
  }

  .bn-heard-title {
    font-size: var(--fs-body);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bn-heard-when {
    font-family: var(--font-geist-mono);
    font-size: var(--fs-small);
    color: var(--muted);
    flex: none;
  }

  .bn-heard audio {
    width: 100%;
    height: 32px;
  }

  .bn-meta {
    font-family: var(--font-geist-mono);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
  }

  @media (max-width: 700px) {
    .bn {
      padding: var(--s4) var(--s3) var(--s5);
    }

    .bn-grid {
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: var(--s3);
    }

    .bn-tile {
      min-height: 132px;
      padding: var(--s3);
    }

    /* Two narrow columns still leave the pot and the meter room to be read. */
    .bn-wide {
      grid-column: span 2;
    }
  }
</style>
