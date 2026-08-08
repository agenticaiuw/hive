(function() {
	//#region src/bridge-core.js
	const DEFAULT_AGENT_URL = "http://127.0.0.1:8000";
	typeof TextEncoder === "function" && new TextEncoder();
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
	//#region src/popup.js
	const api = globalThis.browser ?? globalThis.chrome;
	const elements = {
		statusDot: document.getElementById("status-dot"),
		statusTitle: document.getElementById("status-title"),
		form: document.getElementById("command-form"),
		input: document.getElementById("command-input"),
		send: document.getElementById("command-send"),
		includePage: document.getElementById("include-page"),
		notice: document.getElementById("command-notice"),
		history: document.getElementById("history"),
		openDashboard: document.getElementById("open-dashboard"),
		connectNow: document.getElementById("connect-now"),
		openSettings: document.getElementById("open-settings")
	};
	let dashboardUrl = dashboardUrlFor(DEFAULT_AGENT_URL);
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
			return tab ? {
				url: tab.url ?? "",
				title: tab.title ?? ""
			} : null;
		} catch {
			return null;
		}
	}
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
	});
	async function refresh() {
		const values = await api.storage.local.get([
			"bridgeStatus",
			"agentUrl",
			HISTORY_KEY,
			INCLUDE_PAGE_KEY
		]);
		dashboardUrl = dashboardUrlFor(values.agentUrl || "http://127.0.0.1:8000");
		renderStatus(values.bridgeStatus);
		renderHistory(values[HISTORY_KEY]);
		elements.includePage.checked = values[INCLUDE_PAGE_KEY] !== false;
	}
	refresh().then(() => elements.input.focus());
	//#endregion
})();
