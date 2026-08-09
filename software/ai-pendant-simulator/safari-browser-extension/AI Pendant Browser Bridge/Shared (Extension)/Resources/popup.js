(function() {
	//#region src/bridge-core.js
	const DEFAULT_AGENT_URL = "http://127.0.0.1:8000";
	new TextEncoder();
	//#endregion
	//#region src/command-console.js
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
	/** How the popup should render one entry right now. Pure, so testable. */
	function describeEntry(entry, now = Date.now()) {
		const state = entry?.state ?? "failed";
		if (state === "working") {
			const startedAt = Date.parse(entry?.startedAt ?? "");
			if (Number.isFinite(startedAt) && now - startedAt > 18e4) return {
				state: "lost",
				label: "Lost",
				headline: "The browser suspended the bridge before this finished. Check the dashboard for what actually happened.",
				showDashboardLink: true
			};
			return {
				state: "working",
				label: "Working…",
				headline: "Asking the Mac agent…",
				showDashboardLink: false
			};
		}
		return {
			state,
			label: {
				answered: "Answered",
				executed: "Done",
				parked: "Parked for approval",
				refused: "Refused",
				failed: "Failed"
			}[state] ?? state,
			headline: entry?.headline ?? "",
			showDashboardLink: state === "parked" || state === "lost"
		};
	}
	//#endregion
	//#region ../shared/nodeMesh.js
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
	//#region src/approvals.js
	const APPROVALS_KEY = "pendingApprovals";
	//#endregion
	//#region src/voice-input.js
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
	//#region src/popup.js
	const api = globalThis.browser ?? globalThis.chrome;
	const CONSOLE_PAGE = "popup.html?standalone=1";
	const elements = {
		statusDot: document.getElementById("status-dot"),
		statusTitle: document.getElementById("status-title"),
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
		openSettings: document.getElementById("open-settings")
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
	function renderHistory(history) {
		const list = Array.isArray(history) ? history : [];
		elements.history.replaceChildren(...list.map((entry) => renderEntry(entry)));
		elements.history.hidden = list.length === 0;
	}
	function renderEntry(entry) {
		const view = describeEntry(entry);
		const item = document.createElement("article");
		item.className = `entry entry-${view.state}`;
		const command = document.createElement("p");
		command.className = "entry-command";
		command.textContent = entry.command;
		item.append(command);
		const chip = document.createElement("span");
		chip.className = "entry-chip";
		chip.textContent = view.label;
		command.prepend(chip);
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
	});
	elements.popOut.addEventListener("click", async () => {
		const url = api.runtime.getURL(CONSOLE_PAGE);
		try {
			const tabs = await api.tabs.query({ url: `${api.runtime.getURL("popup.html")}*` });
			const open = (Array.isArray(tabs) ? tabs : []).filter((tab) => tab && tab.id !== void 0 && tab.id !== null && String(tab.url ?? "").includes("standalone=1")).at(-1);
			if (open) {
				if (open.windowId !== void 0 && api.windows?.update) await api.windows.update(open.windowId, { focused: true });
				await api.tabs.update(open.id, { active: true });
				if (!standalone) window.close();
				return;
			}
		} catch {}
		if (api.windows?.create) try {
			await api.windows.create({
				url,
				type: "popup",
				width: 420,
				height: 680,
				focused: true
			});
			if (!standalone) window.close();
			return;
		} catch {}
		try {
			await api.tabs.create({
				url,
				pinned: true,
				active: true
			});
			if (!standalone) window.close();
			return;
		} catch {}
		setNotice("This browser refused to open the console window or a pinned tab.", true);
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
			else if (reply?.needsSetup) setNotice("Save the agent token in settings first.", true);
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
	elements.openSettings.addEventListener("click", () => {
		api.runtime.openOptionsPage();
	});
	api.storage.onChanged.addListener((changes, areaName) => {
		if (areaName !== "local") return;
		if (changes.bridgeStatus) renderStatus(changes.bridgeStatus.newValue);
		if (changes["consoleHistory"]) renderHistory(changes[HISTORY_KEY].newValue);
		if (changes["pendingApprovals"]) renderApprovals(changes[APPROVALS_KEY].newValue);
	});
	async function refresh() {
		const values = await api.storage.local.get([
			"bridgeStatus",
			"agentUrl",
			HISTORY_KEY,
			INCLUDE_PAGE_KEY,
			APPROVALS_KEY
		]);
		dashboardUrl = dashboardUrlFor(values.agentUrl || "http://127.0.0.1:8000");
		renderStatus(values.bridgeStatus);
		renderApprovals(values[APPROVALS_KEY]);
		renderHistory(values[HISTORY_KEY]);
		elements.includePage.checked = values[INCLUDE_PAGE_KEY] !== false;
		refreshMicAvailability();
	}
	refresh().then(() => elements.input.focus());
	//#endregion
})();
