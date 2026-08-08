(function() {
	const DEFAULT_TARGET_MODE = "last-focused";
	const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
	const TARGET_MODES = new Set([
		"last-focused",
		"current-active",
		"new-tab"
	]);
	function normalizeAgentUrl(value) {
		const candidate = String(value ?? "").trim() || "http://127.0.0.1:8000";
		let url;
		try {
			url = new URL(candidate);
		} catch {
			throw new Error("Agent URL must be a valid URL.");
		}
		if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) throw new Error("Agent URL must use http://127.0.0.1 or http://localhost.");
		if (url.username || url.password || url.search || url.hash) throw new Error("Agent URL cannot contain credentials, a query, or a hash.");
		if (url.pathname !== "/" && url.pathname !== "") throw new Error("Agent URL must not contain a path.");
		return url.origin;
	}
	function normalizeConfig(values = {}) {
		const targetMode = TARGET_MODES.has(values.targetMode) ? values.targetMode : DEFAULT_TARGET_MODE;
		return {
			agentUrl: normalizeAgentUrl(values.agentUrl),
			agentToken: String(values.agentToken ?? "").trim(),
			deviceName: String(values.deviceName ?? "").trim().slice(0, 80),
			targetMode
		};
	}
	typeof TextEncoder === "function" && new TextEncoder();
	//#endregion
	//#region src/options.js
	const api = globalThis.browser ?? globalThis.chrome;
	const WEBSITE_ORIGINS = ["http://*/*", "https://*/*"];
	const elements = {
		agentUrl: document.getElementById("agent-url"),
		agentToken: document.getElementById("agent-token"),
		deviceName: document.getElementById("device-name"),
		targetMode: document.getElementById("target-mode"),
		statusDot: document.getElementById("status-dot"),
		statusTitle: document.getElementById("status-title"),
		statusDetail: document.getElementById("status-detail"),
		extensionId: document.getElementById("extension-id"),
		lastConnected: document.getElementById("last-connected"),
		formStatus: document.getElementById("form-status"),
		permissionTitle: document.getElementById("permission-title"),
		permissionToggle: document.getElementById("permission-toggle")
	};
	async function load() {
		const values = await api.storage.local.get([
			"agentUrl",
			"agentToken",
			"deviceName",
			"targetMode",
			"bridgeStatus"
		]);
		const config = normalizeConfig(values);
		elements.agentUrl.value = config.agentUrl;
		elements.agentToken.value = config.agentToken;
		elements.deviceName.value = config.deviceName;
		elements.targetMode.value = config.targetMode;
		renderStatus(values.bridgeStatus);
		await renderPermissions();
	}
	function renderStatus(status) {
		const state = status?.state || "offline";
		elements.statusDot.className = `dot ${state === "connected" ? "connected" : state === "offline" ? "error" : ""}`;
		elements.statusTitle.textContent = status?.message || "The browser bridge has not connected yet.";
		elements.statusDetail.textContent = status?.error || "";
		elements.extensionId.textContent = api.runtime.id;
		elements.lastConnected.textContent = formatDate(status?.lastConnectedAt);
	}
	async function renderPermissions() {
		const granted = await api.permissions.contains({ origins: WEBSITE_ORIGINS });
		elements.permissionTitle.textContent = granted ? "Website control is allowed" : "Website control is not allowed";
		elements.permissionToggle.textContent = granted ? "Revoke access" : "Grant access";
		elements.permissionToggle.dataset.granted = String(granted);
	}
	async function save() {
		setFormStatus("");
		let config;
		try {
			config = normalizeConfig({
				agentUrl: elements.agentUrl.value,
				agentToken: elements.agentToken.value,
				deviceName: elements.deviceName.value,
				targetMode: elements.targetMode.value
			});
		} catch (error) {
			setFormStatus(error.message, true);
			return;
		}
		if (!config.agentToken) {
			setFormStatus("Enter AGENT_TOKEN before connecting.", true);
			return;
		}
		await api.storage.local.set(config);
		if (api.storage.sync) await api.storage.sync.remove("agentToken");
		setFormStatus("Saved only in this browser profile.");
		requestPoll();
	}
	async function testConnection() {
		setFormStatus("Testing…");
		let config;
		try {
			config = normalizeConfig({
				agentUrl: elements.agentUrl.value,
				agentToken: elements.agentToken.value,
				deviceName: elements.deviceName.value,
				targetMode: elements.targetMode.value
			});
			if (!config.agentToken) throw new Error("Enter AGENT_TOKEN first.");
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 6e3);
			let response;
			try {
				response = await fetch(`${config.agentUrl}/browser/status`, {
					headers: { Authorization: `Bearer ${config.agentToken}` },
					cache: "no-store",
					signal: controller.signal
				});
			} finally {
				clearTimeout(timeout);
			}
			if (!response.ok) {
				const payload = await response.json().catch(() => ({}));
				throw new Error(payload.error || `Local agent returned HTTP ${response.status}.`);
			}
			setFormStatus("Connection and token are valid.");
		} catch (error) {
			setFormStatus(error.name === "AbortError" ? "Connection timed out. Is the local agent running?" : error.message, true);
		}
	}
	async function togglePermissions() {
		const granted = elements.permissionToggle.dataset.granted === "true";
		if (!(granted ? await api.permissions.remove({ origins: WEBSITE_ORIGINS }) : await api.permissions.request({ origins: WEBSITE_ORIGINS })) && !granted) setFormStatus("The browser did not grant website access.", true);
		await renderPermissions();
	}
	async function clearToken() {
		elements.agentToken.value = "";
		await api.storage.local.remove("agentToken");
		if (api.storage.sync) await api.storage.sync.remove("agentToken");
		setFormStatus("The local token was removed from this browser profile.");
	}
	async function requestPoll() {
		try {
			await api.runtime.sendMessage({ type: "bridge:poll-now" });
		} catch {}
	}
	function setFormStatus(message, isError = false) {
		elements.formStatus.textContent = message;
		elements.formStatus.className = `notice${isError ? " error" : ""}`;
	}
	function formatDate(value) {
		if (!value) return "Never";
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? "Never" : date.toLocaleString();
	}
	document.getElementById("save").addEventListener("click", save);
	document.getElementById("test").addEventListener("click", testConnection);
	document.getElementById("clear").addEventListener("click", clearToken);
	document.getElementById("connect-now").addEventListener("click", requestPoll);
	elements.permissionToggle.addEventListener("click", togglePermissions);
	api.storage.onChanged.addListener((changes, areaName) => {
		if (areaName === "local" && changes.bridgeStatus) renderStatus(changes.bridgeStatus.newValue);
	});
	load();
	//#endregion
})();
