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
		if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) throw new Error("Agent URL must use http://127.0.0.1 or http://localhost. The relay is reached through the relay peer (relayUrl), not this field.");
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
	new TextEncoder();
	//#endregion
	//#region ../shared/nodeMesh.js
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
	//#region src/relay-peer.js
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
	/** The host_permissions match pattern for an allowlisted origin. */
	function relayOriginPattern(origin) {
		const normalized = normalizeRelayUrl(origin);
		return normalized ? `${normalized}/*` : "";
	}
	const RELAY_STORAGE_KEYS = Object.freeze([
		"relayEnabled",
		"relayUrl",
		"relayDeviceId",
		"deviceToken",
		"meshTrustedSenders"
	]);
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
		permissionToggle: document.getElementById("permission-toggle"),
		relayEnabled: document.getElementById("relay-enabled"),
		relayUrl: document.getElementById("relay-url"),
		relayDeviceId: document.getElementById("relay-device-id"),
		relayDeviceToken: document.getElementById("relay-device-token"),
		relayTrusted: document.getElementById("relay-trusted"),
		relayDot: document.getElementById("relay-dot"),
		relayTitle: document.getElementById("relay-title"),
		relayDetail: document.getElementById("relay-detail"),
		relayStatus: document.getElementById("relay-status"),
		relayAllowlist: document.getElementById("relay-allowlist")
	};
	async function load() {
		const values = await api.storage.local.get([
			"agentUrl",
			"agentToken",
			"deviceName",
			"targetMode",
			"bridgeStatus",
			"relayStatus",
			...RELAY_STORAGE_KEYS
		]);
		const config = normalizeConfig(values);
		elements.agentUrl.value = config.agentUrl;
		elements.agentToken.value = config.agentToken;
		elements.deviceName.value = config.deviceName;
		elements.targetMode.value = config.targetMode;
		const relay = normalizeRelayConfig(values);
		elements.relayEnabled.checked = relay.relayEnabled;
		elements.relayUrl.value = relay.relayUrl || RELAY_ORIGIN_ALLOWLIST[0];
		elements.relayDeviceId.value = relay.relayDeviceId || "";
		elements.relayDeviceToken.value = relay.deviceToken || "";
		elements.relayTrusted.value = relay.trustedSenders.filter((sender) => !sender.startsWith("@")).join(", ");
		elements.relayAllowlist.textContent = `Only these origins are accepted: ${RELAY_ORIGIN_ALLOWLIST.join(", ")}`;
		renderStatus(values.bridgeStatus);
		renderRelayStatus(values.relayStatus, relay);
		await renderPermissions();
	}
	function renderRelayStatus(status, relay) {
		const state = relay?.ready ? status?.state || "offline" : "off";
		elements.relayDot.className = `dot ${state === "connected" ? "connected" : state === "off" ? "" : "error"}`;
		elements.relayTitle.textContent = status?.message || relay?.reason || "The relay peer has not connected yet.";
		elements.relayDetail.textContent = status?.error || "";
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
	function relayFormValues() {
		return {
			relayEnabled: elements.relayEnabled.checked,
			relayUrl: elements.relayUrl.value,
			relayDeviceId: elements.relayDeviceId.value,
			deviceToken: elements.relayDeviceToken.value,
			meshTrustedSenders: elements.relayTrusted.value
		};
	}
	async function saveRelay() {
		setRelayStatus("");
		const raw = relayFormValues();
		if (raw.relayEnabled && !normalizeRelayUrl(raw.relayUrl)) {
			setRelayStatus(`That relay URL is not on the allowlist. Accepted: ${RELAY_ORIGIN_ALLOWLIST.join(", ")}`, true);
			return;
		}
		const relay = normalizeRelayConfig(raw);
		if (raw.relayEnabled && !relay.ready) {
			setRelayStatus(relay.reason, true);
			return;
		}
		const pattern = relayOriginPattern(raw.relayUrl);
		if (relay.ready && pattern) {
			if (!(await api.permissions.contains({ origins: [pattern] }).catch(() => false) || await api.permissions.request({ origins: [pattern] }).catch(() => false))) {
				setRelayStatus("The browser has not granted access to the relay origin, so this browser cannot reach it. Allow it in the extension’s website settings.", true);
				return;
			}
		}
		await api.storage.local.set({
			relayEnabled: relay.relayEnabled,
			relayUrl: relay.relayUrl ?? "",
			relayDeviceId: relay.relayDeviceId ?? "",
			deviceToken: relay.deviceToken ?? "",
			meshTrustedSenders: relay.trustedSenders.filter((sender) => !sender.startsWith("@"))
		});
		setRelayStatus("Saved only in this browser profile.");
		requestRelayDrain();
	}
	async function testRelay() {
		setRelayStatus("Testing…");
		const relay = normalizeRelayConfig({
			...relayFormValues(),
			relayEnabled: true
		});
		if (!relay.ready) {
			setRelayStatus(relay.reason, true);
			return;
		}
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 8e3);
		try {
			const response = await fetch(`${relay.relayUrl}/v1/node/presence?deviceId=${encodeURIComponent(relay.relayDeviceId)}`, {
				headers: { Authorization: `Bearer ${relay.deviceToken}` },
				cache: "no-store",
				signal: controller.signal
			});
			const payload = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(payload.error || `The relay returned HTTP ${response.status}.`);
			setRelayStatus(`Relay reachable. ${payload.pending || 0} message(s) waiting for ${relay.relayDeviceId}.`);
		} catch (error) {
			setRelayStatus(error.name === "AbortError" ? "The relay did not answer within 8s." : error.message, true);
		} finally {
			clearTimeout(timeout);
		}
	}
	async function clearRelayToken() {
		elements.relayDeviceToken.value = "";
		await api.storage.local.remove("deviceToken");
		setRelayStatus("The relay device token was removed from this browser profile.");
	}
	async function requestRelayDrain() {
		try {
			await api.runtime.sendMessage({ type: "relay:drain-now" });
		} catch {}
	}
	function setRelayStatus(message, isError = false) {
		elements.relayStatus.textContent = message;
		elements.relayStatus.className = `notice${isError ? " error" : ""}`;
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
	document.getElementById("relay-save").addEventListener("click", saveRelay);
	document.getElementById("relay-test").addEventListener("click", testRelay);
	document.getElementById("relay-clear").addEventListener("click", clearRelayToken);
	document.getElementById("relay-drain").addEventListener("click", requestRelayDrain);
	elements.permissionToggle.addEventListener("click", togglePermissions);
	api.storage.onChanged.addListener((changes, areaName) => {
		if (areaName !== "local") return;
		if (changes.bridgeStatus) renderStatus(changes.bridgeStatus.newValue);
		if (changes.relayStatus) api.storage.local.get(RELAY_STORAGE_KEYS).then((values) => renderRelayStatus(changes.relayStatus.newValue, normalizeRelayConfig(values)));
	});
	load();
	//#endregion
})();
