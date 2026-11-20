<script lang="ts">
  /*
   * The club's way into Hive (cloud/tasks/club.js): a member signs in once with the invite link the
   * owner sent them, then asks Hive to change itself. Hive on its VM does each request as changes to its
   * own code, in its own worktree, tested, landed and put live on everyone's devices; the steps show here
   * as they happen. Members see the club's requests, who's working on which files, and their messages;
   * nothing of the owner's own board. Their own devices that take the club's releases show with the
   * commit each runs (cloud/tasks/nodes.js), and Hive Phone's updates come from the board's SideStore source.
   * Connect this Mac opens Hive on the member's Mac with a one-use code, which Hive trades for the Mac's own
   * key (club.js /v1/club/devices/code and /connect), so that Mac takes the club's releases too. Get Hive
   * for Mac downloads the notarized app (club.js /v1/club/download/mac), which sets itself up when opened.
   * On a Windows PC the same are Get Hive for Windows (Hive.exe, the newest windows release: club.js
   * /v1/club/download/windows) and Connect this PC (the same one-use code; hive-windows opens the link).
   */
  /* eslint-disable @typescript-eslint/no-explicit-any -- The board answers schemaless JSON here. */
  import { onMount } from "svelte";
  import { base } from "$app/paths";

  type Board = { me: string; now: number; requests: any[]; tasks: any[]; runs: any[]; steps: any[]; members: any[] };

  let signedIn = $state<boolean | null>(null);
  let board = $state<Board | null>(null);
  let agents = $state<any[]>([]);
  let messages = $state<any[]>([]);
  let invite = $state("");
  let words = $state("");
  let follows = $state<number | null>(null);
  let note = $state("");
  let sending = $state(false);
  let to = $state("all");
  let said = $state("");
  let devices = $state<any | null>(null);
  let devicesAt = 0;
  let onMac = $state(false);
  let onWindows = $state(false);
  let connecting = $state(false);
  let connectNote = $state("");

  const KIND: Record<string, string> = { mac: "Mac", windows: "Windows", vm: "VM", phone: "iPhone", extension: "Browser" };
  const short = (commit: unknown, release: unknown) =>
    typeof commit === "string" && /^[0-9a-f]{40}$/.test(commit) ? commit.slice(0, 7) : String(release ?? "").slice(0, 12);

  async function api(path: string, body?: unknown) {
    const response = await fetch(`${base}/club/api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    const value = await response.json().catch(() => ({}));
    if (response.status === 401) signedIn = false;
    if (!response.ok) throw new Error(value.error || `${path} failed (${response.status})`);
    return value;
  }

  async function load() {
    try {
      board = await api("board");
      signedIn = true;
    } catch (error) {
      if (signedIn !== false) note = (error as Error).message;
    }
  }

  async function connectDevice() {
    connecting = true;
    connectNote = "";
    try {
      const { link } = await api("devices/code", {});
      window.location.href = link;
      connectNote = onWindows
        ? "Hive opens on this PC and asks to connect it; it shows here within a minute. If nothing opens, get Hive for Windows first."
        : "Hive opens on this Mac and connects it; it shows here within a few minutes. If nothing opens, get Hive for Mac first.";
      devicesAt = 0;
    } catch (error) {
      connectNote = (error as Error).message;
    } finally {
      connecting = false;
    }
  }

  async function loadTeam() {
    if (!signedIn || !board) return;
    if (Date.now() - devicesAt > 60_000) {
      devicesAt = Date.now();
      devices = await api("devices").catch(() => devices);
    }
    try {
      agents = (await api("team/agents")).agents ?? [];
      const fresh = (await api(`team/inbox?agent=${encodeURIComponent(board.me)}`)).messages ?? [];
      if (fresh.length) messages = [...messages, ...fresh].slice(-50);
    } catch {
      // Shown again on the next look.
    }
  }

  async function join(event: Event) {
    event.preventDefault();
    note = "";
    // The whole link or just its invite.
    const code = invite.trim().match(/[0-9a-f]{48}/)?.[0] ?? "";
    if (!code) {
      note = "That isn't an invite link.";
      return;
    }
    try {
      await api("join", { invite: code });
      invite = "";
      await load();
      await loadTeam();
    } catch (error) {
      note = (error as Error).message;
    }
  }

  async function leave() {
    await api("leave", {}).catch(() => {});
    signedIn = false;
    board = null;
    messages = [];
  }

  async function send(event: Event) {
    event.preventDefault();
    if (!words.trim() || sending) return;
    sending = true;
    note = "";
    try {
      const sent = await api("requests", { text: words.trim(), ...(follows ? { follows } : {}) });
      words = "";
      follows = null;
      note = sent.ahead ? `Sent as R${sent.id}; ${sent.ahead} ahead of it.` : `Sent as R${sent.id}.`;
      await load();
    } catch (error) {
      note = (error as Error).message;
    } finally {
      sending = false;
    }
  }

  async function stop(id: number) {
    try {
      await api("stop", { id });
      await load();
    } catch (error) {
      note = (error as Error).message;
    }
  }

  async function message(event: Event) {
    event.preventDefault();
    if (!said.trim() || !board) return;
    try {
      await api("team/send", { from: board.me, to: to.trim() || "all", text: said.trim() });
      messages = [...messages, { id: `me-${Date.now()}`, from: board.me, to: to.trim() || "all", text: said.trim(), at: Math.floor(Date.now() / 1000) }];
      said = "";
    } catch (error) {
      note = (error as Error).message;
    }
  }

  const going = (r: any) => ["queued", "planning", "working"].includes(r.status);
  const me = $derived(board?.members.find((m: any) => m.name === board?.me));
  const tasksOf = (id: number) => board?.tasks.filter((t: any) => t.request === id) ?? [];
  // The newest steps of a request's runs, oldest first: what its agents are doing now.
  const stepsOf = (id: number) => {
    const runs = new Set(board?.runs.filter((r: any) => r.request === id).map((r: any) => String(r.run)));
    return (board?.steps ?? []).filter((s: any) => runs.has(String(s.run))).slice(-8);
  };
  const ago = (at: number | null) => {
    if (!at || !board) return "";
    const s = Math.max(0, board.now - at);
    return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
  };

  onMount(() => {
    onMac = /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints < 2;
    onWindows = /Windows NT/.test(navigator.userAgent);
    const url = new URL(window.location.href);
    const given = url.searchParams.get("invite");
    if (given) {
      // The invite works once: out of the address bar (and its history) at once.
      url.searchParams.delete("invite");
      history.replaceState(null, "", url);
      invite = given;
      join(new Event("submit")).then(() => {});
    } else {
      load().then(loadTeam);
    }
    const timer = setInterval(() => document.visibilityState === "visible" && signedIn && load(), 4000);
    const team = setInterval(() => document.visibilityState === "visible" && loadTeam(), 8000);
    return () => {
      clearInterval(timer);
      clearInterval(team);
    };
  });
</script>

<svelte:head><title>Hive club</title></svelte:head>

<main class="club">
  <header class="top">
    <img src="{base}/hive.svg" alt="" aria-hidden="true" />
    <h1>Hive club</h1>
    {#if signedIn && board}
      <span class="who">{board.me}</span>
      <button type="button" class="quiet" onclick={leave}>Sign out</button>
    {/if}
  </header>

  {#if signedIn === false}
    <section class="card join">
      <h2>Sign in</h2>
      <p>Paste the invite link the club's owner sent you. It works once; after that this browser stays signed in.</p>
      <form onsubmit={join}>
        <input bind:value={invite} placeholder="Invite link" aria-label="Invite link" autocomplete="off" />
        <button type="submit" disabled={!invite.trim()}>Join</button>
      </form>
      {#if note}<p class="note" role="alert">{note}</p>{/if}
    </section>
  {:else if board}
    <div class="grid">
      <div class="col">
        <form class="card composer" onsubmit={send}>
          <label for="ask">What should Hive change in itself?</label>
          <textarea id="ask" bind:value={words} rows="3" placeholder="Hive's own code: the dashboard, its agents, the Mac app, the extension…"></textarea>
          <div class="row">
            {#if follows}
              <button type="button" class="chip" onclick={() => (follows = null)} title="Send as a new request">Following R{follows} ×</button>
            {/if}
            <span class="count">{me?.going ?? 0} of {me?.max_agents ?? 0} going</span>
            <button type="submit" disabled={!words.trim() || sending}>{sending ? "Sending…" : "Send"}</button>
          </div>
          {#if note}<p class="note" role="status">{note}</p>{/if}
        </form>

        {#if !board.requests.length}
          <p class="empty">No requests from the club yet.</p>
        {/if}
        {#each board.requests as r (r.id)}
          <article class="card request" class:live={going(r)}>
            <div class="head">
              <span class="id">R{r.id}</span>
              <span class="member">{r.member}</span>
              <span class="status s-{r.status}">{r.stop_at && going(r) ? "stopping" : r.status}</span>
              <span class="when">{ago(r.updated_at)}</span>
            </div>
            <p class="words">{r.text}</p>
            {#if tasksOf(r.id).length}
              <ul class="tasks">
                {#each tasksOf(r.id) as t (t.key)}
                  <li><span class="status s-{t.status}">{t.status}</span> {t.title}</li>
                {/each}
              </ul>
            {/if}
            {#if going(r) && stepsOf(r.id).length}
              <ol class="steps">
                {#each stepsOf(r.id) as s (`${s.run}:${s.n}`)}<li>{s.text}</li>{/each}
              </ol>
            {/if}
            {#if r.outcome && !going(r)}<p class="outcome">{r.outcome}</p>{/if}
            <div class="actions">
              {#if r.member === board.me && going(r) && !r.stop_at}
                <button type="button" class="quiet" onclick={() => stop(r.id)}>Stop</button>
              {/if}
              {#if !going(r)}
                <button type="button" class="quiet" onclick={() => { follows = r.id; document.getElementById("ask")?.focus(); }}>Follow up</button>
              {/if}
            </div>
          </article>
        {/each}
      </div>

      <aside class="col side">
        <section class="card">
          <h2>Working now</h2>
          {#if !agents.length}<p class="empty">Nobody.</p>{/if}
          <ul class="agents">
            {#each agents as a (a.name)}
              <li>
                <strong>{a.name}</strong>{#if a.title} · {a.title}{/if}
                {#if a.files.length}
                  <span class="files">{a.files.map((f: any) => f.path).join(", ")}</span>
                {/if}
              </li>
            {/each}
          </ul>
        </section>

        <section class="card">
          <h2>Messages</h2>
          <ul class="messages">
            {#each messages as m (m.id)}
              <li><strong>{m.from}</strong>{#if m.to !== board.me} → {m.to}{/if}: {m.text}</li>
            {/each}
          </ul>
          <form class="say" onsubmit={message}>
            <input bind:value={to} aria-label="To" placeholder="To: an agent, a member, all or owner" />
            <input bind:value={said} aria-label="Message" placeholder="Message" />
            <button type="submit" disabled={!said.trim()}>Send</button>
          </form>
        </section>

        <section class="card">
          <h2>Members</h2>
          <ul class="members">
            {#each board.members as m (m.name)}
              <li><strong>{m.name}</strong> <span class="count">{m.going} of {m.max_agents}</span></li>
            {/each}
          </ul>
        </section>

        {#if devices}
          <section class="card">
            <h2>Your devices</h2>
            {#if !devices.nodes.filter((n: any) => n.kind !== "cli").length}
              <p class="empty">None of your devices take the club's updates yet.</p>
            {/if}
            <ul class="members">
              {#each devices.nodes.filter((n: any) => n.kind !== "cli") as n (`${n.kind}:${n.name}`)}
                <li title={n.note || ""}>
                  <strong>{KIND[n.kind] ?? n.kind} {n.name}</strong>
                  <span class="count">
                    {short(n.commit, n.version)}{#if n.current === false} → {short(n.latest_commit, n.latest)}{/if}
                    · {n.current === true ? "up to date" : n.current === false ? "updating when idle" : n.version === "dev" ? "built by hand" : "nothing published"}
                  </span>
                </li>
              {/each}
            </ul>
            {#if onMac && devices.mac_download}
              <a class="phone" href="/club/api/download/mac" download="Hive.dmg">Get Hive for Mac{devices.mac_download.size ? ` (${Math.round(devices.mac_download.size / 1048576)} MB)` : ""}</a>
            {/if}
            {#if onMac}
              <button type="button" class="link" onclick={connectDevice} disabled={connecting}>{connecting ? "Connecting…" : "Connect this Mac"}</button>
            {/if}
            {#if onWindows && devices.releases?.some((r: any) => r.kind === "windows")}
              <a class="phone" href="/club/api/download/windows" download="Hive.exe">Get Hive for Windows</a>
              <button type="button" class="link" onclick={connectDevice} disabled={connecting}>{connecting ? "Connecting…" : "Connect this PC"}</button>
            {/if}
            {#if devices.phone_source}
              <a class="phone" href={`sidestore://source?url=${encodeURIComponent(devices.phone_source)}`}>Get Hive Phone in SideStore</a>
            {/if}
            {#if connectNote}<p class="empty">{connectNote}</p>{/if}
          </section>
        {/if}
      </aside>
    </div>
  {:else}
    <p class="empty">{note || "Loading…"}</p>
  {/if}
</main>

<style>
  button.link {
    display: block;
    margin-top: 8px;
    padding: 0;
    background: transparent;
    color: var(--gold);
    font-size: var(--fs-small);
    font-weight: var(--w-normal);
  }
  .phone {
    display: inline-block;
    margin-top: 8px;
    color: var(--gold);
    font-size: var(--fs-small);
  }
  .club {
    min-height: 100vh;
    background: var(--background);
    color: var(--ink);
    padding: 20px 16px 48px;
    max-width: 1120px;
    margin: 0 auto;
    font-size: var(--fs-body);
  }
  .top {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 20px;
  }
  .top img {
    width: 28px;
    height: 28px;
  }
  h1 {
    font-size: var(--fs-title);
    font-weight: var(--w-heavy);
    margin: 0;
    flex: 1;
  }
  h2 {
    font-size: var(--fs-micro);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    margin: 0 0 10px;
  }
  .who {
    color: var(--muted);
  }
  .grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 320px;
    gap: 16px;
  }
  @media (max-width: 820px) {
    .grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  .col {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }
  .card {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 14px;
  }
  .join {
    max-width: 480px;
    margin: 10vh auto 0;
  }
  .join p {
    color: var(--muted);
  }
  form {
    display: flex;
    gap: 8px;
  }
  .composer {
    flex-direction: column;
  }
  label {
    font-weight: var(--w-heavy);
  }
  input,
  textarea {
    flex: 1;
    min-width: 0;
    background: var(--panel-strong);
    color: var(--ink);
    border: 1px solid var(--line-strong);
    border-radius: 8px;
    padding: 8px 10px;
    font: inherit;
  }
  textarea {
    resize: vertical;
  }
  button {
    background: var(--gold);
    color: var(--on-gold);
    border: 0;
    border-radius: 8px;
    padding: 8px 14px;
    font: inherit;
    font-weight: var(--w-heavy);
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  button.quiet,
  button.chip {
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--line-strong);
    font-weight: var(--w-normal);
    padding: 4px 10px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    justify-content: flex-end;
  }
  .count,
  .when {
    color: var(--muted);
    font-size: var(--fs-small);
  }
  .row .count {
    margin-right: auto;
  }
  .note {
    color: var(--amber);
    font-size: var(--fs-small);
    margin: 0;
  }
  .empty {
    color: var(--muted);
  }
  .request.live {
    border-color: var(--gold-soft);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--fs-small);
  }
  .id {
    font-family: var(--font-geist-mono);
    color: var(--muted);
  }
  .member {
    font-weight: var(--w-heavy);
  }
  .head .when {
    margin-left: auto;
  }
  .status {
    font-size: var(--fs-micro);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
  .s-working,
  .s-active,
  .s-planning {
    color: var(--gold);
  }
  .s-done {
    color: var(--green);
  }
  .s-failed,
  .s-blocked {
    color: var(--red);
  }
  .words {
    margin: 8px 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  ul,
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .tasks {
    font-size: var(--fs-small);
  }
  .steps {
    margin-top: 8px;
    font-family: var(--font-geist-mono);
    font-size: var(--fs-micro);
    color: var(--muted);
    gap: 2px;
  }
  .steps li {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .outcome {
    color: var(--muted);
    font-size: var(--fs-small);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    margin: 8px 0 0;
  }
  .actions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }
  .actions:empty {
    display: none;
  }
  .agents li,
  .messages li {
    font-size: var(--fs-small);
    overflow-wrap: anywhere;
  }
  .files {
    display: block;
    color: var(--muted);
    font-family: var(--font-geist-mono);
    font-size: var(--fs-micro);
  }
  .messages {
    max-height: 260px;
    overflow-y: auto;
    margin-bottom: 10px;
  }
  .say {
    flex-wrap: wrap;
  }
  .say input:first-child {
    flex-basis: 100%;
  }
</style>
