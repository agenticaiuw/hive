<script lang="ts">
  /*
   * The dashboard: the owner's agents and their tasks, the same page in Hive's Mac app and floating
   * window, on the website, on the phone and in the browser extension (only the host behind /api/*
   * differs, see $lib/dataSource).
   *
   * On the left, every agent (working first), each with the tasks it holds; then the projects. Open
   * an agent and it's a conversation, like Claude Code: what was asked, what it said, its work in
   * short lines, and a box at the bottom that talks to it through the cloud wherever it runs, with
   * its tasks just above that box so they stay in view (T306). Clicking Hive goes home (T308): a box
   * to hand Hive something new, then the tasks: what needs the owner (a question and its answer
   * box, saying why it stopped and what it needs), what's being worked on, what hasn't started and why,
   * and what's done. Rules lists
   * the owner's standing rules under their projects (T307, T309). Every unfinished task can be
   * continued or cancelled from its row. Nothing is said twice (R17).
   *
   * Keys: ⌘K search, / write, ⌘↵ send, Esc back.
   */
  import { onMount } from "svelte";
  import { base } from "$app/paths";
  import {
    actOnTask,
    turnRuleOff,
    fetchConversation,
    fetchFolder,
    fetchClub,
    fetchPhone,
    fetchTaskBoard,
    inviteMember,
    removeMember,
    type ClubMember,
    pairPhone,
    saveFolder,
    savePhonePasscode,
    saveMemory,
    sendToAgent,
    sendToHive,
    startDictation,
    type Dictation,
  } from "$lib/dataSource";
  import {
    ago,
    commitUrl,
    cost,
    folderList,
    needsOwner,
    normalizeBoard,
    normalizeFolder,
    planLimits,
    projects,
    rulesByProject,
    ruleScope,
    sections,
  } from "$lib/tasks.js";
  import {
    agentOfTask,
    agents,
    byAgent,
    conversation,
    deliveryWords,
    reasonFor,
    threadConversation,
    withTitles,
  } from "$lib/agents.js";

  type Board = ReturnType<typeof normalizeBoard>;
  type FolderView = ReturnType<typeof normalizeFolder>;
  type Task = Board["tasks"][number];
  type Step = Board["runs"][number]["steps"][number];
  type Agent = ReturnType<typeof agents>[number];
  type Item = ReturnType<typeof conversation>[number];

  const REFRESH_MS = 15_000;
  const LIVE_REFRESH_MS = 3_000;
  const CONVO_MS = 2_500;
  const KINDS = ["note", "spec", "decision"];
  const SECTION_TITLES: Record<string, string> = {
    "needs-you": "Needs you",
    working: "Working",
    "not-started": "Not started",
    done: "Done",
  };
  const STATUS_LABEL = { "needs-you": "Needs you", stuck: "Stuck", working: "Working", idle: "Idle" } as const;

  let board = $state<Board | null>(null);
  let loadError = $state("");
  let text = $state("");
  let sending = $state(false);
  let sent = $state<{ ok: boolean; text: string } | null>(null);
  let dictation = $state<Dictation | null>(null);
  let reading = $state(false);
  let project = $state("");
  /** On a phone the agents and projects fold behind one button, so what's open comes first. */
  let sideOpen = $state(false);
  let projectsOpen = $state(true);
  let showEarlier = $state(false);
  let folder = $state("");
  let query = $state("");
  let showAllDone = $state(false);
  let doneOpen = $state(false);
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
  let talkBox = $state<HTMLTextAreaElement | null>(null);

  // The agent open on the right (#/agent/<key>), and talking to it.
  let agentKey = $state("");
  let talk = $state("");
  let talking = $state(false);
  let talkError = $state("");
  let convo = $state<{ target: string; steps: Step[]; messages: any[]; loading: boolean; error: string }>({
    target: "",
    steps: [],
    messages: [],
    loading: false,
    error: "",
  });
  /** What the owner just sent, shown at once until the agent's conversation has it. */
  let pending = $state<{ target: string; text: string; at: number }[]>([]);
  let openWork = $state<Record<string, boolean>>({});
  /** Step lines opened to their full text ("<work key>:<n>"). */
  let openLine = $state<Record<string, boolean>>({});
  /** An agent's finished tasks stay folded until the owner asks for them. */
  let allClaims = $state(false);
  /** The owner can fold an agent's tasks away, above its message box. */
  let claimsFolded = $state(false);
  /** The standing rules, under their projects (#/rules). */
  let rulesOpen = $state(false);

  // Acting on a task from its row: the × asks once more before it cancels.
  let confirming = $state("");
  let acting = $state<Record<string, string>>({});
  let actNote = $state<Record<string, { ok: boolean; text: string }>>({});
  let answers = $state<Record<string, string>>({});
  // Turning a standing rule off: the × asks once more, like a task's.
  let ruleConfirming = $state("");
  let ruleActing = $state("");
  let ruleError = $state<Record<string, string>>({});

  const agentList = $derived(board ? agents(board) : []);
  const ofTask = $derived(agentOfTask(agentList));
  // The VM's agent is pinned: always in view, never folded under Earlier.
  const activeAgents = $derived(agentList.filter((a) => a.status !== "idle" || a.pinned));
  const earlierAgents = $derived(agentList.filter((a) => a.status === "idle" && !a.pinned));
  const agent = $derived(agentList.find((a) => a.key === agentKey) ?? null);
  const shown = $derived(
    board ? sections(board.tasks, { project, folder, query, doneLimit: showAllDone ? 500 : 12 }) : [],
  );
  const projectList = $derived(board ? projects(board.tasks, board.folders).slice(0, 12) : []);
  const projectChosen = $derived(projectList.find((p) => p.key === project));
  const folders = $derived(board && project ? folderList(board.tasks, board.folders, project) : []);
  const folderChosen = $derived(folders.find((f) => f.key === folder));
  const limits = $derived(board ? planLimits(board.limits, board.now) : []);
  /** Each task's title by "<machine>:<id>", for the task numbers agents write. */
  const titles = $derived(new Map((board?.tasks ?? []).map((t) => [t.key, t.title])));
  /** A text from `machine` with its task numbers as those tasks' titles. */
  const titled = (text: string, machine: string) => withTitles(text, machine, titles);
  const needsYou = $derived(board ? board.tasks.filter(needsOwner).length : 0);

  // A coding session's conversation comes from its node's steps, read while it's open; Hive in the
  // cloud's from the board.
  const convoTarget = $derived(agent && agent.kind !== "cloud" ? `${agent.machine}\n${agent.run}` : "");
  const items = $derived.by((): Item[] => {
    if (!agent) return [];
    const said =
      agent.kind === "cloud"
        ? threadConversation(agent)
        : conversation(convo.target === convoTarget ? convo.steps : [], convo.target === convoTarget ? convo.messages : []);
    const target = agent.kind === "cloud" ? agent.key : convoTarget;
    const waiting = pending
      .filter((p) => p.target === target)
      .map((p, i) => ({ type: "owner" as const, key: `p${i}`, at: p.at, text: p.text, state: "sending", detail: "" }));
    return [...said, ...waiting];
  });
  const lastWork = $derived([...items].reverse().find((i) => i.type === "work")?.key ?? "");
  const follow = $derived(`${items.length}:${(items.at(-1) as any)?.lines?.length ?? 0}`);

  const live = $derived(
    !!agent && agent.kind === "cloud" && agent.status === "working",
  );
  $effect(() => {
    if (!live) return;
    const fast = setInterval(refresh, LIVE_REFRESH_MS);
    return () => clearInterval(fast);
  });

  $effect(() => {
    const target = convoTarget;
    if (!target) return;
    const [machine, run] = target.split("\n");
    let steps: Step[] = [];
    let stopped = false;
    convo = { target, steps: [], messages: [], loading: true, error: "" };
    const load = async () => {
      try {
        const last = steps.at(-1)?.n ?? 0;
        const answer = await fetchConversation(machine, run, last ? { after: last } : { tail: 300 });
        if (stopped) return;
        const seen = new Set(steps.map((s) => s.n));
        const fresh = (answer?.steps ?? [])
          .map((s: any) => ({ n: Number(s.n), task: 0, at: Number(s.at), kind: String(s.kind), text: String(s.text ?? "") }))
          .filter((s: Step) => !seen.has(s.n));
        steps = [...steps, ...fresh];
        const messages = answer?.messages ?? [];
        convo = { target, steps, messages, loading: false, error: "" };
        pending = pending.filter((p) => p.target !== target || !messages.some((m: any) => m.text === p.text));
      } catch (error) {
        if (!stopped) convo = { ...convo, loading: false, error: message(error) };
      }
    };
    load();
    const timer = setInterval(load, CONVO_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  });

  const NODE_STATE: Record<string, (n: any) => string> = {
    current: () => "On the newest release",
    behind: (n) => `Updates to ${n.latest} by itself when it's idle`,
    old: () => "On routes the board no longer serves; it updates itself when it's idle",
    dev: () => "Built by hand, so releases never replace it",
    "": () => "Nothing published for it yet",
  };
  function nodeTitle(n: any) {
    return [NODE_STATE[n.state]?.(n), n.away ? "Not heard from in 10 minutes" : "", n.note].filter(Boolean).join(" · ");
  }

  function message(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  // The owner's iPhone (cloud/tasks/phone.js), read when its section is opened.
  type PhoneState = { connected: boolean; version: string | null; passcode: boolean; paused: boolean };
  let phone = $state<PhoneState | null>(null);
  let phoneNote = $state("");
  let phoneGet = $state("");
  let phonePass = $state("");

  async function loadPhone() {
    try {
      phone = await fetchPhone();
    } catch (error) {
      phoneNote = message(error);
    }
  }

  // Copies the pairing, which Hive Phone reads from the clipboard when it opens (from the Mac, the
  // clipboard reaches the iPhone by Universal Clipboard). The write starts inside the tap, which is
  // the only time Safari allows it, and fills in when the board answers.
  async function connectPhone() {
    phoneNote = "";
    const asked = pairPhone();
    asked.catch(() => {});
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({ "text/plain": asked.then((p) => new Blob([p.pairing], { type: "text/plain" })) }),
        ]);
      } else {
        await navigator.clipboard.writeText((await asked).pairing);
      }
      phoneGet = (await asked).sidestore;
      phoneNote = "Copied. Open Hive Phone on the iPhone and it connects.";
    } catch (error) {
      phoneNote = message(error);
    }
  }

  async function phoneAct(body: Parameters<typeof savePhonePasscode>[0], done: string) {
    try {
      await savePhonePasscode(body);
      phoneNote = done;
    } catch (error) {
      phoneNote = message(error);
    }
    await loadPhone();
  }

  async function savePasscode(event: Event) {
    event.preventDefault();
    const passcode = phonePass;
    phonePass = "";
    await phoneAct({ passcode, consent: true }, "Saved. Hive unlocks the iPhone with it when a task needs the phone.");
  }

  // The club (cloud/tasks/club.js): members ask Hive to change itself from the club page, each signed in
  // once with the invite link made here, which the owner hands them.
  let club = $state<ClubMember[]>([]);
  let clubName = $state("");
  let clubNote = $state("");
  let clubLink = $state<{ name: string; link: string } | null>(null);

  async function loadClub() {
    try {
      club = (await fetchClub()).members;
    } catch (error) {
      clubNote = message(error);
    }
  }

  async function invite(name: string) {
    clubNote = "";
    try {
      const made = await inviteMember(name);
      clubLink = { name: made.name, link: made.link };
      clubName = "";
      clubNote = `${made.name}'s invite link works once, for 7 days.`;
    } catch (error) {
      clubNote = message(error);
    }
    await loadClub();
  }

  async function copyInvite() {
    if (!clubLink) return;
    try {
      await navigator.clipboard.writeText(clubLink.link);
      clubNote = `Copied ${clubLink.name}'s invite link.`;
    } catch (error) {
      clubNote = message(error);
    }
  }

  async function letGo(name: string) {
    clubNote = "";
    try {
      await removeMember(name);
      if (clubLink?.name === name) clubLink = null;
    } catch (error) {
      clubNote = message(error);
    }
    await loadClub();
  }

  let refreshing = false;
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      board = normalizeBoard(await fetchTaskBoard());
      loadError = "";
    } catch (error) {
      loadError = message(error);
    } finally {
      refreshing = false;
    }
  }

  function readHash() {
    const hit = location.hash.match(/^#\/agent\/(.+)$/);
    agentKey = hit ? decodeURIComponent(hit[1]) : "";
    rulesOpen = location.hash === "#/rules";
    talkError = "";
    allClaims = false;
  }

  function openAgent(key: string) {
    sideOpen = false;
    location.hash = `#/agent/${encodeURIComponent(key)}`;
  }

  function openRules() {
    sideOpen = false;
    location.hash = "#/rules";
  }

  function goHome() {
    sideOpen = false;
    if (location.hash) history.pushState(null, "", location.pathname + location.search);
    readHash();
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
      folderError = message(error);
    }
  }

  function choose(nextProject: string, nextFolder = "") {
    project = nextProject;
    folder = nextFolder;
    folderView = null;
    folderError = "";
    editingAbout = false;
    openMemory = "";
    loadFolder();
    goHome();
  }

  /** Hands Hive in the cloud something new, then opens that conversation. */
  async function send(event?: Event) {
    event?.preventDefault();
    const words = text.trim();
    if (!words || sending) return;
    sending = true;
    sent = null;
    try {
      // Started from a folder, it says where it belongs: the agent files its tasks there.
      const projectName = projectChosen?.name ?? project;
      const scope = folderChosen
        ? `For ${projectName} › ${folderChosen.name}: `
        : projectChosen
          ? `For ${projectName}: `
          : "";
      const answer = await sendToHive(scope + words);
      if (answer.accepted === false) {
        sent = { ok: false, text: answer.error || "Hive didn't take it." };
      } else {
        text = "";
        await refresh();
        if (answer.receiptId && agentList.some((a) => a.key === `cloud|${answer.receiptId}`)) {
          openAgent(`cloud|${answer.receiptId}`);
        } else {
          sent = { ok: true, text: answer.accepted === null ? "Sent. It shows on the left once Hive has it." : "Sent." };
          setTimeout(refresh, 3000);
        }
      }
    } catch (error) {
      sent = { ok: false, text: message(error) };
    } finally {
      sending = false;
    }
  }

  /** Says something to the open agent, through the cloud. */
  async function say(event?: Event) {
    event?.preventDefault();
    const words = talk.trim();
    if (!words || talking || !agent) return;
    talking = true;
    talkError = "";
    const target = agent.kind === "cloud" ? agent.key : convoTarget;
    pending = [...pending, { target, text: words, at: Math.floor(Date.now() / 1000) }];
    talk = "";
    try {
      const answer =
        agent.kind === "cloud"
          ? await sendToAgent({ request: agent.request }, words)
          : await sendToAgent({ machine: agent.machine, run: agent.run }, words);
      if (answer?.error) throw new Error(answer.error);
      if (agent.kind === "cloud") {
        await refresh();
        pending = pending.filter((p) => p.target !== target || p.text !== words);
      }
    } catch (error) {
      pending = pending.filter((p) => p.target !== target || p.text !== words);
      talk = words;
      talkError = message(error);
    } finally {
      talking = false;
    }
  }

  async function act(task: Task, action: "cancel" | "continue" | "answer", words = "") {
    confirming = "";
    acting[task.key] = action;
    delete actNote[task.key];
    try {
      const answer = await actOnTask({ machine: task.machine, id: task.id }, action, words);
      if (answer?.error) throw new Error(answer.error);
      if (action === "answer") answers[task.key] = "";
      actNote[task.key] = {
        ok: true,
        text: action === "cancel" ? "Cancelled." : action === "answer" ? "Sent to its agent." : "Asked its agent to continue.",
      };
      await refresh();
    } catch (error) {
      actNote[task.key] = { ok: false, text: message(error) };
    } finally {
      delete acting[task.key];
    }
  }

  async function askRuleOff(rule: { key: string; machine: string; id: string }) {
    if (ruleConfirming !== rule.key) {
      ruleConfirming = rule.key;
      setTimeout(() => {
        if (ruleConfirming === rule.key) ruleConfirming = "";
      }, 4000);
      return;
    }
    ruleConfirming = "";
    ruleActing = rule.key;
    delete ruleError[rule.key];
    try {
      const answer = await turnRuleOff(rule);
      if (answer?.error) throw new Error(answer.error);
      await refresh();
    } catch (error) {
      ruleError[rule.key] = message(error);
    } finally {
      ruleActing = "";
    }
  }

  function askCancel(task: Task) {
    if (confirming === task.key) return act(task, "cancel");
    confirming = task.key;
    setTimeout(() => {
      if (confirming === task.key) confirming = "";
    }, 4000);
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
      folderError = message(error);
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
      loadError = message(error);
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
      folderError = message(error);
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
      (agent ? talkBox : composerBox)?.focus();
    } else if (event.key === "Escape" && !typing(event.target)) {
      if (sideOpen) sideOpen = false;
      else if (agentKey || rulesOpen) goHome();
      else if (opened) opened = "";
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

  function talkKeys(event: KeyboardEvent) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) say(event);
  }

  /** The mic: the first press starts recording, the second has the speech model write it in. */
  async function dictate() {
    if (reading) return;
    sent = null;
    if (!dictation) {
      try {
        dictation = await startDictation();
      } catch (error) {
        sent = { ok: false, text: message(error) };
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
      sent = { ok: false, text: message(error) };
    } finally {
      reading = false;
    }
  }

  /** Keeps a conversation on its newest line as lines arrive, unless the owner scrolled up. */
  function followNewest(node: HTMLElement, _signature: string) {
    const main = node.closest(".main") as HTMLElement | null;
    const scroller = () =>
      main && getComputedStyle(main).overflowY !== "visible" ? main : (document.scrollingElement as HTMLElement);
    let near = true;
    const onScroll = () => {
      const s = scroller();
      near = s.scrollHeight - s.scrollTop - s.clientHeight < 160;
    };
    const toEnd = () => requestAnimationFrame(() => {
      const s = scroller();
      s.scrollTop = s.scrollHeight;
    });
    main?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    toEnd();
    return {
      update() {
        if (near) toEnd();
      },
      destroy() {
        main?.removeEventListener("scroll", onScroll);
        window.removeEventListener("scroll", onScroll);
      },
    };
  }

  onMount(() => {
    readHash();
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    const focus = () => refresh();
    window.addEventListener("focus", focus);
    window.addEventListener("hashchange", readHash);
    window.addEventListener("popstate", readHash);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
      window.removeEventListener("hashchange", readHash);
      window.removeEventListener("popstate", readHash);
      dictation?.cancel();
    };
  });
</script>

<svelte:window onkeydown={keys} />

{#snippet agentRow(a: Agent)}
  <li>
    <button type="button" class="agent-row" class:on={agentKey === a.key} onclick={() => openAgent(a.key)}>
      <span class="dot st-{a.status}" aria-hidden="true"></span>
      <span class="agent-text">
        <span class="agent-title">{a.title}</span>
        <span class="agent-meta">{a.place ? `${a.label} · ${a.place}` : a.label}</span>
      </span>
      {#if a.status === "stuck"}<span class="tag status st-stuck">{STATUS_LABEL[a.status]}</span>{/if}
      {#if a.tasks.length}<span class="count" title="Tasks it holds">{a.tasks.length}</span>{/if}
    </button>
  </li>
{/snippet}

{#snippet taskRow(task: Task, inAgent: boolean)}
  {@const unfinished = !["done", "dropped"].includes(task.status)}
  <!-- Why it waits: its own reason here; the one its agent gives every task it holds is said once, above. -->
  {@const reason = titled(task.status === "blocked" ? reasonFor(task, ofTask.get(task.key)) : task.status === "open" ? task.outcome : "", task.machine)}
  <li class="task s-{task.status}">
    <div class="task-line">
      <button
        type="button"
        class="task-title"
        aria-expanded={opened === task.key}
        onclick={() => (opened = opened === task.key ? "" : task.key)}
      >
        {#if task.asked}<span class="tid" title="When you asked for it">{task.asked}</span>{/if}
        <span class="tname">{task.title}</span>
        {#if inAgent && task.status === "active"}<span class="now">Working on it</span>{/if}
      </button>
      {#if !unfinished}
        <span class="when">{ago(task.updated, board?.now ?? 0)}</span>
      {:else}
        <div class="task-actions">
          <!-- No Continue for a stuck task: Hive keeps continuing it, and one that needs the owner
               says exactly why and what (the owner, 2026-11-17). A task nobody started can be. -->
          {#if task.status === "open"}
            <button
              type="button"
              class="pill-button"
              disabled={!!acting[task.key]}
              onclick={() => act(task, "continue")}
            >{acting[task.key] === "continue" ? "Starting…" : "Start"}</button>
          {/if}
          <button
            type="button"
            class="x"
            class:armed={confirming === task.key}
            disabled={!!acting[task.key]}
            aria-label={confirming === task.key ? `Confirm: cancel “${task.title}”` : `Cancel “${task.title}”`}
            title={confirming === task.key ? "Click again to cancel it" : "Cancel this task"}
            onclick={() => askCancel(task)}
          >
            {#if confirming === task.key}Cancel{:else}
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
            {/if}
          </button>
        </div>
      {/if}
    </div>

    {#if task.status === "waiting"}
      <p class="task-ask">{titled(task.outcome, task.machine) || "Its agent didn't say what it needs. Ask it below."}</p>
      <form class="answer" onsubmit={(e) => { e.preventDefault(); if ((answers[task.key] ?? "").trim()) act(task, "answer", answers[task.key].trim()); }}>
        <input
          placeholder="Answer…"
          aria-label="Answer “{task.title}”"
          bind:value={answers[task.key]}
          disabled={!!acting[task.key]}
        />
        <button type="submit" class="send-small" disabled={!(answers[task.key] ?? "").trim() || !!acting[task.key]}>
          {acting[task.key] === "answer" ? "Sending…" : "Send"}
        </button>
      </form>
    {:else if reason}
      <p class="reason">{reason}</p>
    {/if}

    {#if actNote[task.key]}
      {@const holder = ofTask.get(task.key)}
      <p class="act-note" class:bad={!actNote[task.key].ok} role="status">
        {actNote[task.key].text}
        <!-- Where the answer went and what its agent does with it: that agent's conversation (T244). -->
        {#if actNote[task.key].ok && !inAgent && holder}
          <button type="button" class="link" onclick={() => openAgent(holder.key)}>See its reply in {holder.title}</button>
        {/if}
      </p>
    {/if}

    {#if opened === task.key}
      <div class="task-more">
        {#if task.quote && task.quote !== task.title}
          <p class="label">You said</p>
          <p class="quote">“{task.quote}”</p>
        {/if}
        {#if task.report}
          <p class="label">Report</p>
          <p class="report">{titled(task.report, task.machine)}</p>
        {:else if task.outcome && (task.status === "active" || !unfinished)}
          <p class="label">What happened</p>
          <p class="report">{titled(task.outcome, task.machine)}</p>
        {/if}
        {#if task.evidence && !task.report}
          <p class="label">Evidence</p>
          <p class="report">{titled(task.evidence, task.machine)}</p>
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
        <p class="meta">
          {[unfinished ? `Updated ${ago(task.updated, board?.now ?? 0)}` : "", cost(task)].filter(Boolean).join(" · ")}
        </p>
      </div>
    {/if}
  </li>
{/snippet}

{#snippet groupHead(a: Agent | null, why: string)}
  <div class="group-head">
    {#if a}
      <button type="button" class="agent-chip" onclick={() => openAgent(a.key)} title="Open this agent">
        <span class="dot st-{a.status}" aria-hidden="true"></span>
        <span>{a.place ? `${a.label} · ${a.place}` : a.label}</span>
        <span class="chip-go" aria-hidden="true">›</span>
      </button>
    {:else}
      <span class="agent-chip none">No agent has these yet</span>
    {/if}
    {#if why}<span class="group-why">{why}</span>{/if}
  </div>
{/snippet}

<div class="app" class:in-agent={!!agent}>
  <aside class="side" aria-label="Agents and projects">
    <div class="brand">
      <!-- Hive's icon: static/hive.svg links to branding/hive.svg at the repository's root, its only copy. -->
      <button type="button" class="brand-home" onclick={() => choose("")} title="Home">
        <img class="brand-mark" src="{base}/hive.svg" alt="" />
        <span>Hive</span>
        {#if needsYou}<span class="count warm" title="Needs you">{needsYou}</span>{/if}
      </button>
      <button
        type="button"
        class="menu"
        aria-expanded={sideOpen}
        aria-controls="side-rest"
        aria-label={sideOpen ? "Close the menu" : "Agents and projects"}
        onclick={() => (sideOpen = !sideOpen)}
      >
        {#if activeAgents.length}<span class="count">{activeAgents.length}</span>{/if}
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" /></svg>
      </button>
    </div>

    <div class="side-rest" id="side-rest" class:open={sideOpen}>
      <label class="search">
        <span class="visually-hidden">Search tasks</span>
        <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" stroke-width="1.7" /><path d="M13.2 13.2L17 17" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" /></svg>
        <input bind:this={searchBox} type="search" placeholder="Search tasks" title="Search tasks (⌘K)" bind:value={query} />
      </label>

      {#if board?.rules.length}
        <button type="button" class="nav-row" class:on={rulesOpen} onclick={openRules}>
          <span>Rules</span>
          <span class="count">{board.rules.length}</span>
        </button>
      {/if}

      <p class="side-label">Agents</p>
      {#if !board}
        <p class="side-empty">Loading…</p>
      {:else if !agentList.length}
        <p class="side-empty">No agents at work.</p>
      {/if}
      <ul class="agent-list">
        {#each activeAgents as a (a.key)}{@render agentRow(a)}{/each}
      </ul>
      {#if earlierAgents.length}
        <button type="button" class="side-more" aria-expanded={showEarlier || !activeAgents.length} onclick={() => (showEarlier = !showEarlier)}>
          {showEarlier || !activeAgents.length ? "Hide earlier" : `Earlier · ${earlierAgents.length}`}
        </button>
        {#if showEarlier || !activeAgents.length}
          <ul class="agent-list">
            {#each earlierAgents as a (a.key)}{@render agentRow(a)}{/each}
          </ul>
        {/if}
      {/if}

      {#if projectList.length}
        <button type="button" class="side-label toggle" aria-expanded={projectsOpen} onclick={() => (projectsOpen = !projectsOpen)}>
          Projects <span aria-hidden="true">{projectsOpen ? "▾" : "▸"}</span>
        </button>
        {#if projectsOpen}
          <ul class="tree">
            {#each projectList as p (p.key)}
              <li>
                <button
                  type="button"
                  class="nav-row"
                  class:on={!agentKey && project === p.key && !folder}
                  aria-expanded={project === p.key}
                  onclick={() => choose(project === p.key && !folder ? "" : p.key)}
                >
                  <span>{p.name}</span>
                  {#if p.open}<span class="count">{p.open}</span>{/if}
                </button>
                {#if project === p.key}
                  <ul class="folders">
                    {#each folders as f (f.key)}
                      <li>
                        <button
                          type="button"
                          class="nav-row sub"
                          class:on={!agentKey && folder === f.key}
                          title={f.about || `The ${f.name} folder`}
                          onclick={() => choose(p.key, folder === f.key ? "" : f.key)}
                        >
                          <span>{f.name}</span>
                          {#if f.open}<span class="count">{f.open}</span>{/if}
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
      {/if}

      <div class="side-foot">
        {#if board?.nodes?.length}
          <!-- What each node runs (cloud/tasks/nodes.js): one behind updates itself when it's idle. -->
          <ul class="limits nodes" aria-label="What each node runs">
            {#each board.nodes as n (n.key)}
              <li class:away={n.away} title={nodeTitle(n)}>
                <span class="dot node-{n.state || 'none'}" aria-hidden="true"></span>
                <span class="who">{n.label}</span>
                <span class="used">{n.version}{#if n.state === "behind"} → {n.latest}{/if}</span>
              </li>
            {/each}
          </ul>
        {/if}
        {#if limits.length}
          <ul class="limits" aria-label="Plan limits">
            {#each limits as l (l.key)}
              <li title={l.home}>
                <span class="who">{l.who}</span>
                {#each l.windows as w (w.label)}
                  <span class="window" class:high={w.used >= 80} title="{w.label} window{w.resets ? ` · ${w.resets}` : ''}">
                    <span
                      class="bar"
                      role="meter"
                      aria-label="{l.who}, {w.label} window used"
                      aria-valuemin="0"
                      aria-valuemax="100"
                      aria-valuenow={w.used}
                    ><span style="width: {w.used}%"></span></span>
                    <span class="used">{w.fresh ? "reset" : `${Math.round(w.used)}%`}</span>
                  </span>
                {/each}
              </li>
            {/each}
          </ul>
        {/if}
        <!-- Hive Phone (mobile/relay): pairing it, getting it, and the passcode Hive unlocks with. -->
        <details class="phone" ontoggle={(e) => (e.currentTarget as HTMLDetailsElement).open && loadPhone()}>
          <summary>iPhone</summary>
          <div class="phone-body">
            <button type="button" class="phone-btn" onclick={connectPhone}>Connect an iPhone</button>
            {#if phoneGet}<a class="phone-link" href={phoneGet}>Get Hive Phone in SideStore</a>{/if}
            {#if phone?.connected && !phone.passcode}
              <form class="phone-pass" onsubmit={savePasscode}>
                <input type="password" inputmode="numeric" autocomplete="off" placeholder="iPhone passcode" aria-label="iPhone passcode" bind:value={phonePass} />
                <button type="submit" class="phone-btn" disabled={!phonePass}>Let Hive unlock with it</button>
              </form>
            {:else if phone?.paused}
              <button type="button" class="phone-btn" onclick={() => phoneAct({ retry: true, consent: true }, "Hive may try unlocking once more.")}>Allow another unlock try</button>
            {:else if phone?.passcode}
              <button type="button" class="phone-btn quiet" onclick={() => phoneAct({ remove: true }, "Forgot the passcode.")}>Forget the passcode</button>
            {/if}
            {#if phoneNote}<p class="phone-note" role="status">{phoneNote}</p>{/if}
          </div>
        </details>
        <!-- The club (cloud/tasks/club.js): who may ask Hive to change itself, from the club page. -->
        <details class="phone" ontoggle={(e) => (e.currentTarget as HTMLDetailsElement).open && loadClub()}>
          <summary>Club</summary>
          <div class="phone-body">
            {#each club as m (m.name)}
              <div class="club-member">
                <span>{m.name}</span>
                <span class="used">{m.joined ? `${m.going} of ${m.max_agents} going` : m.invited ? "invited" : "invite lapsed"}</span>
                {#if !m.joined}<button type="button" class="phone-btn quiet" onclick={() => invite(m.name)}>New link</button>{/if}
                <button type="button" class="phone-btn quiet" onclick={() => letGo(m.name)}>Remove</button>
              </div>
            {/each}
            <form class="phone-pass" onsubmit={(e) => { e.preventDefault(); invite(clubName); }}>
              <input placeholder="Member's name" aria-label="Member's name" autocomplete="off" bind:value={clubName} />
              <button type="submit" class="phone-btn" disabled={!clubName.trim()}>Invite</button>
            </form>
            {#if clubLink}<button type="button" class="phone-btn" onclick={copyInvite}>Copy {clubLink.name}'s invite link</button>{/if}
            <a class="phone-link" href="{base}/club">Open the club page</a>
            {#if clubNote}<p class="phone-note" role="status">{clubNote}</p>{/if}
          </div>
        </details>
        <a class="settings-link" href="{base}/settings">Settings</a>
      </div>
    </div>
  </aside>

  <main class="main">
    {#if agentKey}
      {#if !agent}
        <div class="column">
          <p class="board-note">{board ? "That agent isn't around any more." : "Loading…"}</p>
        </div>
      {:else}
        <div class="column agent-view">
          <!-- Named for what it is and where; what it's on is its first task below, said once. -->
          <header class="agent-head">
            <div class="agent-name">
              <h1>{agent.label}</h1>
              <span class="tag status st-{agent.status}"><span class="dot st-{agent.status}" aria-hidden="true"></span>{STATUS_LABEL[agent.status]}</span>
            </div>
            {#if agent.place}<p class="place">{agent.place}</p>{/if}
          </header>

          <section class="convo" aria-label="Conversation" use:followNewest={follow}>
            {#if convo.loading && !items.length && agent.kind !== "cloud"}
              <p class="board-note">Loading the conversation…</p>
            {:else if !items.length}
              <p class="board-note">Nothing said here yet. Say something below and it reaches the agent wherever it runs.</p>
            {/if}
            {#if convo.error && agent.kind !== "cloud"}<p class="board-note bad">Couldn't load it: {convo.error}</p>{/if}
            {#each items as item (item.key)}
              {#if item.type === "owner"}
                <div class="msg mine">
                  <p class="bubble">{item.text}</p>
                  {#if item.about || item.state}
                    <p class="msg-meta">
                      {[item.about, item.state === "sending" ? "Sending…" : item.state ? deliveryWords({ status: item.state, detail: item.detail }) : ""].filter(Boolean).join(" · ")}
                    </p>
                  {/if}
                </div>
              {:else if item.type === "agent"}
                <div class="msg theirs" class:bad={item.failed}>
                  <p class="bubble">{titled(item.text, agent.machine)}</p>
                </div>
              {:else if item.type === "note"}
                <p class="note">{titled(item.text, agent.machine)}</p>
              {:else}
                {@const going = agent.status === "working" && item.key === lastWork && items.at(-1)?.key === item.key}
                {@const isOpen = openWork[item.key] ?? false}
                <div class="work" class:going>
                  <button type="button" class="work-head" aria-expanded={isOpen} onclick={() => (openWork[item.key] = !isOpen)}>
                    <span class="chev" aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
                    <span>{item.summary}</span>
                  </button>
                  {#if isOpen}
                    <ol class="work-lines">
                      {#each item.lines as l (l.n)}
                        {@const lineKey = `${item.key}:${l.n}`}
                        <li class:failed={l.failed}>
                          {#if l.full}
                            <!-- A step's line is short; the whole of it is a click away. -->
                            <button type="button" class="line-more" aria-expanded={!!openLine[lineKey]} onclick={() => (openLine[lineKey] = !openLine[lineKey])}>
                              <span class="verb">{l.verb}</span> <span class="target">{l.target}</span>
                            </button>
                            {#if openLine[lineKey]}<pre class="line-full">{l.full}</pre>{/if}
                          {:else}
                            <span class="verb">{l.verb}</span> <span class="target">{l.target}</span>
                          {/if}
                        </li>
                      {/each}
                    </ol>
                  {:else if going}
                    {@const l = item.lines.at(-1)}
                    {#if l}<p class="work-now"><span class="verb">{l.verb}</span> <span class="target">{l.target}</span></p>{/if}
                  {/if}
                </div>
              {/if}
            {/each}
          </section>

          <!-- Its tasks sit just above its message box, so they stay in view at the newest line (T306). -->
          <div class="dock">
            {#if agent.tasks.length}
              {@const unfinished = agent.tasks.filter((t) => !["done", "dropped"].includes(t.status))}
              {@const finished = agent.tasks.filter((t) => ["done", "dropped"].includes(t.status))}
              {@const waits = unfinished.find((t) => t.status === "open" && !t.outcome)}
              <section class="claims" aria-labelledby="h-claims">
                <h2 id="h-claims">
                  <button type="button" class="claims-toggle" aria-expanded={!claimsFolded} onclick={() => (claimsFolded = !claimsFolded)}>
                    <span class="chev" aria-hidden="true">{claimsFolded ? "▸" : "▾"}</span>
                    Its tasks <span class="count">{agent.tasks.length}</span>
                  </button>
                </h2>
                {#if !claimsFolded}
                  <div class="claims-body">
                    {#if waits}<p class="claims-why">Not started yet: {titled(reasonFor(waits, agent), agent.machine).replace(/^./, (c) => c.toLowerCase())}</p>{/if}
                    {#if unfinished.length}
                      <ul class="task-list">
                        {#each unfinished as task (task.key)}{@render taskRow(task, true)}{/each}
                      </ul>
                    {/if}
                    {#if finished.length}
                      <button type="button" class="claims-more" aria-expanded={allClaims} onclick={() => (allClaims = !allClaims)}>
                        {allClaims ? "Hide the finished ones" : `Show ${finished.length} finished`}
                      </button>
                      {#if allClaims}
                        <ul class="task-list">
                          {#each finished as task (task.key)}{@render taskRow(task, true)}{/each}
                        </ul>
                      {/if}
                    {/if}
                  </div>
                {/if}
              </section>
            {/if}

          <form class="talk" onsubmit={say}>
            <label class="visually-hidden" for="talk-text">Message this agent</label>
            <textarea
              id="talk-text"
              bind:this={talkBox}
              rows="1"
              placeholder="Message {agent.label}…"
              bind:value={talk}
              onkeydown={talkKeys}
            ></textarea>
            <button type="submit" class="send" disabled={!talk.trim() || talking} aria-label="Send" title="Send (⌘↵)">
              <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M10 15V5M5.5 9.5L10 5l4.5 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
            {#if talkError}<p class="talk-note bad" role="alert">{talkError}</p>{/if}
          </form>
          </div>
        </div>
      {/if}
    {:else if rulesOpen}
      <div class="column">
        <h1 class="page-title">Standing rules</h1>
        {#if !board}
          <p class="board-note">Loading…</p>
        {:else if !board.rules.length}
          <p class="board-note">No standing rules yet.</p>
        {/if}
        {#each board ? rulesByProject(board.rules) : [] as group, i (group.key)}
          <section class="section" aria-labelledby="h-rules-{i}">
            <h2 id="h-rules-{i}" title={group.key || undefined}>{group.name} <span class="count">{group.rules.length}</span></h2>
            <ul class="card rule-list">
              {#each group.rules as r (r.key)}
                <li class="rule">
                  <div class="rule-text">
                    <span title={r.quote ? `You said: “${r.quote}”` : undefined}>{r.text}</span>
                    <span class="rule-scope">{ruleScope(r, { project: false })}</span>
                    {#if ruleError[r.key]}<span class="rule-error">{ruleError[r.key]}</span>{/if}
                  </div>
                  {#if r.machine}
                    <button
                      type="button"
                      class="x"
                      class:armed={ruleConfirming === r.key}
                      disabled={ruleActing === r.key}
                      aria-label={ruleConfirming === r.key ? "Confirm: turn this rule off" : "Turn this rule off"}
                      title={ruleConfirming === r.key ? "Click again to turn it off on every machine" : "Turn this rule off"}
                      onclick={() => askRuleOff(r)}
                    >
                      {#if ruleActing === r.key}…{:else if ruleConfirming === r.key}Turn off{:else}
                        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
                      {/if}
                    </button>
                  {/if}
                </li>
              {/each}
            </ul>
          </section>
        {/each}
      </div>
    {:else}
      <div class="column">
        {#if projectChosen}
          <p class="crumbs">
            {#if folderChosen}
              <button type="button" onclick={() => choose(project)}>{projectChosen.name}</button>
              <span aria-hidden="true">›</span>
              <strong>{folderChosen.name}</strong>
            {:else}
              <strong>{projectChosen.name}</strong>
            {/if}
          </p>
        {/if}

        <form class="composer" onsubmit={send}>
          <label class="visually-hidden" for="task-text">Tell an agent what to do</label>
          <textarea
            id="task-text"
            bind:this={composerBox}
            rows="2"
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
            {#if sent}<p class="composer-note" class:bad={!sent.ok} role="status">{sent.text}</p>{/if}
            <button type="submit" class="send" disabled={!text.trim() || sending} aria-label="Send" title="Send (⌘↵)">
              <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M10 15V5M5.5 9.5L10 5l4.5 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
          </div>
        </form>

        {#if folderChosen}
          <section class="card folder-panel" aria-label="The {folderChosen.name} folder">
            {#if editingAbout}
              <form class="about-form" onsubmit={saveAbout}>
                <textarea rows="2" bind:value={aboutText} placeholder="What this folder is for"></textarea>
                <div class="row-actions">
                  <button type="button" class="quiet" onclick={() => (editingAbout = false)}>Cancel</button>
                  <button type="submit" class="pill-button">Save</button>
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
                      <span class="when">{ago(m.created, board?.now ?? 0)}</span>
                    </button>
                    {#if openMemory === m.key}<p class="mbody">{m.body}</p>{/if}
                  </li>
                {/each}
              </ul>
            {/if}
            <form class="memory-form" onsubmit={addMemory}>
              <textarea rows="2" placeholder="Add a memory for this folder's agents (the first line is its title)" bind:value={memoryText}></textarea>
              <div class="row-actions">
                <select bind:value={memoryKind} aria-label="Kind of memory">
                  {#each KINDS as k (k)}<option value={k}>{k}</option>{/each}
                </select>
                <button type="submit" class="pill-button" disabled={!memoryText.trim() || savingMemory}>
                  {savingMemory ? "Saving…" : "Remember"}
                </button>
              </div>
            </form>
          </section>
        {/if}

        {#if loadError && !board}
          <p class="board-note bad" role="alert">Couldn't load the tasks: {loadError}</p>
        {:else if !board}
          <p class="board-note">Loading the tasks…</p>
        {:else}
          {#if loadError}<p class="board-note bad">Couldn't refresh: {loadError}</p>{/if}

          {#each shown as section (section.id)}
            {#if section.id === "done"}
              {#if section.total}
                <section class="section" aria-labelledby="h-done">
                  <button type="button" class="section-toggle" id="h-done" aria-expanded={doneOpen} onclick={() => (doneOpen = !doneOpen)}>
                    <h2>Done <span class="count">{section.total}</span></h2>
                    <span aria-hidden="true">{doneOpen ? "▾" : "▸"}</span>
                  </button>
                  {#if doneOpen}
                    <ul class="card task-list">
                      {#each section.tasks as task (task.key)}{@render taskRow(task, false)}{/each}
                    </ul>
                    {#if section.total > section.tasks.length}
                      <button type="button" class="side-more" onclick={() => (showAllDone = true)}>Show all {section.total}</button>
                    {/if}
                  {/if}
                </section>
              {/if}
            {:else if section.tasks.length || section.id === "needs-you"}
              <section class="section" aria-labelledby="h-{section.id}">
                <h2 id="h-{section.id}">{SECTION_TITLES[section.id] ?? section.title} <span class="count" class:warm={section.id === "needs-you" && section.total}>{section.total}</span></h2>
                {#if !section.tasks.length}
                  <p class="empty">Nothing needs you right now.</p>
                {:else}
                  {#each byAgent(section.tasks, ofTask) as group (group.key)}
                    {@const waits = section.id === "not-started" ? group.tasks.find((t) => !t.outcome) : undefined}
                    {@render groupHead(group.agent, waits ? titled(reasonFor(waits, group.agent ?? undefined), waits.machine) : "")}
                    <ul class="card task-list">
                      {#each group.tasks as task (task.key)}{@render taskRow(task, false)}{/each}
                    </ul>
                  {/each}
                {/if}
              </section>
            {/if}
          {/each}

          {#if board.unsplit.length}
            <div class="extras">
              <details class="extra">
                <summary>Messages not split into tasks yet <span class="count">{board.unsplit.length}</span></summary>
                <ul>
                  {#each board.unsplit as m (m.key)}<li class="quote">“{m.text}”</li>{/each}
                </ul>
              </details>
            </div>
          {/if}
        {/if}
      </div>
    {/if}
  </main>
</div>

<style>
  /* Dark only, rounded and roomy: friendly rounded display type, soft cards, pill tags, gold for what
     you act on, colour only to say how something is doing. */
  .app {
    --display: ui-rounded, "SF Pro Rounded", var(--font-geist-sans), system-ui, sans-serif;
    --card: rgba(255, 244, 228, 0.035);
    --card-hover: rgba(255, 244, 228, 0.06);
    --radius: 18px;
    display: grid;
    grid-template-columns: 288px minmax(0, 1fr);
    height: 100vh;
    height: 100dvh;
    font-size: var(--fs-body);
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  button {
    font: inherit;
    color: inherit;
    background: none;
    cursor: pointer;
  }
  button:disabled {
    cursor: default;
    opacity: 0.5;
  }
  input,
  textarea,
  select {
    font: inherit;
    color: var(--ink);
  }

  /* ---- the side ---- */
  .side {
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: var(--s4) var(--s3);
    border-right: 1px solid var(--line);
    background: rgba(255, 244, 228, 0.018);
    overflow-y: auto;
  }
  .brand {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--s2) var(--s3);
  }
  .brand-home {
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: var(--display);
    font-size: 1.25rem;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .brand-mark {
    width: 30px;
    height: 30px;
    border-radius: 9px;
  }
  .menu {
    display: none;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-radius: 999px;
    border: 1px solid var(--line);
  }
  .side-rest {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-height: 0;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 var(--s3);
    padding: 0 12px;
    height: 38px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--card);
    color: var(--muted);
  }
  .search:focus-within {
    border-color: var(--line-strong);
  }
  .search input {
    flex: 1;
    min-width: 0;
    background: none;
    border: 0;
  }
  .search input::placeholder {
    color: var(--muted);
  }
  .nav-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    border-radius: 12px;
    text-align: left;
    color: var(--ink-2);
  }
  .nav-row:hover,
  .agent-row:hover {
    background: var(--card-hover);
    color: var(--ink);
  }
  .nav-row.on,
  .agent-row.on {
    background: rgba(255, 244, 228, 0.085);
    color: var(--ink);
  }
  .nav-row.sub {
    padding-left: 26px;
    font-size: var(--fs-small);
  }
  .side-label {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: var(--s4) 0 var(--s1);
    padding: 0 12px;
    color: var(--muted);
    font-size: var(--fs-small);
    font-weight: 600;
  }
  .side-label.toggle:hover {
    color: var(--ink-2);
  }
  .side-empty {
    padding: 4px 12px;
    color: var(--muted);
    font-size: var(--fs-small);
  }
  .side-more {
    align-self: flex-start;
    margin: 2px 0 0 4px;
    padding: 4px 8px;
    border-radius: 999px;
    color: var(--muted);
    font-size: var(--fs-small);
  }
  .side-more:hover {
    color: var(--ink);
  }
  .agent-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .agent-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 9px 12px;
    border-radius: 14px;
    text-align: left;
  }
  .agent-text {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  .agent-title {
    overflow-wrap: anywhere;
    color: var(--ink);
    font-size: 0.875rem;
  }
  .agent-meta {
    overflow-wrap: anywhere;
    color: var(--muted);
    font-size: 0.75rem;
  }
  .dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: rgba(255, 244, 228, 0.22);
  }
  .dot.st-working {
    background: var(--green);
    box-shadow: 0 0 0 0 rgba(122, 216, 160, 0.5);
    animation: pulse 2s ease-out infinite;
  }
  .dot.st-needs-you,
  .dot.st-stuck {
    background: var(--amber);
  }
  @keyframes pulse {
    to {
      box-shadow: 0 0 0 7px rgba(122, 216, 160, 0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot.st-working {
      animation: none;
    }
  }
  .count {
    flex: none;
    min-width: 22px;
    padding: 1px 7px;
    border-radius: 999px;
    background: rgba(255, 244, 228, 0.08);
    color: var(--ink-2);
    font-size: 0.72rem;
    font-weight: 600;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .count.warm {
    background: rgba(255, 173, 92, 0.16);
    color: var(--amber);
  }
  .tree,
  .folders {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .new-folder input {
    width: 100%;
    margin: 2px 0;
    padding: 6px 12px 6px 26px;
    border: 0;
    border-radius: 12px;
    background: none;
    font-size: var(--fs-small);
  }
  .new-folder input::placeholder {
    color: var(--muted);
  }
  .side-foot {
    display: flex;
    flex-direction: column;
    gap: var(--s3);
    margin-top: auto;
    padding: var(--s5) 12px 0;
  }
  .limits {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .limits li {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-size: 0.72rem;
  }
  .limits .who {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .window {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .bar {
    width: 34px;
    height: 4px;
    border-radius: 99px;
    background: rgba(255, 244, 228, 0.1);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--ink-2);
  }
  .window.high .bar span {
    background: var(--amber);
  }
  .used {
    min-width: 28px;
    font-variant-numeric: tabular-nums;
  }
  .nodes li.away {
    opacity: 0.55;
  }
  .dot.node-current {
    background: var(--green);
  }
  .dot.node-behind,
  .dot.node-old {
    background: var(--amber);
  }
  .phone summary {
    cursor: pointer;
    color: var(--muted);
    font-size: 0.72rem;
  }
  .phone-body {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    padding-top: 8px;
  }
  .phone-pass {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
  }
  .phone-pass input {
    width: 100%;
    font: inherit;
    font-size: 0.8rem;
  }
  .phone-btn {
    font: inherit;
    font-size: 0.72rem;
    cursor: pointer;
  }
  .club-member {
    align-self: stretch;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .club-member > span:first-child {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .phone-btn.quiet {
    color: var(--muted);
  }
  .phone-link,
  .phone-note {
    font-size: 0.72rem;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  .settings-link {
    color: var(--muted);
    font-size: var(--fs-small);
  }
  .settings-link:hover {
    color: var(--ink);
  }

  /* ---- the main column ---- */
  .main {
    min-width: 0;
    overflow-y: auto;
  }
  .column {
    max-width: 780px;
    margin: 0 auto;
    padding: var(--s6) var(--s5) var(--s7);
  }
  .crumbs {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: var(--s4);
    color: var(--muted);
    font-size: var(--fs-small);
  }
  .crumbs button:hover {
    color: var(--ink);
  }
  .crumbs strong {
    color: var(--ink);
    font-weight: 600;
  }
  .card {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--card);
  }
  .composer {
    display: flex;
    flex-direction: column;
    gap: var(--s2);
    padding: var(--s4) var(--s4) var(--s3);
    border: 1px solid var(--line-strong);
    border-radius: 24px;
    background: rgba(255, 244, 228, 0.045);
    box-shadow: 0 18px 50px -24px rgba(0, 0, 0, 0.8);
  }
  .composer:focus-within {
    border-color: rgba(245, 197, 66, 0.35);
  }
  .composer textarea,
  .talk textarea {
    width: 100%;
    resize: none;
    border: 0;
    background: none;
    font-size: 1rem;
    line-height: 1.5;
  }
  .composer textarea::placeholder,
  .talk textarea::placeholder {
    color: var(--muted);
  }
  .composer-row {
    display: flex;
    align-items: center;
    gap: var(--s3);
  }
  .composer-note {
    flex: 1;
    color: var(--ink-2);
    font-size: var(--fs-small);
  }
  .mic {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 36px;
    min-width: 36px;
    justify-content: center;
    padding: 0 10px;
    border-radius: 999px;
    border: 1px solid var(--line);
    color: var(--ink-2);
    font-size: var(--fs-small);
  }
  .mic.on {
    border-color: rgba(255, 123, 112, 0.5);
    color: var(--red);
  }
  .send {
    display: grid;
    place-items: center;
    flex: none;
    width: 36px;
    height: 36px;
    margin-left: auto;
    border-radius: 50%;
    background: var(--gold);
    color: var(--on-gold);
  }
  .send:disabled {
    opacity: 1;
    background: rgba(255, 244, 228, 0.1);
    color: var(--muted);
  }

  .section {
    margin-top: var(--s6);
  }
  .section h2,
  .claims h2 {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: var(--s3);
    font-family: var(--display);
    font-size: 1.2rem;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .section-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
  }
  .section-toggle h2 {
    margin: 0;
    color: var(--ink);
  }
  .section-toggle + .task-list {
    margin-top: var(--s3);
  }
  .section h2 + .group-head {
    margin-top: 0;
  }
  .group-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 10px;
    margin: var(--s4) 0 var(--s2);
  }
  .group-why {
    color: var(--muted);
    font-size: var(--fs-small);
  }
  .agent-chip.none {
    color: var(--muted);
  }
  .chip-go {
    margin-left: 2px;
    color: var(--muted);
  }
  .now {
    flex: none;
    align-self: center;
    padding: 1px 9px;
    border-radius: 999px;
    background: rgba(122, 216, 160, 0.12);
    color: var(--green);
    font-size: 0.7rem;
    font-weight: 600;
  }
  .claims-more {
    width: 100%;
    padding: 10px 16px;
    border-top: 1px solid var(--line);
    color: var(--muted);
    font-size: var(--fs-small);
    text-align: left;
  }
  .claims-more:hover {
    color: var(--ink);
  }
  .claims-why {
    padding: 0 16px 6px;
    color: var(--muted);
    font-size: var(--fs-small);
  }
  .empty {
    color: var(--muted);
  }
  .task-list {
    overflow: hidden;
  }
  .task {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 14px 16px;
  }
  .task + .task {
    border-top: 1px solid var(--line);
  }
  .task-line {
    display: flex;
    align-items: center;
    gap: var(--s3);
  }
  .task-title {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex: 1;
    min-width: 0;
    text-align: left;
  }
  .tid {
    flex: none;
    color: var(--muted);
    font-family: var(--font-geist-mono), ui-monospace, monospace;
    font-size: 0.75rem;
  }
  .tname {
    color: var(--ink);
    font-weight: 500;
  }
  .task-title:hover .tname {
    text-decoration: underline;
    text-decoration-color: var(--line-strong);
    text-underline-offset: 3px;
  }
  .s-done .tname,
  .s-dropped .tname {
    color: var(--ink-2);
    font-weight: 400;
  }
  .s-dropped .tname {
    text-decoration: line-through;
    text-decoration-color: var(--muted);
  }
  .when {
    flex: none;
    color: var(--muted);
    font-size: 0.75rem;
  }
  .task-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: none;
  }
  .pill-button {
    padding: 5px 14px;
    border-radius: 999px;
    border: 1px solid var(--line-strong);
    color: var(--ink);
    font-size: var(--fs-small);
    font-weight: 500;
  }
  .pill-button:hover:not(:disabled) {
    border-color: rgba(245, 197, 66, 0.5);
    color: var(--gold);
  }
  .x {
    display: grid;
    place-items: center;
    min-width: 28px;
    height: 28px;
    border-radius: 999px;
    color: var(--muted);
    font-size: 0.75rem;
    font-weight: 600;
  }
  .x:hover:not(:disabled) {
    background: rgba(255, 123, 112, 0.12);
    color: var(--red);
  }
  .x.armed {
    padding: 0 12px;
    background: rgba(255, 123, 112, 0.16);
    color: var(--red);
  }
  .task-ask,
  .reason {
    padding-left: 2px;
    line-height: 1.45;
  }
  .task-ask {
    color: var(--ink);
  }
  .reason {
    color: var(--ink-2);
    font-size: var(--fs-small);
  }
  .answer {
    display: flex;
    gap: 8px;
    margin-top: 2px;
  }
  .answer input {
    flex: 1;
    min-width: 0;
    height: 36px;
    padding: 0 14px;
    border: 1px solid var(--line-strong);
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.2);
  }
  .answer input:focus {
    border-color: rgba(255, 173, 92, 0.5);
  }
  .send-small {
    padding: 0 16px;
    border-radius: 999px;
    background: var(--gold);
    color: var(--on-gold);
    font-size: var(--fs-small);
    font-weight: 600;
  }
  .send-small:disabled {
    opacity: 1;
    background: rgba(255, 244, 228, 0.1);
    color: var(--muted);
  }
  .act-note {
    color: var(--green);
    font-size: var(--fs-small);
  }
  .agent-chip {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    gap: 7px;
    padding: 3px 11px 3px 9px;
    border-radius: 999px;
    background: rgba(255, 244, 228, 0.06);
    color: var(--ink-2);
    font-size: 0.75rem;
  }
  .agent-chip:hover {
    background: rgba(255, 244, 228, 0.1);
    color: var(--ink);
  }
  .agent-chip .dot {
    width: 6px;
    height: 6px;
  }
  .task-more {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 6px;
    padding: 12px 14px;
    border-radius: 14px;
    background: rgba(0, 0, 0, 0.18);
  }
  .label {
    margin-top: 6px;
    color: var(--muted);
    font-size: 0.72rem;
    font-weight: 600;
  }
  .label:first-child {
    margin-top: 0;
  }
  .quote,
  .report {
    color: var(--ink-2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.5;
  }
  .changes {
    color: var(--ink-2);
    font-size: var(--fs-small);
  }
  .changes code,
  .hash {
    font-family: var(--font-geist-mono), ui-monospace, monospace;
    font-size: 0.75rem;
  }
  .hash {
    color: var(--gold);
    margin-right: 6px;
  }
  .files summary {
    cursor: pointer;
  }
  .meta {
    margin-top: 6px;
    color: var(--muted);
    font-size: 0.75rem;
  }
  .meta:empty {
    display: none;
  }
  .board-note {
    margin-top: var(--s5);
    color: var(--muted);
  }
  .bad {
    color: var(--red) !important;
  }
  .link {
    color: var(--gold);
  }
  .quiet {
    color: var(--muted);
    font-size: var(--fs-small);
  }
  .extras {
    display: flex;
    flex-direction: column;
    gap: var(--s2);
    margin-top: var(--s6);
  }
  .extra summary {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-size: var(--fs-small);
    cursor: pointer;
    list-style: none;
  }
  .extra summary:hover {
    color: var(--ink-2);
  }
  .extra ul {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: var(--s3) 0 var(--s2);
    padding: var(--s4);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    color: var(--ink-2);
    font-size: var(--fs-small);
  }

  .rule {
    display: flex;
    align-items: flex-start;
    gap: var(--s2);
  }
  .rule-text {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    gap: 2px;
    overflow-wrap: anywhere;
  }
  .rule-scope {
    color: var(--muted);
  }
  .rule-error {
    color: var(--red);
  }

  /* ---- a folder ---- */
  .folder-panel {
    display: flex;
    flex-direction: column;
    gap: var(--s3);
    margin-top: var(--s5);
    padding: var(--s4);
  }
  .about {
    color: var(--ink-2);
  }
  .about .link {
    margin-left: 6px;
    font-size: var(--fs-small);
  }
  .about-form,
  .memory-form {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .about-form textarea,
  .memory-form textarea {
    width: 100%;
    padding: 10px 14px;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: rgba(0, 0, 0, 0.2);
    resize: vertical;
  }
  .row-actions {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 8px;
  }
  .row-actions select {
    padding: 4px 10px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--panel-strong);
    font-size: var(--fs-small);
  }
  .memories {
    display: flex;
    flex-direction: column;
  }
  .memory {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 4px;
    text-align: left;
  }
  .kind {
    flex: none;
    padding: 1px 9px;
    border-radius: 999px;
    background: rgba(255, 244, 228, 0.07);
    color: var(--ink-2);
    font-size: 0.7rem;
  }
  .kind-spec {
    color: var(--blue);
  }
  .kind-decision {
    color: var(--gold);
  }
  .kind-report {
    color: var(--green);
  }
  .mtitle {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .mbody {
    padding: 4px 4px 10px;
    color: var(--ink-2);
    white-space: pre-wrap;
    font-size: var(--fs-small);
  }

  /* ---- an agent ---- */
  .agent-view {
    display: flex;
    flex-direction: column;
    min-height: 100%;
    padding-bottom: 0;
  }
  .agent-name {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
  }
  .agent-name h1 {
    font-family: var(--display);
    font-size: clamp(1.5rem, 1.2rem + 1.2vw, 2rem);
    font-weight: 700;
    letter-spacing: -0.015em;
    line-height: 1.2;
  }
  .agent-head .place {
    margin-top: 2px;
  }
  .tag {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 11px;
    border-radius: 999px;
    background: rgba(255, 244, 228, 0.07);
    color: var(--ink-2);
    font-size: 0.75rem;
    font-weight: 600;
  }
  .tag.status.st-working {
    background: rgba(122, 216, 160, 0.12);
    color: var(--green);
  }
  .tag.status.st-needs-you,
  .tag.status.st-stuck {
    background: rgba(255, 173, 92, 0.14);
    color: var(--amber);
  }
  .place {
    color: var(--muted);
    font-size: var(--fs-small);
  }
  /* Its tasks and its message box, held at the bottom of the window together. */
  .dock {
    position: sticky;
    bottom: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s2);
    margin: 0 calc(-1 * var(--s2));
    padding: var(--s2) 0 var(--s4);
    background: var(--background);
    box-shadow: 0 -12px 30px -10px var(--background);
  }
  .claims {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: #161512;
  }
  .claims h2 {
    margin: 0;
    font-size: 0.95rem;
  }
  .claims-toggle {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    font: inherit;
    text-align: left;
  }
  .claims-toggle .chev {
    width: 10px;
    color: var(--muted);
    font-size: 0.75rem;
  }
  /* A long list scrolls inside, so the conversation keeps most of the window. */
  .claims-body {
    max-height: 38vh;
    overflow-y: auto;
    border-top: 1px solid var(--line);
    padding-top: 8px;
  }
  .claims-body > .claims-more:first-child {
    border-top: 0;
  }
  .page-title {
    font-family: var(--display);
    font-size: clamp(1.5rem, 1.2rem + 1.2vw, 2rem);
    font-weight: 700;
    letter-spacing: -0.015em;
    line-height: 1.2;
  }
  .rule-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: var(--s4);
    color: var(--ink-2);
    font-size: var(--fs-small);
  }
  .brand-home .count {
    font-family: var(--font-geist-sans), system-ui, sans-serif;
    letter-spacing: 0;
  }
  .convo {
    display: flex;
    flex-direction: column;
    gap: var(--s3);
    flex: 1;
    padding: var(--s5) 0 var(--s4);
  }
  .msg {
    display: flex;
    flex-direction: column;
    max-width: 86%;
  }
  .msg.mine {
    align-self: flex-end;
    align-items: flex-end;
  }
  .bubble {
    padding: 10px 15px;
    border-radius: 20px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.5;
  }
  .mine .bubble {
    border-bottom-right-radius: 6px;
    background: rgba(245, 197, 66, 0.13);
    color: var(--ink);
  }
  .theirs .bubble {
    border-bottom-left-radius: 6px;
    background: rgba(255, 244, 228, 0.06);
    color: var(--ink);
  }
  .msg-meta {
    margin-top: 4px;
    padding: 0 6px;
    color: var(--muted);
    font-size: 0.72rem;
  }
  .note {
    align-self: center;
    padding: 3px 12px;
    border-radius: 999px;
    background: rgba(255, 244, 228, 0.05);
    color: var(--muted);
    font-size: 0.75rem;
  }
  .work {
    align-self: flex-start;
    max-width: 100%;
    padding-left: 4px;
  }
  .work-head {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-size: var(--fs-small);
    text-align: left;
  }
  .work-head:hover {
    color: var(--ink-2);
  }
  .chev {
    width: 10px;
    font-size: 0.7rem;
  }
  .work.going .work-head {
    color: var(--ink-2);
  }
  .work-lines,
  .work-now {
    margin: 6px 0 0 4px;
    padding-left: 14px;
    border-left: 2px solid var(--line);
    font-size: var(--fs-small);
  }
  .work-lines {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .work-now {
    border-left-color: rgba(122, 216, 160, 0.5);
  }
  .verb {
    color: var(--ink-2);
  }
  .target {
    color: var(--muted);
    font-family: var(--font-geist-mono), ui-monospace, monospace;
    font-size: 0.75rem;
    overflow-wrap: anywhere;
  }
  .work-lines .failed .verb {
    color: var(--red);
  }
  .line-more {
    padding: 0;
    border: 0;
    background: none;
    text-align: left;
    cursor: pointer;
  }
  .line-more:hover .target {
    color: var(--ink-2);
  }
  .line-full {
    margin: 4px 0 6px;
    padding: 8px 10px;
    border-radius: 10px;
    background: var(--card-hover);
    color: var(--ink-2);
    font-family: var(--font-geist-mono), ui-monospace, monospace;
    font-size: 0.75rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .talk {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--s2);
    padding: var(--s3) var(--s3) var(--s3) var(--s4);
    border: 1px solid var(--line-strong);
    border-radius: 24px;
    background: #1a1815;
    box-shadow: 0 18px 40px -20px rgba(0, 0, 0, 0.9);
  }
  .talk:focus-within {
    border-color: rgba(245, 197, 66, 0.35);
  }
  .talk textarea {
    flex: 1;
    min-width: 0;
    max-height: 40vh;
    padding: 6px 0;
    field-sizing: content;
  }
  .talk-note {
    flex-basis: 100%;
    font-size: var(--fs-small);
  }

  /* ---- phones ---- */
  @media (max-width: 760px) {
    .app {
      display: block;
      height: auto;
    }
    .side {
      position: sticky;
      top: 0;
      z-index: 5;
      max-height: 100dvh;
      padding: var(--s3) var(--s4);
      border-right: 0;
      border-bottom: 1px solid var(--line);
      background: rgba(16, 15, 13, 0.92);
      backdrop-filter: blur(14px);
    }
    .brand {
      padding: 0;
    }
    .menu {
      display: inline-flex;
    }
    .side-rest {
      display: none;
      padding-top: var(--s3);
    }
    .side-rest.open {
      display: flex;
    }
    .main {
      overflow: visible;
    }
    .column {
      padding: var(--s5) var(--s4) var(--s6);
    }
    .agent-view {
      min-height: calc(100dvh - 60px);
    }
    .msg {
      max-width: 92%;
    }
    .dock {
      margin: 0 calc(-1 * var(--s1));
      padding-bottom: var(--s3);
    }
    .claims-body {
      max-height: 28vh;
    }
  }
</style>
