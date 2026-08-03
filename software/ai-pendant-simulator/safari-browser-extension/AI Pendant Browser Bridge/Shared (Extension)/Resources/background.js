(function() {
	const DEFAULT_TARGET_MODE = "last-focused";
	const MAX_TEXT_LENGTH = 5e4;
	const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
	const TARGET_MODES = new Set([
		"last-focused",
		"current-active",
		"new-tab"
	]);
	/** Commands the extension can execute. Keep in sync with background.js. */
	const COMMAND_TYPES = new Set([
		"navigate",
		"click",
		"type",
		"read_page",
		"snapshot",
		"wait_for",
		"scroll",
		"select",
		"list_tabs",
		"capture",
		"press_key"
	]);
	const READ_MODES = new Set([
		"text",
		"main_text",
		"html",
		"forms",
		"landmarks"
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
	function validateNavigationUrl(value) {
		let url;
		try {
			url = new URL(String(value ?? ""));
		} catch {
			throw new Error("The navigation command did not contain a valid URL.");
		}
		if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http:// and https:// navigation is allowed.");
		return url.href;
	}
	function originPattern(value) {
		const url = new URL(value);
		return `${url.protocol}//${url.host}/*`;
	}
	function validateCommand(command) {
		if (!command || typeof command !== "object") throw new Error("The local agent sent an invalid browser command.");
		const action = command.action;
		const type = action?.type;
		const params = action?.params ?? {};
		if (!COMMAND_TYPES.has(type)) throw new Error(`Unsupported browser command: ${String(type ?? "")}`);
		if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Browser command parameters must be an object.");
		if (type === "navigate") validateNavigationUrl(params.url);
		if (type === "click" || type === "type" || type === "select" || type === "scroll") {
			const hasSelector = String(params.selector ?? "").trim();
			const hasRef = String(params.ref ?? "").trim();
			if (!hasSelector && !hasRef) throw new Error("A CSS selector or snapshot ref is required.");
			if (hasSelector && hasSelector.length > 2e3) throw new Error("A valid, reasonably sized CSS selector is required.");
		}
		if (type === "type" && String(params.text ?? "").length > 5e4) throw new Error(`Typed text is limited to ${MAX_TEXT_LENGTH} characters.`);
		if (type === "select" && String(params.value ?? params.label ?? "").trim() === "") throw new Error("select requires value or label.");
		if (type === "wait_for") {
			const hasSelector = String(params.selector ?? "").trim();
			const hasText = String(params.textContains ?? params.text ?? "").trim();
			if (!hasSelector && !hasText) throw new Error("wait_for requires selector or textContains.");
		}
		if (type === "read_page" && params.mode != null) {
			const mode = String(params.mode).trim();
			if (mode && !READ_MODES.has(mode)) throw new Error(`read_page mode must be one of: ${[...READ_MODES].join(", ")}.`);
		}
		if (type === "press_key" && !String(params.key ?? "").trim()) throw new Error("press_key requires key.");
		if (params.tabId !== void 0 && (!Number.isInteger(params.tabId) || params.tabId < 0)) throw new Error("tabId must be a non-negative integer.");
		if (params.windowId !== void 0 && (!Number.isInteger(params.windowId) || params.windowId < 0)) throw new Error("windowId must be a non-negative integer.");
		return {
			type,
			params
		};
	}
	function pickTargetTab(tabs, params = {}, targetMode = DEFAULT_TARGET_MODE) {
		const candidates = tabs.filter((tab) => Number.isInteger(tab?.id));
		if (Number.isInteger(params.tabId)) return candidates.find((tab) => tab.id === params.tabId) ?? null;
		const urlNeedle = String(params.urlContains ?? "").trim().toLowerCase();
		if (urlNeedle) return candidates.filter((tab) => String(tab.url ?? "").toLowerCase().includes(urlNeedle)).sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0))[0] ?? null;
		const titleNeedle = String(params.titleContains ?? "").trim().toLowerCase();
		if (titleNeedle) return candidates.filter((tab) => String(tab.title ?? "").toLowerCase().includes(titleNeedle)).sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0))[0] ?? null;
		if (Number.isInteger(params.windowId)) return candidates.find((tab) => tab.windowId === params.windowId && tab.active === true) ?? null;
		if (targetMode === "current-active") return candidates.find((tab) => tab.active === true) ?? null;
		return candidates.filter((tab) => tab.active === true).sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0))[0] ?? null;
	}
	function isScriptableUrl(value) {
		try {
			return ["http:", "https:"].includes(new URL(value).protocol);
		} catch {
			return false;
		}
	}
	function retryDelay(attempt, baseMs = 750, maximumMs = 15e3) {
		const boundedAttempt = Math.max(0, Math.min(Number(attempt) || 0, 8));
		return Math.min(maximumMs, baseMs * 2 ** boundedAttempt);
	}
	//#endregion
	//#region browser-extension/src/background.js
	const api = globalThis.browser ?? globalThis.chrome;
	const POLL_ALARM = "ai-pendant-poll";
	const POLL_WINDOW_MS = 25e3;
	const POLL_INTERVAL_MS = 750;
	const HEARTBEAT_INTERVAL_MS = 12e3;
	const FETCH_TIMEOUT_MS = 7e3;
	const STATUS_KEY = "bridgeStatus";
	const CONFIG_KEYS = [
		"agentUrl",
		"agentToken",
		"deviceName",
		"targetMode",
		"instanceId"
	];
	let activePoll = null;
	let configRevision = 0;
	async function migrateSyncedCredentials() {
		if (!api.storage.sync) return;
		const local = await api.storage.local.get(CONFIG_KEYS);
		const synced = await api.storage.sync.get(["agentUrl", "agentToken"]);
		const updates = {};
		if (!local.agentUrl && synced.agentUrl) updates.agentUrl = synced.agentUrl;
		if (!local.agentToken && synced.agentToken) updates.agentToken = synced.agentToken;
		if (Object.keys(updates).length) await api.storage.local.set(updates);
		if (synced.agentToken) await api.storage.sync.remove("agentToken");
	}
	async function getConfig() {
		const values = await api.storage.local.get(CONFIG_KEYS);
		const config = normalizeConfig(values);
		if (!values.instanceId) {
			values.instanceId = crypto.randomUUID();
			await api.storage.local.set({ instanceId: values.instanceId });
		}
		return {
			...config,
			instanceId: values.instanceId,
			extensionId: `ai-pendant-${api.runtime.id}-${values.instanceId}`
		};
	}
	async function request(config, path, options = {}) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		try {
			return await fetch(`${config.agentUrl}${path}`, {
				...options,
				cache: "no-store",
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${config.agentToken}`,
					...options.body ? { "Content-Type": "application/json" } : {},
					...options.headers
				},
				signal: controller.signal
			});
		} finally {
			clearTimeout(timeout);
		}
	}
	async function postJson(config, path, payload) {
		const response = await request(config, path, {
			method: "POST",
			body: JSON.stringify(payload)
		});
		if (!response.ok) throw await responseError(response);
		return response.status === 204 ? null : response.json();
	}
	async function responseError(response) {
		let detail = "";
		try {
			const payload = await response.json();
			detail = payload.error || payload.message || "";
		} catch {
			detail = await response.text().catch(() => "");
		}
		const error = new Error(detail || `Local agent returned HTTP ${response.status}.`);
		error.status = response.status;
		return error;
	}
	async function currentTabSummary() {
		const [tab] = await api.tabs.query({
			active: true,
			lastFocusedWindow: true
		});
		const scriptable = (await api.tabs.query({}).catch(() => [])).filter((t) => isScriptableUrl(t?.url));
		return tab ? {
			tabId: tab.id ?? null,
			windowId: tab.windowId ?? null,
			tabUrl: isScriptableUrl(tab.url) ? new URL(tab.url).origin : "",
			tabTitle: String(tab.title || "").slice(0, 80),
			tabCount: scriptable.length
		} : {
			tabId: null,
			windowId: null,
			tabUrl: "",
			tabTitle: "",
			tabCount: scriptable.length
		};
	}
	async function heartbeat(config) {
		const tab = await currentTabSummary();
		await postJson(config, "/browser/heartbeat", {
			extensionId: config.extensionId,
			deviceName: config.deviceName || platformLabel(),
			browserName: browserLabel(),
			extensionVersion: api.runtime.getManifest().version,
			userAgent: globalThis.navigator?.userAgent ?? "",
			...tab
		});
	}
	async function pollOnce(config) {
		const response = await request(config, `/browser/poll?extensionId=${encodeURIComponent(config.extensionId)}`);
		if (response.status === 204) return false;
		if (!response.ok) throw await responseError(response);
		const command = (await response.json())?.command;
		let result;
		try {
			result = {
				ok: true,
				result: await executeCommand(command, config)
			};
		} catch (error) {
			result = {
				ok: false,
				error: error?.message || String(error)
			};
		}
		await postResultWithRetry(config, command?.commandId, {
			...result,
			extensionId: config.extensionId
		});
		return true;
	}
	async function postResultWithRetry(config, commandId, result) {
		if (!commandId) throw new Error("The browser command is missing its commandId.");
		let lastError;
		for (let attempt = 0; attempt < 3; attempt += 1) try {
			await postJson(config, `/browser/result/${encodeURIComponent(commandId)}`, result);
			return;
		} catch (error) {
			lastError = error;
			if (attempt < 2) await delay(retryDelay(attempt, 300, 1200));
		}
		throw lastError;
	}
	async function pollWindow(revision) {
		const config = await getConfig();
		if (!config.agentToken) {
			await updateStatus({
				state: "needs-setup",
				connected: false,
				message: "Open settings and save the local agent token."
			});
			return;
		}
		const deadline = Date.now() + POLL_WINDOW_MS;
		let nextHeartbeatAt = 0;
		let failures = 0;
		while (Date.now() < deadline && revision === configRevision) try {
			if (Date.now() >= nextHeartbeatAt) {
				await heartbeat(config);
				nextHeartbeatAt = Date.now() + HEARTBEAT_INTERVAL_MS;
				await updateStatus({
					state: "connected",
					connected: true,
					message: "Connected to the local Mac agent.",
					lastConnectedAt: (/* @__PURE__ */ new Date()).toISOString(),
					error: ""
				});
			}
			const handledCommand = await pollOnce(config);
			failures = 0;
			if (!handledCommand) await delay(POLL_INTERVAL_MS);
		} catch (error) {
			failures += 1;
			await updateStatus({
				state: error?.status === 401 ? "unauthorized" : "offline",
				connected: false,
				message: error?.status === 401 ? "The local agent rejected the token." : "Cannot reach the local Mac agent.",
				error: error?.message || String(error),
				lastErrorAt: (/* @__PURE__ */ new Date()).toISOString()
			});
			await delay(retryDelay(failures - 1));
		}
	}
	function startPolling() {
		if (activePoll) return activePoll;
		const revision = configRevision;
		activePoll = pollWindow(revision).catch(async (error) => {
			await updateStatus({
				state: "error",
				connected: false,
				message: "Browser bridge stopped unexpectedly.",
				error: error?.message || String(error),
				lastErrorAt: (/* @__PURE__ */ new Date()).toISOString()
			});
		}).finally(() => {
			activePoll = null;
			if (revision !== configRevision) startPolling();
		});
		return activePoll;
	}
	async function updateStatus(patch) {
		const status = {
			...(await api.storage.local.get(STATUS_KEY))[STATUS_KEY] ?? {},
			...patch,
			extensionId: api.runtime.id,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		await api.storage.local.set({ [STATUS_KEY]: status });
		if (api.action?.setBadgeText) {
			await api.action.setBadgeText({ text: status.state === "connected" ? "ON" : status.state === "needs-setup" ? "SET" : "!" });
			if (api.action.setBadgeBackgroundColor) await api.action.setBadgeBackgroundColor({ color: status.state === "connected" ? "#078B70" : "#B54736" });
		}
	}
	async function executeCommand(command, config) {
		const { type, params } = validateCommand(command);
		if (type === "navigate") return navigate(params, config);
		if (type === "list_tabs") return listTabs(params);
		const tab = await selectTargetTab(params, config.targetMode);
		await assertPageAccess(tab);
		if (type === "capture") return captureTab(tab);
		if (type === "wait_for") return waitForInTab(tab, params);
		const firstResult = (await api.scripting.executeScript({
			target: {
				tabId: tab.id,
				frameIds: [0]
			},
			func: runInPage,
			args: [type, params]
		}))?.[0];
		if (!firstResult) throw new Error("The browser returned no result from the active page.");
		if (firstResult.error) throw new Error(firstResult.error.message || String(firstResult.error));
		return {
			...firstResult.result,
			tabId: tab.id,
			windowId: tab.windowId,
			url: tab.url ?? "",
			title: tab.title ?? firstResult.result?.title ?? ""
		};
	}
	async function waitForInTab(tab, params) {
		const timeoutMs = Math.max(100, Math.min(Number(params.timeoutMs) || 1e4, 3e4));
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			if ((await api.scripting.executeScript({
				target: {
					tabId: tab.id,
					frameIds: [0]
				},
				func: checkWaitCondition,
				args: [params]
			}))?.[0]?.result === true) return {
				message: "wait_for satisfied",
				waitedMs: Date.now() - started,
				tabId: tab.id,
				windowId: tab.windowId,
				url: tab.url ?? ""
			};
			await delay(150);
		}
		throw new Error(`wait_for timed out after ${timeoutMs}ms`);
	}
	/** Injected: returns true if wait condition holds. */
	function checkWaitCondition(params) {
		const selector = String(params.selector || "").trim();
		const textNeedle = String(params.textContains || params.text || "").trim().toLowerCase();
		if (selector) try {
			const el = document.querySelector(selector);
			if (el) {
				const style = window.getComputedStyle(el);
				const rect = el.getBoundingClientRect();
				if (style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0) return true;
			}
		} catch {
			throw new Error(`Invalid CSS selector: ${selector}`);
		}
		if (textNeedle) {
			if ((document.body?.innerText || "").toLowerCase().includes(textNeedle)) return true;
		}
		return false;
	}
	async function listTabs(params = {}) {
		const max = Math.max(1, Math.min(Number(params.limit) || 30, 80));
		const rows = (await api.tabs.query({})).filter((tab) => isScriptableUrl(tab?.url)).sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0)).slice(0, max).map((tab) => ({
			tabId: tab.id,
			windowId: tab.windowId,
			active: Boolean(tab.active),
			title: String(tab.title || "").slice(0, 120),
			url: tab.url || "",
			origin: isScriptableUrl(tab.url) ? new URL(tab.url).origin : ""
		}));
		return {
			message: `${rows.length} open web tab(s)`,
			tabs: rows,
			tabCount: rows.length
		};
	}
	async function captureTab(tab) {
		const windowId = tab.windowId;
		if (tab.active === false) {
			await api.tabs.update(tab.id, { active: true });
			await delay(150);
		}
		const dataUrl = await api.tabs.captureVisibleTab(windowId, { format: "png" });
		return {
			message: "Captured visible tab",
			tabId: tab.id,
			windowId,
			url: tab.url ?? "",
			title: tab.title ?? "",
			mimeType: "image/png",
			imageDataUrl: dataUrl
		};
	}
	async function navigate(params, config) {
		const url = validateNavigationUrl(params.url);
		const openNewTab = params.newTab === true || config.targetMode === "new-tab";
		let tab;
		if (openNewTab) tab = await api.tabs.create({
			url,
			active: params.active !== false,
			...Number.isInteger(params.windowId) ? { windowId: params.windowId } : {}
		});
		else {
			tab = await selectTargetTab(params, config.targetMode);
			tab = await api.tabs.update(tab.id, {
				url,
				active: params.active !== false
			});
		}
		if (params.waitForLoad !== false) tab = await waitForTabLoad(tab.id, 15e3);
		return {
			message: `Navigated to ${url}`,
			tabId: tab.id,
			windowId: tab.windowId,
			url: tab.url || url
		};
	}
	async function selectTargetTab(params, targetMode) {
		if (Number.isInteger(params.tabId)) return api.tabs.get(params.tabId);
		let tabs;
		if (Number.isInteger(params.windowId)) tabs = await api.tabs.query({ windowId: params.windowId });
		else if (params.urlContains) tabs = await api.tabs.query({});
		else if (targetMode === "current-active") tabs = await api.tabs.query({
			active: true,
			currentWindow: true
		});
		else tabs = await api.tabs.query({ active: true });
		const tab = pickTargetTab(tabs, params, targetMode);
		if (tab) return tab;
		throw new Error("No matching browser tab is available. Open a web page or specify a valid tabId.");
	}
	async function assertPageAccess(tab) {
		if (!tab?.id || !isScriptableUrl(tab.url)) throw new Error("This page cannot be controlled. Browser settings, extension pages, and local files are protected.");
		const pattern = originPattern(tab.url);
		if (!await api.permissions.contains({ origins: [pattern] })) throw new Error(`Website access is not granted for ${new URL(tab.url).origin}. Open the extension settings and grant website access.`);
	}
	function waitForTabLoad(tabId, timeoutMs) {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(async () => {
				cleanup();
				try {
					resolve(await api.tabs.get(tabId));
				} catch {
					reject(/* @__PURE__ */ new Error("The destination tab closed before it finished loading."));
				}
			}, timeoutMs);
			const onUpdated = (updatedTabId, changeInfo, tab) => {
				if (updatedTabId === tabId && changeInfo.status === "complete") {
					cleanup();
					resolve(tab);
				}
			};
			const onRemoved = (removedTabId) => {
				if (removedTabId === tabId) {
					cleanup();
					reject(/* @__PURE__ */ new Error("The destination tab closed before it finished loading."));
				}
			};
			const cleanup = () => {
				clearTimeout(timeout);
				api.tabs.onUpdated.removeListener(onUpdated);
				api.tabs.onRemoved.removeListener(onRemoved);
			};
			api.tabs.onUpdated.addListener(onUpdated);
			api.tabs.onRemoved.addListener(onRemoved);
		});
	}
	/**
	* Injected into the page (isolated world). Keep pure-page; no chrome.* APIs.
	*/
	function runInPage(type, params) {
		const ATTR = "data-pendant-ref";
		const MAX_ELEMENTS = 80;
		const cssPath = (el) => {
			if (!(el instanceof Element)) return "";
			if (el.id) {
				const id = CSS.escape(el.id);
				if (document.querySelectorAll(`#${id}`).length === 1) return `#${id}`;
			}
			const parts = [];
			let node = el;
			while (node && node.nodeType === 1 && parts.length < 6) {
				let part = node.nodeName.toLowerCase();
				if (node.id) {
					parts.unshift(`#${CSS.escape(node.id)}`);
					break;
				}
				const parent = node.parentElement;
				if (parent) {
					const siblings = [...parent.children].filter((c) => c.nodeName === node.nodeName);
					if (siblings.length > 1) {
						const index = siblings.indexOf(node) + 1;
						part += `:nth-of-type(${index})`;
					}
				}
				parts.unshift(part);
				node = parent;
			}
			return parts.join(" > ");
		};
		const resolveElement = () => {
			if (params.ref) {
				const ref = String(params.ref).trim();
				const byAttr = document.querySelector(`[${ATTR}="${ref.replace(/"/g, "")}"]`);
				if (byAttr) return byAttr;
				throw new Error(`Snapshot ref not found: ${ref}. Call snapshot again and use a fresh ref.`);
			}
			const selector = String(params.selector ?? "");
			let element;
			try {
				element = document.querySelector(selector);
			} catch {
				throw new Error(`Invalid CSS selector: ${selector}`);
			}
			if (!element) throw new Error(`Element not found: ${selector}`);
			return element;
		};
		const isVisible = (el) => {
			if (!(el instanceof Element)) return false;
			const style = window.getComputedStyle(el);
			if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
			const rect = el.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0;
		};
		const accessibleName = (el) => {
			const aria = el.getAttribute("aria-label");
			if (aria) return aria.trim().slice(0, 120);
			const labelledBy = el.getAttribute("aria-labelledby");
			if (labelledBy) {
				const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.innerText).filter(Boolean).join(" ").trim();
				if (text) return text.slice(0, 120);
			}
			if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
				const lab = el.labels?.[0]?.innerText;
				if (lab) return lab.trim().slice(0, 120);
				if (el.placeholder) return el.placeholder.trim().slice(0, 120);
				if (el.name) return el.name.slice(0, 120);
			}
			if (el instanceof HTMLSelectElement && el.name) return el.name.slice(0, 120);
			return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
		};
		const roleOf = (el) => {
			const explicit = el.getAttribute("role");
			if (explicit) return explicit;
			const tag = el.tagName.toLowerCase();
			if (tag === "a" && el.hasAttribute("href")) return "link";
			if (tag === "button") return "button";
			if (tag === "select") return "combobox";
			if (tag === "textarea") return "textbox";
			if (tag === "input") {
				const t = (el.type || "text").toLowerCase();
				if (t === "checkbox") return "checkbox";
				if (t === "radio") return "radio";
				if (t === "submit" || t === "button") return "button";
				return "textbox";
			}
			if (el.isContentEditable) return "textbox";
			return tag;
		};
		if (type === "snapshot") {
			const max = Math.max(1, Math.min(Number(params.maxElements) || MAX_ELEMENTS, MAX_ELEMENTS));
			document.querySelectorAll(`[${ATTR}]`).forEach((el) => el.removeAttribute(ATTR));
			const candidates = [...document.querySelectorAll("a[href], button, input, select, textarea, [role=\"button\"], [role=\"link\"], [role=\"textbox\"], [role=\"checkbox\"], [role=\"radio\"], [role=\"menuitem\"], [contenteditable=\"true\"]")].filter((el) => isVisible(el) && !el.closest("[aria-hidden=\"true\"]"));
			const elements = [];
			for (const el of candidates) {
				if (elements.length >= max) break;
				if (el instanceof HTMLInputElement && (el.type === "hidden" || el.type === "password") && params.includeSensitive !== true) {
					if (el.type === "hidden") continue;
				}
				const ref = `e${elements.length}`;
				el.setAttribute(ATTR, ref);
				const rect = el.getBoundingClientRect();
				elements.push({
					ref,
					role: roleOf(el),
					name: accessibleName(el),
					tag: el.tagName.toLowerCase(),
					selector: cssPath(el),
					disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
					checked: el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") ? Boolean(el.checked) : el.getAttribute("aria-checked") === "true" ? true : void 0,
					href: el instanceof HTMLAnchorElement ? el.href?.slice(0, 300) : void 0,
					inputType: el instanceof HTMLInputElement ? (el.type || "text").toLowerCase() : void 0,
					bounds: {
						x: Math.round(rect.x),
						y: Math.round(rect.y),
						w: Math.round(rect.width),
						h: Math.round(rect.height)
					}
				});
			}
			return {
				message: `Snapshot: ${elements.length} interactive element(s)`,
				title: document.title,
				url: location.href,
				elementCount: elements.length,
				elements
			};
		}
		if (type === "click") {
			const element = resolveElement();
			element.scrollIntoView({
				block: "center",
				inline: "center"
			});
			element.click();
			return { message: `Clicked ${params.ref || params.selector}` };
		}
		if (type === "type") {
			const element = resolveElement();
			if (element instanceof HTMLInputElement && element.type === "password" && params.allowSensitiveInput !== true) throw new Error("Typing into password fields requires allowSensitiveInput=true.");
			const text = String(params.text ?? "");
			element.focus();
			if (element instanceof HTMLInputElement) (Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set)?.call(element, text);
			else if (element instanceof HTMLTextAreaElement) (Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set)?.call(element, text);
			else if (element.isContentEditable) element.textContent = text;
			else throw new Error("The selected element is not editable.");
			element.dispatchEvent(new InputEvent("input", {
				bubbles: true,
				inputType: "insertText",
				data: text
			}));
			element.dispatchEvent(new Event("change", { bubbles: true }));
			if (params.submit) if (element.form?.requestSubmit) element.form.requestSubmit();
			else element.dispatchEvent(new KeyboardEvent("keydown", {
				key: "Enter",
				code: "Enter",
				bubbles: true
			}));
			return { message: `Typed into ${params.ref || params.selector}` };
		}
		if (type === "select") {
			const element = resolveElement();
			if (!(element instanceof HTMLSelectElement)) throw new Error("select requires a <select> element.");
			const value = String(params.value ?? "");
			const label = String(params.label ?? "");
			let matched = false;
			for (const opt of element.options) if (value && opt.value === value || label && opt.textContent.trim() === label || label && opt.textContent.trim().includes(label)) {
				element.value = opt.value;
				matched = true;
				break;
			}
			if (!matched) throw new Error("No matching option for select.");
			element.dispatchEvent(new Event("input", { bubbles: true }));
			element.dispatchEvent(new Event("change", { bubbles: true }));
			return { message: `Selected option on ${params.ref || params.selector}` };
		}
		if (type === "scroll") {
			if (params.selector || params.ref) {
				resolveElement().scrollIntoView({
					block: params.block || "center",
					inline: "nearest",
					behavior: "instant"
				});
				return { message: `Scrolled to ${params.ref || params.selector}` };
			}
			const dy = Number(params.dy) || 0;
			const dx = Number(params.dx) || 0;
			window.scrollBy(dx, dy);
			return { message: `Scrolled by (${dx}, ${dy})` };
		}
		if (type === "press_key") {
			const key = String(params.key || "");
			const target = params.selector || params.ref ? resolveElement() : document.activeElement || document.body;
			target.dispatchEvent(new KeyboardEvent("keydown", {
				key,
				code: key,
				bubbles: true
			}));
			target.dispatchEvent(new KeyboardEvent("keyup", {
				key,
				code: key,
				bubbles: true
			}));
			return { message: `Pressed ${key}` };
		}
		if (type === "read_page") {
			const maximum = Math.max(1, Math.min(Number(params.maxChars) || 12e3, 5e4));
			const mode = String(params.mode || "text");
			if (params.selector || params.ref) {
				const element = resolveElement();
				const content = mode === "html" ? element.outerHTML : element.innerText || element.textContent || "";
				return {
					message: "Read selected content",
					content: String(content ?? "").slice(0, maximum),
					title: document.title,
					mode
				};
			}
			let content = "";
			if (mode === "html") content = document.documentElement?.outerHTML || "";
			else if (mode === "forms") content = [...document.querySelectorAll("form")].map((form, i) => {
				return `form#${i}\n${[...form.querySelectorAll("input,select,textarea")].map((el) => {
					const name = el.name || el.id || el.getAttribute("aria-label") || el.type;
					return `  - ${el.tagName.toLowerCase()}${el.type ? `[${el.type}]` : ""} name=${name}`;
				}).join("\n")}`;
			}).join("\n\n");
			else if (mode === "landmarks") content = [...document.querySelectorAll("main, nav, header, footer, [role=\"main\"], [role=\"navigation\"], h1, h2")].map((el) => {
				return `${el.tagName.toLowerCase()}: ${(el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 160)}`;
			}).join("\n");
			else if (mode === "main_text") content = (document.querySelector("main, [role=\"main\"], article") || document.body)?.innerText || "";
			else content = document.body?.innerText || "";
			return {
				message: `Read page (${mode})`,
				content: String(content ?? "").slice(0, maximum),
				title: document.title,
				mode
			};
		}
		throw new Error(`Unsupported browser command: ${type}`);
	}
	function browserLabel() {
		const userAgent = globalThis.navigator?.userAgent ?? "";
		if (/Edg\//.test(userAgent)) return "Microsoft Edge";
		if (/Firefox\//.test(userAgent)) return "Firefox";
		if (/Chrome\//.test(userAgent)) return "Google Chrome";
		if (/Safari\//.test(userAgent)) return "Safari";
		return "Web Extension";
	}
	function platformLabel() {
		const platform = globalThis.navigator?.platform || "Mac";
		return `${browserLabel()} on ${platform}`;
	}
	function delay(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
	api.runtime.onInstalled.addListener(async ({ reason }) => {
		await migrateSyncedCredentials();
		await api.alarms.create(POLL_ALARM, { periodInMinutes: .5 });
		if (reason === "install") await api.runtime.openOptionsPage();
		startPolling();
	});
	api.runtime.onStartup.addListener(async () => {
		await migrateSyncedCredentials();
		await api.alarms.create(POLL_ALARM, { periodInMinutes: .5 });
		startPolling();
	});
	api.alarms.onAlarm.addListener((alarm) => {
		if (alarm.name === POLL_ALARM) startPolling();
	});
	api.storage.onChanged.addListener((changes, areaName) => {
		if (areaName === "local" && [
			"agentUrl",
			"agentToken",
			"deviceName",
			"targetMode"
		].some((key) => changes[key])) {
			configRevision += 1;
			startPolling();
		}
	});
	api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
		if (message?.type === "bridge:poll-now") {
			startPolling().then(() => sendResponse({ ok: true }));
			return true;
		}
		if (message?.type === "bridge:get-status") {
			api.storage.local.get(STATUS_KEY).then((values) => sendResponse(values[STATUS_KEY] ?? null));
			return true;
		}
		return false;
	});
	migrateSyncedCredentials().then(() => api.alarms.create(POLL_ALARM, { periodInMinutes: .5 })).then(() => startPolling());
	//#endregion
})();
