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
	//#region src/command-console.js
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
	//#region src/brain.js
	const BRAIN_STORAGE_KEYS = [
		"brainEnabled",
		"modelProxyUrl",
		"deviceToken"
	];
	Object.freeze({
		brainEnabled: false,
		modelProxyUrl: null,
		deviceToken: null
	});
	const MAX_FAILURES = 2;
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
	function normalizeBrainConfig(values = {}) {
		const brainEnabled = values.brainEnabled === true;
		const modelProxyUrl = validProxyUrl(values.modelProxyUrl);
		const deviceToken = String(values.deviceToken ?? "").trim() || null;
		let reason = "";
		if (!brainEnabled) reason = "The local brain is switched off (brainEnabled is not true).";
		else if (!modelProxyUrl) reason = "No usable modelProxyUrl is configured — the relay-side model proxy has not been set up yet.";
		else if (!deviceToken) reason = "No deviceToken is configured — scoped device tokens land with the relay proxy task.";
		return {
			brainEnabled,
			modelProxyUrl,
			deviceToken,
			ready: brainEnabled && Boolean(modelProxyUrl) && Boolean(deviceToken),
			reason
		};
	}
	/**
	* Where a command should go. 'mac-planner' is the answer until the credential
	* task lands; the caller treats anything but 'local-brain' as the Mac path.
	*/
	function chooseBrainRoute(config) {
		const normalized = config && "ready" in config ? config : normalizeBrainConfig(config);
		return normalized.ready ? {
			route: "local-brain",
			reason: "Brain configuration is complete."
		} : {
			route: "mac-planner",
			reason: normalized.reason
		};
	}
	const BROWSER_TOOLS = Object.freeze([
		{
			name: "navigate",
			description: "Open an http(s) URL in a tab.",
			params: "url, newTab?"
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
			startedAt: new Date(now).toISOString()
		};
	}
	const TERMINAL = new Set(["done", "handoff"]);
	/**
	* The reducer. Every transition the loop can make is here, pure, so the whole
	* lifecycle is testable without a model, a browser, or a network.
	*
	* Events:
	*   {type:'model_reply', text}          — while thinking
	*   {type:'model_error', error}         — while thinking
	*   {type:'tool_result', ok, result?, error?} — while acting
	*   {type:'hand_off', reason}           — from anywhere
	*/
	function reduceBrain(state, event) {
		if (!state || TERMINAL.has(state.status)) return state;
		if (event?.type === "hand_off") return {
			...state,
			status: "handoff",
			pendingCall: null,
			handoffReason: event.reason || "Handed off to the Mac planner."
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
	*/
	function buildBrainMessages(state) {
		const tools = BROWSER_TOOLS.map((tool) => `- ${tool.name}(${tool.params}): ${tool.description}`).join("\n");
		const transcript = state.steps.map((step, index) => {
			const outcome = step.ok ? JSON.stringify(step.result)?.slice(0, 2e3) : `ERROR: ${step.error}`;
			return `${index + 1}. ${step.tool}(${JSON.stringify(step.params)}) → ${outcome}`;
		}).join("\n");
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
	function summarizeBrainRun(state) {
		if (state.status === "done") return `Brain answered after ${state.stepCount} tool call(s).`;
		if (state.status === "handoff") return `Brain handed off to the Mac planner: ${state.handoffReason}`;
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
	*        runs one of the 11 page commands through the extension's own
	*        validated executor and returns its sanitized result.
	*/
	async function runBrainLoop({ command, page = null, config, callModel, runTool }) {
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
				error: error?.message || String(error)
			});
		}
		else if (state.status === "acting") try {
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
		else break;
		if (!TERMINAL.has(state.status)) state = reduceBrain(state, {
			type: "hand_off",
			reason: "The loop ran out of turns without finishing."
		});
		return state;
	}
	//#endregion
	//#region src/background.js
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
		if (chooseBrainRoute(brainConfig).route === "local-brain") {
			const finished = await runBrainLoop({
				command,
				page,
				config: brainConfig,
				callModel: (messages) => brainCallModel(brainConfig, messages),
				runTool: (call) => runBrainTool(call, config)
			});
			if (finished.status === "done") {
				await patchEntry(id, {
					state: "answered",
					headline: finished.response || "Done.",
					detail: summarizeBrainRun(finished),
					finishedAt: (/* @__PURE__ */ new Date()).toISOString()
				});
				return;
			}
			brainNote = summarizeBrainRun(finished);
		}
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
	* The brain's model call. Never reached today: runBrainLoop refuses to run
	* without a ready config, and no ready config can exist until the relay-side
	* model proxy and scoped device tokens land. No key material lives here.
	*/
	async function brainCallModel(brainConfig, messages) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 6e4);
		try {
			const response = await fetch(brainConfig.modelProxyUrl, {
				method: "POST",
				cache: "no-store",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${brainConfig.deviceToken}`
				},
				body: JSON.stringify({ messages }),
				signal: controller.signal
			});
			if (!response.ok) throw await responseError(response);
			const payload = await response.json();
			return String(payload?.reply ?? payload?.content ?? payload?.text ?? "");
		} finally {
			clearTimeout(timeout);
		}
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
		if (message?.type === "console:submit") {
			handleConsoleSubmit(message).then(sendResponse).catch((error) => sendResponse({
				ok: false,
				error: error?.message || String(error)
			}));
			return true;
		}
		return false;
	});
	migrateSyncedCredentials().then(() => api.alarms.create(POLL_ALARM, { periodInMinutes: .5 })).then(() => startPolling());
	//#endregion
})();
