<script lang="ts">
  /*
   * The dashboard's home: every task the owner has given any agent, on any machine, the folders
   * they're in, the agents at work, and a box to hand an agent the next one. The same page in
   * Hive's desktop app, on the website, on the phone and in the browser extension; only the host
   * behind /api/* differs (see $lib/dataSource).
   *
   * On the left, the projects and their folders (a project's parts: "memory retrieval" in hive)
   * and the agents at work with the task each is on. Choosing a folder shows what it's for and
   * every memory its agents get (notes, specs, decisions, the reports of its done tasks), and
   * what's sent from there goes to that folder. On the right, what needs the owner, then what's
   * being worked on, then what hasn't started, then what's done, each newest first, a folder's
   * tasks together. A task shows its title, the owner's own words, what happened, what it cost
   * (the agent's time against the estimate, tokens) and opens to its report.
   *
   * Keys: ⌘K search, / write, ⌘↵ send, Esc back to everything.
   */
  import { onMount } from "svelte";
  import { base } from "$app/paths";
  import {
    fetchFolder,
    fetchTaskBoard,
    saveFolder,
    saveMemory,
    sendToHive,
    startDictation,
    type Dictation,
  } from "$lib/dataSource";
  import {
    HARNESSES,
    REQUEST_WORDS,
    STATUS_WORDS,
    agentsAtWork,
    ago,
    byFolder,
    commitUrl,
    cost,
    folderList,
    normalizeBoard,
    normalizeFolder,
    planLimits,
    projects,
    sections,
    where,
  } from "$lib/tasks.js";

  type Board = ReturnType<typeof normalizeBoard>;
  type FolderView = ReturnType<typeof normalizeFolder>;

  const REFRESH_MS = 15_000;
  const KINDS = ["note", "spec", "decision"];

  let board = $state<Board | null>(null);
  let loadError = $state("");
  let text = $state("");
  let sending = $state(false);
  let sent = $state<{ ok: boolean; text: string } | null>(null);
  // Dictation: recording while `dictation` is set, then `reading` while the speech model reads it.
  let dictation = $state<Dictation | null>(null);
  let reading = $state(false);
  let project = $state("");
  /** On a phone the projects, agents and plan limits fold away behind one toggle, so the
   * composer and the tasks come first; on wider screens they are always shown. */
  let sideOpen = $state(false);
  let folder = $state("");
  let query = $state("");
  let showAllDone = $state(false);
  let opened = $state("");
  let folderView = $state<FolderView | null>(null);
  let folderError = $state("");
  let openMemory = $state("");
  let memoryText = $state("");
  let memoryKind = $state("note");
  let savingMemory = $state(false);
  let newFolder = $state("");
  let editingAbout = $state(false);
  let aboutText = $state("");
  let searchBox = $state<HTMLInputElement | null>(null);
  let composerBox = $state<HTMLTextAreaElement | null>(null);

  const shown = $derived(
    board
      ? sections(board.tasks, { project, folder, query, doneLimit: showAllDone ? 500 : 12 })
      : [],
  );
  const projectList = $derived(board ? projects(board.tasks, board.folders).slice(0, 12) : []);
  const projectChosen = $derived(projectList.find((p) => p.key === project));
  const folders = $derived(board && project ? folderList(board.tasks, board.folders, project) : []);
  const folderChosen = $derived(folders.find((f) => f.key === folder));
  const working = $derived(board ? agentsAtWork(board.tasks, board.now) : []);
  const limits = $derived(board ? planLimits(board.limits, board.now) : []);
  // What was sent to Hive in the cloud lately: anything still going, and what ended in the last day.
  const requests = $derived(
    board
      ? board.requests
          .filter((r) => !["done", "failed"].includes(r.status) || board!.now - r.updated < 86400)
          .slice(0, 5)
      : [],
  );
  const unfinished = $derived(
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

  async function loadFolder() {
    if (!project || !folder) {
      folderView = null;
      return;
    }
    const want = `${project}/${folder}`;
    try {
      const view = normalizeFolder(await fetchFolder(project, folder));
      if (`${project}/${folder}` === want) {
        folderView = view;
        folderError = "";
      }
    } catch (error) {
      folderError = error instanceof Error ? error.message : String(error);
    }
  }

  function choose(nextProject: string, nextFolder = "") {
    sideOpen = false;
    project = nextProject;
    folder = nextFolder;
    folderView = null;
    folderError = "";
    editingAbout = false;
    openMemory = "";
    loadFolder();
  }

  async function send(event?: Event) {
    event?.preventDefault();
    const words = text.trim();
    if (!words || sending) return;
    sending = true;
    sent = null;
    try {
      // An instruction started from a folder says where it belongs: the agent files its tasks
      // there and gets every memory of the folder.
      const projectName = projectChosen?.name ?? project;
      const scope = folderChosen
        ? `For ${projectName} › ${folderChosen.name}: `
        : projectChosen
          ? `For ${projectName}: `
          : "";
      // Everything goes to Hive's agent in the cloud; it's told which device it came from.
      const answer = await sendToHive(scope + words);
      if (answer.accepted === false) {
        sent = { ok: false, text: answer.error || "Hive didn't take it." };
      } else {
        sent = {
          ok: true,
          text: answer.accepted === null ? "Sent. Check below before sending it again." : "Sent.",
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

  async function addMemory(event: Event) {
    event.preventDefault();
    const words = memoryText.trim();
    if (!words || !folderChosen || savingMemory) return;
    savingMemory = true;
    try {
      const [title, ...rest] = words.split("\n");
      await saveMemory({
        project,
        folder: folderChosen.name,
        kind: memoryKind,
        title: title.replace(/^#+\s*/, "").trim(),
        body: rest.join("\n").trim() || title.trim(),
      });
      memoryText = "";
      await Promise.all([loadFolder(), refresh()]);
    } catch (error) {
      folderError = error instanceof Error ? error.message : String(error);
    } finally {
      savingMemory = false;
    }
  }

  async function makeFolder(event: Event) {
    event.preventDefault();
    const name = newFolder.trim();
    if (!name || !project) return;
    try {
      await saveFolder({ project, name });
      newFolder = "";
      await refresh();
      choose(project, name.toLowerCase());
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    }
  }

  async function saveAbout(event: Event) {
    event.preventDefault();
    if (!folderChosen) return;
    try {
      await saveFolder({ project, name: folderChosen.name, about: aboutText.trim() });
      editingAbout = false;
      await Promise.all([loadFolder(), refresh()]);
    } catch (error) {
      folderError = error instanceof Error ? error.message : String(error);
    }
  }

  function editAbout() {
    aboutText = folderView?.about ?? folderChosen?.about ?? "";
    editingAbout = true;
  }

  function typing(target: EventTarget | null) {
    const el = target as HTMLElement | null;
    return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
  }

  function keys(event: KeyboardEvent) {
    if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      searchBox?.focus();
      searchBox?.select();
    } else if (event.key === "/" && !typing(event.target)) {
      event.preventDefault();
      composerBox?.focus();
    } else if (event.key === "Escape" && !typing(event.target)) {
      if (opened) opened = "";
      else if (folder) choose(project);
      else if (project) choose("");
    }
  }

  function composerKeys(event: KeyboardEvent) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send(event);
    else if (event.key === "Escape" && dictation) {
      event.stopPropagation();
      dictation.cancel();
      dictation = null;
    }
  }

  /** The mic: the first press starts recording, the second has the speech model write it in. */
  async function dictate() {
    if (reading) return;
    sent = null;
    if (!dictation) {
      try {
        dictation = await startDictation();
      } catch (error) {
        sent = { ok: false, text: error instanceof Error ? error.message : String(error) };
      }
      return;
    }
    const recording = dictation;
    dictation = null;
    reading = true;
    try {
      const words = await recording.stop();
      if (words) text = text.trim() ? `${text.trimEnd()} ${words}` : words;
      else sent = { ok: false, text: "No words came through; try again a little closer." };
      composerBox?.focus();
    } catch (error) {
      sent = { ok: false, text: error instanceof Error ? error.message : String(error) };
    } finally {
      reading = false;
    }
  }

  onMount(() => {
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    const focus = () => {
      refresh();
    };
    window.addEventListener("focus", focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
      dictation?.cancel();
    };
  });
</script>

<svelte:window onkeydown={keys} />

<div class="app">
  <aside class="side" aria-label="Projects and agents">
    <div class="brand">
      <!-- Hive's icon: static/hive.svg links to branding/hive.svg at the repository's root, its only copy. -->
      <img class="brand-mark" src="{base}/hive.svg" alt="Hive" title="Hive" />
      <h1>Hive</h1>
    </div>

    <label class="search">
      <span class="visually-hidden">Search tasks</span>
      <input bind:this={searchBox} type="search" placeholder="Search" title="Search tasks (⌘K)" bind:value={query} />
    </label>

    <button
      type="button"
      class="side-toggle"
      aria-expanded={sideOpen}
      aria-controls="side-rest"
      onclick={() => (sideOpen = !sideOpen)}
    >
      <span>Projects</span>
      {#if working.length}<span class="n">{working.length} at work</span>{/if}
    </button>

    <div class="side-rest" id="side-rest" class:open={sideOpen}>
    <button type="button" class="row top" class:on={!project} onclick={() => choose("")}>
      <span class="name">Everything</span>
      {#if unfinished}<span class="n">{unfinished}</span>{/if}
    </button>

    {#if projectList.length}
      <p class="side-label">Projects</p>
      <ul class="tree">
        {#each projectList as p (p.key)}
          <li>
            <button
              type="button"
              class="row"
              class:on={project === p.key && !folder}
              aria-expanded={project === p.key}
              onclick={() => choose(project === p.key && !folder ? "" : p.key)}
            >
              <span class="caret" aria-hidden="true">{project === p.key ? "▾" : "▸"}</span>
              <span class="name">{p.name}</span>
              {#if p.open}<span class="n">{p.open}</span>{/if}
            </button>
            {#if project === p.key}
              <ul class="folders">
                {#each folders as f (f.key)}
                  <li>
                    <button
                      type="button"
                      class="row folder"
                      class:on={folder === f.key}
                      title={f.about || `The ${f.name} folder`}
                      onclick={() => choose(p.key, folder === f.key ? "" : f.key)}
                    >
                      <span class="name">{f.name}</span>
                      {#if f.open}<span class="n">{f.open}</span>{/if}
                    </button>
                  </li>
                {/each}
                <li>
                  <form class="new-folder" onsubmit={makeFolder}>
                    <input placeholder="+ New folder" aria-label="New folder in {p.name}" bind:value={newFolder} />
                  </form>
                </li>
              </ul>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    {#if working.length}
      <p class="side-label">Agents at work <span class="n">{working.length}</span></p>
      <ul class="agents">
        {#each working as a (a.key)}
          {@const on = a.on[0] ?? a.open[0]}
          <li class="agent" class:busy={a.on.length > 0}>
            <span class="pulse" aria-hidden="true"></span>
            <div>
              <p class="who" title="{a.machine} · {ago(a.last, board?.now ?? 0)}">
                {HARNESSES[a.harness as keyof typeof HARNESSES] ?? a.harness}{#if a.projectName} · {a.projectName}{/if}
              </p>
              {#if on}<p class="on">{on.title}</p>{/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}

    {#if limits.length}
      <p class="side-label">Plan limits</p>
      <ul class="limits">
        {#each limits as l (l.key)}
          <li>
            <p class="who" title={l.home}>{l.who}</p>
            {#each l.windows as w (w.label)}
              <div class="window" class:high={w.used >= 80} title={w.resets || undefined}>
                <span class="window-name">{w.label}</span>
                <span
                  class="bar"
                  role="meter"
                  aria-label="{l.who}, {w.label} window used"
                  aria-valuemin="0"
                  aria-valuemax="100"
                  aria-valuenow={w.used}
                ><span style="width: {w.used}%"></span></span>
                <span class="used">{w.fresh ? "reset" : `${Math.round(w.used)}%`}</span>
              </div>
            {/each}
          </li>
        {/each}
      </ul>
    {/if}
    <a class="settings-link" href="{base}/settings">Settings</a>
    </div>
  </aside>

  <main class="main">
    <p class="crumbs">
      <button type="button" onclick={() => choose("")}>Everything</button>
      {#if projectChosen}
        <span aria-hidden="true">›</span>
        <button type="button" onclick={() => choose(project)}>{projectChosen.name}</button>
      {/if}
      {#if folderChosen}
        <span aria-hidden="true">›</span>
        <strong>{folderChosen.name}</strong>
      {/if}
    </p>

    {#if folderChosen}
      <section class="folder-panel" aria-label="The {folderChosen.name} folder">
        {#if editingAbout}
          <form class="about-form" onsubmit={saveAbout}>
            <textarea rows="2" bind:value={aboutText} placeholder="What this folder is for"></textarea>
            <div class="row-actions">
              <button type="button" class="quiet" onclick={() => (editingAbout = false)}>Cancel</button>
              <button type="submit">Save</button>
            </div>
          </form>
        {:else}
          <p class="about">
            {folderView?.about || folderChosen.about || "Nothing says what this folder is for yet."}
            <button type="button" class="link" onclick={editAbout}>Edit</button>
          </p>
        {/if}
        {#if folderError}<p class="bad">{folderError}</p>{/if}
        {#if folderView?.memories.length}
          <ul class="memories">
            {#each folderView.memories as m (m.key)}
              <li>
                <button
                  type="button"
                  class="memory"
                  aria-expanded={openMemory === m.key}
                  onclick={() => (openMemory = openMemory === m.key ? "" : m.key)}
                >
                  <span class="kind kind-{m.kind}">{m.kind}</span>
                  <span class="mtitle">{m.title}</span>
                  <span class="mwhen">{ago(m.created, board?.now ?? 0)}</span>
                </button>
                {#if openMemory === m.key}
                  <p class="mbody">{m.body}</p>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
        <form class="memory-form" onsubmit={addMemory}>
          <textarea
            rows="2"
            placeholder="Add a memory for this folder's agents (the first line is its title)"
            bind:value={memoryText}
          ></textarea>
          <div class="row-actions">
            <select bind:value={memoryKind} aria-label="Kind of memory">
              {#each KINDS as k (k)}<option value={k}>{k}</option>{/each}
            </select>
            <button type="submit" disabled={!memoryText.trim() || savingMemory}>
              {savingMemory ? "Saving…" : "Remember"}
            </button>
          </div>
        </form>
      </section>
    {/if}

    <form class="composer" onsubmit={send}>
      <label class="visually-hidden" for="task-text">Tell an agent what to do</label>
      <textarea
        id="task-text"
        bind:this={composerBox}
        rows="3"
        placeholder={folderChosen
          ? `Tell an agent what to do in ${folderChosen.name}…`
          : projectChosen
            ? `Tell an agent what to do in ${projectChosen.name}…`
            : "Tell an agent what to do…"}
        bind:value={text}
        onkeydown={composerKeys}
      ></textarea>
      <div class="composer-row">
        <button
          type="button"
          class="mic"
          class:on={dictation}
          onclick={dictate}
          disabled={reading}
          aria-pressed={Boolean(dictation)}
          aria-label={dictation ? "Stop and write in what you said" : "Dictate"}
          title={dictation ? "Stop and write it in (Esc throws it away)" : "Dictate"}
        >
          {#if reading}
            Writing…
          {:else}
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
              <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            </svg>
            {#if dictation}<span>Listening</span>{/if}
          {/if}
        </button>
        <button type="submit" disabled={!text.trim() || sending}>
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
      {#if sent}
        <p class="composer-note" class:bad={!sent.ok} role="status">{sent.text}</p>
      {/if}
      {#if requests.length}
        <ul class="requests" aria-label="Sent to Hive in the cloud">
          {#each requests as r (r.id)}
            <li class="request {r.status}">
              <span class="state">{REQUEST_WORDS[r.status as keyof typeof REQUEST_WORDS] ?? r.status}</span>
              <span class="said" title={r.outcome || r.text}>{r.text}</span>
              <span class="id">{ago(r.updated, board?.now ?? 0)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </form>

    {#if loadError && !board}
      <p class="board-note bad" role="alert">Couldn't load the tasks: {loadError}</p>
    {:else if !board}
      <p class="board-note">Loading the tasks…</p>
    {:else}
      {#if loadError}<p class="board-note bad">Couldn't refresh: {loadError}</p>{/if}

      {#each shown as section (section.id)}
        {#if section.tasks.length || section.id === "needs-you"}
          <section class="task-section" aria-labelledby="h-{section.id}">
            <h2 id="h-{section.id}">{section.title} <span class="n">{section.total}</span></h2>
            {#if !section.tasks.length}
              <p class="empty">Nothing waiting on you.</p>
            {/if}
            {#each byFolder(section.tasks) as run (run.folder)}
              {#if run.folder && !folder}
                <h3 class="run-head">
                  <button
                    type="button"
                    class="link"
                    onclick={() => choose(run.tasks[0].projectName.toLowerCase(), run.folder.toLowerCase())}
                  >{run.folder}</button>
                  <span class="n">{run.tasks.length}</span>
                </h3>
              {/if}
              <ul class="task-list">
                {#each run.tasks as task (task.key)}
                  <li class="task status-{task.status}" class:open={opened === task.key}>
                    <button
                      type="button"
                      class="task-main"
                      aria-expanded={opened === task.key}
                      onclick={() => (opened = opened === task.key ? "" : task.key)}
                    >
                      <!-- A row is its title and when: the section says its status and the heading
                           its folder; who ran it and what it cost are inside, when it's opened. -->
                      <span class="dot" aria-hidden="true" title={STATUS_WORDS[task.status as keyof typeof STATUS_WORDS] ?? task.status}></span>
                      <span class="title">{task.title}</span>
                      <span class="when">{ago(task.updated, board.now)}</span>
                    </button>
                    {#if opened === task.key}
                      <div class="task-more">
                        {#if task.quote && task.quote !== task.title}
                          <p class="label">You said</p>
                          <p class="quote">“{task.quote}”</p>
                        {/if}
                        {#if task.report}
                          <p class="label">Report</p>
                          <p class="report">{task.report}</p>
                        {:else if task.outcome}
                          <p class="label">What happened</p>
                          <p class="report">{task.outcome}</p>
                        {:else}
                          <p class="empty">No report yet: it comes when the task is done.</p>
                        {/if}
                        {#if task.evidence && !task.report}
                          <p class="label">Evidence</p>
                          <p class="report">{task.evidence}</p>
                        {/if}
                        {#if task.commits.length}
                          <p class="label">Commits</p>
                          <ul class="changes">
                            {#each task.commits as commit (commit.hash)}
                              <li>
                                {#if commitUrl(task, commit)}
                                  <a class="hash" href={commitUrl(task, commit)} target="_blank" rel="noreferrer">{commit.hash.slice(0, 7)}</a>
                                {:else}
                                  <code class="hash">{commit.hash.slice(0, 7)}</code>
                                {/if}
                                {commit.title}
                              </li>
                            {/each}
                          </ul>
                        {/if}
                        {#if task.files.length}
                          <details class="files">
                            <summary class="label">Changed {task.files.length} {task.files.length === 1 ? "file" : "files"}</summary>
                            <ul class="changes">
                              {#each task.files as file (file)}<li><code>{file}</code></li>{/each}
                            </ul>
                          </details>
                        {/if}
                        <p class="meta">{where(task)}{#if cost(task)} · {cost(task)}{/if}</p>
                      </div>
                    {/if}
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
          <summary>Messages not split into tasks yet <span class="n">{board.unsplit.length}</span></summary>
          <ul class="task-list">
            {#each board.unsplit as m (m.key)}
              <li class="task plain">
                <p class="quote">“{m.text}”</p>
              </li>
            {/each}
          </ul>
        </details>
      {/if}

      {#if board.rules.length}
        <details class="task-section extra">
          <summary>Your standing rules <span class="n">{board.rules.length}</span></summary>
          <ul class="task-list">
            {#each board.rules as r (r.key)}
              <li class="task plain">
                <p class="title" title={r.quote ? `You said: “${r.quote}”` : undefined}>{r.text}</p>
              </li>
            {/each}
          </ul>
        </details>
      {/if}
    {/if}
  </main>
</div>

<style>
  /* The side runs the full height of the window, like a Mac app's sidebar; the tasks sit in a
     readable column beside it. */
  .app {
    display: grid;
    grid-template-columns: 264px minmax(0, 1fr);
    min-height: 100vh;
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
  button {
    font: inherit;
    color: inherit;
  }
  /* ---- the side: projects, folders, agents ---- */
  /* The side lays out what's in .side-rest; the toggle only exists on phones. */
  .side-rest {
    display: contents;
  }
  .side-toggle {
    display: none;
  }
  .side {
    position: sticky;
    top: 0;
    align-self: start;
    height: 100vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: var(--s5) var(--s3);
    border-right: 1px solid var(--line);
    background: rgba(255, 244, 228, 0.02);
  }
  .brand {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s2);
    padding: 0 var(--s1);
    margin-bottom: var(--s3);
  }
  .brand-mark {
    width: 28px;
    height: 28px;
    margin: -2px;
  }
  .brand h1 {
    margin: 0;
    font-size: var(--fs-title);
    font-weight: var(--w-heavy);
    letter-spacing: -0.01em;
  }
  .settings-link {
    margin-top: auto;
    padding: var(--s3) var(--s1) 0;
    color: var(--muted);
    font-size: var(--fs-small);
    text-decoration: none;
  }
  .settings-link:hover {
    color: var(--ink);
  }
  .search {
    display: flex;
    align-items: center;
    gap: var(--s2);
    margin-bottom: var(--s2);
    padding: 0 var(--s2) 0 var(--s3);
    border-radius: 8px;
    border: 1px solid var(--line);
    background: var(--raise-1);
  }
  .search:focus-within {
    border-color: rgba(245, 197, 66, 0.45);
  }
  .search input {
    flex: 1;
    min-width: 0;
    padding: 7px 0;
    border: 0;
    background: transparent;
    color: var(--ink);
    font: inherit;
    font-size: var(--fs-small);
    outline: none;
  }
  .side-label {
    margin: var(--s5) 0 var(--s1);
    padding: 0 var(--s2);
    color: var(--muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-weight: var(--w-heavy);
  }
  .tree,
  .folders,
  .agents,
  .limits,
  .memories,
  .task-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--s2);
    width: 100%;
    padding: 6px var(--s2);
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--ink-2);
    font-size: var(--fs-small);
    text-align: left;
    cursor: pointer;
  }
  .row:hover {
    background: var(--raise-1);
    color: var(--ink);
  }
  .row.on {
    background: var(--gold-soft);
    color: var(--ink);
  }
  .row.on .n {
    color: var(--gold);
  }
  .row .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* A drawn chevron: the ▸ ▾ characters shrink to dots at this size. */
  .caret {
    display: inline-grid;
    place-items: center;
    width: 10px;
    height: 10px;
    font-size: 0;
  }
  .caret::before {
    content: "";
    width: 5px;
    height: 5px;
    border-right: 1.5px solid var(--muted);
    border-bottom: 1.5px solid var(--muted);
    transform: translateX(-1px) rotate(-45deg);
  }
  [aria-expanded="true"] > .caret::before {
    transform: translateY(-1px) rotate(45deg);
  }
  .folders {
    margin: 2px 0 var(--s2) 14px;
    padding-left: var(--s2);
    border-left: 1px solid var(--line);
  }
  .n {
    color: var(--muted);
    font-size: var(--fs-micro);
    font-weight: var(--w-normal);
    font-variant-numeric: tabular-nums;
  }
  .new-folder input {
    width: 100%;
    padding: 5px var(--s2);
    border: 1px dashed transparent;
    border-radius: 7px;
    background: transparent;
    color: var(--ink-2);
    font: inherit;
    font-size: var(--fs-small);
    outline: none;
  }
  .new-folder input::placeholder {
    color: var(--muted);
  }
  .new-folder input:focus {
    border-color: var(--line-strong);
    color: var(--ink);
  }
  .agents {
    display: grid;
    gap: var(--s1);
  }
  .agent {
    display: grid;
    grid-template-columns: 8px 1fr;
    gap: var(--s2);
    padding: var(--s2);
    border-radius: 8px;
    background: var(--raise-1);
  }
  .pulse {
    width: 7px;
    height: 7px;
    margin-top: 6px;
    border-radius: 50%;
    background: var(--muted);
  }
  .agent.busy .pulse {
    background: var(--blue);
    box-shadow: 0 0 0 0 var(--blue);
    animation: pulse 2s infinite;
  }
  @keyframes pulse {
    70% {
      box-shadow: 0 0 0 6px transparent;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .agent.busy .pulse {
      animation: none;
    }
  }
  .who,
  .when {
    margin: 0;
    color: var(--muted);
    font-size: var(--fs-micro);
  }
  .limits {
    display: grid;
    gap: var(--s3);
    padding: 0 var(--s2);
  }
  .window {
    display: grid;
    grid-template-columns: 3.4em 1fr 3em;
    align-items: center;
    gap: var(--s2);
    margin-top: 4px;
    font-size: var(--fs-micro);
    color: var(--ink-2);
  }
  .bar {
    height: 4px;
    border-radius: 99px;
    background: var(--raise-2);
    overflow: hidden;
  }
  .bar > span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--gold);
  }
  .window.high .bar > span {
    background: var(--red);
  }
  .used {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .agent .on {
    margin: 2px 0;
    color: var(--ink);
    font-size: var(--fs-small);
  }
  .id {
    color: var(--muted);
    font-size: var(--fs-micro);
  }

  /* ---- the main column ---- */
  .main {
    min-width: 0;
    width: 100%;
    max-width: 920px;
    margin: 0 auto;
    padding: var(--s6) var(--s6) var(--s7);
  }
  .crumbs {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--s2);
    min-height: 34px;
    margin: 0 0 var(--s4);
    color: var(--muted);
    font-size: 1.375rem;
    font-weight: var(--w-heavy);
    letter-spacing: -0.015em;
  }
  .crumbs button {
    padding: 0;
    border: 0;
    background: none;
    color: var(--muted);
    font-weight: inherit;
    cursor: pointer;
  }
  .crumbs button:hover {
    color: var(--ink-2);
  }
  .crumbs > :last-child {
    color: var(--ink);
  }
  .crumbs strong {
    font-weight: inherit;
  }
  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--gold);
    cursor: pointer;
  }
  .folder-panel,
  .composer {
    display: grid;
    gap: var(--s3);
    margin-bottom: var(--s5);
    border-radius: 14px;
  }
  .folder-panel {
    padding: var(--s4);
    background: var(--panel);
    border: 1px solid var(--line);
  }
  .composer {
    padding: var(--s3) var(--s3) var(--s2);
    background: var(--panel-strong);
    border: 1px solid var(--line-strong);
    box-shadow:
      inset 0 1px 0 rgba(255, 244, 228, 0.04),
      0 16px 40px -24px rgba(0, 0, 0, 0.8);
  }
  .composer:focus-within {
    border-color: rgba(245, 197, 66, 0.4);
  }
  .about {
    margin: 0;
    color: var(--ink-2);
    font-size: var(--fs-small);
  }
  .about .link {
    margin-left: var(--s2);
    font-size: var(--fs-micro);
  }
  .memories {
    display: grid;
    gap: 2px;
  }
  .memory {
    display: flex;
    align-items: baseline;
    gap: var(--s2);
    width: 100%;
    padding: 6px var(--s2);
    border: 0;
    border-radius: 7px;
    background: var(--raise-1);
    text-align: left;
    cursor: pointer;
  }
  .memory:hover {
    background: var(--raise-2);
  }
  .kind {
    flex: none;
    padding: 0 6px;
    border-radius: 4px;
    background: var(--raise-2);
    color: var(--ink-2);
    font-size: var(--fs-micro);
  }
  .kind-spec {
    color: var(--blue);
  }
  .kind-decision {
    color: var(--amber);
  }
  .kind-report {
    color: var(--green);
  }
  .mtitle {
    flex: 1;
    color: var(--ink);
    font-size: var(--fs-small);
  }
  .mwhen {
    color: var(--muted);
    font-size: var(--fs-micro);
    white-space: nowrap;
  }
  .mbody,
  .report {
    margin: 4px var(--s2) var(--s2);
    color: var(--ink-2);
    font-size: var(--fs-small);
    line-height: 1.55;
    white-space: pre-wrap;
    max-width: var(--measure);
  }
  textarea {
    width: 100%;
    resize: vertical;
    padding: var(--s3);
    border-radius: 10px;
    border: 1px solid var(--line-strong);
    background: var(--raise-1);
    color: var(--ink);
    font: inherit;
    font-size: var(--fs-body);
  }
  textarea::placeholder {
    color: var(--muted);
  }
  textarea:focus {
    border-color: rgba(245, 197, 66, 0.45);
    outline: none;
  }
  .memory-form textarea,
  .about-form textarea {
    font-size: var(--fs-small);
    padding: var(--s2) var(--s3);
  }
  .composer textarea {
    min-height: 68px;
    resize: none;
    padding: var(--s1) var(--s1) 0;
    border: 0;
    background: transparent;
    line-height: 1.5;
  }
  .row-actions,
  .composer-row {
    display: flex;
    gap: var(--s2);
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  select {
    appearance: none;
    -webkit-appearance: none;
    padding: 5px 26px 5px 10px;
    border-radius: 8px;
    border: 1px solid var(--line);
    background: var(--raise-1)
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23958d81' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")
      no-repeat right 9px center / 9px;
    color: var(--ink);
    font: inherit;
    font-size: var(--fs-small);
    cursor: pointer;
  }
  select:hover {
    border-color: var(--line-strong);
  }
  .composer button[type="submit"],
  .row-actions button[type="submit"] {
    display: inline-flex;
    align-items: center;
    gap: var(--s2);
    padding: 6px 12px 6px 14px;
    border-radius: 8px;
    border: 0;
    background: var(--gold);
    color: var(--on-gold);
    font-size: var(--fs-small);
    font-weight: var(--w-heavy);
    cursor: pointer;
  }
  .composer button[type="submit"]:hover:not([disabled]),
  .row-actions button[type="submit"]:hover:not([disabled]) {
    background: #ffd45e;
  }
  .composer button[type="submit"][disabled],
  .row-actions button[type="submit"][disabled] {
    opacity: 1;
    background: var(--raise-2);
    color: var(--muted);
  }
  .row-actions .quiet {
    padding: 6px 12px;
    border-radius: 8px;
    border: 1px solid var(--line-strong);
    background: transparent;
    color: var(--ink-2);
    cursor: pointer;
  }
  .composer .mic {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 32px;
    height: 30px;
    padding: 0 8px;
    border-radius: 8px;
    border: 0;
    background: transparent;
    color: var(--muted);
    font-size: var(--fs-small);
    cursor: pointer;
  }
  .composer .mic:hover {
    color: var(--ink);
    background: var(--raise-2);
  }
  .composer .mic.on {
    color: var(--red);
    background: color-mix(in srgb, var(--red) 12%, transparent);
    animation: listening 1.4s ease-in-out infinite;
  }
  @keyframes listening {
    50% {
      background: color-mix(in srgb, var(--red) 22%, transparent);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .composer .mic.on {
      animation: none;
    }
  }
  button[disabled] {
    opacity: 0.45;
    cursor: default;
  }
  .requests {
    list-style: none;
    margin: 0;
    padding: var(--s2) var(--s1) var(--s1);
    border-top: 1px solid var(--line);
    display: grid;
    gap: 6px;
  }
  .request {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: var(--s2);
    align-items: baseline;
    font-size: var(--fs-small);
  }
  .request .state {
    padding: 1px 8px;
    border-radius: 99px;
    background: var(--raise-2);
    color: var(--ink-2);
    font-size: var(--fs-micro);
    white-space: nowrap;
  }
  .request.planning .state,
  .request.working .state {
    color: var(--blue);
  }
  .request.done .state {
    color: var(--green);
  }
  .request.failed .state {
    color: var(--red);
  }
  .request .said {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink);
  }
  .composer-note,
  .board-note {
    margin: 0;
    padding: 0 var(--s1);
    color: var(--ink-2);
    font-size: var(--fs-small);
  }
  .board-note {
    margin-bottom: var(--s5);
    padding: 0;
    color: var(--muted);
  }
  .bad {
    color: var(--red);
  }

  /* ---- tasks: each section a heading, each folder one list ---- */
  .task-section {
    margin-bottom: var(--s6);
  }
  .task-section h2,
  .task-section summary {
    display: flex;
    align-items: center;
    gap: var(--s2);
    margin: 0 0 var(--s3);
    color: var(--ink);
    font-size: var(--fs-body);
    font-weight: var(--w-heavy);
  }
  .task-section h2 .n,
  .task-section summary .n {
    padding: 0 7px;
    border-radius: 99px;
    background: var(--raise-2);
    color: var(--ink-2);
    line-height: 1.6;
  }
  .task-section summary {
    list-style: none;
    color: var(--ink-2);
    font-size: var(--fs-small);
    cursor: pointer;
  }
  .task-section summary::-webkit-details-marker {
    display: none;
  }
  .task-section summary::before {
    content: "▸";
    width: 10px;
    color: var(--muted);
    font-size: 9px;
  }
  .task-section[open] summary::before {
    content: "▾";
  }
  .run-head {
    display: flex;
    gap: var(--s2);
    align-items: baseline;
    margin: var(--s4) 0 var(--s2);
    padding: 0 var(--s1);
    font-size: var(--fs-small);
    font-weight: var(--w-normal);
  }
  .run-head .link {
    color: var(--ink-2);
    font-family: var(--font-geist-mono), ui-monospace, monospace;
    font-size: 0.78rem;
  }
  .run-head .link:hover {
    color: var(--ink);
  }
  .task-list {
    display: grid;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--panel);
    overflow: hidden;
  }
  .task {
    background: transparent;
    transition: background 0.12s ease;
  }
  .task + .task {
    border-top: 1px solid var(--line);
  }
  .task:hover,
  .task.open {
    background: var(--raise-1);
  }
  .task.plain {
    padding: var(--s3) var(--s4);
  }
  .task-main {
    display: grid;
    grid-template-columns: 8px minmax(0, 1fr) auto;
    gap: var(--s3);
    align-items: start;
    width: 100%;
    padding: 11px var(--s4);
    border: 0;
    background: none;
    text-align: left;
    cursor: pointer;
  }
  .task-main .title {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }
  .task.open .task-main .title {
    display: block;
  }
  .task-main .when {
    margin-top: 3px;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .task-more {
    padding: 0 var(--s4) var(--s4) calc(var(--s4) + 8px + var(--s3));
  }
  .task-more .report {
    margin-left: 0;
  }
  .changes {
    margin: 4px 0 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 3px;
    font-size: var(--fs-small);
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }
  .changes code,
  .changes .hash {
    font-family: var(--font-geist-mono), ui-monospace, monospace;
    font-size: 0.88em;
  }
  .changes .hash {
    margin-right: 6px;
    color: var(--gold);
  }
  .files summary {
    cursor: pointer;
  }
  .label {
    margin: var(--s3) 0 0;
    color: var(--muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-weight: var(--w-heavy);
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
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--blue) 22%, transparent);
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
    font-weight: 500;
    line-height: 1.45;
  }
  .status-done .title,
  .status-dropped .title {
    color: var(--ink-2);
  }
  .quote {
    margin: 4px 0 0;
    padding-left: var(--s3);
    border-left: 2px solid var(--line-strong);
    color: var(--ink-2);
    font-size: var(--fs-small);
    line-height: 1.55;
    max-width: var(--measure);
  }
  .meta {
    margin: 2px 0 0;
    color: var(--muted);
    font-size: 0.75rem;
  }
  .empty {
    color: var(--muted);
    font-size: var(--fs-small);
    margin: 0;
  }
  .task-section > .empty {
    padding: var(--s4);
    border: 1px dashed var(--line);
    border-radius: 12px;
  }
  .more {
    margin-top: var(--s3);
    padding: 4px 12px;
    border-radius: 999px;
    border: 1px solid var(--line-strong);
    background: transparent;
    color: var(--ink-2);
    font-size: var(--fs-small);
    cursor: pointer;
  }
  .more:hover {
    color: var(--ink);
    background: var(--raise-1);
  }

  /* ---- narrow screens (the phone, the browser's side panel): the side goes on top ---- */
  @media (max-width: 820px) {
    .app {
      grid-template-columns: minmax(0, 1fr);
    }
    .side {
      position: static;
      height: auto;
      overflow: visible;
      padding: var(--s4) var(--s4) var(--s3);
      border-right: 0;
      border-bottom: 1px solid var(--line);
    }
    .main {
      padding: var(--s4) var(--s4) var(--s7);
    }
    .crumbs {
      font-size: var(--fs-title);
      min-height: 0;
    }
    .side-toggle {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--s2);
      width: 100%;
      padding: var(--s2) var(--s3);
      border: 1px solid var(--line);
      border-radius: 8px;
      background: transparent;
      color: var(--ink-2);
      font-size: var(--fs-small);
      text-align: left;
      cursor: pointer;
    }
    .side-rest:not(.open) {
      display: none;
    }
  }
</style>
