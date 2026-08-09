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
		"press_key",
		"activate_tab"
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
	const MAX_COMMAND_AGE_MS = 9e4;
	function validateCommand(command, now = Date.now()) {
		if (!command || typeof command !== "object") throw new Error("The local agent sent an invalid browser command.");
		const queuedAt = Date.parse(command.createdAt ?? "");
		if (Number.isFinite(queuedAt) && now - queuedAt > 9e4) throw new Error(`Refused a browser command queued ${Math.round((now - queuedAt) / 1e3)}s ago. Nothing is still waiting for it, so running it now would act on the owner's browser unprompted.`);
		const action = command.action;
		const type = action?.type;
		const params = action?.params ?? {};
		if (!COMMAND_TYPES.has(type)) throw new Error(`Unsupported browser command: ${String(type ?? "")}`);
		if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Browser command parameters must be an object.");
		if (type === "navigate") validateNavigationUrl(params.url);
		if (type === "activate_tab") {
			const hasNeedle = String(params.urlContains ?? "").trim();
			const hasUrl = String(params.url ?? "").trim();
			if (!hasNeedle && !hasUrl) throw new Error("activate_tab requires urlContains or url.");
			if (hasUrl) validateNavigationUrl(params.url);
		}
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
	function truncateTitle(title, max = 80) {
		const text = String(title ?? "").replace(/\s+/g, " ").trim();
		if (text.length <= max) return text;
		return `${text.slice(0, max - 1)}…`;
	}
	function retryDelay(attempt, baseMs = 750, maximumMs = 15e3) {
		const boundedAttempt = Math.max(0, Math.min(Number(attempt) || 0, 8));
		return Math.min(maximumMs, baseMs * 2 ** boundedAttempt);
	}
	/**
	* The identity a replay would arrive under.
	*
	* The agent's own lease expires at 45s and its caller gives up at 45s, so the
	* dangerous sequence is entirely invisible from the agent's side: the extension
	* runs `click`, the POST of the result fails (postResultWithRetry gives up after
	* three attempts), and the command is still sitting in the agent's map. Anything
	* that hands it out again — a re-poll, a redelivery, an agent that decided to
	* retry — makes the same click happen a second time. The agent cannot tell
	* whether the first one landed; only the side that ran it can.
	*
	* An explicit idempotencyKey lets a caller declare two enqueues to be the same
	* act. Without one the commandId is still a perfectly good identity for the
	* replay case, which is the case that actually bites.
	*/
	function commandIdentity(command) {
		const declared = String(command?.idempotencyKey ?? "").trim();
		if (declared) return `idem:${declared.slice(0, 200)}`;
		const commandId = String(command?.commandId ?? "").trim();
		return commandId ? `cmd:${commandId}` : "";
	}
	const TEXT_ENCODER = typeof TextEncoder === "function" ? new TextEncoder() : null;
	function byteLengthOf(value) {
		const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
		return TEXT_ENCODER ? TEXT_ENCODER.encode(text).length : text.length * 2;
	}
	const LEDGER_MAX_BYTES = 128 * 1024;
	const LEDGER_TTL_MS = 5 * MAX_COMMAND_AGE_MS;
	/**
	* Remember what this extension has already done, so a replay is answered rather
	* than re-executed.
	*
	* Under byte pressure a full entry is first downgraded to a stub — the fact of
	* execution, without the result — because forgetting the *result* costs the
	* caller one repeated read, while forgetting the *execution* costs the owner a
	* second click on a real page. Only when stubs alone still exceed the budget is
	* an entry dropped, oldest first.
	*/
	function createCommandLedger({ maxBytes = LEDGER_MAX_BYTES, ttlMs = LEDGER_TTL_MS } = {}) {
		const entries = /* @__PURE__ */ new Map();
		let bytes = 0;
		const sizeOf = (entry) => byteLengthOf(entry.result) + byteLengthOf(entry.key) + 64;
		const drop = (key) => {
			const entry = entries.get(key);
			if (!entry) return;
			bytes -= entry.bytes;
			entries.delete(key);
		};
		const stub = (entry) => {
			if (entry.stubbed) return false;
			bytes -= entry.bytes;
			entry.result = {
				ok: false,
				error: "This command already ran in the browser. Its result was dropped to stay inside the extension result budget; re-running it was refused because the first run may have changed the page."
			};
			entry.stubbed = true;
			entry.bytes = sizeOf(entry);
			bytes += entry.bytes;
			return true;
		};
		const reclaim = (now) => {
			for (const [key, entry] of entries) if (now - entry.storedAt > ttlMs) drop(key);
			for (const entry of entries.values()) {
				if (bytes <= maxBytes) break;
				stub(entry);
			}
			for (const key of [...entries.keys()]) {
				if (bytes <= maxBytes) break;
				drop(key);
			}
		};
		return {
			recall(key, now = Date.now()) {
				if (!key) return null;
				const entry = entries.get(key);
				if (!entry) return null;
				if (now - entry.storedAt > ttlMs) {
					drop(key);
					return null;
				}
				return entry;
			},
			remember(key, result, now = Date.now()) {
				if (!key) return null;
				drop(key);
				const entry = {
					key,
					result,
					storedAt: now,
					stubbed: false,
					bytes: 0
				};
				entry.bytes = sizeOf(entry);
				if (entry.bytes > maxBytes) {
					entries.set(key, entry);
					bytes += entry.bytes;
					stub(entry);
				} else {
					entries.set(key, entry);
					bytes += entry.bytes;
				}
				reclaim(now);
				return entries.get(key) ?? null;
			},
			stats() {
				return {
					entries: entries.size,
					bytes,
					maxBytes,
					ttlMs
				};
			},
			clear() {
				entries.clear();
				bytes = 0;
			}
		};
	}
	const WITHHELD = "[withheld]";
	/**
	* The rules, in one place, because there is no way to share code across the
	* extension boundary.
	*
	* local-agent/redaction.js owns the same job on the agent side and the two
	* lists will drift; that is a known cost, taken deliberately. The extension
	* cannot import a Node module, and the whole point of this boundary is that it
	* runs *before* anything crosses to the agent — a rule that only exists on the
	* far side has already lost. Kept structural (field types and autofill tokens)
	* rather than a prose copy of redaction.js, so the two lists overlap as little
	* as possible and neither pretends to be the other.
	*/
	const PRIVACY_RULES = {
		withheldInputTypes: ["password"],
		credentialAutocomplete: [
			"current-password",
			"new-password",
			"one-time-code"
		],
		paymentAutocomplete: [
			"cc-number",
			"cc-exp",
			"cc-exp-month",
			"cc-exp-year",
			"cc-csc",
			"cc-type",
			"cc-name",
			"cc-given-name",
			"cc-family-name",
			"cc-additional-name"
		],
		credentialTokens: [
			"password",
			"passwd",
			"pwd",
			"passphrase",
			"onetimecode",
			"otpcode",
			"totp",
			"mfacode",
			"2facode",
			"securityanswer",
			"apikey",
			"accesstoken",
			"sessiontoken",
			"privatekey",
			"clientsecret"
		],
		paymentTokens: [
			"cardnumber",
			"creditcard",
			"cardnum",
			"ccnumber",
			"ccnum",
			"cvv",
			"cvc",
			"csc",
			"securitycode",
			"cardexp",
			"expmonth",
			"expyear",
			"iban",
			"routingnumber",
			"accountnumber",
			"sortcode"
		],
		secretLabelPatterns: [
			"\\b(pass(?:word|phrase|code)|secret|api[\\s_-]?key|auth\\s*token|access\\s*token|private\\s*key)\\b",
			"\\b(lock|door|gate|garage|safe|alarm|bike|locker|keypad|entry|wifi|router|sim)\\s*(code|combination|pin|password)\\b",
			"\\b(pin|passcode|combination|security\\s+code|access\\s+code|cvv|cvc)\\b\\s*(is|are|=|:)"
		],
		secretLabelWords: [
			"password",
			"passwd",
			"pwd",
			"passphrase",
			"passcode",
			"secret",
			"api",
			"apikey",
			"key",
			"token",
			"auth",
			"pin",
			"cvv",
			"cvc",
			"csc",
			"code",
			"combination",
			"credential",
			"credentials",
			"login",
			"wifi",
			"is",
			"the",
			"my"
		],
		secretValuePatterns: [
			"\\b(sk|pk|rk)[-_][A-Za-z0-9_-]{16,}",
			"\\bgh[pousr]_[A-Za-z0-9]{20,}",
			"\\bxox[abprs]-[A-Za-z0-9-]{10,}",
			"\\bAKIA[0-9A-Z]{16}\\b",
			"\\bey[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]*",
			"-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----",
			"\"(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret)\"\\s*:\\s*\"[^\"]*\"",
			"\\b(?:\\d[ -]?){13,19}\\b"
		]
	};
	const compile = (sources, flags = "gi") => sources.map((source) => new RegExp(source, flags));
	const squash = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
	/**
	* What kind of field this is, from its own description of itself.
	*
	* Errs towards credential/payment: over-classifying costs one withheld value
	* the agent could have read, under-classifying puts a card number in a prompt.
	*/
	function classifyFieldSensitivity(field = {}, rules = PRIVACY_RULES) {
		const type = String(field.type ?? field.inputType ?? "").toLowerCase();
		if (rules.withheldInputTypes.includes(type)) return "credential";
		const tokens = String(field.autocomplete ?? "").toLowerCase().split(/\s+/).filter(Boolean);
		if (tokens.some((token) => rules.credentialAutocomplete.includes(token))) return "credential";
		if (tokens.some((token) => rules.paymentAutocomplete.includes(token))) return "payment";
		const haystack = squash([
			field.name,
			field.fieldName,
			field.id,
			field.ariaLabel,
			field.placeholder,
			field.label,
			field.autocomplete
		].filter(Boolean).join(" "));
		if (!haystack) return "normal";
		if (rules.credentialTokens.some((token) => haystack.includes(token))) return "credential";
		if (rules.paymentTokens.some((token) => haystack.includes(token))) return "payment";
		return "normal";
	}
	/**
	* Did the withholding actually withhold anything?
	*
	* This is the check evidenceCapsules.js had to bolt on after the fact, kept
	* here as a first-class function so it can be tested directly rather than
	* inferred from a passing pipeline. A mask that appends its marker to the
	* original — "The wifi password is hunter2.: [withheld]" — leaves every word of
	* the secret in place while the caller records action:"withheld". A store that
	* lies about what it withheld is worse than one that never tried.
	*/
	function verifyWithheld(original, emitted) {
		const survivors = String(original ?? "").split(/[^A-Za-z0-9]+/).filter((word) => word.length >= 4);
		const text = String(emitted ?? "");
		return !survivors.some((word) => text.includes(word));
	}
	/**
	* Cut the text into the smallest pieces that can be withheld independently.
	*
	* The size of a segment is the blast radius of a label match, and the first
	* version of this got that badly wrong on markup: read_page mode:"html" returns
	* the whole document as a single line with no sentence breaks, so one `<p>`
	* mentioning a password withheld the entire page. Splitting at tag boundaries
	* costs nothing on plain text — `><` does not occur in prose — and turns
	* "the page is unreadable" back into "that paragraph is withheld".
	*
	* Every split either keeps its separator or is zero-width, so joining the
	* segments back together reproduces the input exactly.
	*/
	function segmentsOf(text) {
		const segments = [];
		for (const [index, line] of String(text).split("\n").entries()) {
			if (index) segments.push({
				text: "\n",
				literal: true
			});
			for (const chunk of line.split(/(?<=>)(?=<)/)) for (const piece of chunk.split(/((?<=[.!?])\s+)/)) {
				if (!piece) continue;
				segments.push({
					text: piece,
					literal: /^\s+$/.test(piece)
				});
			}
		}
		return segments;
	}
	/**
	* Did this pattern match a secret, or only the word announcing one?
	*
	* A pattern in the value list is trusted to have consumed the secret, so its
	* span is replaced and the rest of the sentence is kept. A pattern that matches
	* only label words has not consumed anything — replacing its span produces
	* "The wifi [withheld] is hunter2.", which is the redaction.js failure wearing
	* a different hat. A match with no letters at all (a bare card number) is a
	* value by construction.
	*/
	function matchedOnlyTheLabel(match, rules) {
		const words = String(match).toLowerCase().split(/[^a-z]+/).filter(Boolean);
		if (!words.length) return false;
		return words.every((word) => rules.secretLabelWords?.includes(word));
	}
	/**
	* Strip secrets from extracted text, then prove they are gone.
	*
	* Two mechanisms, because secrets come in two shapes:
	*   - a label pattern says "a secret is nearby" but not where it ends, so the
	*     whole segment is withheld;
	*   - a value pattern *is* the secret, so only its span goes and the sentence
	*     around it stays readable.
	*
	* Whichever fired, the result is verified against the original: if any
	* non-trivial word of a segment that was supposed to be withheld survives, the
	* segment is replaced outright and `verified` is false so the caller knows the
	* rules, not the text, are what needs fixing.
	*/
	function withholdSecrets(value, rules = PRIVACY_RULES) {
		const labels = compile(rules.secretLabelPatterns);
		const values = compile(rules.secretValuePatterns);
		const out = [];
		let withheld = 0;
		let verified = true;
		for (const segment of segmentsOf(String(value ?? ""))) {
			if (segment.literal || !segment.text) {
				out.push(segment.text);
				continue;
			}
			if (labels.some((pattern) => {
				pattern.lastIndex = 0;
				return pattern.test(segment.text);
			})) {
				withheld += 1;
				out.push(WITHHELD);
				if (!verifyWithheld(segment.text, "[withheld]")) verified = false;
				continue;
			}
			let emitted = segment.text;
			const removed = [];
			for (const pattern of values) {
				pattern.lastIndex = 0;
				emitted = emitted.replace(pattern, (match) => {
					removed.push(match);
					return WITHHELD;
				});
			}
			if (removed.length) {
				withheld += removed.length;
				const label = removed.some((match) => matchedOnlyTheLabel(match, rules));
				const survived = !removed.every((match) => verifyWithheld(match, emitted));
				if (label || survived) {
					verified = false;
					emitted = WITHHELD;
				}
			}
			out.push(emitted);
		}
		return {
			text: out.join(""),
			withheld,
			verified
		};
	}
	const INPUT_TAG = /<input\b[^>]*>/gi;
	const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/g;
	/**
	* Scrub values out of the markup before it is serialized to the agent.
	*
	* read_page mode:"html" returns document.documentElement.outerHTML, which is
	* every hidden input on the page — session ids, CSRF and bearer tokens — plus
	* any server-rendered value= on a card or password field. That markup then
	* crosses to the agent, is stored with the result, and is exactly the kind of
	* text that ends up pasted into a third-party prompt.
	*
	* This is attribute surgery, not parsing: it is a second layer under the
	* text pass, and both run before anything leaves the browser.
	*/
	function withholdMarkupValues(html, rules = PRIVACY_RULES) {
		let withheld = 0;
		return {
			html: String(html ?? "").replace(INPUT_TAG, (tag) => {
				const field = {};
				ATTRIBUTE.lastIndex = 0;
				let match;
				while ((match = ATTRIBUTE.exec(tag)) !== null) {
					const raw = match[2];
					field[match[1].toLowerCase()] = raw.startsWith("\"") || raw.startsWith("'") ? raw.slice(1, -1) : raw;
				}
				const type = String(field.type ?? "").toLowerCase();
				if (classifyFieldSensitivity({
					type,
					name: field.name,
					id: field.id,
					autocomplete: field.autocomplete,
					placeholder: field.placeholder,
					ariaLabel: field["aria-label"]
				}, rules) === "normal" && type !== "hidden") return tag;
				if (!("value" in field)) return tag;
				withheld += 1;
				return tag.replace(/(\bvalue\s*=\s*)("[^"]*"|'[^']*'|[^\s"'>]+)/i, `$1"${WITHHELD}"`);
			}),
			withheld
		};
	}
	/**
	* Every extraction says which tab it came from, what it was pointed at, and
	* when — stamped in the browser rather than reconstructed by the agent, which
	* only knows what it asked for and not where the tab actually ended up.
	*/
	function provenanceFor({ command, tab, result, locator, now = Date.now() }) {
		const params = command?.action?.params ?? {};
		return {
			commandId: command?.commandId ?? null,
			action: command?.action?.type ?? null,
			tabId: Number.isInteger(tab?.id) ? tab.id : result?.tabId ?? null,
			windowId: Number.isInteger(tab?.windowId) ? tab.windowId : result?.windowId ?? null,
			url: String(result?.url ?? tab?.url ?? ""),
			requestedUrl: String(params.url ?? ""),
			title: truncateTitle(result?.title ?? tab?.title ?? "", 200),
			locator: String(locator ?? "").trim() || String(params.ref ?? "").trim() || String(params.selector ?? "").trim() || "document",
			observedAt: new Date(now).toISOString()
		};
	}
	/**
	* The last thing that runs before a result crosses out of the browser.
	*
	* Everything here is deliberately after execution and before the POST: the
	* agent is a different process with its own log, its own store and a cloud
	* relay attached, so a value that reaches it has effectively left the machine.
	*/
	function sanitizeExtraction(result, { rules = PRIVACY_RULES } = {}) {
		if (!result || typeof result !== "object" || Array.isArray(result)) return {
			result,
			privacy: {
				withheld: 0,
				verified: true,
				fields: []
			}
		};
		const clean = { ...result };
		let withheld = 0;
		let verified = true;
		if (typeof clean.content === "string" && clean.content) {
			if (String(clean.mode ?? "") === "html") {
				const markup = withholdMarkupValues(clean.content, rules);
				clean.content = markup.html;
				withheld += markup.withheld;
			}
			const text = withholdSecrets(clean.content, rules);
			clean.content = text.text;
			withheld += text.withheld;
			verified = verified && text.verified;
		}
		if (Array.isArray(clean.tabs)) {
			const valuesOnly = {
				...rules,
				secretLabelPatterns: []
			};
			clean.tabs = clean.tabs.map((tab) => {
				const scrubbed = withholdSecrets(String(tab?.url ?? ""), valuesOnly);
				if (!scrubbed.withheld) return tab;
				withheld += scrubbed.withheld;
				return {
					...tab,
					url: scrubbed.text,
					urlWithheld: true
				};
			});
		}
		const fields = [];
		if (Array.isArray(clean.elements)) {
			clean.elements = clean.elements.map((element) => {
				const sensitivity = classifyFieldSensitivity({
					type: element?.inputType,
					name: element?.fieldName,
					id: element?.id,
					autocomplete: element?.autocomplete,
					label: element?.name
				}, rules);
				if (sensitivity === "normal") return element;
				fields.push({
					ref: element?.ref ?? null,
					sensitivity
				});
				return {
					...element,
					sensitivity,
					fieldName: void 0,
					value: void 0,
					name: sensitivity === "credential" ? WITHHELD : element?.name
				};
			});
			withheld += fields.length;
		}
		const privacy = {
			withheld,
			verified,
			fields,
			boundary: "browser-extension/src/bridge-core.js sanitizeExtraction"
		};
		return {
			result: {
				...clean,
				privacy
			},
			privacy
		};
	}
	//#endregion
	//#region browser-extension/src/command-console.js
	const CONSOLE_SOURCE = "browser-extension";
	const HISTORY_KEY = "consoleHistory";
	const SESSION_KEY = "consoleSessionId";
	const MAX_COMMAND_CHARS = 2e3;
	const PLAN_TIMEOUT_MS = 12e4;
	const EXECUTE_TIMEOUT_MS = 18e4;
	const HEADLINE_MAX = 500;
	const DETAIL_MAX = 2e3;
	const clip = (value, max) => {
		const text = String(value ?? "").trim();
		return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
	};
	/**
	* The page the owner was looking at, reduced to what may leave the browser.
	*
	* Full URL on purpose — "summarize this page" needs the path — but through the
	* same value-pattern scrub list_tabs uses, so a magic-link token in the query
	* string is withheld while the address stays targetable. Label patterns are
	* skipped for the same reason sanitizeExtraction skips them for tab URLs: a
	* URL containing the word "password" is an address, not a secret.
	*/
	function scrubPageContext(page) {
		const url = String(page?.url ?? "");
		if (!isScriptableUrl(url)) return null;
		return {
			url: clip(withholdSecrets(url, {
				...PRIVACY_RULES,
				secretLabelPatterns: []
			}).text, 400),
			title: truncateTitle(page?.title ?? "", 120)
		};
	}
	/**
	* What actually goes in the /plan `command` field. The agent's contract has no
	* separate context parameter — the command text is the only channel — so the
	* page rides along as a clearly-labelled trailer the planner can use or ignore.
	*/
	function buildCommandText(command, page = null) {
		const text = clip(command, MAX_COMMAND_CHARS);
		if (!page) return text;
		return `${text}\n\n[Sent from the browser extension. Active page: ${page.title ? `"${page.title}" — ${page.url}` : page.url}]`;
	}
	function interpretPlanResponse({ status, payload }) {
		if (!payload || typeof payload !== "object") return {
			kind: "error",
			message: `The local agent returned HTTP ${status} with no readable body.`
		};
		const common = {
			jobId: payload.jobId ?? null,
			sessionId: payload.sessionId ?? null,
			planner: payload.planner ?? null
		};
		if (status === 401) return {
			kind: "error",
			unauthorized: true,
			message: payload.error || "The local agent rejected the token. Open settings.",
			...common
		};
		if (status === 422 || payload.status === "unsupported") return {
			kind: "refused",
			message: payload.error || "The planner refused this request.",
			...common
		};
		if (status < 200 || status >= 300 || payload.ok === false) return {
			kind: "error",
			cancelled: Boolean(payload.cancelled),
			message: payload.error || `The local agent returned HTTP ${status}.`,
			...common
		};
		if (payload.status === "instant") return {
			kind: "answered",
			message: payload.response || payload.summary || "Done.",
			...common
		};
		const actions = Array.isArray(payload.actions) ? payload.actions : [];
		if (payload.status === "ready" && actions.length) {
			const planLine = payload.summary || payload.response || payload.preview?.spoken || `Prepared ${actions.length} step${actions.length === 1 ? "" : "s"}.`;
			if (payload.requiresConfirmation === false) return {
				kind: "execute",
				actions,
				message: planLine,
				...common
			};
			return {
				kind: "parked",
				message: planLine,
				detail: describePlanSteps(actions, payload.preview),
				safety: payload.safety || "",
				...common
			};
		}
		if (payload.status === "ready" && payload.response) return {
			kind: "answered",
			message: payload.response,
			...common
		};
		return {
			kind: "error",
			message: payload.error || `The planner returned an empty ${payload.status ?? "unknown"} plan.`,
			...common
		};
	}
	function interpretExecuteResponse({ status, payload }) {
		if (!payload || typeof payload !== "object") return {
			kind: "error",
			message: `The local agent returned HTTP ${status} with no readable body.`
		};
		const common = {
			jobId: payload.jobId ?? null,
			sessionId: payload.sessionId ?? null
		};
		if (status < 200 || status >= 300) return {
			kind: "error",
			cancelled: Boolean(payload.cancelled),
			message: payload.error || `The local agent returned HTTP ${status}.`,
			...common
		};
		const steps = describeResults(payload.results);
		const message = payload.response || steps.join(" ") || (payload.ok ? "Done." : payload.error || "Execution failed.");
		return {
			kind: payload.ok ? "executed" : "exec-failed",
			status: payload.status ?? (payload.ok ? "success" : "failed"),
			message,
			steps,
			...common
		};
	}
	function describeResults(results) {
		if (!Array.isArray(results)) return [];
		return results.map((result) => {
			const label = result?.action?.label || result?.action?.type || "step";
			const text = result?.message || result?.error || "";
			return clip(`${result?.ok ? "✓" : "✗"} ${label}${text ? ` — ${text}` : ""}`, 300);
		});
	}
	function describePlanSteps(actions, preview) {
		const lines = actions.slice(0, 6).map((action, index) => `${index + 1}. ${clip(action?.label || action?.type || "step", 120)}`);
		if (actions.length > 6) lines.push(`… and ${actions.length - 6} more`);
		const touched = [
			...preview?.affected?.apps ?? [],
			...preview?.affected?.urls ?? [],
			...preview?.affected?.paths ?? []
		];
		if (touched.length) lines.push(`Touches: ${clip(touched.join(", "), 200)}`);
		return lines.join("\n");
	}
	function newHistoryEntry({ id, command, page = null, now = Date.now() }) {
		return {
			id,
			command: clip(command, MAX_COMMAND_CHARS),
			page: page ? {
				url: page.url,
				title: page.title
			} : null,
			state: "working",
			headline: "",
			detail: "",
			jobId: null,
			sessionId: null,
			planner: null,
			startedAt: new Date(now).toISOString(),
			finishedAt: null
		};
	}
	function appendHistory(history, entry) {
		return [entry, ...Array.isArray(history) ? history : []].slice(0, 8);
	}
	function patchHistory(history, id, patch) {
		return (Array.isArray(history) ? history : []).map((entry) => entry?.id === id ? {
			...entry,
			...patch,
			headline: clip(patch.headline ?? entry.headline, HEADLINE_MAX),
			detail: clip(patch.detail ?? entry.detail, DETAIL_MAX)
		} : entry);
	}
	/** Outcome (from the interpreters above) → history entry patch. */
	function outcomeToPatch(outcome, now = Date.now()) {
		const base = {
			finishedAt: new Date(now).toISOString(),
			jobId: outcome.jobId ?? null,
			sessionId: outcome.sessionId ?? null,
			planner: outcome.planner ?? null
		};
		switch (outcome.kind) {
			case "answered": return {
				...base,
				state: "answered",
				headline: outcome.message
			};
			case "executed": return {
				...base,
				state: "executed",
				headline: outcome.message,
				detail: (outcome.steps ?? []).join("\n")
			};
			case "exec-failed": return {
				...base,
				state: "failed",
				headline: outcome.message,
				detail: (outcome.steps ?? []).join("\n")
			};
			case "parked": return {
				...base,
				state: "parked",
				headline: outcome.message,
				detail: [outcome.safety, outcome.detail].filter(Boolean).join("\n")
			};
			case "refused": return {
				...base,
				state: "refused",
				headline: outcome.message
			};
			default: return {
				...base,
				state: "failed",
				headline: outcome.message || "Something went wrong."
			};
		}
	}
	//#endregion
	//#region browser-extension/src/brain.js
	const BRAIN_STORAGE_KEYS = [
		"brainEnabled",
		"modelProxyUrl",
		"deviceToken",
		"brainRetryAfterAt"
	];
	Object.freeze({
		brainEnabled: false,
		modelProxyUrl: null,
		deviceToken: null
	});
	const MAX_FAILURES = 2;
	const INFER_LIMITS = Object.freeze({
		maxMessages: 40,
		maxPromptChars: 24e3,
		maxOutputTokens: 2048,
		defaultOutputTokens: 512
	});
	const BRAIN_OUTPUT_TOKENS = 1024;
	/**
	* The budget to retry a cut-off reply with, or null when there is no headroom
	* left to buy.
	*
	* A truncated reply in JSON mode is not a bad answer, it is half an answer:
	* the model stopped mid-object and the parse fails downstream looking like
	* garbage. One doubling is worth the second billed call because the handoff it
	* replaces costs a Mac planner call anyway; a second doubling is not, because
	* a reply that will not fit in the ceiling will not fit next time either.
	*/
	function escalateOutputTokens(current) {
		const asked = Number(current) || INFER_LIMITS.defaultOutputTokens;
		if (asked >= INFER_LIMITS.maxOutputTokens) return null;
		return Math.min(asked * 2, INFER_LIMITS.maxOutputTokens);
	}
	const abnormalStop = (message, code) => {
		const error = new Error(message);
		error.code = code;
		error.fatal = true;
		return error;
	};
	/**
	* Ask for a reply, and decide what an abnormal ending means.
	*
	* The policy lives here, away from the fetch, because it is the part with a
	* decision in it: when to pay again, and when paying again buys nothing.
	* `send(maxTokens)` is injected and resolves to the relay's
	* `{content, truncated, complete, refusal, finishReason}` — so every branch
	* below is exercised in tests without a relay, which matters because these are
	* the branches no client can reproduce on purpose.
	*
	* ONLY truncation is retried. A length stop is the one ending more room fixes;
	* a content filter or a refusal ends the same way however much budget it is
	* given, so retrying those just bills twice for one refusal.
	*/
	async function callModelWithHeadroom(send, maxTokens = BRAIN_OUTPUT_TOKENS) {
		let asked = maxTokens;
		for (let attempt = 0; attempt < 4; attempt += 1) {
			const reply = await send(asked);
			if (reply?.truncated) {
				const escalated = escalateOutputTokens(asked);
				if (!escalated) throw abnormalStop(`The model's reply was cut off at the relay's ${INFER_LIMITS.maxOutputTokens}-token ceiling.`, "truncated");
				asked = escalated;
				continue;
			}
			const refusal = String(reply?.refusal ?? "").trim();
			if (refusal) throw abnormalStop(`The model declined: ${refusal}`, "refusal");
			if (reply?.complete === false) throw abnormalStop(`The model stopped abnormally (${reply?.finishReason || "unknown reason"}), so its answer is not trustworthy.`, "incomplete");
			return String(reply?.content ?? "");
		}
		throw abnormalStop(`The model's reply was cut off at the relay's ${INFER_LIMITS.maxOutputTokens}-token ceiling.`, "truncated");
	}
	const PROMPT_CHAR_BUDGET = INFER_LIMITS.maxPromptChars - 1e3;
	const FATAL_INFER_CODES = new Set([
		"credential_predates_capability",
		"scope_denied",
		"not_configured",
		"model_not_allowed",
		"invalid_messages",
		"prompt_too_large",
		"rate_limited"
	]);
	/**
	* The brain's model endpoint is either the relay (https) or a local dev proxy
	* on loopback. Anything else — plain http to a LAN address, a file URL — is a
	* misconfiguration, not a brain.
	*/
	function validProxyUrl(value) {
		try {
			const url = new URL(String(value ?? ""));
			if (url.protocol === "https:") return url.href;
			if (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)) return url.href;
			return null;
		} catch {
			return null;
		}
	}
	/** The instant a `retryAfter` in seconds points at. Null when there isn't one. */
	function cooldownUntil(retryAfterSeconds, now = Date.now()) {
		const seconds = Number(retryAfterSeconds);
		if (!Number.isFinite(seconds) || seconds <= 0) return null;
		return new Date(now + seconds * 1e3).toISOString();
	}
	/** Milliseconds still to wait, or 0 when the window has passed or never was. */
	function cooldownRemainingMs(retryAfterAt, now = Date.now()) {
		const at = Date.parse(String(retryAfterAt ?? ""));
		if (!Number.isFinite(at)) return 0;
		return Math.max(0, at - now);
	}
	function normalizeBrainConfig(values = {}) {
		const brainEnabled = values.brainEnabled === true;
		const modelProxyUrl = validProxyUrl(values.modelProxyUrl);
		const deviceToken = String(values.deviceToken ?? "").trim() || null;
		const brainRetryAfterAt = String(values.brainRetryAfterAt ?? "").trim() || null;
		let reason = "";
		if (!brainEnabled) reason = "The local brain is switched off (brainEnabled is not true).";
		else if (!modelProxyUrl) reason = "No usable modelProxyUrl is configured — the relay-side model proxy has not been set up yet.";
		else if (!deviceToken) reason = "No deviceToken is configured — scoped device tokens land with the relay proxy task.";
		return {
			brainEnabled,
			modelProxyUrl,
			deviceToken,
			brainRetryAfterAt,
			ready: brainEnabled && Boolean(modelProxyUrl) && Boolean(deviceToken),
			reason
		};
	}
	/**
	* Where a command should go. 'mac-planner' is the answer until the credential
	* task lands; the caller treats anything but 'local-brain' as the Mac path.
	*/
	function chooseBrainRoute(config, now = Date.now()) {
		const normalized = config && "ready" in config ? config : normalizeBrainConfig(config);
		if (!normalized.ready) return {
			route: "mac-planner",
			reason: normalized.reason
		};
		const waitMs = cooldownRemainingMs(normalized.brainRetryAfterAt, now);
		if (waitMs > 0) return {
			route: "mac-planner",
			reason: `The relay asked not to be called again for ${Math.ceil(waitMs / 1e3)}s (until ${normalized.brainRetryAfterAt}).`,
			cooldownMs: waitMs
		};
		return {
			route: "local-brain",
			reason: "Brain configuration is complete."
		};
	}
	const BROWSER_TOOLS = Object.freeze([
		{
			name: "navigate",
			description: "Open an http(s) URL in a tab.",
			params: "url, newTab?"
		},
		{
			name: "activate_tab",
			description: "Focus the existing tab matching a URL, or open it.",
			params: "urlContains | url"
		},
		{
			name: "click",
			description: "Click an element.",
			params: "selector | ref"
		},
		{
			name: "type",
			description: "Type text into a field.",
			params: "selector | ref, text, submit?"
		},
		{
			name: "read_page",
			description: "Read page text/html/forms/landmarks.",
			params: "mode?, selector?, maxChars?"
		},
		{
			name: "snapshot",
			description: "List interactive elements with refs.",
			params: "maxElements?"
		},
		{
			name: "wait_for",
			description: "Wait until a selector or text appears.",
			params: "selector | textContains, timeoutMs?"
		},
		{
			name: "scroll",
			description: "Scroll the page or to an element.",
			params: "dx?, dy?, selector?, ref?"
		},
		{
			name: "select",
			description: "Choose an option in a <select>.",
			params: "selector | ref, value | label"
		},
		{
			name: "list_tabs",
			description: "List open web tabs.",
			params: "limit?"
		},
		{
			name: "capture",
			description: "Screenshot the visible tab.",
			params: ""
		},
		{
			name: "press_key",
			description: "Press a keyboard key.",
			params: "key, selector?"
		}
	]);
	for (const tool of BROWSER_TOOLS) if (!COMMAND_TYPES.has(tool.name)) throw new Error(`brain tool ${tool.name} is not an executable command`);
	if (BROWSER_TOOLS.length !== COMMAND_TYPES.size) throw new Error("brain tool catalog does not cover every executable command");
	function createBrainState({ command, page = null, maxSteps = 6, now = Date.now() } = {}) {
		return {
			status: "thinking",
			command: String(command ?? ""),
			page,
			steps: [],
			stepCount: 0,
			maxSteps,
			failures: 0,
			pendingCall: null,
			response: null,
			handoffReason: null,
			parkedCall: null,
			parkedReason: null,
			startedAt: new Date(now).toISOString()
		};
	}
	const TERMINAL = new Set([
		"done",
		"handoff",
		"parked"
	]);
	/**
	* The reducer. Every transition the loop can make is here, pure, so the whole
	* lifecycle is testable without a model, a browser, or a network.
	*
	* Events:
	*   {type:'model_reply', text}          — while thinking
	*   {type:'model_error', error}         — while thinking
	*   {type:'tool_result', ok, result?, error?} — while acting
	*   {type:'hand_off', reason}           — from anywhere
	*   {type:'park', reason}               — while acting; the pending call is
	*                                         refused unattended execution
	*/
	function reduceBrain(state, event) {
		if (!state || TERMINAL.has(state.status)) return state;
		if (event?.type === "hand_off") return {
			...state,
			status: "handoff",
			pendingCall: null,
			handoffReason: event.reason || "Handed off to the Mac planner."
		};
		if (state.status === "acting" && event?.type === "park") return {
			...state,
			status: "parked",
			parkedCall: state.pendingCall,
			parkedReason: event.reason || "This step is irreversible or outward-facing.",
			pendingCall: null
		};
		if (state.status === "thinking" && event?.type === "model_reply") {
			const parsed = parseToolCalls(event.text);
			if (parsed.done) return {
				...state,
				status: "done",
				response: parsed.response
			};
			if (parsed.malformed || !parsed.calls.length) {
				const failures = state.failures + 1;
				if (failures >= MAX_FAILURES) return {
					...state,
					failures,
					status: "handoff",
					handoffReason: `The model reply was unusable twice (${parsed.reason || "no tool call"}).`
				};
				return {
					...state,
					failures
				};
			}
			const call = parsed.calls[0];
			if (!COMMAND_TYPES.has(call.type)) {
				const failures = state.failures + 1;
				return failures >= MAX_FAILURES ? {
					...state,
					failures,
					status: "handoff",
					handoffReason: `The model asked for an unknown tool twice (${call.type}).`
				} : {
					...state,
					failures
				};
			}
			if (state.stepCount >= state.maxSteps) return {
				...state,
				status: "handoff",
				handoffReason: `Step budget of ${state.maxSteps} spent without an answer.`
			};
			return {
				...state,
				status: "acting",
				pendingCall: call,
				failures: 0
			};
		}
		if (state.status === "thinking" && event?.type === "model_error") {
			if (event.fatal) return {
				...state,
				status: "handoff",
				handoffReason: event.error
			};
			const failures = state.failures + 1;
			return failures >= MAX_FAILURES ? {
				...state,
				failures,
				status: "handoff",
				handoffReason: `The model endpoint failed twice: ${event.error}`
			} : {
				...state,
				failures
			};
		}
		if (state.status === "acting" && event?.type === "tool_result") {
			const step = {
				tool: state.pendingCall?.type ?? "unknown",
				params: state.pendingCall?.params ?? {},
				ok: event.ok === true,
				...event.ok === true ? { result: event.result ?? null } : { error: String(event.error ?? "Tool failed.") }
			};
			const next = {
				...state,
				steps: [...state.steps, step],
				stepCount: state.stepCount + 1,
				pendingCall: null,
				failures: event.ok === true ? 0 : state.failures + 1,
				status: "thinking"
			};
			if (next.failures >= MAX_FAILURES) return {
				...next,
				status: "handoff",
				handoffReason: "Tools failed twice in a row."
			};
			if (next.stepCount >= next.maxSteps) return step.ok ? next : {
				...next,
				status: "handoff",
				handoffReason: "Out of steps."
			};
			return next;
		}
		return state;
	}
	/**
	* The prompt is rebuilt from state every turn rather than kept as chat history
	* so the reducer stays the single source of truth.
	*
	* Bounded against the relay's prompt ceiling here rather than discovering it
	* as a 400: a `read_page` result is up to 50 kB on its own, so a few steps of
	* transcript can outgrow the whole budget. The system block and the owner's
	* command are never dropped — without either there is nothing to answer — and
	* the transcript keeps the MOST RECENT steps, which are the ones the next
	* decision turns on. Dropped steps are declared in the prompt rather than
	* silently omitted, so the model is never told a partial history is complete.
	*/
	function buildBrainMessages(state) {
		const tools = BROWSER_TOOLS.map((tool) => `- ${tool.name}(${tool.params}): ${tool.description}`).join("\n");
		const lines = state.steps.map((step, index) => {
			const outcome = step.ok ? JSON.stringify(step.result)?.slice(0, 2e3) : `ERROR: ${step.error}`;
			return `${index + 1}. ${step.tool}(${JSON.stringify(step.params)}) → ${outcome}`;
		});
		const fixedChars = tools.length + String(state.command).length + 400;
		let budget = Math.max(0, PROMPT_CHAR_BUDGET - fixedChars);
		const kept = [];
		for (let index = lines.length - 1; index >= 0; index -= 1) {
			const cost = lines[index].length + 1;
			if (cost > budget) break;
			budget -= cost;
			kept.unshift(lines[index]);
		}
		const dropped = lines.length - kept.length;
		const transcript = kept.length ? (dropped ? `(${dropped} earlier step(s) omitted to fit the prompt limit)\n` : "") + kept.join("\n") : "";
		return [
			{
				role: "system",
				content: `You are the planning brain of a browser extension. You may either answer the user directly or drive the page with one tool per turn.
Tools:\n${tools}\nReply with EXACTLY ONE JSON object and nothing else. Either
  {"tool": "<name>", "params": {…}}
or, when you are finished,
  {"done": true, "response": "<what to tell the user>"}
` + (state.page ? `The user is looking at: "${state.page.title}" — ${state.page.url}\n` : "") + `You have ${Math.max(0, state.maxSteps - state.stepCount)} tool call(s) left.`
			},
			{
				role: "user",
				content: state.command
			},
			...transcript ? [{
				role: "user",
				content: `Tool results so far:\n${transcript}`
			}] : []
		];
	}
	/**
	* Read a model reply. Accepts a fenced ```json block or a bare JSON object;
	* plain prose with no JSON at all is taken as a final answer, because a model
	* that just answered the question should not be punished for skipping the
	* envelope. Returns {done, response, calls:[{type, params}], malformed, reason}.
	*/
	function parseToolCalls(text) {
		const raw = String(text ?? "").trim();
		if (!raw) return {
			done: false,
			response: null,
			calls: [],
			malformed: true,
			reason: "empty reply"
		};
		const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
		const candidate = (fenced ? fenced[1] : raw).trim();
		const start = candidate.indexOf("{");
		const end = candidate.lastIndexOf("}");
		if (start === -1) return {
			done: true,
			response: raw,
			calls: [],
			malformed: false,
			reason: ""
		};
		if (end <= start) return {
			done: false,
			response: null,
			calls: [],
			malformed: true,
			reason: "truncated JSON"
		};
		let parsed;
		try {
			parsed = JSON.parse(candidate.slice(start, end + 1));
		} catch (error) {
			return {
				done: false,
				response: null,
				calls: [],
				malformed: true,
				reason: `unparseable JSON: ${error.message}`
			};
		}
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			if (parsed.done === true || typeof parsed.response === "string" && !parsed.tool) return {
				done: true,
				response: String(parsed.response ?? "").trim() || raw,
				calls: [],
				malformed: false,
				reason: ""
			};
			const calls = (Array.isArray(parsed.tool_calls) ? parsed.tool_calls : Array.isArray(parsed.tools) ? parsed.tools : parsed.tool ? [parsed] : []).map((item) => ({
				type: String(item?.tool ?? item?.name ?? item?.type ?? "").trim(),
				params: item?.params && typeof item.params === "object" && !Array.isArray(item.params) ? item.params : {}
			})).filter((item) => item.type);
			if (calls.length) return {
				done: false,
				response: null,
				calls,
				malformed: false,
				reason: ""
			};
		}
		return {
			done: false,
			response: null,
			calls: [],
			malformed: true,
			reason: "JSON had neither a tool call nor a done response"
		};
	}
	/**
	* Read a failed POST /v1/infer. Pure, so every branch is testable without a
	* relay — which matters more than usual here, because the branch that still
	* demands a human remedy (a credential minted with an explicit `scopes`
	* ceiling that leaves out `llm:infer`) cannot be reproduced locally at all.
	*
	* Keys on `code`, never on message text: the relay's own comment says the
	* generic denial stays deliberately vague so a probing token gets no
	* scope-enumeration oracle out of it, and vague text is exactly what a text
	* match would break on.
	*/
	function interpretInferError({ status, payload } = {}) {
		const code = String(payload?.code ?? "").trim() || "unknown";
		const relayText = String(payload?.error ?? "").trim();
		const message = code === "credential_predates_capability" ? "The browser credential was minted with an explicit scope ceiling that leaves out inference. Re-pair the extension with a wider scope list (pendant-credentials.mjs pair --role browser_node) — a narrowed credential never widens on its own." : code === "scope_denied" ? "This credential's role is not allowed to use the relay's inference route." : code === "rate_limited" ? `This device has spent its hourly inference budget${payload?.resetAt ? `; it resets at ${payload.resetAt}` : ""}.` : code === "not_configured" ? "The relay has no model key configured, so it cannot think for this node." : code === "prompt_too_large" || code === "invalid_messages" ? relayText || "The relay refused the prompt." : code === "upstream_error" ? `The model provider refused the request (HTTP ${status ?? "?"}).` : relayText || `The relay returned HTTP ${status ?? "?"}.`;
		const retryAfter = Number(payload?.retryAfter);
		const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;
		return {
			code,
			status: status ?? null,
			message,
			fatal: FATAL_INFER_CODES.has(code),
			retryAfter: seconds,
			retryAt: cooldownUntil(seconds)
		};
	}
	function summarizeBrainRun(state) {
		if (state.status === "done") return `Brain answered after ${state.stepCount} tool call(s).`;
		if (state.status === "handoff") return `Brain handed off to the Mac planner: ${state.handoffReason}`;
		if (state.status === "parked") return `Brain stopped before an irreversible step and parked it for approval: ${state.parkedReason}`;
		return `Brain is ${state.status} (${state.stepCount} tool call(s) so far).`;
	}
	/**
	* @param {object} options
	* @param {string} options.command      what the owner asked for
	* @param {object|null} options.page    {url, title} context, already scrubbed
	* @param {object} options.config      normalizeBrainConfig() output
	* @param {(messages: object[]) => Promise<string>} options.callModel
	*        POSTs to config.modelProxyUrl with the device token; resolves to the
	*        model's text reply. Injected by background.js — and never invoked
	*        unless config.ready, which today it never is.
	* @param {(call: {type, params}) => Promise<object>} options.runTool
	*        runs one of the extension's page commands through its own
	*        validated executor and returns its sanitized result.
	* @param {(call: {type, params}) => {allow: boolean, reason?: string}} [options.assessTool]
	*        the outward gate (affinity.createOutwardGuard().assess). Consulted
	*        BEFORE every runTool; {allow:false} parks the call instead of
	*        running it. Optional so the pure-loop tests stay pure; background.js
	*        always supplies it.
	*/
	async function runBrainLoop({ command, page = null, config, callModel, runTool, assessTool = null }) {
		const normalized = config && "ready" in config ? config : normalizeBrainConfig(config);
		let state = createBrainState({
			command,
			page
		});
		if (!normalized.ready) return reduceBrain(state, {
			type: "hand_off",
			reason: normalized.reason
		});
		for (let turn = 0; turn < state.maxSteps * 2 + 2; turn += 1) if (state.status === "thinking") try {
			const text = await callModel(buildBrainMessages(state));
			state = reduceBrain(state, {
				type: "model_reply",
				text
			});
		} catch (error) {
			state = reduceBrain(state, {
				type: "model_error",
				error: error?.message || String(error),
				fatal: error?.fatal === true
			});
		}
		else if (state.status === "acting") {
			if (assessTool) {
				let verdict;
				try {
					verdict = assessTool(state.pendingCall);
				} catch (error) {
					verdict = {
						allow: false,
						reason: `The safety gate itself failed (${error?.message || error}).`
					};
				}
				if (verdict?.allow !== true) {
					state = reduceBrain(state, {
						type: "park",
						reason: verdict?.reason || "This step is irreversible or outward-facing."
					});
					continue;
				}
			}
			try {
				const result = await runTool(state.pendingCall);
				state = reduceBrain(state, {
					type: "tool_result",
					ok: true,
					result
				});
			} catch (error) {
				state = reduceBrain(state, {
					type: "tool_result",
					ok: false,
					error: error?.message || String(error)
				});
			}
		} else break;
		if (!TERMINAL.has(state.status)) state = reduceBrain(state, {
			type: "hand_off",
			reason: "The loop ran out of turns without finishing."
		});
		return state;
	}
	//#endregion
	//#region browser-extension/src/affinity.js
	const CAPABILITY_BROWSER = "browser";
	const CAPABILITY_HIVE = "hive";
	const EFFECT_READ = "read";
	const EFFECT_OUTWARD = "outward";
	const LOCAL_CLAIMABLE_ACTIONS = Object.freeze({
		browser_navigate: "navigate",
		browser_click: "click",
		browser_type: "type",
		browser_read_page: "read_page",
		browser_snapshot: "snapshot",
		browser_wait_for: "wait_for",
		browser_scroll: "scroll",
		browser_select: "select",
		browser_list_tabs: "list_tabs",
		browser_capture: "capture",
		browser_press_key: "press_key",
		browser_activate_tab: "activate_tab",
		open_url: "activate_tab"
	});
	/** The local command a hive plan step becomes, or null when it cannot. */
	function localCallFor(action) {
		const hiveType = String(action?.type ?? "").trim();
		const params = action?.params && typeof action.params === "object" && !Array.isArray(action.params) ? { ...action.params } : {};
		if (COMMAND_TYPES.has(hiveType)) return {
			type: hiveType,
			params
		};
		const localType = LOCAL_CLAIMABLE_ACTIONS[hiveType];
		if (!localType) return null;
		if (hiveType === "open_url") {
			const url = String(params.url ?? "").trim();
			if (!url) return null;
			let urlContains = "";
			try {
				urlContains = new URL(url).hostname;
			} catch {
				return null;
			}
			return {
				type: "activate_tab",
				params: {
					url,
					urlContains
				}
			};
		}
		return {
			type: localType,
			params
		};
	}
	const READ_COMMANDS = new Set([
		"read_page",
		"snapshot",
		"list_tabs",
		"wait_for",
		"capture",
		"scroll"
	]);
	const outwardMatchers = Object.freeze([
		"\\b(submit|confirm|place\\s+(?:the\\s+)?order|checkout|check\\s+out)\\b",
		"\\b(buy|sell|trade|invest|transfer|withdraw|deposit|pay(?:ment)?|purchase|donate)\\b",
		"\\b(send|reply|post|publish|share|tweet|forward)\\b",
		"\\b(cancel|unsubscribe|terminate|close\\s+(?:my\\s+)?account|deactivat\\w*|delete)\\b",
		"\\b(sign|agree|accept|consent|authoriz\\w*|approve)\\b",
		"\\b(book|reserve|order|enroll|register|subscribe|renew)\\b"
	]).map((source) => new RegExp(source, "i"));
	/** Does this text describe an outward commit point? '' matches nothing. */
	function textLooksOutward(text) {
		const haystack = String(text ?? "");
		if (!haystack.trim()) return false;
		return outwardMatchers.some((pattern) => pattern.test(haystack));
	}
	/**
	* The effect tag for one local call.
	*
	* `targetName` is what the page itself calls the element (the accessible name
	* a snapshot recorded). It is the strongest signal there is — the label the
	* OWNER would read before pressing the same control — so it participates in
	* the match alongside the planner's label and the raw selector.
	*
	* Fail-closed rule for clicks: a click whose target this side cannot describe
	* AT ALL (a bare ref with no snapshot behind it, an empty selector) is tagged
	* 'outward'. Not because it is known to be dangerous, but because it is not
	* known to be safe, and "click the unlabeled thing on a live page" is not a
	* bet to make unattended.
	*/
	function classifyEffect({ type, params = {}, label = "", targetName = "" } = {}) {
		const command = String(type ?? "").trim();
		if (READ_COMMANDS.has(command)) return {
			effect: EFFECT_READ,
			reason: "Reads the page; changes nothing."
		};
		if (command === "navigate" || command === "activate_tab") return {
			effect: "act",
			reason: "Opens or focuses a page."
		};
		const described = [
			targetName,
			label,
			String(params.selector ?? ""),
			String(params.ref ?? ""),
			String(params.text ?? ""),
			String(params.value ?? params.label ?? "")
		].filter(Boolean).join(" ");
		if (command === "click") {
			const hasName = String(targetName ?? "").trim();
			const hasSelector = String(params.selector ?? "").trim();
			if (!hasName && !hasSelector) return {
				effect: EFFECT_OUTWARD,
				reason: "Clicks a target this side cannot describe (no snapshot name, no selector) — not provably safe."
			};
			if (textLooksOutward(described)) return {
				effect: EFFECT_OUTWARD,
				reason: `The click target reads as a commit point: "${(hasName || hasSelector).slice(0, 120)}".`
			};
			return {
				effect: "act",
				reason: "Clicks an element."
			};
		}
		if (command === "type" || command === "select") {
			if (params.submit === true) return {
				effect: EFFECT_OUTWARD,
				reason: "Typing with submit:true files the form in the same breath."
			};
			if (textLooksOutward(described)) return {
				effect: EFFECT_OUTWARD,
				reason: "The field or its content reads as part of an outward action."
			};
			return {
				effect: "act",
				reason: "Edits a field without submitting."
			};
		}
		if (command === "press_key") {
			const key = String(params.key ?? "").trim().toLowerCase();
			if (key === "enter" || key === "return") return {
				effect: EFFECT_OUTWARD,
				reason: "Enter submits whatever form holds the focus."
			};
			return {
				effect: "act",
				reason: `Presses ${key || "a key"}.`
			};
		}
		return {
			effect: EFFECT_OUTWARD,
			reason: `No effect classification exists for "${command}".`
		};
	}
	/** Tag one hive plan step. Pure; never throws. */
	function tagPlanStep(action, index = 0) {
		const localCall = localCallFor(action);
		const label = String(action?.label ?? action?.type ?? "step");
		if (!localCall) return {
			index,
			label,
			hiveType: String(action?.type ?? ""),
			capability: CAPABILITY_HIVE,
			localCall: null,
			effect: null,
			effectReason: ""
		};
		const { effect, reason } = classifyEffect({
			type: localCall.type,
			params: localCall.params,
			label
		});
		return {
			index,
			label,
			hiveType: String(action?.type ?? ""),
			capability: CAPABILITY_BROWSER,
			localCall,
			effect,
			effectReason: reason
		};
	}
	/**
	* THE AFFINITY RULE. A non-empty plan whose every step is browser-capable
	* executes on this node; anything else forwards to the hive unchanged.
	*/
	function routePlan(actions) {
		const steps = (Array.isArray(actions) ? actions : []).map((action, index) => tagPlanStep(action, index));
		if (!steps.length) return {
			route: CAPABILITY_HIVE,
			steps,
			reason: "The plan has no steps."
		};
		const foreign = steps.filter((step) => step.capability !== CAPABILITY_BROWSER);
		if (foreign.length) {
			const named = foreign.slice(0, 3).map((step) => step.hiveType || step.label).join(", ");
			return {
				route: CAPABILITY_HIVE,
				steps,
				reason: `${foreign.length} of ${steps.length} step(s) need more than a browser (${named}) — the hive keeps the whole plan.`
			};
		}
		return {
			route: CAPABILITY_BROWSER,
			steps,
			reason: `All ${steps.length} step(s) are browser work; this node runs them itself.`
		};
	}
	/**
	* A stateful wrapper around classifyEffect for tool-by-tool execution.
	*
	* The brain clicks by ref, and a ref means nothing outside the snapshot that
	* minted it. The guard watches snapshot results go past and remembers each
	* ref's accessible name, so when the model later says {click, ref:"e4"} the
	* classifier sees "Confirm cancellation" — the words the OWNER would have
	* read — and not an opaque token. A ref the guard never saw snapshotted is
	* unclassifiable and therefore parks (classifyEffect's fail-closed rule).
	*/
	function createOutwardGuard() {
		const names = /* @__PURE__ */ new Map();
		return {
			/** Feed every successful tool result through here. */
			observe(call, result) {
				if (String(call?.type) !== "snapshot") return;
				for (const element of result?.elements ?? []) {
					const ref = String(element?.ref ?? "").trim();
					if (!ref) continue;
					names.set(ref, {
						name: String(element?.name ?? ""),
						role: String(element?.role ?? "")
					});
				}
			},
			/** What the last snapshot called this ref, if anything. */
			describeRef(ref) {
				return names.get(String(ref ?? "").trim()) ?? null;
			},
			/**
			* May this call run unattended? {allow, effect, reason, targetName}.
			* Read and act steps pass; outward steps do not — deciding what happens
			* to a parked call is the caller's business, not the guard's.
			*/
			assess(call) {
				const known = names.get(String(call?.params?.ref ?? "").trim());
				const targetName = known ? [known.name, known.role && `(${known.role})`].filter(Boolean).join(" ") : "";
				const { effect, reason } = classifyEffect({
					type: call?.type,
					params: call?.params ?? {},
					targetName
				});
				return {
					allow: effect !== EFFECT_OUTWARD,
					effect,
					reason,
					targetName
				};
			}
		};
	}
	const NAVIGATION_COMMANDS = new Set(["navigate", "activate_tab"]);
	/** What a finished run actually did, counted from its steps. */
	function summarizeEffects(steps = []) {
		const counts = {
			read: 0,
			opened: 0,
			act: 0,
			outward: 0,
			failed: 0
		};
		for (const step of steps) {
			if (step?.ok === false) {
				counts.failed += 1;
				continue;
			}
			if (step?.effect === "outward") counts.outward += 1;
			else if (step?.effect === "act") if (NAVIGATION_COMMANDS.has(String(step?.tool ?? ""))) counts.opened += 1;
			else counts.act += 1;
			else counts.read += 1;
		}
		return counts;
	}
	/**
	* Does the command ASK for an outward effect? Same vocabulary as the step
	* classifier, applied to the owner's own words — "cancel my recurring
	* investments" wants a cancellation, and a run that never performed one must
	* not be allowed to sound as if it did.
	*/
	function commandWantsOutwardEffect(command) {
		return textLooksOutward(command);
	}
	/**
	* The honest completion line for a locally executed run.
	*
	* verdict:
	*   'achieved'   — outward/act effects ran and nothing is pending.
	*   'recon-only' — nothing on any page was changed; says exactly that.
	*   'parked'     — stopped at an outward step; the effect has NOT happened.
	*   'incomplete' — the command wanted an outward effect and none ran.
	*
	* The model's own response (if any) survives as color, never as the claim:
	* headline truth is derived from `steps` and `parked`, which only the
	* executor writes.
	*/
	function honestVerdict({ command, steps = [], parked = [], response = "" } = {}) {
		const effects = summarizeEffects(steps);
		const wanted = commandWantsOutwardEffect(command);
		const said = String(response ?? "").trim();
		if (parked.length) return {
			verdict: "parked",
			headline: "Stopped before the irreversible step — nothing was submitted, cancelled or sent. It is waiting for your approval.",
			detail: `Parked: ${parked.map((entry) => String(entry?.reason ?? "an irreversible step")).slice(0, 2).join("; ")}. Steps so far: ${describeCounts(effects)}.`
		};
		if (effects.act === 0 && effects.outward === 0) return {
			verdict: "recon-only",
			headline: said ? `${said} (Read-only: opened and read pages; changed nothing.)` : "Read-only run: opened and read pages; changed nothing.",
			detail: `Steps: ${describeCounts(effects)}.`
		};
		if (wanted && effects.outward === 0) return {
			verdict: "incomplete",
			headline: "NOT done: the final submit/cancel/send step never ran, so nothing was changed. " + (said || "The pages were only navigated and read."),
			detail: `Steps: ${describeCounts(effects)}.`
		};
		return {
			verdict: "achieved",
			headline: said || "Done.",
			detail: `Steps: ${describeCounts(effects)}.`
		};
	}
	function describeCounts(effects) {
		return `${effects.read} read, ${effects.opened} page(s) opened, ${effects.act} page interaction(s), ${effects.outward} approved outward step(s), ${effects.failed} failed`;
	}
	/** The relay brain's own mailbox. '@' can never appear in a deviceId. */
	const RELAY_NODE_ADDRESS = "@relay";
	/** Serialized envelope ceiling. See the SIZE note above. */
	const MAX_ENVELOPE_BYTES = 64 * 1024;
	const DEVICE_ADDRESS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/;
	const RESERVED_ADDRESS_PATTERN = /^@[a-z][a-z0-9-]{1,30}$/;
	const KIND_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9][a-z0-9_]*){0,5}$/;
	const MESSAGE_ID_PATTERN = /^nmsg_[A-Za-z0-9_-]{8,64}$/;
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
	/** A message kind, or '' if it is not one. Lowercase dotted verbs only. */
	function normalizeNodeKind(value) {
		const kind = String(value ?? "").trim();
		return kind.length <= 64 && KIND_PATTERN.test(kind) ? kind : "";
	}
	/** True while the envelope is still deliverable. */
	function envelopeIsLive(envelope, now = Date.now()) {
		const expiresAt = Date.parse(envelope?.expiresAt || "");
		return Number.isFinite(expiresAt) && expiresAt > now;
	}
	/**
	* Parse one envelope off the wire. Returns null for anything that is not a
	* well-formed envelope of a version we speak — a receiver must never have to
	* guess whether `payload` exists.
	*/
	function parseNodeEnvelope(input) {
		let candidate = input;
		if (typeof input === "string") try {
			candidate = JSON.parse(input);
		} catch {
			return null;
		}
		if (!candidate || typeof candidate !== "object") return null;
		if (candidate.v !== 1) return null;
		if (!MESSAGE_ID_PATTERN.test(String(candidate.id || ""))) return null;
		if (!normalizeNodeAddress(candidate.from)) return null;
		if (!normalizeNodeAddress(candidate.to)) return null;
		if (!normalizeNodeKind(candidate.kind)) return null;
		if (candidate.payload === null || typeof candidate.payload !== "object" || Array.isArray(candidate.payload)) return null;
		return candidate;
	}
	//#endregion
	//#region shared/bridgeSocketProtocol.js
	const BRIDGE_PING_FRAME = "{\"type\":\"ping\"}";
	const MESH_SUBPROTOCOL = "pendant.mesh.v1";
	const BEARER_SUBPROTOCOL_PREFIX = "bearer.";
	const BRIDGE_PING_INTERVAL_MS = 55e3;
	function parseBridgeFrame(data) {
		if (typeof data !== "string") return null;
		try {
			const parsed = JSON.parse(data);
			return parsed && typeof parsed.type === "string" ? parsed : null;
		} catch {
			return null;
		}
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
	/**
	* Descriptors rather than fetches, so every URL, method and body this module
	* can produce is assertable in a unit test without a network or a mock.
	* `auth: 'device'` is a marker: the caller supplies the token, this module
	* never holds it and never puts it in a URL.
	*/
	function inboxRequest(config) {
		return {
			method: "GET",
			path: `/v1/node/inbox?deviceId=${encodeURIComponent(config.relayDeviceId)}`,
			auth: "device",
			body: null
		};
	}
	function ackRequest(config, messageIds) {
		return {
			method: "POST",
			path: "/v1/node/inbox/ack",
			auth: "device",
			body: {
				deviceId: config.relayDeviceId,
				messageIds: [...messageIds]
			}
		};
	}
	function sendRequest(config, { to, kind, payload, correlationId = null, ttlMs }) {
		return {
			method: "POST",
			path: "/v1/node/messages",
			auth: "device",
			body: {
				to,
				kind,
				payload,
				...correlationId ? { correlationId } : {},
				...Number.isFinite(ttlMs) ? { ttlMs } : {}
			}
		};
	}
	/**
	* Where the socket connects. The deviceId is a path parameter because it is
	* not a secret; the CREDENTIAL is not here and must never be, because query
	* strings are the part of a request that gets logged — by Cloudflare, by any
	* proxy in between, and by the browser's own network panel.
	*/
	function socketUrl(config) {
		const origin = normalizeRelayUrl(config?.relayUrl);
		const address = normalizeNodeAddress(config?.relayDeviceId);
		if (!origin || !address) return "";
		return `${origin.replace(/^http/, "ws")}/v1/node/socket?deviceId=${encodeURIComponent(address)}`;
	}
	/**
	* The two subprotocol offers, in order.
	*
	* Two rather than one because RFC 6455 makes the server echo a protocol the
	* client offered, and a browser closes a socket whose selected protocol it did
	* not offer. Offering the plain mesh name alongside the credential gives the
	* server something safe to echo — measured: it selects "pendant.mesh.v1" and
	* the token never appears in the response.
	*/
	function socketProtocols(config) {
		const token = String(config?.deviceToken ?? "").trim();
		if (!token) return [];
		return [MESH_SUBPROTOCOL, `${BEARER_SUBPROTOCOL_PREFIX}${token}`];
	}
	/** True when the server picked the protocol we can live with. */
	function socketProtocolAccepted(selected) {
		return String(selected ?? "") === "pendant.mesh.v1" || String(selected ?? "") === "";
	}
	/**
	* What one inbound frame means. Pure, so the frame table is a test rather than
	* a switch buried in an event handler.
	*/
	function reactToFrame(raw) {
		const frame = parseBridgeFrame(raw);
		if (!frame) return {
			drain: false,
			kind: ""
		};
		return {
			drain: frame.type === "mail" || frame.type === "work",
			kind: frame.type
		};
	}
	function createEnvelopeLedger(seen = {}) {
		const entries = {};
		for (const [id, expiresAt] of Object.entries(seen ?? {})) {
			const at = Number(expiresAt);
			if (Number.isFinite(at)) entries[id] = at;
		}
		return entries;
	}
	/** Forget ids whose envelopes could no longer be delivered anyway. */
	function pruneEnvelopeLedger(ledger, now = Date.now(), max = 400) {
		const live = Object.entries(ledger).filter(([, expiresAt]) => expiresAt > now);
		live.sort((left, right) => left[1] - right[1]);
		return Object.fromEntries(live.slice(Math.max(0, live.length - max)));
	}
	const MAX_MESH_COMMAND_AGE_MS = 10 * 6e4;
	/** kind → what this extension does with it. */
	const MESH_KINDS = Object.freeze({
		"browser.command": "command",
		"browser.ping": "ping",
		"approval_request": "approval"
	});
	const MESH_RESULT_KIND = "browser.command.result";
	const MESH_PONG_KIND = "browser.pong";
	const MAX_RESULT_PAYLOAD_BYTES = MAX_ENVELOPE_BYTES - 2048;
	const encoder = typeof TextEncoder === "function" ? new TextEncoder() : null;
	const byteLength = (value) => {
		const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
		return encoder ? encoder.encode(text).length : text.length * 2;
	};
	function fitResultPayload(payload, max = MAX_RESULT_PAYLOAD_BYTES) {
		if (byteLength(payload) <= max) return {
			payload,
			truncated: false
		};
		const trimmed = { ...payload };
		const result = trimmed.result && typeof trimmed.result === "object" ? { ...trimmed.result } : null;
		if (result && typeof result.content === "string") {
			let content = result.content;
			while (content.length > 64) {
				content = content.slice(0, Math.floor(content.length / 2));
				result.content = `${content}\n[truncated to fit the 64 KiB node-mesh envelope]`;
				trimmed.result = result;
				if (byteLength(trimmed) <= max) return {
					payload: {
						...trimmed,
						truncated: true
					},
					truncated: true
				};
			}
		}
		return {
			payload: {
				ok: payload?.ok === true,
				truncated: true,
				error: "The result did not fit a 64 KiB node-mesh envelope and no text field could be trimmed. Screenshots and other large blobs cannot cross the mesh; ask the Mac peer for them, or ask for a narrower selector."
			},
			truncated: true
		};
	}
	/**
	* Sort one drained page into what to run, what to ignore, and what to ack.
	*
	* EVERYTHING drained is acked, including duplicates, expired mail and mail
	* this node refuses to execute. An ack is "I have this", not "I did this" —
	* leaving a message unacked because it was refused would guarantee it comes
	* back every 60 s forever, and the inbox would fill until MAX_INBOX_DEPTH
	* started rejecting the sends that mattered.
	*/
	function acceptEnvelopes(rawMessages, { ledger = {}, config, now = Date.now() } = {}) {
		const trusted = new Set(config?.trustedSenders ?? DEFAULT_TRUSTED_SENDERS);
		const self = normalizeNodeAddress(config?.relayDeviceId);
		const seen = { ...ledger };
		const run = [];
		const ignored = [];
		const ackIds = [];
		for (const raw of Array.isArray(rawMessages) ? rawMessages : []) {
			const envelope = parseNodeEnvelope(raw);
			if (!envelope) {
				ignored.push({
					envelope: null,
					reason: "not a node-mesh envelope of a version we speak"
				});
				continue;
			}
			ackIds.push(envelope.id);
			if (envelope.id in seen) {
				ignored.push({
					envelope,
					reason: "already handled (at-least-once redelivery)"
				});
				continue;
			}
			seen[envelope.id] = Date.parse(envelope.expiresAt) || now + 6e5;
			if (self && envelope.to !== self) {
				ignored.push({
					envelope,
					reason: `addressed to ${envelope.to}, not to this node`
				});
				continue;
			}
			const handling = MESH_KINDS[envelope.kind];
			if (!handling) {
				ignored.push({
					envelope,
					reason: `no handler for kind "${envelope.kind}"`
				});
				continue;
			}
			if (handling !== "approval" && !envelopeIsLive(envelope, now)) {
				ignored.push({
					envelope,
					reason: "expired before it was drained"
				});
				continue;
			}
			if (!trusted.has(envelope.from)) {
				ignored.push({
					envelope,
					reason: `"${envelope.from}" is not a trusted sender for this browser. Add it to meshTrustedSenders to let it drive tabs.`
				});
				continue;
			}
			const age = now - (Date.parse(envelope.createdAt) || now);
			if (handling !== "approval" && age > 6e5) {
				ignored.push({
					envelope,
					reason: `queued ${Math.round(age / 1e3)}s ago; this node refuses mesh mail older than ${MAX_MESH_COMMAND_AGE_MS / 6e4} minutes`
				});
				continue;
			}
			run.push({
				envelope,
				handling
			});
		}
		return {
			run,
			ignored,
			ackIds,
			ledger: seen
		};
	}
	/**
	* Is there mail left AFTER this page?
	*
	* `pending` counts the page it just leased you, not what remains beyond it —
	* a drain returning one message comes back `pending: 1` and only reads 0 once
	* the ack lands. Measured on the live relay: messages=1, pending=1, then
	* pending=0 after the ack. So `while (pending > 0) drain()` never terminates;
	* it re-leases nothing and spins. The only honest read is the comparison.
	*/
	function hasMoreMail(page) {
		return Number(page?.pending || 0) > (Array.isArray(page?.messages) ? page.messages.length : 0);
	}
	/**
	* Build the Error a failed relay response should throw. One place, because
	* the wire contract has three parts that drift independently: the human
	* message (`error` or `message`), the machine name (`code` — e.g. the
	* ownership 403's `not_your_inbox` since relay 41dbc4b), and the HTTP
	* status. describeRelayFailure keys on status first and uses code only to
	* sharpen, so this must carry all three — dropping `code` at this seam once
	* left the not_your_inbox branch unreachable from live traffic.
	*/
	async function relayResponseError(response) {
		let detail = "";
		let code = "";
		try {
			const payload = await response.json();
			detail = payload.error || payload.message || "";
			code = typeof payload.code === "string" ? payload.code : "";
		} catch {
			detail = await response.text().catch(() => "");
		}
		const error = new Error(detail || `The relay returned HTTP ${response.status}.`);
		error.status = response.status;
		if (code) error.code = code;
		return error;
	}
	/**
	* Why a relay request failed, in a form the UI can act on.
	*
	* `code` is present on the relay's refusals (`scope_denied`, `unknown_node`,
	* `inbox_full`, `invalid_envelope`, `credential_predates_capability`) — and,
	* since relay commit 41dbc4b, on the ownership 403 as well: both
	* /v1/node/inbox and /v1/node/inbox/ack now send `not_your_inbox`
	* (OWNERSHIP_DENIED_CODE in cloud-relay/nodeMailbox.js) beside their
	* deliberately vague message. Status stays the primary signal and code only
	* sharpens it, never the other way round: a relay predating that commit — or
	* any future 403 shipped without a code — must still land on the precise
	* generic fix, not "unknown". 401 and 403 are split because they need
	* different fixes: 401 is a credential this relay does not accept, 403 is a
	* credential that is fine but is not allowed to touch this deviceId — and
	* when the relay names it `not_your_inbox`, that is stated outright: the
	* token is valid but paired to a different deviceId than the inbox it
	* requested.
	*/
	function describeRelayFailure(error) {
		const status = Number(error?.status || 0);
		const code = String(error?.code ?? "") || "";
		if (status === 401) return {
			state: "unauthorized",
			code,
			message: "The relay does not accept this browser's device token. Pair again and paste the new one."
		};
		if (status === 403) {
			if (code === "not_your_inbox") return {
				state: "unauthorized",
				code,
				message: "This token is valid but paired to a different device ID than the inbox it requested. Set the device ID to the one this token was paired with, or pair again to get a token for this one."
			};
			return {
				state: "unauthorized",
				code,
				message: "This token is valid but not for this device ID. Check that the device ID here matches the one it was paired with."
			};
		}
		return {
			state: "offline",
			code,
			message: "Cannot reach the relay."
		};
	}
	/**
	* A mesh envelope, shaped as the command the extension already knows how to
	* validate and execute — so mesh-borne work goes through exactly the same
	* validateCommand / sanitizeExtraction path as Mac-borne work, with no second
	* executor to keep in sync and no shortcut past the privacy boundary.
	*
	* createdAt is stamped at DELIVERY, not copied from the envelope: acceptEnvelopes
	* above has already applied the mesh's own freshness rules, and letting
	* bridge-core's 90 s rule run a second time over the same field would refuse
	* every message the durable queue held while the browser was closed.
	*/
	function envelopeToCommand(envelope, now = Date.now()) {
		const payload = envelope?.payload ?? {};
		const type = String(payload.type ?? "").trim();
		if (!COMMAND_TYPES.has(type)) throw new Error(`"${type || "(none)"}" is not a browser command this extension can run.`);
		return {
			commandId: envelope.id,
			idempotencyKey: String(payload.idempotencyKey ?? "").trim() || void 0,
			createdAt: new Date(now).toISOString(),
			source: "node-mesh",
			from: envelope.from,
			action: {
				type,
				params: payload.params && typeof payload.params === "object" && !Array.isArray(payload.params) ? payload.params : {}
			}
		};
	}
	/** The answer to a `browser.command`, addressed back at whoever asked. */
	function resultMessageFor(envelope, outcome, config) {
		const { payload, truncated } = fitResultPayload({
			ok: outcome?.ok === true,
			...outcome?.ok === true ? { result: outcome.result } : { error: String(outcome?.error ?? "Command failed.") }
		});
		return {
			...sendRequest(config, {
				to: envelope.from,
				kind: MESH_RESULT_KIND,
				payload,
				correlationId: envelope.id
			}),
			truncated
		};
	}
	function pongMessageFor(envelope, presence, config) {
		return sendRequest(config, {
			to: envelope.from,
			kind: MESH_PONG_KIND,
			payload: {
				...presence,
				address: config.relayDeviceId
			},
			correlationId: envelope.id
		});
	}
	const MAC_FRESH_MS = 4e4;
	const RELAY_POLL_SOCKET_MS = 3e5;
	const RELAY_POLL_IDLE_MS = 3e4;
	const RELAY_POLL_ACTIVE_MS = 3e3;
	/**
	* The whole routing policy, as one pure function.
	*
	* Written this way on purpose. "Prefer the Mac, fall back to the relay" is the
	* kind of rule that otherwise lives as an emergent property of two independent
	* loops and their timeouts, where the only way to find out what it does is to
	* unplug something and watch. Here it is a table a test can assert.
	*
	* The key decision: `inbound` lists BOTH peers whenever both are usable. A
	* mesh message is durable and silent — nothing tells the extension it exists —
	* so an extension that only drained its inbox while the Mac was down would
	* leave relay mail unread for as long as the Mac stayed up. Preferring the Mac
	* is a statement about where WORK GOES OUT, not about what is listened to.
	*/
	function choosePeer({ macConfigured = false, macLastOkAt = 0, relayReady = false, socketOpen = false, now = Date.now() } = {}) {
		const macFresh = macConfigured && now - macLastOkAt <= 4e4;
		const inbound = [];
		if (macConfigured) inbound.push("mac");
		if (relayReady) inbound.push("relay");
		const outbound = macFresh ? "mac" : relayReady ? "relay" : macConfigured ? "mac" : null;
		const relayTransport = !relayReady ? "none" : socketOpen ? "socket" : "poll";
		const relayPollMs = !relayReady ? RELAY_POLL_ACTIVE_MS : socketOpen ? RELAY_POLL_SOCKET_MS : macFresh ? RELAY_POLL_IDLE_MS : RELAY_POLL_ACTIVE_MS;
		let reason;
		if (!macConfigured && !relayReady) reason = "Neither peer is configured; this extension is unreachable.";
		else if (relayReady && socketOpen && macFresh) reason = "Both peers reachable: the relay pushes over its socket, results go to the Mac (loopback is faster).";
		else if (relayReady && socketOpen) reason = "The relay is pushing over its socket; the Mac is not answering.";
		else if (macFresh && relayReady) reason = "Both peers configured, but the relay socket is down — sweeping its inbox on the fallback cadence.";
		else if (macFresh) reason = "Only the Mac is configured; the relay peer is off or unconfigured.";
		else if (relayReady && macConfigured) reason = `The Mac has not answered in ${Math.round((now - macLastOkAt) / 1e3)}s; the relay is carrying this node.`;
		else if (relayReady) reason = "Only the relay is configured; there is no Mac peer.";
		else reason = "The Mac is configured but silent, and there is no relay peer to fall back to.";
		return {
			inbound,
			outbound,
			macFresh,
			relayTransport,
			relayPollMs,
			reason
		};
	}
	/** One line for the popup and the status store. Never names a credential. */
	function describeRelayPeer(config, choice) {
		if (!config.ready) return `Relay peer: off — ${config.reason}`;
		return `Relay peer: ${config.relayDeviceId} @ ${config.relayUrl} — ${choice.reason}`;
	}
	//#endregion
	//#region browser-extension/src/execution-status.js
	const EXECUTION_STATUS_KEY = "localExecutionStatus";
	const PENDING_APPROVALS_KEY = "localPendingApprovals";
	const APPROVAL_MESSAGE_TYPES = Object.freeze({
		status: "affinity:get-status",
		listPending: "affinity:list-pending",
		resolve: "affinity:resolve-approval"
	});
	const APPROVAL_TTL_MS = 10 * 6e4;
	const MAX_RUNS_KEPT = 8;
	const MAX_PENDING_KEPT = 12;
	function createStatusEmitter() {
		const listeners = /* @__PURE__ */ new Map();
		return {
			on(event, handler) {
				if (!listeners.has(event)) listeners.set(event, /* @__PURE__ */ new Set());
				listeners.get(event).add(handler);
				return () => listeners.get(event)?.delete(handler);
			},
			emit(event, payload) {
				for (const handler of listeners.get(event) ?? []) try {
					handler(payload);
				} catch {}
			}
		};
	}
	/**
	* @param {object} options
	* @param {object} options.storage  a storage.local-shaped object
	*                                  ({get(keys), set(values)}) — injected so
	*                                  tests hand in a plain fake.
	* @param {object} [options.emitter] createStatusEmitter() output.
	* @param {() => number} [options.now]
	*
	* All writes go through one promise chain, same as background.js's
	* withHistory: storage.local has no transactions, and two steps finishing
	* together must not eat each other's entries.
	*/
	function createExecutionJournal({ storage, emitter = createStatusEmitter(), now = Date.now } = {}) {
		if (!storage) throw new Error("createExecutionJournal requires a storage.");
		let writes = Promise.resolve();
		const serialize = (mutate) => {
			writes = writes.then(mutate, mutate);
			return writes;
		};
		const readStatus = async () => (await storage.get("localExecutionStatus"))["localExecutionStatus"] ?? { runs: [] };
		const readPending = async () => (await storage.get("localPendingApprovals"))["localPendingApprovals"] ?? [];
		const writeRun = (runId, mutate) => serialize(async () => {
			const status = await readStatus();
			const runs = Array.isArray(status.runs) ? [...status.runs] : [];
			const index = runs.findIndex((run) => run?.runId === runId);
			if (index === -1) return null;
			runs[index] = mutate({ ...runs[index] });
			await storage.set({ [EXECUTION_STATUS_KEY]: { runs } });
			emitter.emit("run", runs[index]);
			return runs[index];
		});
		return {
			events: emitter,
			/** A run exists from the moment the command is claimed locally. */
			beginRun({ runId, command, origin = "browser-extension", route, executor }) {
				return serialize(async () => {
					const status = await readStatus();
					const runs = Array.isArray(status.runs) ? status.runs : [];
					const run = {
						runId,
						command: String(command ?? ""),
						origin,
						route: route ?? "local",
						executor: executor ?? "browser-extension",
						state: "executing",
						steps: [],
						verdict: null,
						headline: "",
						detail: "",
						hiveRecord: "pending",
						startedAt: new Date(now()).toISOString(),
						finishedAt: null
					};
					await storage.set({ [EXECUTION_STATUS_KEY]: { runs: [run, ...runs].slice(0, MAX_RUNS_KEPT) } });
					emitter.emit("run", run);
					return run;
				});
			},
			/** One executed (or failed) step, already effect-tagged by affinity.js. */
			recordStep(runId, step) {
				return writeRun(runId, (run) => ({
					...run,
					steps: [...run.steps, {
						tool: String(step?.tool ?? step?.type ?? "step"),
						effect: step?.effect ?? null,
						ok: step?.ok === true,
						summary: String(step?.summary ?? "").slice(0, 300),
						at: new Date(now()).toISOString()
					}].slice(-24)
				}));
			},
			/**
			* Park an outward step. The run stops here; the approval entry is what a
			* later popup pass renders, and resolveApproval is what its buttons call.
			*/
			parkStep(runId, { call, effect, reason, targetName = "" }) {
				return serialize(async () => {
					const pending = await readPending();
					const entry = {
						id: `apr-${runId}-${pending.length + 1}`,
						runId,
						call: {
							type: String(call?.type ?? ""),
							params: call?.params ?? {}
						},
						effect: effect ?? "outward",
						reason: String(reason ?? "This step is irreversible or outward-facing."),
						targetName: String(targetName ?? ""),
						state: "pending",
						requestedAt: new Date(now()).toISOString(),
						resolvedAt: null,
						expiresAt: new Date(now() + APPROVAL_TTL_MS).toISOString()
					};
					await storage.set({ [PENDING_APPROVALS_KEY]: [entry, ...pending].slice(0, MAX_PENDING_KEPT) });
					emitter.emit("approval", entry);
					return entry;
				});
			},
			/** The terminal verdict, from affinity.honestVerdict — never from a model. */
			finishRun(runId, { state = "finished", verdict, headline, detail } = {}) {
				return writeRun(runId, (run) => ({
					...run,
					state,
					verdict: verdict ?? run.verdict,
					headline: String(headline ?? run.headline).slice(0, 500),
					detail: String(detail ?? run.detail).slice(0, 2e3),
					finishedAt: new Date(now()).toISOString()
				}));
			},
			/** Stamp whether the hive heard about this run. */
			markHiveRecord(runId, outcome) {
				return writeRun(runId, (run) => ({
					...run,
					hiveRecord: outcome
				}));
			},
			async getStatus() {
				await writes;
				return readStatus();
			},
			/** Pending approvals that have not expired. Expiry is enforced on read
			* AND on resolve, so a stale entry cannot run by being clicked late. */
			async listPendingApprovals() {
				await writes;
				const pending = await readPending();
				const at = now();
				return pending.filter((entry) => entry?.state === "pending" && Date.parse(entry.expiresAt ?? "") > at);
			},
			/**
			* Resolve one approval. Returns the entry in its new state, or null when
			* it does not exist. An expired entry resolves to 'expired' whatever the
			* verdict was — approving a ten-minute-old click is refused, not honored.
			* The caller (background.js) is the one who actually executes on
			* 'approved'; this module only owns the state.
			*/
			resolveApproval(id, verdict) {
				return serialize(async () => {
					const pending = await readPending();
					const index = pending.findIndex((entry) => entry?.id === id);
					if (index === -1) return null;
					const entry = { ...pending[index] };
					if (entry.state !== "pending") return entry;
					entry.state = Date.parse(entry.expiresAt ?? "") <= now() ? "expired" : verdict === "approved" ? "approved" : "declined";
					entry.resolvedAt = new Date(now()).toISOString();
					const next = [...pending];
					next[index] = entry;
					await storage.set({ [PENDING_APPROVALS_KEY]: next });
					emitter.emit("approval", entry);
					return entry;
				});
			}
		};
	}
	const BROWSER_TASK_RECORD_KIND = "browser.task.record";
	const RECORD_TTL_MS = 360 * 6e4;
	const scrub = (text) => withholdSecrets(String(text ?? "")).text;
	/**
	* The submission record — sent WHEN THE RUN BEGINS, already marked claimed
	* by this node. The invariant the shape encodes: this is a record OF work,
	* never a request FOR work. `claimable:false` states it; the transport
	* enforces it (see the module header — the Mac cannot drain '@relay').
	*/
	function hiveClaimRecordFor(run, relayConfig) {
		return sendRequest(relayConfig, {
			to: "@relay",
			kind: BROWSER_TASK_RECORD_KIND,
			correlationId: run.runId,
			ttlMs: RECORD_TTL_MS,
			payload: {
				record: "claim",
				claimable: false,
				taskId: run.runId,
				command: scrub(run.command).slice(0, 500),
				origin: run.origin ?? "browser-extension",
				claimedBy: relayConfig.relayDeviceId,
				executedBy: relayConfig.relayDeviceId,
				status: "executing",
				startedAt: run.startedAt
			}
		});
	}
	/** The terminal record: verdict plus the step trace, same address. */
	function hiveVerdictRecordFor(run, relayConfig) {
		return sendRequest(relayConfig, {
			to: "@relay",
			kind: BROWSER_TASK_RECORD_KIND,
			correlationId: run.runId,
			ttlMs: RECORD_TTL_MS,
			payload: {
				record: "verdict",
				claimable: false,
				taskId: run.runId,
				command: scrub(run.command).slice(0, 500),
				origin: run.origin ?? "browser-extension",
				claimedBy: relayConfig.relayDeviceId,
				executedBy: relayConfig.relayDeviceId,
				status: run.state,
				verdict: run.verdict,
				headline: scrub(run.headline).slice(0, 500),
				steps: (run.steps ?? []).slice(-24).map((step) => ({
					tool: step.tool,
					effect: step.effect,
					ok: step.ok,
					summary: scrub(step.summary).slice(0, 200),
					at: step.at
				})),
				startedAt: run.startedAt,
				finishedAt: run.finishedAt
			}
		});
	}
	const APPROVAL_DECISION_KIND = "approval_decision";
	const APPROVAL_DECISIONS = Object.freeze(["approve", "deny"]);
	const SETTLED_PROMPT_TTL_MS = 10 * 6e4;
	const clean = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
	/**
	* One approval_request envelope, as the card a surface renders. Returns null
	* for anything else — wrong kind, no approvalId — so a caller can feed it a
	* whole drained page and keep only the questions.
	*
	* The texts are bounded here, once, because both surfaces put them straight
	* into UI: a summary is a sentence, a detail is a paragraph, and a payload
	* that claims otherwise gets trimmed rather than trusted with the layout.
	*/
	function approvalPromptFromEnvelope(envelope, { now = Date.now() } = {}) {
		if (envelope?.kind !== "approval_request") return null;
		const payload = envelope.payload ?? {};
		const approvalId = clean(payload.approvalId, 80);
		if (!approvalId || !envelope.id) return null;
		const payloadExpiry = Date.parse(String(payload.expiresAt ?? ""));
		const envelopeExpiry = Date.parse(String(envelope.expiresAt ?? ""));
		const expiresAt = Number.isFinite(payloadExpiry) ? payloadExpiry : envelopeExpiry;
		return {
			approvalId,
			summary: clean(payload.summary, 200) || "An action is waiting for your approval.",
			detail: clean(payload.detail, 600),
			risk: clean(payload.risk, 40),
			expiresAt: Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : null,
			envelopeId: envelope.id,
			from: envelope.from,
			receivedAt: new Date(now).toISOString(),
			decision: null,
			decidedAt: null
		};
	}
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
	* Fold freshly drained envelopes into the held prompts. Pure; the caller owns
	* where the list lives (React state on the phone, storage.local in the
	* extension).
	*
	* Returns { prompts, changed } — and the SAME array when nothing changed, so
	* a React setState or a storage write can be skipped instead of churned.
	*/
	function mergeApprovalPrompts(prompts, envelopes, { now = Date.now() } = {}) {
		const held = Array.isArray(prompts) ? prompts : [];
		let list = held;
		let changed = false;
		for (const envelope of Array.isArray(envelopes) ? envelopes : []) {
			const prompt = approvalPromptFromEnvelope(envelope, { now });
			if (!prompt) continue;
			const index = list.findIndex((entry) => entry?.approvalId === prompt.approvalId);
			if (index === -1) {
				list = changed ? list : [...held];
				list.push(prompt);
				changed = true;
				continue;
			}
			const current = list[index];
			if (current.envelopeId === prompt.envelopeId && current.from === prompt.from) continue;
			list = changed ? list : [...held];
			list[index] = {
				...current,
				envelopeId: prompt.envelopeId,
				from: prompt.from
			};
			changed = true;
		}
		if (!changed) return {
			prompts: held,
			changed: false
		};
		return {
			prompts: pruneApprovalPrompts(list, now),
			changed: true
		};
	}
	/** Mark one prompt decided. Pure; answering is the caller's job, first. */
	function settleApprovalPrompt(prompts, approvalId, decision, { now = Date.now() } = {}) {
		return (Array.isArray(prompts) ? prompts : []).map((prompt) => prompt?.approvalId === approvalId ? {
			...prompt,
			decision,
			decidedAt: new Date(now).toISOString()
		} : prompt);
	}
	/** How many prompts still need the owner: live and undecided. */
	function undecidedApprovalCount(prompts, now = Date.now()) {
		return (Array.isArray(prompts) ? prompts : []).filter((prompt) => approvalIsAnswerable(prompt, now)).length;
	}
	/**
	* Sweep receipts and enforce the cap. Settled and long-expired cards go
	* first; a live question is the last thing this will ever drop, and dropping
	* one at all means MAX_APPROVAL_PROMPTS questions are already unanswered.
	*/
	function pruneApprovalPrompts(prompts, now = Date.now(), max = 20) {
		const list = (Array.isArray(prompts) ? prompts : []).filter((prompt) => {
			if (!prompt?.approvalId) return false;
			if (prompt.decidedAt && Date.parse(prompt.decidedAt) + 6e5 <= now) return false;
			if (!prompt.decision && approvalIsExpired(prompt, now)) return Date.parse(prompt.expiresAt) + SETTLED_PROMPT_TTL_MS > now;
			return true;
		});
		if (list.length <= max) return list;
		const weight = (prompt) => prompt.decision ? 0 : approvalIsExpired(prompt, now) ? 1 : 2;
		const drop = new Set([...list].sort((left, right) => weight(left) - weight(right) || String(left.receivedAt ?? "").localeCompare(String(right.receivedAt ?? ""))).slice(0, list.length - max).map((prompt) => prompt.approvalId));
		return list.filter((prompt) => !drop.has(prompt.approvalId));
	}
	/**
	* The answer, in the exact frozen shape. Returns the fields a sender hands to
	* its own transport — mesh_send params on the phone, sendRequest() in the
	* extension — so the payload and the corr cannot be assembled differently on
	* different surfaces.
	*/
	function approvalDecisionBody(prompt, decision) {
		if (!APPROVAL_DECISIONS.includes(decision)) throw new Error(`An approval decision is "approve" or "deny", not "${String(decision)}".`);
		if (!prompt?.approvalId || !prompt?.envelopeId || !prompt?.from) throw new Error("A decision needs the prompt it answers: approvalId, envelopeId and from.");
		return {
			to: prompt.from,
			kind: APPROVAL_DECISION_KIND,
			payload: {
				approvalId: prompt.approvalId,
				decision
			},
			correlationId: prompt.envelopeId
		};
	}
	//#endregion
	//#region browser-extension/src/approvals.js
	const APPROVALS_KEY = "pendingApprovals";
	/**
	* What the toolbar badge shows: the number of prompts still waiting on the
	* owner, or null to fall back to the connection badge. A count outranks 'ON'
	* because 'ON' is reassurance and a count is a request — amber, like every
	* "parked, waiting for you" state in this extension's UI.
	*/
	function approvalBadge(prompts, now = Date.now()) {
		const waiting = undecidedApprovalCount(prompts, now);
		if (!waiting) return null;
		return {
			text: String(Math.min(waiting, 99)),
			color: "#B07C1F"
		};
	}
	/**
	* Everything between "the owner pressed a button" and "background.js performs
	* a fetch", as one pure step so the whole decision path is assertable:
	*
	*   { ok: true,  request, envelopeId, prompts }   — send `request`, and only
	*     AFTER it succeeds persist `prompts` (the settled list) and ack
	*     `envelopeId`. The settle rides in the return value rather than being
	*     applied by the caller so the two can never disagree about what was
	*     decided.
	*   { ok: false, error, prompts }                 — nothing to send; `prompts`
	*     is the input unchanged, because a refused decision must leave the card
	*     exactly as pressable or as settled as it already was.
	*
	* Refusals mirror the phone's: a prompt this browser no longer holds, one
	* already answered (an approval is answered once — the double-click and the
	* stale popup land here), and one past its own deadline.
	*/
	function prepareApprovalDecision(prompts, approvalId, decision, { config, now = Date.now() } = {}) {
		const list = Array.isArray(prompts) ? prompts : [];
		const prompt = list.find((entry) => entry?.approvalId === approvalId);
		if (!prompt) return {
			ok: false,
			error: "That approval is no longer held here — it may have been pruned or answered elsewhere.",
			prompts: list
		};
		if (prompt.decision) return {
			ok: false,
			error: `Already answered: ${prompt.decision === "approve" ? "approved" : "denied"}${prompt.decidedAt ? ` at ${prompt.decidedAt}` : ""}. An approval is answered once.`,
			prompts: list
		};
		if (approvalIsExpired(prompt, now)) return {
			ok: false,
			error: "This approval expired before it was answered. Whoever asked must send a fresh one.",
			prompts: list
		};
		let request;
		try {
			request = sendRequest(config, approvalDecisionBody(prompt, decision));
		} catch (error) {
			return {
				ok: false,
				error: error?.message ?? String(error),
				prompts: list
			};
		}
		return {
			ok: true,
			request,
			envelopeId: prompt.envelopeId,
			prompts: settleApprovalPrompt(list, approvalId, decision, { now })
		};
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
	const RELAY_STATUS_KEY = "relayStatus";
	const RELAY_LEDGER_KEY = "relaySeenEnvelopes";
	const CONFIG_KEYS = [
		"agentUrl",
		"agentToken",
		"deviceName",
		"targetMode",
		"instanceId"
	];
	let activePoll = null;
	let activeRelayDrain = null;
	let configRevision = 0;
	let meshSocket = null;
	let meshSocketOpen = false;
	let meshPingTimer = null;
	let meshSocketRefused = false;
	let macLastOkAt = 0;
	const INCARNATION_NONCE = crypto.randomUUID();
	const commandLedger = createCommandLedger();
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
			nonce: INCARNATION_NONCE,
			capabilities: [
				"idempotency-ledger",
				"privacy-boundary",
				"provenance"
			],
			ledger: commandLedger.stats(),
			...tab
		});
	}
	async function pollOnce(config) {
		const response = await request(config, `/browser/poll?extensionId=${encodeURIComponent(config.extensionId)}`);
		if (response.status === 204) return false;
		if (!response.ok) throw await responseError(response);
		const command = (await response.json())?.command;
		const identity = commandIdentity(command);
		let result;
		const replayed = commandLedger.recall(identity);
		if (replayed) {
			await postResultWithRetry(config, command?.commandId, {
				...replayed.result,
				extensionId: config.extensionId,
				replayed: true
			});
			return true;
		}
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
		commandLedger.remember(identity, result);
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
				macLastOkAt = Date.now();
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
		await refreshBadge(status);
	}
	/**
	* One writer for the toolbar badge, so its two claimants cannot fight.
	*
	* Approvals waiting on the owner outrank connection state: 'ON' is
	* reassurance, a count is a request, and the poll loop repaints the badge
	* often enough that the count falls away on its own once the last card is
	* answered or expires. Everything that changes either input — a status
	* update, a drained approval, a decision — lands here.
	*/
	async function refreshBadge(status = null) {
		if (!api.action?.setBadgeText) return;
		const stored = await api.storage.local.get([STATUS_KEY, APPROVALS_KEY]);
		const current = status ?? stored[STATUS_KEY] ?? {};
		const badge = approvalBadge(stored["pendingApprovals"] ?? []) ?? {
			text: current.state === "connected" ? "ON" : current.state === "needs-setup" ? "SET" : "!",
			color: current.state === "connected" ? "#078B70" : "#B54736"
		};
		await api.action.setBadgeText({ text: badge.text });
		if (api.action.setBadgeBackgroundColor) await api.action.setBadgeBackgroundColor({ color: badge.color });
	}
	let approvalWrites = Promise.resolve();
	function withApprovals(mutate) {
		const run = approvalWrites.then(async () => {
			const next = await mutate((await api.storage.local.get("pendingApprovals"))["pendingApprovals"] ?? []);
			if (next) await api.storage.local.set({ [APPROVALS_KEY]: next });
			return next;
		});
		approvalWrites = run.then(() => {}, (error) => {
			console.warn("approval store write failed:", error?.message || error);
		});
		return run;
	}
	async function getRelayConfig() {
		return normalizeRelayConfig(await api.storage.local.get(RELAY_STORAGE_KEYS));
	}
	async function relayFetch(relayConfig, descriptor, timeoutMs = FETCH_TIMEOUT_MS) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch(`${relayConfig.relayUrl}${descriptor.path}`, {
				method: descriptor.method,
				cache: "no-store",
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${relayConfig.deviceToken}`,
					...descriptor.body ? { "Content-Type": "application/json" } : {}
				},
				...descriptor.body ? { body: JSON.stringify(descriptor.body) } : {},
				signal: controller.signal
			});
			if (!response.ok) throw await relayResponseError(response);
			return response.status === 204 ? null : await response.json();
		} finally {
			clearTimeout(timeout);
		}
	}
	function ensureMeshSocket(relayConfig, onMail) {
		if (meshSocket || meshSocketRefused) return;
		const url = socketUrl(relayConfig);
		const protocols = socketProtocols(relayConfig);
		if (!url || !protocols.length) return;
		let socket;
		try {
			socket = new WebSocket(url, protocols);
		} catch (error) {
			console.warn(`mesh socket could not be created: ${error?.message || error}`);
			return;
		}
		meshSocket = socket;
		socket.addEventListener("open", () => {
			if (!socketProtocolAccepted(socket.protocol)) {
				console.warn("mesh socket selected an unexpected subprotocol; closing.");
				try {
					socket.close();
				} catch {}
				return;
			}
			meshSocketOpen = true;
			updateRelayStatus({
				state: "connected",
				connected: true,
				transport: "socket",
				message: "The relay is pushing over its own socket.",
				lastConnectedAt: (/* @__PURE__ */ new Date()).toISOString(),
				error: ""
			});
			meshPingTimer = setInterval(() => {
				try {
					socket.send(BRIDGE_PING_FRAME);
				} catch {}
			}, BRIDGE_PING_INTERVAL_MS);
		});
		socket.addEventListener("message", (event) => {
			if (reactToFrame(event?.data).drain) onMail();
		});
		socket.addEventListener("close", (event) => {
			meshSocketOpen = false;
			meshSocket = null;
			if (meshPingTimer) {
				clearInterval(meshPingTimer);
				meshPingTimer = null;
			}
			if (event?.code === 1008 || event?.code === 4001 || event?.code === 4003) {
				meshSocketRefused = true;
				updateRelayStatus({
					state: "unauthorized",
					connected: false,
					transport: "poll",
					message: "The relay refused this browser's socket credential.",
					lastErrorAt: (/* @__PURE__ */ new Date()).toISOString()
				});
			}
		});
		socket.addEventListener("error", () => {
			meshSocketOpen = false;
		});
	}
	function closeMeshSocket() {
		if (meshPingTimer) {
			clearInterval(meshPingTimer);
			meshPingTimer = null;
		}
		if (meshSocket) try {
			meshSocket.close();
		} catch {}
		meshSocket = null;
		meshSocketOpen = false;
	}
	async function runMeshEnvelope(envelope, handling, relayConfig, macConfig) {
		if (handling === "approval") {
			if (await withApprovals((stored) => {
				const merged = mergeApprovalPrompts(stored, [envelope]);
				return merged.changed ? merged.prompts : null;
			})) await refreshBadge();
			return;
		}
		if (handling === "ping") {
			await relayFetch(relayConfig, pongMessageFor(envelope, {
				browser: browserLabel(),
				extensionVersion: api.runtime.getManifest().version,
				macFresh: Date.now() - macLastOkAt <= MAC_FRESH_MS,
				observedAt: (/* @__PURE__ */ new Date()).toISOString()
			}, relayConfig));
			return;
		}
		let outcome;
		try {
			const command = envelopeToCommand(envelope);
			const identity = commandIdentity(command);
			const replayed = commandLedger.recall(identity);
			if (replayed) outcome = {
				...replayed.result,
				replayed: true
			};
			else {
				try {
					outcome = {
						ok: true,
						result: await executeCommand(command, macConfig)
					};
				} catch (error) {
					outcome = {
						ok: false,
						error: error?.message || String(error)
					};
				}
				commandLedger.remember(identity, outcome);
			}
		} catch (error) {
			outcome = {
				ok: false,
				error: error?.message || String(error)
			};
		}
		await relayFetch(relayConfig, resultMessageFor(envelope, outcome, relayConfig));
	}
	async function drainRelayOnce(relayConfig, macConfig) {
		const page = await relayFetch(relayConfig, inboxRequest(relayConfig));
		const stored = (await api.storage.local.get(RELAY_LEDGER_KEY))[RELAY_LEDGER_KEY] ?? {};
		const accepted = acceptEnvelopes(page?.messages, {
			ledger: createEnvelopeLedger(stored),
			config: relayConfig
		});
		await api.storage.local.set({ [RELAY_LEDGER_KEY]: pruneEnvelopeLedger(accepted.ledger) });
		if (accepted.ackIds.length) await relayFetch(relayConfig, ackRequest(relayConfig, accepted.ackIds));
		for (const { envelope, handling } of accepted.run) try {
			await runMeshEnvelope(envelope, handling, relayConfig, macConfig);
		} catch (error) {
			console.warn(`mesh ${envelope.kind} from ${envelope.from} failed: ${error?.message || error}`);
		}
		return {
			drained: accepted.ackIds.length,
			ran: accepted.run.length,
			ignored: accepted.ignored.length,
			more: hasMoreMail(page),
			pending: Number(page?.pending || 0)
		};
	}
	async function drainRelayUntilEmpty(relayConfig, macConfig, maxPages = 5) {
		let report = await drainRelayOnce(relayConfig, macConfig);
		let totals = {
			...report,
			pages: 1
		};
		for (let page = 1; page < maxPages && report.more; page += 1) {
			report = await drainRelayOnce(relayConfig, macConfig);
			totals = {
				drained: totals.drained + report.drained,
				ran: totals.ran + report.ran,
				ignored: totals.ignored + report.ignored,
				more: report.more,
				pending: report.pending,
				pages: page + 1
			};
		}
		return totals;
	}
	async function relayWindow(revision) {
		const relayConfig = await getRelayConfig();
		if (!relayConfig.ready) {
			await updateRelayStatus({
				state: "off",
				connected: false,
				message: relayConfig.reason
			});
			return;
		}
		const macConfig = await getConfig();
		const deadline = Date.now() + POLL_WINDOW_MS;
		ensureMeshSocket(relayConfig, () => drainRelayUntilEmpty(relayConfig, macConfig).catch((error) => console.warn(`mesh doorbell drain failed: ${error?.message || error}`)));
		while (Date.now() < deadline && revision === configRevision) {
			const choice = choosePeer({
				macConfigured: Boolean(macConfig.agentToken),
				macLastOkAt,
				relayReady: true,
				socketOpen: meshSocketOpen
			});
			try {
				const report = await drainRelayUntilEmpty(relayConfig, macConfig);
				await updateRelayStatus({
					state: "connected",
					connected: true,
					transport: choice.relayTransport,
					message: describeRelayPeer(relayConfig, choice),
					lastConnectedAt: (/* @__PURE__ */ new Date()).toISOString(),
					error: "",
					...report
				});
			} catch (error) {
				await updateRelayStatus({
					...describeRelayFailure(error),
					connected: false,
					transport: meshSocketOpen ? "socket" : "poll",
					error: error?.message || String(error),
					lastErrorAt: (/* @__PURE__ */ new Date()).toISOString()
				});
			}
			if (Date.now() + choice.relayPollMs >= deadline) break;
			await delay(choice.relayPollMs);
		}
	}
	function startRelayDrain() {
		if (activeRelayDrain) return activeRelayDrain;
		const revision = configRevision;
		activeRelayDrain = relayWindow(revision).catch(async (error) => {
			await updateRelayStatus({
				state: "error",
				connected: false,
				message: "The relay peer stopped unexpectedly.",
				error: error?.message || String(error),
				lastErrorAt: (/* @__PURE__ */ new Date()).toISOString()
			});
		}).finally(() => {
			activeRelayDrain = null;
			if (revision !== configRevision) startRelayDrain();
		});
		return activeRelayDrain;
	}
	async function updateRelayStatus(patch) {
		const current = (await api.storage.local.get(RELAY_STATUS_KEY))[RELAY_STATUS_KEY] ?? {};
		await api.storage.local.set({ [RELAY_STATUS_KEY]: {
			...current,
			...patch,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		} });
	}
	/**
	* The owner's answer to one approval card, from the popup.
	*
	* Order is the contract: SEND the decision, THEN persist the settle, THEN ack
	* the request envelope. A decision recorded but never sent would read as
	* answered while the requester waits forever; a decision sent but not
	* recorded merely invites a duplicate answer, which the relay's approvalId
	* makes idempotent — so the settle waits for the send. The whole
	* check-send-settle runs inside the approval write chain, which is what makes
	* two frantic clicks land as one answer and one "answered once" refusal.
	*/
	async function decideApproval({ approvalId, decision }) {
		const relayConfig = await getRelayConfig();
		if (!relayConfig.ready) return {
			ok: false,
			error: relayConfig.reason || "The relay peer is switched off."
		};
		let outcome = {
			ok: false,
			error: "The decision was not sent."
		};
		try {
			await withApprovals(async (stored) => {
				const prepared = prepareApprovalDecision(stored, String(approvalId ?? ""), decision, { config: relayConfig });
				if (!prepared.ok) {
					outcome = {
						ok: false,
						error: prepared.error
					};
					return null;
				}
				await relayFetch(relayConfig, prepared.request);
				try {
					await relayFetch(relayConfig, ackRequest(relayConfig, [prepared.envelopeId]));
				} catch {}
				outcome = {
					ok: true,
					decision
				};
				return prepared.prompts;
			});
		} catch (error) {
			outcome = {
				ok: false,
				error: error?.message || String(error)
			};
		}
		await refreshBadge();
		return outcome;
	}
	/**
	* Run one command, then take everything it produced through the privacy
	* boundary and stamp it with where it came from.
	*
	* The order is the whole point. sanitizeExtraction runs after execution and
	* before the result is handed back to pollOnce, which is the last moment it is
	* still inside Safari: past here it is in a different process with a log, a
	* store and a cloud relay attached, and a credential that reaches the agent has
	* effectively left the machine.
	*/
	async function executeCommand(command, config) {
		const { type, params } = validateCommand(command);
		const { result, tab } = await runCommand(type, params, config);
		const clean = sanitizeExtraction(result);
		return {
			...clean.result,
			provenance: provenanceFor({
				command,
				tab,
				result: clean.result,
				locator: params.ref || params.selector
			})
		};
	}
	async function runCommand(type, params, config) {
		if (type === "navigate") return {
			result: await navigate(params, config),
			tab: null
		};
		if (type === "activate_tab") return {
			result: await activateTab(params, config),
			tab: null
		};
		if (type === "list_tabs") return {
			result: await listTabs(params),
			tab: null
		};
		const tab = await selectTargetTab(params, config.targetMode);
		await assertPageAccess(tab);
		if (type === "capture") return {
			result: await captureTab(tab),
			tab
		};
		if (type === "wait_for") return {
			result: await waitForInTab(tab, params),
			tab
		};
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
			result: {
				...firstResult.result,
				tabId: tab.id,
				windowId: tab.windowId,
				url: tab.url ?? "",
				title: tab.title ?? firstResult.result?.title ?? ""
			},
			tab
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
	/**
	* Find-or-open. Focuses the freshest existing tab matching `urlContains`
	* (bringing its window forward), and only when nothing matches — and a `url`
	* was given — opens a new tab. "Open ibkr" means the signed-in tab the owner
	* already has, not a duplicate and not whatever the active tab was showing.
	* Needs only the `tabs` permission (already in the manifest); windows.update
	* requires none.
	*/
	async function activateTab(params, _config) {
		const needle = String(params.urlContains ?? "").trim().toLowerCase();
		const fallbackUrl = String(params.url ?? "").trim();
		if (needle) {
			const match = (await api.tabs.query({})).filter((tab) => Number.isInteger(tab?.id) && isScriptableUrl(tab.url) && String(tab.url).toLowerCase().includes(needle)).sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
			if (match) {
				const tab = await api.tabs.update(match.id, { active: true });
				if (api.windows?.update && Number.isInteger(tab?.windowId)) await api.windows.update(tab.windowId, { focused: true }).catch(() => {});
				return {
					message: `Activated the existing tab matching "${needle}"`,
					tabId: tab.id,
					windowId: tab.windowId,
					url: tab.url ?? match.url ?? "",
					title: tab.title ?? match.title ?? "",
					activatedExisting: true
				};
			}
		}
		if (!fallbackUrl) throw new Error(`No open tab matches "${needle}" and no url was given to open instead.`);
		const url = validateNavigationUrl(fallbackUrl);
		let tab = await api.tabs.create({
			url,
			active: true
		});
		if (params.waitForLoad !== false) tab = await waitForTabLoad(tab.id, 15e3);
		return {
			message: `No matching tab was open; opened ${url}`,
			tabId: tab.id,
			windowId: tab.windowId,
			url: tab.url || url,
			activatedExisting: false
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
					fieldName: el.getAttribute?.("name") || void 0,
					autocomplete: el.getAttribute?.("autocomplete") || void 0,
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
	let historyWrites = Promise.resolve();
	function withHistory(mutate) {
		historyWrites = historyWrites.then(async () => {
			const next = mutate((await api.storage.local.get("consoleHistory"))["consoleHistory"] ?? []);
			await api.storage.local.set({ [HISTORY_KEY]: next });
		}).catch((error) => {
			console.warn("console history write failed:", error?.message || error);
		});
		return historyWrites;
	}
	const patchEntry = (id, patch) => withHistory((history) => patchHistory(history, id, patch));
	/**
	* POST one console leg to the agent and interpret the response. Unlike the
	* poll-loop `request()` this gets a long timeout: a /plan can sit in a model
	* stream for most of a minute and that is normal, not an outage.
	*/
	async function consolePost(config, path, payload, timeoutMs, interpret) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch(`${config.agentUrl}${path}`, {
				method: "POST",
				cache: "no-store",
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${config.agentToken}`,
					"Content-Type": "application/json"
				},
				body: JSON.stringify(payload),
				signal: controller.signal
			});
			const body = await response.json().catch(() => null);
			return interpret({
				status: response.status,
				payload: body
			});
		} catch (error) {
			return {
				kind: "error",
				message: error?.name === "AbortError" ? `The local agent did not answer within ${Math.round(timeoutMs / 1e3)}s. Check the dashboard — the job may still be running.` : error?.message || String(error)
			};
		} finally {
			clearTimeout(timeout);
		}
	}
	let journalInstance = null;
	function executionJournal() {
		if (!journalInstance) journalInstance = createExecutionJournal({ storage: api.storage.local });
		return journalInstance;
	}
	/**
	* Tell the hive about a locally executed run — the owner's rule: "it should
	* stay in the browser extension but of course it can record the task to the
	* hive." Sent as node-mesh mail addressed to '@relay', which the Mac agent
	* can NEVER claim: cloud-relay/nodeMailbox.js lets only an inbox's owner
	* drain it and only an admin principal owns '@relay'. A record, not a job.
	*
	* Best effort by design: an unconfigured or unreachable relay must not stop
	* local execution, but the run's own status says whether the hive heard.
	*/
	async function recordRunToHive(runId, phase) {
		const journal = executionJournal();
		const relayConfig = await getRelayConfig();
		if (!relayConfig.ready) {
			await journal.markHiveRecord(runId, "unconfigured");
			return;
		}
		const run = (await journal.getStatus()).runs.find((entry) => entry.runId === runId);
		if (!run) return;
		try {
			await relayFetch(relayConfig, phase === "claim" ? hiveClaimRecordFor(run, relayConfig) : hiveVerdictRecordFor(run, relayConfig));
			await journal.markHiveRecord(runId, phase === "claim" ? "claimed-recorded" : "recorded");
		} catch (error) {
			await journal.markHiveRecord(runId, `failed: ${error?.message || error}`);
		}
	}
	/**
	* The owner approved a parked outward step (via the popup, next pass). The
	* step runs through the same validated executor as everything else, and the
	* run's verdict is recomputed from what actually happened. resolveApproval
	* has already enforced single-use and the 10-minute freshness window.
	*/
	async function executeApprovedStep(entry) {
		const journal = executionJournal();
		const config = await getConfig();
		try {
			const result = await executeCommand({
				commandId: `approved-${entry.id}`,
				createdAt: (/* @__PURE__ */ new Date()).toISOString(),
				action: entry.call
			}, config);
			await journal.recordStep(entry.runId, {
				tool: entry.call?.type,
				effect: EFFECT_OUTWARD,
				ok: true,
				summary: `Approved by owner: ${String(result?.message ?? entry.call?.type).slice(0, 250)}`
			});
			const run = (await journal.getStatus()).runs.find((candidate) => candidate.runId === entry.runId);
			const verdict = honestVerdict({
				command: run?.command ?? "",
				steps: run?.steps ?? [],
				parked: []
			});
			await journal.finishRun(entry.runId, {
				state: "finished",
				...verdict
			});
			await recordRunToHive(entry.runId, "verdict");
			await patchEntry(entry.runId, {
				state: "executed",
				headline: verdict.headline,
				detail: verdict.detail,
				finishedAt: (/* @__PURE__ */ new Date()).toISOString()
			});
			return {
				ok: true,
				ran: true,
				message: result?.message ?? "Done."
			};
		} catch (error) {
			const message = error?.message || String(error);
			await journal.recordStep(entry.runId, {
				tool: entry.call?.type,
				effect: EFFECT_OUTWARD,
				ok: false,
				summary: message.slice(0, 300)
			});
			await journal.finishRun(entry.runId, {
				state: "failed",
				verdict: "failed",
				headline: `The approved step failed: ${message}`
			});
			await recordRunToHive(entry.runId, "verdict");
			await patchEntry(entry.runId, {
				state: "failed",
				headline: `The approved step failed: ${message}`,
				finishedAt: (/* @__PURE__ */ new Date()).toISOString()
			});
			return {
				ok: false,
				ran: true,
				error: message
			};
		}
	}
	async function handleConsoleSubmit({ command, page }) {
		const text = String(command ?? "").trim();
		if (!text) return {
			ok: false,
			error: "Type a command first."
		};
		const config = await getConfig();
		if (!config.agentToken) return {
			ok: false,
			needsSetup: true
		};
		const id = crypto.randomUUID();
		const scrubbedPage = scrubPageContext(page);
		await withHistory((history) => appendHistory(history, newHistoryEntry({
			id,
			command: text,
			page: scrubbedPage
		})));
		runConsoleCommand({
			id,
			command: text,
			page: scrubbedPage,
			config
		}).catch((error) => patchEntry(id, {
			state: "failed",
			headline: error?.message || String(error),
			finishedAt: (/* @__PURE__ */ new Date()).toISOString()
		}));
		return {
			ok: true,
			id
		};
	}
	async function runConsoleCommand({ id, command, page, config }) {
		const brainConfig = normalizeBrainConfig(await api.storage.local.get(BRAIN_STORAGE_KEYS));
		let brainNote = "";
		const route = chooseBrainRoute(brainConfig);
		if (route.route === "local-brain") {
			const journal = executionJournal();
			const guard = createOutwardGuard();
			await journal.beginRun({
				runId: id,
				command,
				route: "local-brain"
			});
			await recordRunToHive(id, "claim");
			const finished = await runBrainLoop({
				command,
				page,
				config: brainConfig,
				callModel: (messages) => brainCallModel(brainConfig, messages),
				runTool: async (call) => {
					const result = await runBrainTool(call, config);
					guard.observe(call, result);
					await journal.recordStep(id, {
						tool: call?.type,
						effect: guard.assess(call).effect,
						ok: true,
						summary: String(result?.message ?? "").slice(0, 300)
					});
					return result;
				},
				assessTool: (call) => guard.assess(call)
			});
			if (finished.status === "parked") {
				const assessed = guard.assess(finished.parkedCall ?? {});
				const parked = await journal.parkStep(id, {
					call: finished.parkedCall,
					effect: EFFECT_OUTWARD,
					reason: finished.parkedReason,
					targetName: assessed.targetName
				});
				const verdict = honestVerdict({
					command,
					steps: (await journal.getStatus()).runs.find((run) => run.runId === id)?.steps ?? [],
					parked: [parked]
				});
				await journal.finishRun(id, {
					state: "parked",
					...verdict
				});
				await recordRunToHive(id, "verdict");
				await patchEntry(id, {
					state: "parked",
					headline: verdict.headline,
					detail: [
						`Waiting in this browser's approval queue (${parked.id}).`,
						verdict.detail,
						"Approval UI lands with the next popup pass."
					].join("\n"),
					finishedAt: (/* @__PURE__ */ new Date()).toISOString()
				});
				return;
			}
			if (finished.status === "done") {
				if (brainConfig.brainRetryAfterAt) await api.storage.local.remove("brainRetryAfterAt").catch(() => {});
				const verdict = honestVerdict({
					command,
					steps: (await journal.getStatus()).runs.find((run) => run.runId === id)?.steps ?? [],
					parked: [],
					response: finished.response
				});
				await journal.finishRun(id, {
					state: "finished",
					...verdict
				});
				await recordRunToHive(id, "verdict");
				await patchEntry(id, {
					state: verdict.verdict === "incomplete" ? "failed" : "answered",
					headline: verdict.headline,
					detail: [summarizeBrainRun(finished), verdict.detail].filter(Boolean).join("\n"),
					finishedAt: (/* @__PURE__ */ new Date()).toISOString()
				});
				return;
			}
			brainNote = summarizeBrainRun(finished);
			await journal.finishRun(id, {
				state: "handed-off",
				verdict: "handoff",
				headline: brainNote
			});
			await recordRunToHive(id, "verdict");
		} else if (route.cooldownMs) brainNote = `Brain skipped — ${route.reason}`;
		const commandText = buildCommandText(command, page);
		const stored = await api.storage.local.get(SESSION_KEY);
		const sessionId = String(stored["consoleSessionId"] ?? "").trim();
		const planOutcome = await consolePost(config, "/plan", {
			command: commandText,
			...sessionId ? { sessionId } : {},
			source: CONSOLE_SOURCE
		}, PLAN_TIMEOUT_MS, interpretPlanResponse);
		if (planOutcome.sessionId) await api.storage.local.set({ [SESSION_KEY]: planOutcome.sessionId });
		if (planOutcome.kind !== "execute") {
			const patch = outcomeToPatch(planOutcome);
			if (brainNote) patch.detail = [brainNote, patch.detail].filter(Boolean).join("\n");
			await patchEntry(id, patch);
			return;
		}
		const affinity = routePlan(planOutcome.actions);
		if (affinity.route === "browser") {
			await patchEntry(id, { headline: "Plan is all browser work — running it in this browser…" });
			await executePlanLocally({
				id,
				command,
				steps: affinity.steps,
				config,
				brainNote
			});
			return;
		}
		await patchEntry(id, { headline: "Plan ready — executing…" });
		await patchEntry(id, outcomeToPatch(await consolePost(config, "/execute", {
			command: commandText,
			actions: planOutcome.actions,
			...planOutcome.sessionId ? { sessionId: planOutcome.sessionId } : {},
			planMeta: {
				planner: planOutcome.planner ?? null,
				source: CONSOLE_SOURCE
			},
			source: CONSOLE_SOURCE
		}, EXECUTE_TIMEOUT_MS, interpretExecuteResponse)));
	}
	/**
	* Execute a fully browser-capable plan on this node.
	*
	* Steps run in order through the SAME validateCommand → runCommand →
	* sanitizeExtraction path every agent-issued command takes — a locally
	* claimed plan gets no shortcut past the privacy boundary. An outward step
	* stops the run and parks in the approval queue; a failed step stops the run
	* honestly rather than pressing on into a page in an unknown state.
	*/
	async function executePlanLocally({ id, command, steps, config, brainNote = "" }) {
		const journal = executionJournal();
		await journal.beginRun({
			runId: id,
			command,
			route: "local-plan"
		});
		await recordRunToHive(id, "claim");
		const parked = [];
		for (const step of steps) {
			if (step.effect === "outward") {
				const remaining = steps.length - step.index - 1;
				parked.push(await journal.parkStep(id, {
					call: step.localCall,
					effect: step.effect,
					reason: step.effectReason + (remaining ? ` (${remaining} later plan step(s) will not run either way — re-run the command after deciding.)` : ""),
					targetName: step.label
				}));
				break;
			}
			try {
				const result = await executeCommand({
					commandId: `local-${id}-${step.index}`,
					createdAt: (/* @__PURE__ */ new Date()).toISOString(),
					action: step.localCall
				}, config);
				await journal.recordStep(id, {
					tool: step.localCall.type,
					effect: step.effect,
					ok: true,
					summary: String(result?.message ?? step.label).slice(0, 300)
				});
			} catch (error) {
				const message = error?.message || String(error);
				await journal.recordStep(id, {
					tool: step.localCall.type,
					effect: step.effect,
					ok: false,
					summary: message.slice(0, 300)
				});
				const verdict = honestVerdict({
					command,
					steps: (await journal.getStatus()).runs.find((run) => run.runId === id)?.steps ?? [],
					parked: []
				});
				await journal.finishRun(id, {
					state: "failed",
					verdict: "failed",
					headline: `Stopped at step ${step.index + 1} (${step.label}): ${message}`,
					detail: verdict.detail
				});
				await recordRunToHive(id, "verdict");
				await patchEntry(id, {
					state: "failed",
					headline: `Stopped at step ${step.index + 1} (${step.label}): ${message}`,
					detail: [brainNote, verdict.detail].filter(Boolean).join("\n"),
					finishedAt: (/* @__PURE__ */ new Date()).toISOString()
				});
				return;
			}
		}
		const verdict = honestVerdict({
			command,
			steps: (await journal.getStatus()).runs.find((run) => run.runId === id)?.steps ?? [],
			parked
		});
		await journal.finishRun(id, {
			state: parked.length ? "parked" : "finished",
			...verdict
		});
		await recordRunToHive(id, "verdict");
		await patchEntry(id, {
			state: parked.length ? "parked" : verdict.verdict === "incomplete" ? "failed" : "executed",
			headline: verdict.headline,
			detail: [
				brainNote,
				`Ran in this browser (affinity: all steps browser-capable).`,
				verdict.detail,
				...parked.length ? [`Waiting in this browser's approval queue (${parked[0].id}).`, "Approval UI lands with the next popup pass."] : []
			].filter(Boolean).join("\n"),
			finishedAt: (/* @__PURE__ */ new Date()).toISOString()
		});
	}
	/**
	* The brain's model call: POST /v1/infer on the relay
	* (cloud-relay/nodeInference.js). Not reached until the owner configures a
	* browser_node credential — see the header of src/brain.js. No key material
	* lives here; the upstream provider key never leaves the relay.
	*
	* Deliberately absent from the body: `deviceId`, which the relay takes from
	* the credential and ignores here, and `model`, which is allow-listed
	* server-side — naming one outside the list is a 400 rather than a silent
	* substitution, and this loop has no reason to name one at all.
	*/
	function brainCallModel(brainConfig, messages) {
		return callModelWithHeadroom((maxTokens) => postInference(brainConfig, messages, maxTokens));
	}
	async function postInference(brainConfig, messages, maxTokens) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 65e3);
		let payload;
		try {
			const response = await fetch(brainConfig.modelProxyUrl, {
				method: "POST",
				cache: "no-store",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
					Authorization: `Bearer ${brainConfig.deviceToken}`
				},
				body: JSON.stringify({
					messages,
					maxTokens,
					responseFormat: "json_object"
				}),
				signal: controller.signal
			});
			payload = await response.json().catch(() => null);
			if (!response.ok) {
				const verdict = interpretInferError({
					status: response.status,
					payload
				});
				if (verdict.retryAt) await api.storage.local.set({ brainRetryAfterAt: verdict.retryAt }).catch(() => {});
				const error = new Error(verdict.message);
				error.code = verdict.code;
				error.fatal = verdict.fatal;
				throw error;
			}
			if (payload?.budget && payload.budget.enforced === false) console.warn("relay inference budget is advisory: no durable counter was reachable.");
		} finally {
			clearTimeout(timeout);
		}
		if (payload?.truncated) console.warn(`relay inference was cut off at ${maxTokens} tokens (finishReason: ${payload?.finishReason ?? "unknown"}).`);
		return {
			content: String(payload?.content ?? ""),
			truncated: payload?.truncated === true,
			complete: payload?.complete ?? null,
			refusal: payload?.refusal ?? null,
			finishReason: payload?.finishReason ?? null
		};
	}
	/**
	* The brain's tools ARE the extension's own 11 page commands, run through the
	* same validation and the same privacy boundary as agent-issued commands —
	* a locally minted command gets no shortcut past sanitizeExtraction.
	*/
	async function runBrainTool(call, config) {
		const { type, params } = validateCommand({
			commandId: `brain-${crypto.randomUUID()}`,
			createdAt: (/* @__PURE__ */ new Date()).toISOString(),
			action: {
				type: call?.type,
				params: call?.params ?? {}
			}
		});
		const { result } = await runCommand(type, params, config);
		return sanitizeExtraction(result).result;
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
	function startPeers() {
		startPolling();
		startRelayDrain();
	}
	api.runtime.onInstalled.addListener(async ({ reason }) => {
		await migrateSyncedCredentials();
		await api.alarms.create(POLL_ALARM, { periodInMinutes: .5 });
		if (reason === "install") await api.runtime.openOptionsPage();
		startPeers();
	});
	api.runtime.onStartup.addListener(async () => {
		await migrateSyncedCredentials();
		await api.alarms.create(POLL_ALARM, { periodInMinutes: .5 });
		startPeers();
	});
	api.alarms.onAlarm.addListener((alarm) => {
		if (alarm.name === POLL_ALARM) startPeers();
	});
	api.storage.onChanged.addListener((changes, areaName) => {
		if (areaName !== "local") return;
		if ([
			"agentUrl",
			"agentToken",
			"deviceName",
			"targetMode"
		].some((key) => changes[key])) {
			configRevision += 1;
			startPolling();
		}
		if (RELAY_STORAGE_KEYS.some((key) => changes[key])) {
			configRevision += 1;
			meshSocketRefused = false;
			closeMeshSocket();
			startRelayDrain();
		}
	});
	api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
		if (message?.type === "bridge:poll-now") {
			startPolling().then(() => sendResponse({ ok: true }));
			startRelayDrain();
			return true;
		}
		if (message?.type === "bridge:get-status") {
			api.storage.local.get(STATUS_KEY).then((values) => sendResponse(values[STATUS_KEY] ?? null));
			return true;
		}
		if (message?.type === "peers:get-status") {
			Promise.all([
				api.storage.local.get([STATUS_KEY, RELAY_STATUS_KEY]),
				getRelayConfig(),
				getConfig()
			]).then(([values, relayConfig, macConfig]) => sendResponse({
				mac: values[STATUS_KEY] ?? null,
				relay: values[RELAY_STATUS_KEY] ?? null,
				choice: choosePeer({
					macConfigured: Boolean(macConfig.agentToken),
					macLastOkAt,
					relayReady: relayConfig.ready,
					socketOpen: meshSocketOpen
				})
			})).catch((error) => sendResponse({ error: error?.message || String(error) }));
			return true;
		}
		if (message?.type === "relay:drain-now") {
			startRelayDrain().then(() => sendResponse({ ok: true }));
			return true;
		}
		if (message?.type === "approval:decide") {
			decideApproval(message).then(sendResponse).catch((error) => sendResponse({
				ok: false,
				error: error?.message || String(error)
			}));
			return true;
		}
		if (message?.type === APPROVAL_MESSAGE_TYPES.status) {
			executionJournal().getStatus().then(sendResponse).catch((error) => sendResponse({ error: error?.message || String(error) }));
			return true;
		}
		if (message?.type === APPROVAL_MESSAGE_TYPES.listPending) {
			executionJournal().listPendingApprovals().then(sendResponse).catch((error) => sendResponse({ error: error?.message || String(error) }));
			return true;
		}
		if (message?.type === APPROVAL_MESSAGE_TYPES.resolve) {
			executionJournal().resolveApproval(String(message.id ?? ""), message.verdict).then(async (entry) => {
				if (!entry) return {
					ok: false,
					error: "No such pending approval."
				};
				if (entry.state === "expired") {
					await executionJournal().finishRun(entry.runId, {
						state: "expired",
						verdict: "parked",
						headline: "The parked step expired before it was approved. Nothing was submitted, cancelled or sent."
					});
					await recordRunToHive(entry.runId, "verdict");
					return {
						ok: false,
						error: "That approval expired (steps stay approvable for 10 minutes). Re-run the command."
					};
				}
				if (entry.state === "declined") {
					await executionJournal().finishRun(entry.runId, {
						state: "declined",
						verdict: "parked",
						headline: "You declined the parked step. Nothing was submitted, cancelled or sent."
					});
					await recordRunToHive(entry.runId, "verdict");
					await patchEntry(entry.runId, {
						state: "refused",
						headline: "Declined — the irreversible step was not run.",
						finishedAt: (/* @__PURE__ */ new Date()).toISOString()
					});
					return {
						ok: true,
						ran: false
					};
				}
				return executeApprovedStep(entry);
			}).then(sendResponse).catch((error) => sendResponse({
				ok: false,
				error: error?.message || String(error)
			}));
			return true;
		}
		if (message?.type === "console:submit") {
			handleConsoleSubmit(message).then(sendResponse).catch((error) => sendResponse({
				ok: false,
				error: error?.message || String(error)
			}));
			return true;
		}
		return false;
	});
	migrateSyncedCredentials().then(() => api.alarms.create(POLL_ALARM, { periodInMinutes: .5 })).then(() => startPeers());
	//#endregion
})();
