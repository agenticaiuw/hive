(function() {
	//#region browser-extension/src/bridge-core.js
	const DEFAULT_AGENT_URL = "http://127.0.0.1:8000";
	Object.freeze([
		"session",
		"sessionId",
		"browserSession",
		"sessionName",
		"bootstrapUrl"
	]);
	Object.freeze(["tabId", "windowId"]);
	new TextEncoder();
	//#endregion
	//#region browser-extension/src/command-console.js
	const HISTORY_KEY = "consoleHistory";
	const INCLUDE_PAGE_KEY = "consoleIncludePage";
	const MAX_COMMAND_CHARS = 2e3;
	function dashboardUrlFor(agentUrl) {
		try {
			const url = new URL(agentUrl);
			if (url.hostname === "127.0.0.1") url.hostname = "localhost";
			return `${url.origin}/dashboard`;
		} catch {
			return "http://localhost:8000/dashboard";
		}
	}
	/**
	* May this entry still be decided from the popup? Pure, and the SAME check
	* the popup renders from and background.js gates on — a button that is
	* pressable must be a button that works, and the only way to guarantee that
	* is for both sides to ask one function.
	*
	* The agent's own `plan_ready` re-check happens on top of this, in
	* background.js, because it needs the network. This covers everything
	* knowable from the entry alone.
	*/
	function planDecisionPreflight(entry, now = Date.now()) {
		if (!entry) return {
			ok: false,
			error: "That command is no longer in this list."
		};
		if (entry.state !== "parked") return {
			ok: false,
			error: `That plan is no longer waiting — it is "${entry.state}".`
		};
		const pending = entry.pending;
		if (!pending?.kind) return {
			ok: false,
			error: "This plan parked before the popup could keep its steps, so it can only be approved on the dashboard."
		};
		const parkedAt = Date.parse(pending.parkedAt ?? entry.finishedAt ?? "");
		if (Number.isFinite(parkedAt) && now - parkedAt > 6e5) return {
			ok: false,
			expired: true,
			error: "This plan has been waiting too long to run from here — the pages it was written against have moved on. Send the command again."
		};
		return {
			ok: true,
			pending
		};
	}
	/**
	* The ordered ways a browser might agree to show the standalone console.
	*
	* THE BUG THIS SHAPE FIXES (owner, 2026-08-10: "after I first expand the
	* pop-up and then collapse it, I'm not able to open the pop-up again"). The
	* ladder used to be `if (await rung())` — treating a FALSY RETURN as "this
	* rung declined, try the next one". But a browser that opens the window and
	* returns nothing is indistinguishable from one that refused, so a successful
	* `windows.create` fell through and also opened a pinned tab, then a plain
	* tab, then another window. The right test is whether the METHOD EXISTS,
	* decided here, before anything is called; the caller then treats "did not
	* throw" as success and stops.
	*
	* @returns rung names in order, skipping any the browser cannot do at all.
	*/
	function consoleWindowRungs({ hasWindowsCreate = false, hasTabsCreate = false } = {}) {
		const rungs = [];
		if (hasWindowsCreate) rungs.push("popup-window");
		if (hasTabsCreate) rungs.push("pinned-tab", "tab");
		if (hasWindowsCreate) rungs.push("window");
		return rungs;
	}
	/**
	* WHERE THE THINKING WILL HAPPEN, said out loud before a command is sent.
	*
	* THE DEFECT THIS FIXES, found 2026-08-09 by the owner asking why everything
	* went to the Mac. Routing is brain-first (background.js runConsoleCommand),
	* but the brain needs a relay credential, and with none paired
	* `brainAvailability()` fails at its first line and EVERY command falls
	* through to the Mac. That is the designed fallback working — and it was
	* invisible: the popup went on saying "this browser thinks for itself", which
	* for an unpaired browser is simply false.
	*
	* A capability that silently degrades to its fallback, under a UI that claims
	* otherwise, is worse than one that is plainly missing: there is nothing to
	* notice and nothing to fix. So the popup states which brain is about to be
	* used, and when it is not this one, why, and what to do.
	*/
	function describeBrainState({ relayStatus, agentConfigured = false } = {}) {
		const state = String(relayStatus?.state ?? "off");
		if (state === "connected" || state === "degraded") return {
			brain: "local",
			label: "Thinks here",
			tone: "ok",
			help: "This browser thinks for itself and acts in your signed-in tabs. Anything it cannot do here goes to the agent on your Mac. Nothing that submits, sends or cancels runs until you approve it above."
		};
		if (state === "unauthorized") return {
			brain: "mac",
			label: "Bad token",
			tone: "error",
			help: "The relay rejected this browser’s credential, so it cannot think for itself and every command is going to your Mac. Paste the pairing code in this popup and press Connect — one paste replaces both credentials."
		};
		return {
			brain: "mac",
			label: "No brain",
			tone: "warn",
			help: agentConfigured ? "This browser has no brain of its own yet, so every command goes to the agent on your Mac and needs it awake. Paste the pairing code in this popup and press Connect to let it think here instead." : "This browser is not set up: paste the pairing code above (PAIRING_CODE in the repo .env) and press Connect. One paste configures everything."
		};
	}
	/**
	* THE ONE ENTRY THE POPUP SHOWS.
	*
	* The owner, 2026-08-09: "it should not show my past tasks in this popup, only
	* the current task." The list itself is unchanged — the background still keeps
	* the last HISTORY_LIMIT so a finished run is not lost, and the dashboard still
	* has every one of them. This is only about what the popup paints: the command
	* in flight, or if nothing is in flight, the last one's outcome, which is the
	* answer the owner is standing there waiting for.
	*/
	function currentEntry(history) {
		return (Array.isArray(history) ? history : [])[0] ?? null;
	}
	/** How the popup should render one entry right now. Pure, so testable. */
	function describeEntry(entry, now = Date.now()) {
		const state = entry?.state ?? "failed";
		if (state === "working") {
			const startedAt = Date.parse(entry?.startedAt ?? "");
			if (Number.isFinite(startedAt) && now - startedAt > 18e4) return {
				state: "lost",
				label: "Lost",
				headline: "The browser suspended the bridge before this finished. Check the dashboard for what actually happened.",
				canDecide: false,
				showDashboardLink: true
			};
			return {
				state: "working",
				label: "Working…",
				headline: String(entry?.headline ?? "").trim() || "Working on it…",
				canDecide: false,
				showDashboardLink: false
			};
		}
		const labels = {
			answered: "Answered",
			executed: "Done",
			parked: "Parked for approval",
			denied: "Denied",
			refused: "Refused",
			failed: "Failed"
		};
		const decision = state === "parked" ? planDecisionPreflight(entry, now) : { ok: false };
		return {
			state,
			label: labels[state] ?? state,
			headline: entry?.headline ?? "",
			canDecide: decision.ok === true,
			decisionNote: decision.ok ? "" : state === "parked" ? decision.error : "",
			showDashboardLink: state === "parked" && !decision.ok || state === "lost"
		};
	}
	//#endregion
	//#region browser-extension/src/pairing.js
	const PAIR_LIFETIMES = Object.freeze([
		"session",
		"7d",
		"30d",
		"forever"
	]);
	const DEFAULT_PAIR_LIFETIME = "forever";
	Object.freeze({
		session: null,
		"7d": 10080 * 60 * 1e3,
		"30d": 720 * 60 * 60 * 1e3,
		forever: null
	});
	/** Anything not canonical becomes the default — the UI only offers the four,
	* so a stray value is corruption, not intent. */
	function normalizePairLifetime(raw) {
		const value = String(raw ?? "").trim();
		return PAIR_LIFETIMES.includes(value) ? value : DEFAULT_PAIR_LIFETIME;
	}
	function defaultPairDeviceId(storedId, randomHex) {
		const existing = String(storedId ?? "").trim();
		if (existing) return existing;
		return `browser-${(String(randomHex ?? "").replace(/[^0-9a-f]/gi, "").slice(0, 6) || "000000").toLowerCase()}`;
	}
	const PAIR_OUTCOME_KEY = "pairOutcome";
	Object.freeze([
		"agentToken",
		"deviceToken",
		"relayEnabled",
		"pairLifetime",
		"pairExpiresAt"
	]);
	//#endregion
	//#region shared/nodeMesh.js
	/** The relay brain's own mailbox. '@' can never appear in a deviceId. */
	const RELAY_NODE_ADDRESS = "@relay";
	Object.freeze([
		"https://ai-pendant-relay.your-subdomain.workers.dev",
		"http://127.0.0.1:8787",
		"http://localhost:8787"
	]);
	Object.freeze([
		"relayEnabled",
		"relayUrl",
		"relayDeviceId",
		"deviceToken",
		"meshTrustedSenders"
	]);
	Object.freeze([RELAY_NODE_ADDRESS]);
	Object.freeze({
		"browser.command": "command",
		"browser.ping": "ping",
		"approval_request": "approval"
	});
	typeof TextEncoder === "function" && new TextEncoder();
	Object.freeze(["approve", "deny"]);
	/** Past the approval's own deadline. A prompt with no deadline never expires. */
	function approvalIsExpired(prompt, now = Date.now()) {
		const expiresAt = Date.parse(String(prompt?.expiresAt ?? ""));
		return Number.isFinite(expiresAt) && expiresAt <= now;
	}
	/** May the owner still answer this? One predicate for every disabled button. */
	function approvalIsAnswerable(prompt, now = Date.now()) {
		return Boolean(prompt?.approvalId) && !prompt.decision && !approvalIsExpired(prompt, now);
	}
	/**
	* The countdown line under a card. Returns exactly 'expired' past the
	* deadline — both surfaces render that word, per the contract's own wording.
	*/
	function approvalCountdown(prompt, now = Date.now()) {
		const expiresAt = Date.parse(String(prompt?.expiresAt ?? ""));
		if (!Number.isFinite(expiresAt)) return "no deadline";
		const left = expiresAt - now;
		if (left <= 0) return "expired";
		const minutes = Math.floor(left / 6e4);
		const seconds = Math.floor(left % 6e4 / 1e3);
		return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s left` : `${seconds}s left`;
	}
	//#endregion
	//#region browser-extension/src/approvals.js
	const APPROVALS_KEY = "pendingApprovals";
	//#endregion
	//#region browser-extension/src/voice-input.js
	/** The simulator's language rule: Korean keyboards get Korean STT. */
	function speechLang(navigatorLanguage) {
		return String(navigatorLanguage || "").toLowerCase().startsWith("ko") ? "ko-KR" : "en-US";
	}
	/**
	* Which backend this click should use. A table, not a cascade of ifs in a
	* click handler, so the policy is assertable:
	*
	*   Web Speech present -> 'webspeech' (the simulator's desktop default)
	*   otherwise          -> 'none', with the reason spelled out
	*/
	function chooseVoiceBackend({ hasSpeechRecognition = false } = {}) {
		if (hasSpeechRecognition) return {
			backend: "webspeech",
			reason: "This browser has the Web Speech API; speech stays the browser's own."
		};
		return {
			backend: "none",
			reason: "This browser has no Web Speech API — type the command instead."
		};
	}
	/**
	* How a transcript lands in the box: appended to whatever is already typed,
	* one space between, clipped to the same limit the input enforces — so a
	* spoken half-sentence can finish a typed one.
	*/
	function mergeTranscript(existing, transcript) {
		return [String(existing ?? "").trim(), String(transcript ?? "").trim()].filter(Boolean).join(" ").slice(0, MAX_COMMAND_CHARS);
	}
	/**
	* Web Speech error → what the popup does about it. 'aborted' is the owner's
	* own click and says nothing.
	*/
	function describeRecognitionError(code) {
		switch (String(code || "")) {
			case "aborted": return {
				silent: true,
				message: ""
			};
			case "no-speech": return {
				silent: false,
				message: "No speech detected — try again."
			};
			case "not-allowed":
			case "service-not-allowed": return {
				silent: false,
				message: "Microphone blocked — allow mic access for this extension, or type instead."
			};
			case "audio-capture": return {
				silent: false,
				message: "No microphone was found — plug one in or type instead."
			};
			case "network": return {
				silent: false,
				message: "The browser's speech service is unreachable on this network — type instead."
			};
			default: return {
				silent: false,
				message: `Voice failed (${code || "unknown"}) — type instead.`
			};
		}
	}
	//#endregion
	//#region browser-extension/src/popup.js
	const api = globalThis.browser ?? globalThis.chrome;
	const CONSOLE_PAGE = "popup.html?standalone=1";
	const WEBSITE_ORIGINS = ["http://*/*", "https://*/*"];
	const elements = {
		statusDot: document.getElementById("status-dot"),
		statusTitle: document.getElementById("status-title"),
		brainDot: document.getElementById("brain-dot"),
		brainTitle: document.getElementById("brain-title"),
		brainHelp: document.getElementById("brain-help"),
		approvals: document.getElementById("approvals"),
		form: document.getElementById("command-form"),
		input: document.getElementById("command-input"),
		send: document.getElementById("command-send"),
		mic: document.getElementById("command-mic"),
		popOut: document.getElementById("pop-out"),
		includePage: document.getElementById("include-page"),
		includePageLabel: document.querySelector("label[for=\"include-page\"] span"),
		notice: document.getElementById("command-notice"),
		history: document.getElementById("history"),
		openDashboard: document.getElementById("open-dashboard"),
		connectNow: document.getElementById("connect-now"),
		setup: document.getElementById("setup"),
		pairCode: document.getElementById("pair-code"),
		pairLifetime: document.getElementById("pair-lifetime"),
		pairConnect: document.getElementById("pair-connect"),
		pairNotice: document.getElementById("pair-notice"),
		grantPages: document.getElementById("grant-pages")
	};
	const standalone = new URLSearchParams(location.search).get("standalone") === "1";
	if (standalone) {
		document.body.classList.add("standalone");
		document.title = "AI Pendant Console";
		elements.popOut.hidden = true;
		if (elements.includePageLabel) elements.includePageLabel.textContent = "Include the active browser tab (title and address) with the command";
	}
	let dashboardUrl = dashboardUrlFor(DEFAULT_AGENT_URL);
	let heldApprovals = [];
	let approvalTicker = null;
	let approvalBusyId = null;
	function renderApprovals(prompts) {
		heldApprovals = Array.isArray(prompts) ? prompts : [];
		elements.approvals.replaceChildren(...heldApprovals.map((prompt) => renderApprovalCard(prompt)));
		elements.approvals.hidden = heldApprovals.length === 0;
		const anyLive = heldApprovals.some((prompt) => approvalIsAnswerable(prompt) && prompt.expiresAt);
		if (anyLive && approvalTicker === null) approvalTicker = window.setInterval(() => renderApprovals(heldApprovals), 1e3);
		else if (!anyLive && approvalTicker !== null) {
			window.clearInterval(approvalTicker);
			approvalTicker = null;
		}
	}
	function renderApprovalCard(prompt) {
		const expired = !prompt.decision && approvalIsExpired(prompt);
		const settled = Boolean(prompt.decision);
		const busy = approvalBusyId === prompt.approvalId;
		const item = document.createElement("article");
		item.className = `approval${settled ? " approval-decided" : expired ? " approval-expired" : ""}`;
		const summary = document.createElement("p");
		summary.className = "approval-summary";
		summary.textContent = prompt.summary;
		const chip = document.createElement("span");
		chip.className = "approval-chip";
		chip.textContent = prompt.risk ? `${prompt.risk} risk` : "approval";
		summary.prepend(chip);
		item.append(summary);
		if (prompt.detail) {
			const detail = document.createElement("p");
			detail.className = "approval-detail";
			detail.textContent = prompt.detail;
			item.append(detail);
		}
		const clock = document.createElement("p");
		clock.className = `approval-clock${expired ? " expired" : ""}`;
		clock.textContent = settled ? `${prompt.decision === "approve" ? "Approved" : "Denied"} — answer sent` : approvalCountdown(prompt);
		item.append(clock);
		const row = document.createElement("div");
		row.className = "approval-actions";
		const approve = document.createElement("button");
		approve.type = "button";
		approve.className = "primary";
		approve.textContent = prompt.decision === "approve" ? "Approved" : expired ? "Expired" : busy ? "Sending…" : "Approve";
		const deny = document.createElement("button");
		deny.type = "button";
		deny.className = "danger";
		deny.textContent = prompt.decision === "deny" ? "Denied" : expired ? "Expired" : "Deny";
		for (const button of [approve, deny]) button.disabled = settled || expired || busy;
		approve.addEventListener("click", () => void decide(prompt, "approve"));
		deny.addEventListener("click", () => void decide(prompt, "deny"));
		row.append(approve, deny);
		item.append(row);
		return item;
	}
	async function decide(prompt, decision) {
		if (approvalBusyId || !approvalIsAnswerable(prompt)) return;
		approvalBusyId = prompt.approvalId;
		renderApprovals(heldApprovals);
		try {
			const reply = await api.runtime.sendMessage({
				type: "approval:decide",
				approvalId: prompt.approvalId,
				decision
			});
			if (reply?.ok) setNotice(decision === "approve" ? "Approved." : "Denied.");
			else setNotice(reply?.error || "The decision could not be sent.", true);
		} catch (error) {
			setNotice(error?.message || "The bridge is not awake yet — try again.", true);
		} finally {
			approvalBusyId = null;
			renderApprovals(heldApprovals);
		}
	}
	function renderStatus(status) {
		const state = status?.state || "offline";
		elements.statusDot.className = `dot ${state === "connected" ? "connected" : state === "offline" ? "error" : ""}`;
		elements.statusTitle.textContent = state === "connected" ? "Connected" : state === "needs-setup" ? "Needs setup" : state === "unauthorized" ? "Bad token" : "Offline";
	}
	let planBusyId = null;
	let lastHistory = [];
	/**
	* Which brain, and the footer that explains it. Both come from one pure
	* function so the chip and the sentence can never disagree — and since
	* 2026-08-12 the setup card is gated on the SAME view, because gating it on
	* stored-credential presence let the chip say "No brain" while the card (and
	* its pairing box) stayed hidden. The owner stared at instructions to paste
	* a code with nowhere to paste it. One function, three surfaces, no votes.
	*/
	function renderBrain(view) {
		elements.brainDot.className = `dot ${view.tone === "ok" ? "connected" : view.tone === "error" ? "error" : ""}`;
		elements.brainTitle.textContent = view.label;
		elements.brainHelp.textContent = view.help;
		elements.brainDot.parentElement.title = view.help;
	}
	function renderHistory(history) {
		lastHistory = Array.isArray(history) ? history : [];
		const entry = currentEntry(lastHistory);
		elements.history.replaceChildren(...entry ? [renderEntry(entry)] : []);
		elements.history.hidden = !entry;
	}
	function renderEntry(entry) {
		const view = describeEntry(entry);
		const busy = planBusyId === entry.id;
		const item = document.createElement("article");
		item.className = `entry entry-${view.state}`;
		const command = document.createElement("p");
		command.className = "entry-command";
		const chip = document.createElement("span");
		chip.className = "entry-chip";
		chip.textContent = view.label;
		const commandText = document.createElement("span");
		commandText.textContent = entry.command;
		command.append(chip, " ", commandText);
		item.append(command);
		if (view.headline) {
			const headline = document.createElement("p");
			headline.className = "entry-headline";
			headline.textContent = view.headline;
			item.append(headline);
		}
		if (entry.detail) {
			const detail = document.createElement("pre");
			detail.className = "entry-detail";
			detail.textContent = entry.detail;
			item.append(detail);
		}
		if (view.canDecide) {
			const row = document.createElement("div");
			row.className = "entry-actions";
			const approve = document.createElement("button");
			approve.type = "button";
			approve.className = "primary";
			approve.textContent = busy ? "Running…" : "Approve and run";
			approve.disabled = busy;
			const deny = document.createElement("button");
			deny.type = "button";
			deny.className = "danger";
			deny.textContent = "Deny";
			deny.disabled = busy;
			approve.addEventListener("click", () => void decidePlan(entry, "approve"));
			deny.addEventListener("click", () => void decidePlan(entry, "deny"));
			row.append(approve, deny);
			item.append(row);
		} else if (view.decisionNote) {
			const note = document.createElement("p");
			note.className = "entry-note";
			note.textContent = view.decisionNote;
			item.append(note);
		}
		if (view.showDashboardLink) {
			const link = document.createElement("a");
			link.className = "entry-link";
			link.href = dashboardUrl;
			link.target = "_blank";
			link.rel = "noreferrer";
			link.textContent = "Open dashboard to review and approve";
			item.append(link);
		}
		return item;
	}
	async function decidePlan(entry, decision) {
		if (planBusyId) return;
		planBusyId = entry.id;
		renderHistory(lastHistory);
		try {
			const reply = await api.runtime.sendMessage({
				type: "plan:decide",
				id: entry.id,
				decision
			});
			if (reply?.ok) setNotice(decision === "approve" ? "Approved — running it…" : "Denied. Nothing ran.");
			else if (reply?.needsSetup) setNotice("Connect this browser first — paste the pairing code above.", true);
			else setNotice(reply?.error || "That decision could not be sent.", true);
		} catch (error) {
			setNotice(error?.message || "The bridge is not awake yet — try again.", true);
		} finally {
			planBusyId = null;
			renderHistory(lastHistory);
		}
	}
	function setNotice(message, isError = false) {
		elements.notice.textContent = message;
		elements.notice.className = `notice${isError ? " error" : ""}`;
	}
	async function currentPage() {
		try {
			const [tab] = await api.tabs.query({
				active: true,
				lastFocusedWindow: true
			});
			if (tab && !standalone) return {
				url: tab.url ?? "",
				title: tab.title ?? ""
			};
			const selfUrl = api.runtime.getURL("");
			const page = [tab, ...await api.tabs.query({ active: true })].find((candidate) => candidate?.url && !candidate.url.startsWith(selfUrl));
			return page ? {
				url: page.url ?? "",
				title: page.title ?? ""
			} : null;
		} catch {
			return null;
		}
	}
	const voice = {
		phase: "idle",
		recognition: null
	};
	const speechRecognitionCtor = () => globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition ?? null;
	function renderMic() {
		const listening = voice.phase === "listening";
		elements.mic.classList.toggle("is-listening", listening);
		elements.mic.setAttribute("aria-pressed", String(listening));
		const label = listening ? "Stop listening" : "Speak a command";
		elements.mic.title = label;
		elements.mic.setAttribute("aria-label", label);
		elements.input.disabled = listening;
		elements.send.disabled = listening;
		elements.input.placeholder = listening ? "Listening…" : "Ask the agent anything…";
	}
	function settleVoice() {
		voice.phase = "idle";
		voice.recognition = null;
		renderMic();
		refreshMicAvailability();
		elements.input.focus();
	}
	/** Advertise availability honestly: a mic that cannot work says why. */
	function refreshMicAvailability() {
		if (voice.phase !== "idle") return;
		const choice = chooseVoiceBackend({ hasSpeechRecognition: Boolean(speechRecognitionCtor()) });
		elements.mic.disabled = choice.backend === "none";
		elements.mic.title = choice.backend === "none" ? choice.reason : "Speak a command";
	}
	function startWebSpeech() {
		const recognition = new (speechRecognitionCtor())();
		let committed = elements.input.value;
		recognition.lang = speechLang(navigator.language);
		recognition.interimResults = true;
		recognition.maxAlternatives = 1;
		recognition.continuous = false;
		recognition.onresult = (event) => {
			let interim = "";
			for (let index = event.resultIndex; index < event.results.length; index += 1) {
				const result = event.results[index];
				const text = result[0]?.transcript ?? "";
				if (result.isFinal) committed = mergeTranscript(committed, text);
				else interim += text;
			}
			elements.input.value = mergeTranscript(committed, interim);
		};
		recognition.onerror = (event) => {
			if (voice.recognition !== recognition) return;
			const outcome = describeRecognitionError(event.error);
			if (!outcome.silent) setNotice(outcome.message, true);
			settleVoice();
		};
		recognition.onend = () => {
			if (voice.recognition !== recognition) return;
			elements.input.value = committed;
			settleVoice();
		};
		voice.phase = "listening";
		voice.recognition = recognition;
		renderMic();
		try {
			recognition.start();
		} catch (error) {
			setNotice(error?.message || "Voice could not start — type instead.", true);
			settleVoice();
		}
	}
	elements.mic.addEventListener("click", () => {
		if (voice.phase === "listening") {
			try {
				voice.recognition?.stop();
			} catch {
				settleVoice();
			}
			return;
		}
		setNotice("");
		const choice = chooseVoiceBackend({ hasSpeechRecognition: Boolean(speechRecognitionCtor()) });
		if (choice.backend === "webspeech") startWebSpeech();
		else setNotice(choice.reason, true);
	});
	window.addEventListener("pagehide", () => {
		try {
			voice.recognition?.abort?.();
		} catch {}
		if (approvalTicker !== null) {
			window.clearInterval(approvalTicker);
			approvalTicker = null;
		}
	});
	elements.popOut.addEventListener("click", async () => {
		const url = api.runtime.getURL(CONSOLE_PAGE);
		try {
			const tabs = await api.tabs.query({ url: `${api.runtime.getURL("popup.html")}*` });
			const open = (Array.isArray(tabs) ? tabs : []).filter((tab) => tab && tab.id !== void 0 && tab.id !== null && String(tab.url ?? "").includes("standalone=1")).at(-1);
			if (open) {
				if (open.windowId !== void 0 && api.windows?.update) await api.windows.update(open.windowId, { focused: true });
				await api.tabs.update(open.id, { active: true });
				return;
			}
		} catch {}
		const open = {
			"popup-window": () => api.windows.create({
				url,
				type: "popup",
				width: 420,
				height: 680,
				focused: true
			}),
			"pinned-tab": () => api.tabs.create({
				url,
				pinned: true,
				active: true
			}),
			tab: () => api.tabs.create({
				url,
				active: true
			}),
			window: () => api.windows.create({
				url,
				focused: true
			})
		};
		for (const rung of consoleWindowRungs({
			hasWindowsCreate: Boolean(api.windows?.create),
			hasTabsCreate: Boolean(api.tabs?.create)
		})) try {
			await open[rung]();
			return;
		} catch {}
		setNotice("This browser refused every way of opening the console (popup window, pinned tab, tab, window).", true);
	});
	elements.form.addEventListener("submit", async (event) => {
		event.preventDefault();
		const command = elements.input.value.trim().slice(0, MAX_COMMAND_CHARS);
		if (!command) return;
		setNotice("");
		elements.send.disabled = true;
		try {
			const page = elements.includePage.checked ? await currentPage() : null;
			const reply = await api.runtime.sendMessage({
				type: "console:submit",
				command,
				page
			});
			if (reply?.ok) elements.input.value = "";
			else if (reply?.needsSetup) setNotice("Connect this browser first — paste the pairing code above.", true);
			else setNotice(reply?.error || "The bridge did not accept the command.", true);
		} catch (error) {
			setNotice(error?.message || "The bridge is not awake yet — try again.", true);
		} finally {
			elements.send.disabled = false;
			elements.input.focus();
		}
	});
	elements.includePage.addEventListener("change", () => {
		api.storage.local.set({ [INCLUDE_PAGE_KEY]: elements.includePage.checked });
	});
	elements.openDashboard.addEventListener("click", () => {
		api.tabs.create({ url: dashboardUrl });
	});
	elements.connectNow.addEventListener("click", async () => {
		elements.statusTitle.textContent = "Connecting…";
		try {
			await api.runtime.sendMessage({ type: "bridge:poll-now" });
		} catch {}
		await refresh();
	});
	let pairStartedAt = 0;
	function setPairNotice(message, isError = false) {
		elements.pairNotice.textContent = message;
		elements.pairNotice.className = `notice${isError ? " error" : ""}`;
	}
	function renderSetup({ agentConfigured, brainWorking }) {
		elements.setup.hidden = agentConfigured && brainWorking;
		const title = elements.setup.querySelector(".setup-title");
		if (title) title.textContent = agentConfigured ? "Reconnect the brain" : "Connect this browser";
		elements.form.hidden = !agentConfigured;
		elements.history.hidden = elements.history.hidden || !agentConfigured;
		elements.openDashboard.parentElement.hidden = !agentConfigured;
	}
	function renderPairOutcome(outcome) {
		if (!outcome || !pairStartedAt || (outcome.at ?? 0) < pairStartedAt) return;
		pairStartedAt = 0;
		elements.pairConnect.disabled = false;
		if (outcome.ok) {
			elements.pairCode.value = "";
			setPairNotice(outcome.note || "Paired.");
		} else setPairNotice(outcome.error || "Pairing failed.", true);
	}
	elements.pairConnect.addEventListener("click", async () => {
		const code = elements.pairCode.value.trim();
		if (!code) {
			setPairNotice("Paste the pairing code first.", true);
			return;
		}
		elements.pairConnect.disabled = true;
		pairStartedAt = Date.now();
		setPairNotice("Pairing…");
		const stored = await api.storage.local.get([
			"relayDeviceId",
			"agentUrl",
			"deviceName"
		]);
		const randomBytes = new Uint8Array(3);
		crypto.getRandomValues(randomBytes);
		const deviceId = defaultPairDeviceId(stored.relayDeviceId, [...randomBytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
		try {
			const reply = await api.runtime.sendMessage({
				type: "pair:run",
				agentUrl: stored.agentUrl || "http://127.0.0.1:8000",
				code,
				deviceId,
				deviceName: stored.deviceName || "Browser extension",
				lifetime: normalizePairLifetime(elements.pairLifetime.value)
			});
			if (reply === void 0 || reply === null) setPairNotice("Still pairing — finishing in the background. This popup will update by itself.");
			else if (!reply.ok) renderPairOutcome({
				...reply,
				at: Date.now()
			});
		} catch (error) {
			pairStartedAt = 0;
			elements.pairConnect.disabled = false;
			setPairNotice(error?.message || "The bridge is not awake yet — try again.", true);
		}
	});
	async function renderGrantPages({ agentConfigured }) {
		let granted = true;
		try {
			granted = await api.permissions.contains({ origins: WEBSITE_ORIGINS });
		} catch {}
		elements.grantPages.hidden = !agentConfigured || granted;
	}
	elements.grantPages.addEventListener("click", async () => {
		let granted = false;
		try {
			granted = await api.permissions.request({ origins: WEBSITE_ORIGINS });
		} catch {
			granted = false;
		}
		if (granted) {
			elements.grantPages.hidden = true;
			setNotice("Website access granted — this browser can now act in your tabs.");
		} else setNotice("The browser did not grant website access.", true);
	});
	function onStorageChanged(changes, areaName) {
		if (areaName !== "local") return;
		if (changes.bridgeStatus) renderStatus(changes.bridgeStatus.newValue);
		if (changes.relayStatus || changes.agentToken || changes.deviceToken || changes.relayEnabled) refresh();
		if (changes["consoleHistory"]) renderHistory(changes[HISTORY_KEY].newValue);
		if (changes["pendingApprovals"]) renderApprovals(changes[APPROVALS_KEY].newValue);
		if (changes["pairOutcome"]) renderPairOutcome(changes[PAIR_OUTCOME_KEY].newValue);
	}
	api.storage.onChanged.addListener(onStorageChanged);
	window.addEventListener("pagehide", () => {
		try {
			api.storage.onChanged.removeListener(onStorageChanged);
		} catch {}
	});
	async function refresh() {
		const values = await api.storage.local.get([
			"bridgeStatus",
			"relayStatus",
			"agentUrl",
			"agentToken",
			"deviceToken",
			"relayEnabled",
			HISTORY_KEY,
			INCLUDE_PAGE_KEY,
			APPROVALS_KEY
		]);
		const agentConfigured = Boolean(values.agentToken);
		const brainView = describeBrainState({
			relayStatus: values.relayStatus,
			agentConfigured
		});
		dashboardUrl = dashboardUrlFor(values.agentUrl || "http://127.0.0.1:8000");
		renderStatus(values.bridgeStatus);
		renderBrain(brainView);
		renderApprovals(values[APPROVALS_KEY]);
		renderHistory(values[HISTORY_KEY]);
		elements.includePage.checked = values[INCLUDE_PAGE_KEY] !== false;
		refreshMicAvailability();
		renderSetup({
			agentConfigured,
			brainWorking: brainView.brain === "local"
		});
		renderGrantPages({ agentConfigured });
	}
	refresh().then(() => {
		(elements.setup.hidden ? elements.input : elements.pairCode).focus();
	});
	(async () => {
		try {
			await api.runtime.sendMessage({ type: "bridge:poll-now" });
		} catch {}
	})();
	//#endregion
})();
