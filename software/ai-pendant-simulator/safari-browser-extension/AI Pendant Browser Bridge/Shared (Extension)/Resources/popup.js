(function() {
	//#region browser-extension/src/bridge-core.js
	const DEFAULT_AGENT_URL = "http://127.0.0.1:8000";
	typeof TextEncoder === "function" && new TextEncoder();
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
	//#region shared/nodeMesh.js
	/** The relay brain's own mailbox. '@' can never appear in a deviceId. */
	const RELAY_NODE_ADDRESS = "@relay";
	const DEVICE_ADDRESS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/;
	const RESERVED_ADDRESS_PATTERN = /^@[a-z][a-z0-9-]{1,30}$/;
	/**
	* A node address, or '' if it is not one. Accepts a registered device id or a
	* reserved '@name' address; rejects everything else, including empty strings
	* and the whitespace-padded near-misses a hand-typed config produces.
	*/
	function normalizeNodeAddress(value) {
		const address = String(value ?? "").trim();
		if (RESERVED_ADDRESS_PATTERN.test(address)) return address;
		return DEVICE_ADDRESS_PATTERN.test(address) ? address : "";
	}
	//#endregion
	//#region browser-extension/src/relay-peer.js
	const RELAY_ORIGIN_ALLOWLIST = Object.freeze([
		"https://ai-pendant-relay.your-subdomain.workers.dev",
		"http://127.0.0.1:8787",
		"http://localhost:8787"
	]);
	/**
	* A usable relay origin, or ''.
	*
	* Deliberately NOT a widening of normalizeAgentUrl(). That function's output
	* is the base URL background.js sends `Authorization: Bearer <agentToken>` to,
	* and agentToken is the MAC's credential. One URL field covering two origins
	* therefore means one field that can aim either credential at either host —
	* and the failure is silent, because both hosts answer 401 the same way. Two
	* fields, two allowlists, one credential bound to each: a misconfiguration
	* then costs a failed request instead of a leaked token.
	*/
	function normalizeRelayUrl(value) {
		const candidate = String(value ?? "").trim();
		if (!candidate) return "";
		let url;
		try {
			url = new URL(candidate);
		} catch {
			return "";
		}
		if (url.username || url.password || url.search || url.hash) return "";
		if (url.pathname !== "/" && url.pathname !== "") return "";
		return RELAY_ORIGIN_ALLOWLIST.includes(url.origin) ? url.origin : "";
	}
	const RELAY_STORAGE_KEYS = Object.freeze([
		"relayEnabled",
		"relayUrl",
		"relayDeviceId",
		"deviceToken",
		"meshTrustedSenders"
	]);
	Object.freeze({
		relayEnabled: false,
		relayUrl: null,
		relayDeviceId: null,
		deviceToken: null
	});
	const DEFAULT_TRUSTED_SENDERS = Object.freeze([RELAY_NODE_ADDRESS]);
	function normalizeTrustedSenders(value, extra = []) {
		const raw = Array.isArray(value) ? value : String(value ?? "").split(/[\s,]+/).filter(Boolean);
		const senders = new Set(DEFAULT_TRUSTED_SENDERS);
		for (const candidate of [...raw, ...extra]) {
			const address = normalizeNodeAddress(candidate);
			if (address) senders.add(address);
		}
		return [...senders];
	}
	/**
	* Refuses to report `ready` unless the origin, the address and the credential
	* are all present and sane — the same discipline normalizeBrainConfig uses, so
	* a half-configured relay peer behaves exactly like an absent one.
	*/
	function normalizeRelayConfig(values = {}) {
		const relayEnabled = values.relayEnabled === true;
		const relayUrl = normalizeRelayUrl(values.relayUrl) || null;
		const relayDeviceId = normalizeNodeAddress(values.relayDeviceId) || null;
		const deviceToken = String(values.deviceToken ?? "").trim() || null;
		let reason = "";
		if (!relayEnabled) reason = "The relay peer is switched off (relayEnabled is not true).";
		else if (!relayUrl) reason = "No usable relayUrl is configured. It must be one of the allowlisted relay origins.";
		else if (!relayDeviceId) reason = "No relayDeviceId is configured — that is the address the relay delivers this extension's mail to.";
		else if (!deviceToken) reason = "No deviceToken is configured — pair this browser with `pendant-credentials.mjs pair --role browser_node`.";
		return {
			relayEnabled,
			relayUrl,
			relayDeviceId,
			deviceToken,
			trustedSenders: normalizeTrustedSenders(values.meshTrustedSenders),
			ready: relayEnabled && Boolean(relayUrl) && Boolean(relayDeviceId) && Boolean(deviceToken),
			reason
		};
	}
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
	const RECORDER_MIME_CANDIDATES = Object.freeze([
		"audio/webm;codecs=opus",
		"audio/webm",
		"audio/mp4",
		"audio/ogg;codecs=opus",
		"audio/ogg"
	]);
	function pickRecorderMimeType(MediaRecorderCtor) {
		if (!MediaRecorderCtor || typeof MediaRecorderCtor.isTypeSupported !== "function") return "";
		return RECORDER_MIME_CANDIDATES.find((type) => MediaRecorderCtor.isTypeSupported(type)) || "";
	}
	function mimeToFormat(mimeType) {
		const value = String(mimeType || "").toLowerCase();
		if (value.includes("mp4") || value.includes("m4a") || value.includes("aac")) return "m4a";
		if (value.includes("ogg")) return "ogg";
		if (value.includes("mp3") || value.includes("mpeg")) return "mp3";
		if (value.includes("wav")) return "wav";
		return "webm";
	}
	function blobToBase64(blob) {
		if (typeof FileReader === "function") return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onerror = () => reject(/* @__PURE__ */ new Error("Could not read recorded audio."));
			reader.onloadend = () => {
				const result = String(reader.result || "");
				resolve(result.includes(",") ? result.split(",")[1] : result);
			};
			reader.readAsDataURL(blob);
		});
		return blob.arrayBuffer().then((buffer) => {
			let binary = "";
			const bytes = new Uint8Array(buffer);
			for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
			return btoa(binary);
		});
	}
	/** The simulator's language rule: Korean keyboards get Korean STT. */
	function speechLang(navigatorLanguage) {
		return String(navigatorLanguage || "").toLowerCase().startsWith("ko") ? "ko-KR" : "en-US";
	}
	/** What /v1/transcribe's `language` field wants: a bare two-letter code. */
	function transcribeLanguage(navigatorLanguage) {
		return speechLang(navigatorLanguage).slice(0, 2);
	}
	/**
	* Which backend this click should use. A table, not a cascade of ifs in a
	* click handler, so the policy is assertable:
	*
	*   Web Speech present            -> 'webspeech' (the simulator's desktop
	*                                    default; costs no scope and no upload)
	*   no Web Speech, relay paired   -> 'cloud' (the dashboard's MediaRecorder →
	*                                    /v1/transcribe pipeline, device token)
	*   neither                       -> 'none', with the reason spelled out
	*/
	function chooseVoiceBackend({ hasSpeechRecognition = false, relayReady = false } = {}) {
		if (hasSpeechRecognition) return {
			backend: "webspeech",
			reason: "This browser has the Web Speech API; speech stays the browser's own."
		};
		if (relayReady) return {
			backend: "cloud",
			reason: "No Web Speech API here — recording locally and transcribing through the relay's speech route."
		};
		return {
			backend: "none",
			reason: "This browser has no Web Speech API and no paired relay peer to transcribe a recording — type instead."
		};
	}
	/**
	* The cloud leg as a request descriptor, the relay-peer.js discipline:
	* `auth: 'device'` means popup.js attaches the token; this module never
	* holds it and never puts it in a URL.
	*/
	function transcribeRequest(config, { audioBase64, format, language, durationMs } = {}) {
		if (!config?.ready) throw new Error(config?.reason || "The relay peer is not configured; there is nowhere to transcribe.");
		const audio = String(audioBase64 ?? "").trim();
		if (!audio) throw new Error("No audio captured — try again.");
		if (Math.floor(audio.length * 3 / 4) > 8388608) throw new Error("Recording is too large (8 MB max) — try a shorter one.");
		return {
			method: "POST",
			path: "/v1/transcribe",
			auth: "device",
			body: {
				audioBase64: audio,
				format: mimeToFormat(format),
				...language ? { language: String(language).slice(0, 2).toLowerCase() } : {},
				...Number.isFinite(durationMs) && durationMs > 0 ? { durationMs: Math.round(durationMs) } : {},
				deviceId: config.relayDeviceId
			}
		};
	}
	/** The dashboard's own "was anything actually said" rule. */
	function transcriptHasSpeech(value) {
		return /[\p{L}\p{N}]/u.test(String(value || ""));
	}
	/**
	* What one /v1/transcribe answer means for the box. The scope refusal gets
	* its own sentence because it is the one failure the owner can neither retry
	* nor fix in settings: today's browser_node pairing simply does not include
	* cloud speech, and pretending that is a network blip would send them
	* debugging their Wi-Fi.
	*/
	function interpretTranscribeResponse({ status, payload }) {
		const body = payload && typeof payload === "object" ? payload : {};
		if (status === 401) return {
			kind: "error",
			message: "The relay does not accept this browser's device token. Pair again in settings, then retry."
		};
		if (status === 403) return {
			kind: "error",
			message: "This browser's relay token is not allowed to use cloud speech-to-text (the browser_node role does not include the speech:transcribe scope). Type the command instead."
		};
		if (status < 200 || status >= 300) return {
			kind: "error",
			message: body.error || `The relay answered HTTP ${status}.`
		};
		const text = String(body.text || "").trim();
		if (!transcriptHasSpeech(text)) return { kind: "no-speech" };
		return {
			kind: "transcript",
			text
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
	* Web Speech error → what the popup does about it. `fallbackToCloud` mirrors
	* the simulator's rule: a 'network' failure (carrier networks break Google's
	* STT constantly) retries through the relay pipeline WHEN there is one.
	* 'aborted' is the owner's own click and says nothing.
	*/
	function describeRecognitionError(code, { relayReady = false } = {}) {
		switch (String(code || "")) {
			case "aborted": return {
				silent: true,
				fallbackToCloud: false,
				message: ""
			};
			case "no-speech": return {
				silent: false,
				fallbackToCloud: false,
				message: "No speech detected — try again."
			};
			case "not-allowed":
			case "service-not-allowed": return {
				silent: false,
				fallbackToCloud: false,
				message: "Microphone blocked — allow mic access for this extension, or type instead."
			};
			case "audio-capture": return {
				silent: false,
				fallbackToCloud: false,
				message: "No microphone was found — plug one in or type instead."
			};
			case "network": return {
				silent: false,
				fallbackToCloud: relayReady,
				message: relayReady ? "Browser speech is blocked on this network — retrying through the relay…" : "The browser's speech service is unreachable on this network — type instead."
			};
			default: return {
				silent: false,
				fallbackToCloud: false,
				message: `Voice failed (${code || "unknown"}) — type instead.`
			};
		}
	}
	//#endregion
	//#region browser-extension/src/console-window.js
	const CONSOLE_PAGE = "console.html";
	/**
	* The windows.create payload. `type: 'popup'` is what drops the tab strip
	* and address bar in Chrome; browsers that do not honor it fall back to a
	* normal window, which is acceptable — persistence is the point, not chrome.
	*/
	function consoleWindowOptions(url) {
		return {
			url,
			type: "popup",
			width: 420,
			height: 680,
			focused: true
		};
	}
	/**
	* The fallback ladder for one open attempt, in order. Pure so the order is
	* a test, not an archaeology dig:
	*
	*   1. 'window'     — windows.create({type:'popup'}) (skipped entirely when
	*                     the API is absent, as it is in some Safari builds)
	*   2. 'pinned-tab' — tabs.create({pinned:true}); the rung that exists
	*                     because Safari may refuse windows.create at runtime
	*/
	function planConsoleOpen({ hasWindows = false } = {}) {
		const attempts = [];
		if (hasWindows) attempts.push({ how: "window" });
		attempts.push({ how: "pinned-tab" });
		return attempts;
	}
	/**
	* Is this document the standalone console rather than the popover? The page
	* declares it on <body class="standalone"> so the answer never depends on
	* URL parsing, which Safari rewrites under the extension's own scheme.
	*/
	function isStandaloneSurface(doc) {
		return Boolean(doc?.body?.classList?.contains("standalone"));
	}
	/**
	* Given the tabs that already show the console, the one to focus instead of
	* opening a duplicate — newest first, because the owner's most recent pop-out
	* is the one they arranged where they wanted it.
	*/
	function existingConsoleTab(tabs) {
		const usable = (Array.isArray(tabs) ? tabs : []).filter((tab) => tab && tab.id !== void 0 && tab.id !== null);
		if (!usable.length) return null;
		return usable[usable.length - 1];
	}
	//#endregion
	//#region browser-extension/src/popup.js
	const api = globalThis.browser ?? globalThis.chrome;
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
	const standalone = isStandaloneSurface(document);
	if (standalone) {
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
		recognition: null,
		capture: null
	};
	const speechRecognitionCtor = () => globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition ?? null;
	async function relayConfig() {
		return normalizeRelayConfig(await api.storage.local.get(RELAY_STORAGE_KEYS));
	}
	function renderMic() {
		const active = voice.phase !== "idle";
		elements.mic.classList.toggle("is-listening", voice.phase === "listening" || voice.phase === "recording");
		elements.mic.classList.toggle("is-transcribing", voice.phase === "transcribing");
		elements.mic.setAttribute("aria-pressed", String(voice.phase === "listening" || voice.phase === "recording"));
		elements.mic.disabled = voice.phase === "transcribing";
		const label = voice.phase === "listening" || voice.phase === "recording" ? "Stop listening" : voice.phase === "transcribing" ? "Transcribing…" : "Speak a command";
		elements.mic.title = label;
		elements.mic.setAttribute("aria-label", label);
		elements.input.disabled = active;
		elements.send.disabled = active;
		elements.input.placeholder = active ? voice.phase === "transcribing" ? "Transcribing…" : "Listening…" : "Ask the agent anything…";
	}
	function settleVoice() {
		voice.phase = "idle";
		voice.recognition = null;
		voice.capture = null;
		renderMic();
		refreshMicAvailability();
		elements.input.focus();
	}
	/** Advertise availability honestly: a mic that cannot work says why. */
	async function refreshMicAvailability() {
		if (voice.phase !== "idle") return;
		const relay = await relayConfig();
		const choice = chooseVoiceBackend({
			hasSpeechRecognition: Boolean(speechRecognitionCtor()),
			relayReady: relay.ready
		});
		elements.mic.disabled = choice.backend === "none";
		elements.mic.title = choice.backend === "none" ? choice.reason : "Speak a command";
	}
	function startWebSpeech(relay) {
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
			const outcome = describeRecognitionError(event.error, { relayReady: relay.ready });
			if (!outcome.silent) setNotice(outcome.message, !outcome.fallbackToCloud);
			if (outcome.fallbackToCloud) {
				voice.recognition = null;
				startRecording(relay);
				return;
			}
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
	/** The dashboard's capture, verbatim in behavior: 250 ms chunks, the same
	* mime candidates, the recorder handle kept out of any render path. */
	async function startRecording(relay) {
		if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
			setNotice("This browser cannot record audio — type a command instead.", true);
			settleVoice();
			return;
		}
		let stream = null;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			const mimeType = pickRecorderMimeType(MediaRecorder);
			const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
			const chunks = [];
			recorder.ondataavailable = (event) => {
				if (event.data && event.data.size > 0) chunks.push(event.data);
			};
			recorder.start(250);
			voice.phase = "recording";
			voice.capture = {
				recorder,
				stream,
				chunks,
				relay,
				mimeType: recorder.mimeType || mimeType || "audio/webm",
				startedAt: Date.now()
			};
			renderMic();
			setNotice("Recording — press the mic again to transcribe.");
		} catch {
			stream?.getTracks().forEach((track) => track.stop());
			setNotice("Microphone blocked — allow mic access for this extension, or type instead.", true);
			settleVoice();
		}
	}
	async function stopRecordingAndTranscribe() {
		const capture = voice.capture;
		if (!capture) {
			settleVoice();
			return;
		}
		voice.capture = null;
		voice.phase = "transcribing";
		renderMic();
		setNotice("Transcribing…");
		try {
			if (capture.recorder.state !== "inactive") {
				const stopped = new Promise((resolve) => {
					capture.recorder.onstop = () => resolve();
				});
				capture.recorder.stop();
				await Promise.race([stopped, new Promise((resolve) => window.setTimeout(resolve, 2e3))]);
			}
			const blob = new Blob(capture.chunks, { type: capture.mimeType });
			if (!blob.size) throw new Error("No audio captured — try again.");
			const request = transcribeRequest(capture.relay, {
				audioBase64: await blobToBase64(blob),
				format: mimeToFormat(blob.type || capture.mimeType),
				language: transcribeLanguage(navigator.language),
				durationMs: Date.now() - capture.startedAt
			});
			const response = await fetch(`${capture.relay.relayUrl}${request.path}`, {
				method: request.method,
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${capture.relay.deviceToken}`
				},
				body: JSON.stringify(request.body)
			});
			let payload = null;
			try {
				payload = await response.json();
			} catch {
				payload = null;
			}
			const outcome = interpretTranscribeResponse({
				status: response.status,
				payload
			});
			if (outcome.kind === "transcript") {
				elements.input.value = mergeTranscript(elements.input.value, outcome.text);
				setNotice("");
			} else if (outcome.kind === "no-speech") setNotice("No speech detected — try again.");
			else setNotice(outcome.message, true);
		} catch (error) {
			setNotice(error?.message || "Voice transcription failed — type instead.", true);
		} finally {
			capture.stream.getTracks().forEach((track) => track.stop());
			settleVoice();
		}
	}
	elements.mic.addEventListener("click", async () => {
		if (voice.phase === "listening") {
			try {
				voice.recognition?.stop();
			} catch {
				settleVoice();
			}
			return;
		}
		if (voice.phase === "recording") {
			stopRecordingAndTranscribe();
			return;
		}
		if (voice.phase !== "idle") return;
		setNotice("");
		const relay = await relayConfig();
		const choice = chooseVoiceBackend({
			hasSpeechRecognition: Boolean(speechRecognitionCtor()),
			relayReady: relay.ready
		});
		if (choice.backend === "webspeech") startWebSpeech(relay);
		else if (choice.backend === "cloud") await startRecording(relay);
		else setNotice(choice.reason, true);
	});
	window.addEventListener("pagehide", () => {
		try {
			voice.recognition?.abort?.();
		} catch {}
		const capture = voice.capture;
		voice.capture = null;
		if (!capture) return;
		try {
			if (capture.recorder.state !== "inactive") capture.recorder.stop();
		} catch {}
		capture.stream.getTracks().forEach((track) => track.stop());
	});
	elements.popOut.addEventListener("click", async () => {
		const url = api.runtime.getURL(CONSOLE_PAGE);
		try {
			const open = existingConsoleTab(await api.tabs.query({ url }));
			if (open) {
				if (open.windowId !== void 0 && api.windows?.update) await api.windows.update(open.windowId, { focused: true });
				await api.tabs.update(open.id, { active: true });
				if (!standalone) window.close();
				return;
			}
		} catch {}
		for (const attempt of planConsoleOpen({ hasWindows: Boolean(api.windows?.create) })) try {
			if (attempt.how === "window") await api.windows.create(consoleWindowOptions(url));
			else await api.tabs.create({
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
		if (RELAY_STORAGE_KEYS.some((key) => key in changes)) refreshMicAvailability();
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
		await refreshMicAvailability();
	}
	refresh().then(() => elements.input.focus());
	//#endregion
})();
