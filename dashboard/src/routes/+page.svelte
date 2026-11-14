<script lang="ts">
  /*
   * The dashboard's home: every task the owner has given any agent, on any machine, and a box to
   * hand an agent the next one. The same page in Hive's desktop app, on the website, on the phone
   * and in the browser extension; only the host behind /api/* differs (see $lib/dataSource).
   *
   * Order is what needs the owner, then what's being worked on, then what hasn't started, then
   * what's done, each newest first, similar tasks (the same part of a project) together. A task
   * shows its title, the owner's own words it came from, what happened, what it cost (the agent's
   * time against the estimate, tokens) and where it lives (agent, machine, project, part). Above
   * the sections, the agents at work and the task each is on. Choosing a part starts the next
   * instruction there.
   */
  import { onMount } from "svelte";
  import { base } from "$app/paths";
  import {
    fetchAgents,
    fetchTaskBoard,
    sendToAgent,
    type AgentChoice,
  } from "$lib/dataSource";
  import {
    HARNESSES,
    STATUS_WORDS,
    agentsAtWork,
    ago,
    byPart,
    cost,
    estimates,
    normalizeBoard,
    parts,
    projects,
    sections,
    where,
  } from "$lib/tasks.js";

  type Board = ReturnType<typeof normalizeBoard>;

  const REFRESH_MS = 15_000;

  let board = $state<Board | null>(null);
  let loadError = $state("");
  let agents = $state<AgentChoice[]>([]);
  let agent = $state("");
  let text = $state("");
  let sending = $state(false);
  let sent = $state<{ ok: boolean; text: string } | null>(null);
  let project = $state("");
  let part = $state("");
  let query = $state("");
  let showAllDone = $state(false);

  const shown = $derived(
    board
      ? sections(board.tasks, { project, part, query, doneLimit: showAllDone ? 500 : 12 })
      : [],
  );
  const projectList = $derived(board ? projects(board.tasks).slice(0, 8) : []);
  const partList = $derived(board ? parts(board.tasks, project).slice(0, 12) : []);
  const projectChosen = $derived(projectList.find((p) => p.key === project));
  const partChosen = $derived(partList.find((p) => p.key === part));
  const working = $derived(board ? agentsAtWork(board.tasks, board.now) : []);
  const pace = $derived(board ? estimates(board.tasks) : null);
  const chosen = $derived(agents.find((a) => a.id === agent));
  const openCount = $derived(
    board ? board.tasks.filter((t) => !["done", "dropped"].includes(t.status)).length : 0,
  );

  async function refresh() {
    try {
      board = normalizeBoard(await fetchTaskBoard());
      loadError = "";
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    }
  }

  async function loadAgents() {
    try {
      agents = await fetchAgents();
      if (!agents.some((a) => a.id === agent)) {
        agent = (agents.find((a) => a.available) ?? agents[0])?.id ?? "";
      }
    } catch {
      agents = [];
    }
  }

  async function send(event?: Event) {
    event?.preventDefault();
    const words = text.trim();
    if (!words || !chosen?.available || sending) return;
    sending = true;
    sent = null;
    try {
      // An instruction started from a part says where it belongs, so the agent files its tasks there.
      const scope = partChosen
        ? `For ${projectChosen ? `${projectChosen.name} › ` : ""}${partChosen.name}: `
        : projectChosen
          ? `For ${projectChosen.name}: `
          : "";
      const answer = await sendToAgent(chosen.id, scope + words);
      if (answer.accepted === false) {
        sent = { ok: false, text: answer.error || `${chosen.name} didn't take it.` };
      } else {
        sent = {
          ok: true,
          text:
            answer.accepted === null
              ? `Sent. ${chosen.name} may already have it; check below before sending it again.`
              : `${chosen.name} has it. Its tasks show up below once it saves them.`,
        };
        text = "";
        setTimeout(refresh, 3000);
      }
    } catch (error) {
      sent = { ok: false, text: error instanceof Error ? error.message : String(error) };
    } finally {
      sending = false;
    }
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send(event);
  }

  onMount(() => {
    refresh();
    loadAgents();
    const timer = setInterval(refresh, REFRESH_MS);
    const focus = () => {
      refresh();
      loadAgents();
    };
    window.addEventListener("focus", focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  });
</script>

<main class="dashboard-shell tasks-page">
  <header class="topbar">
    <div class="brand">
      <!-- Hive's icon: static/hive.svg links to branding/hive.svg at the repository's root, its only copy. -->
      <img class="brand-mark" src="{base}/hive.svg" alt="Hive" title="Hive" />
      <h1>Hive</h1>
    </div>
    <nav class="top-actions" aria-label="Dashboard">
      <a class="hive-link current" href="{base}/" aria-current="page">Tasks</a>
      <a class="hive-link" href="{base}/voice">Voice</a>
      <a class="hive-link" href="{base}/pc">PC</a>
      <a class="hive-link" href="{base}/hive">⬡ Hive</a>
    </nav>
  </header>

  <form class="composer" onsubmit={send}>
    <label class="visually-hidden" for="task-text">Tell an agent what to do</label>
    <textarea
      id="task-text"
      rows="3"
      placeholder={partChosen
        ? `Tell an agent what to do in ${partChosen.name}…`
        : projectChosen
          ? `Tell an agent what to do in ${projectChosen.name}…`
          : "Tell an agent what to do…"}
      bind:value={text}
      onkeydown={keydown}
    ></textarea>
    <div class="composer-row">
      <label class="agent-pick">
        <span>To</span>
        <select bind:value={agent} disabled={!agents.length}>
          {#each agents as a (a.id)}
            <option value={a.id} disabled={!a.available}>{a.name} · {a.where}</option>
          {:else}
            <option value="">No agent reachable</option>
          {/each}
        </select>
      </label>
      <button type="submit" disabled={!text.trim() || !chosen?.available || sending}>
        {sending ? "Sending…" : "Send"}
      </button>
    </div>
    {#if chosen && !chosen.available && chosen.note}
      <p class="composer-note">{chosen.note}</p>
    {:else if sent}
      <p class="composer-note" class:bad={!sent.ok} role="status">{sent.text}</p>
    {/if}
  </form>

  {#if loadError && !board}
    <p class="board-note bad" role="alert">Couldn't load the tasks: {loadError}</p>
  {:else if !board}
    <p class="board-note">Loading the tasks…</p>
  {:else}
    <div class="board-head">
      <p class="board-note">
        {openCount} unfinished ·
        {board.source === "cloud" ? "every machine" : "this machine only"}
        {#if board.note}· {board.note}{/if}
        {#if loadError}· last refresh failed: {loadError}{/if}
        {#if pace}
          · done tasks lately took {pace.ratio.toFixed(1)}× their estimates
        {/if}
      </p>
      <input
        class="search"
        type="search"
        placeholder="Search tasks"
        aria-label="Search tasks"
        bind:value={query}
      />
    </div>

    {#if projectList.length > 1}
      <div class="chips" role="group" aria-label="Project">
        <button type="button" class:on={!project} onclick={() => (project = "")}>All</button>
        {#each projectList as p (p.key)}
          <button
            type="button"
            class:on={project === p.key}
            onclick={() => {
              project = project === p.key ? "" : p.key;
              part = "";
            }}
          >
            {p.name}{#if p.open}<span class="count">{p.open}</span>{/if}
          </button>
        {/each}
      </div>
    {/if}

    {#if partList.length}
      <div class="chips parts" role="group" aria-label="Part of the project">
        <span class="chips-label">Parts</span>
        {#each partList as p (p.key)}
          <button
            type="button"
            class:on={part === p.key}
            title="Show this part's tasks; what you send goes to this part"
            onclick={() => (part = part === p.key ? "" : p.key)}
          >
            {p.name}{#if p.open}<span class="count">{p.open}</span>{/if}
          </button>
        {/each}
      </div>
    {/if}

    {#if working.length}
      <section class="task-section" aria-labelledby="h-agents">
        <h2 id="h-agents">Agents at work <span class="count">{working.length}</span></h2>
        <ul class="task-list agents">
          {#each working as a (a.key)}
            <li class="task agent">
              <p class="meta">
                <strong>{HARNESSES[a.harness as keyof typeof HARNESSES] ?? a.harness}</strong>
                · {a.machine}{#if a.projectName} · {a.projectName}{/if} · {ago(a.last, board.now)}
              </p>
              {#each a.on as t (t.key)}
                <p class="title"><span class="tag on">On</span> {t.title} <span class="id">{t.id}</span></p>
              {/each}
              {#if !a.on.length && a.open[0]}
                <p class="title"><span class="tag">Next</span> {a.open[0].title} <span class="id">{a.open[0].id}</span></p>
              {/if}
              {#if a.open.length > (a.on.length ? 0 : 1)}
                <p class="meta">{a.open.length - (a.on.length ? 0 : 1)} more not started</p>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#each shown as section (section.id)}
      {#if section.tasks.length || section.id === "needs-you"}
        <section class="task-section" aria-labelledby="h-{section.id}">
          <h2 id="h-{section.id}">
            {section.title}
            <span class="count">{section.total}</span>
          </h2>
          {#if !section.tasks.length}
            <p class="empty">Nothing waiting on you.</p>
          {/if}
          {#each byPart(section.tasks) as run (run.part)}
          {#if run.part && !part}
            <h3 class="part-head">{run.part} <span class="count">{run.tasks.length}</span></h3>
          {/if}
          <ul class="task-list">
            {#each run.tasks as task (task.key)}
              <li class="task status-{task.status}">
                <div class="task-main">
                  <span class="dot" aria-hidden="true"></span>
                  <div>
                    <p class="title">{task.title}</p>
                    {#if task.quote && task.quote !== task.title}
                      <p class="quote">“{task.quote}”</p>
                    {/if}
                    {#if task.outcome}
                      <p class="outcome">{task.outcome}</p>
                    {/if}
                    <p class="meta">
                      <span class="status-word">{STATUS_WORDS[task.status as keyof typeof STATUS_WORDS] ?? task.status}</span>
                      · {where(task)} · {ago(task.updated, board.now)} · {task.id}
                    </p>
                    {#if cost(task)}
                      <p class="meta cost">{cost(task)}</p>
                    {/if}
                  </div>
                </div>
              </li>
            {/each}
          </ul>
          {/each}
          {#if section.id === "done" && section.total > section.tasks.length}
            <button type="button" class="more" onclick={() => (showAllDone = true)}>
              Show all {section.total}
            </button>
          {/if}
        </section>
      {/if}
    {/each}

    {#if board.unsplit.length}
      <details class="task-section extra">
        <summary>Messages not split into tasks yet <span class="count">{board.unsplit.length}</span></summary>
        <ul class="task-list">
          {#each board.unsplit as m (m.key)}
            <li class="task">
              <p class="quote">“{m.text}”</p>
              <p class="meta">{where({ harness: m.harness, machine: m.machine, projectName: m.projectName })} · {ago(m.said, board.now)} · {m.id}</p>
            </li>
          {/each}
        </ul>
      </details>
    {/if}

    {#if board.rules.length}
      <details class="task-section extra">
        <summary>Your standing rules <span class="count">{board.rules.length}</span></summary>
        <ul class="task-list">
          {#each board.rules as r (r.key)}
            <li class="task">
              <p class="title">{r.text}</p>
              {#if r.quote}<p class="quote">“{r.quote}”</p>{/if}
              <p class="meta">{r.projectName || "everywhere"} · {r.id}</p>
            </li>
          {/each}
        </ul>
      </details>
    {/if}
  {/if}
</main>

<style>
  .tasks-page {
    max-width: 860px;
  }
  .hive-link.current {
    color: var(--ink);
    background: var(--raise-2);
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
  .composer {
    display: grid;
    gap: var(--s3);
    padding: var(--s4);
    margin-bottom: var(--s6);
    border-radius: 16px;
    background: var(--panel);
    border: 1px solid var(--line);
  }
  .composer textarea {
    width: 100%;
    resize: vertical;
    min-height: 72px;
    padding: var(--s3);
    border-radius: 10px;
    border: 1px solid var(--line-strong);
    background: var(--panel-strong);
    color: var(--ink);
    font: inherit;
    font-size: var(--fs-body);
  }
  .composer-row {
    display: flex;
    gap: var(--s3);
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
  }
  .agent-pick {
    display: flex;
    gap: var(--s2);
    align-items: center;
    color: var(--muted);
    font-size: var(--fs-small);
  }
  select,
  .search {
    padding: 6px 10px;
    border-radius: 8px;
    border: 1px solid var(--line-strong);
    background: var(--panel-strong);
    color: var(--ink);
    font: inherit;
    font-size: var(--fs-small);
  }
  .composer button[type="submit"] {
    padding: 8px 20px;
    border-radius: 10px;
    border: 0;
    background: var(--green);
    color: #06110b;
    font-weight: var(--w-heavy);
    cursor: pointer;
  }
  .composer button[disabled] {
    opacity: 0.45;
    cursor: default;
  }
  .composer-note,
  .board-note {
    margin: 0;
    color: var(--ink-2);
    font-size: var(--fs-small);
  }
  .bad {
    color: var(--red);
  }
  .board-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--s3);
    flex-wrap: wrap;
    margin-bottom: var(--s3);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2);
    margin-bottom: var(--s5);
  }
  .chips button,
  .more {
    padding: 4px 12px;
    border-radius: 999px;
    border: 1px solid var(--line-strong);
    background: transparent;
    color: var(--ink-2);
    font: inherit;
    font-size: var(--fs-small);
    cursor: pointer;
  }
  .chips button.on {
    background: var(--raise-2);
    color: var(--ink);
    border-color: var(--ink-2);
  }
  .chips.parts {
    margin-top: calc(-1 * var(--s3));
    align-items: center;
  }
  .chips-label {
    color: var(--muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-weight: var(--w-heavy);
    margin-right: var(--s1);
  }
  .part-head {
    margin: var(--s3) 0 var(--s2);
    color: var(--ink-2);
    font-size: var(--fs-small);
    font-weight: var(--w-heavy);
  }
  .agent .meta:first-child {
    margin-top: 0;
  }
  .agent .meta strong {
    color: var(--ink-2);
  }
  .agent .title {
    margin-top: 4px;
  }
  .tag {
    display: inline-block;
    margin-right: 6px;
    padding: 0 6px;
    border-radius: 4px;
    background: var(--raise-2);
    color: var(--ink-2);
    font-size: var(--fs-micro);
    font-weight: var(--w-normal);
    vertical-align: 2px;
  }
  .tag.on {
    color: var(--blue);
  }
  .id {
    color: var(--muted);
    font-size: var(--fs-micro);
    font-weight: var(--w-normal);
  }
  .meta.cost {
    margin-top: 2px;
  }
  .count {
    margin-left: 6px;
    color: var(--muted);
    font-size: var(--fs-micro);
    font-weight: var(--w-normal);
  }
  .task-section {
    margin-bottom: var(--s6);
  }
  .task-section h2,
  .task-section summary {
    margin: 0 0 var(--s3);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    font-weight: var(--w-heavy);
    cursor: default;
  }
  .task-section summary {
    cursor: pointer;
  }
  .task-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--s2);
  }
  .task {
    padding: var(--s3) var(--s4);
    border-radius: 12px;
    background: var(--raise-1);
  }
  .task-main {
    display: grid;
    grid-template-columns: 10px 1fr;
    gap: var(--s3);
    align-items: start;
  }
  .dot {
    width: 8px;
    height: 8px;
    margin-top: 7px;
    border-radius: 50%;
    background: var(--muted);
  }
  .status-waiting .dot,
  .status-blocked .dot {
    background: var(--amber);
  }
  .status-active .dot {
    background: var(--blue);
  }
  .status-done .dot {
    background: var(--green);
  }
  .status-dropped .dot {
    background: var(--line-strong);
  }
  .title {
    margin: 0;
    color: var(--ink);
    font-size: var(--fs-body);
    font-weight: var(--w-heavy);
  }
  .quote {
    margin: 2px 0 0;
    color: var(--ink-2);
    font-size: var(--fs-small);
  }
  .outcome {
    margin: 6px 0 0;
    color: var(--ink-2);
    font-size: var(--fs-small);
    max-width: var(--measure);
  }
  .meta {
    margin: 6px 0 0;
    color: var(--muted);
    font-size: var(--fs-micro);
  }
  .status-blocked .status-word,
  .status-waiting .status-word {
    color: var(--amber);
  }
  .empty {
    color: var(--muted);
    font-size: var(--fs-small);
    margin: 0;
  }
  .more {
    margin-top: var(--s3);
  }
</style>
