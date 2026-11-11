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
	const HIVE_CONTROL_PARAMS = Object.freeze([
		"session",
		"sessionId",
		"browserSession",
		"sessionName",
		"bootstrapUrl"
	]);
	const NUMERIC_PARAMS = Object.freeze(["tabId", "windowId"]);
	/**
	* Make a hive-issued action's params runnable HERE.
	*
	* THE FAILURE THIS EXISTS FOR, observed live on 2026-08-09. The owner asked
	* the popup "what are the most worth watching movies here" on the United
	* onboard portal. The Mac planner returned:
	*
	*   {type:"browser_read_page", params:{mode:"main_text", maxChars:12000, tabId:"optional"}}
	*
	* — it had copied the word "optional" out of its own tool schema, where
	* `tabId: 'optional'` is a DESCRIPTION that reads exactly like a value. The
	* whole plan was browser work, so affinity claimed it and ran it here, where
	* validateCommand correctly refused: "tabId must be a non-negative integer."
	* The run died at step 2.
	*
	* On the MAC that same plan works, because it never reaches the executor
	* unfiltered: browserSessions.toWireParams strips the control params and does
	* `Number(tabId)`, deleting anything that is not an integer. So the identical
	* plan succeeded there and failed here — and "runs on the Mac, dies in the
	* browser" is the one difference local execution must never introduce.
	*
	* This is that filter, on this side of the bridge. It only ever REMOVES what
	* cannot be honoured; nothing is invented, and a param this extension does
	* understand is passed through untouched.
	*/
	function normalizeCommandParams(params) {
		if (!params || typeof params !== "object" || Array.isArray(params)) return {};
		const clean = { ...params };
		for (const key of HIVE_CONTROL_PARAMS) delete clean[key];
		for (const key of NUMERIC_PARAMS) {
			if (clean[key] === void 0) continue;
			const value = Number(clean[key]);
			if (Number.isInteger(value) && value >= 0) clean[key] = value;
			else delete clean[key];
		}
		return clean;
	}
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
	const TEXT_ENCODER = new TextEncoder();
	function byteLengthOf(value) {
		const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
		return TEXT_ENCODER.encode(text).length;
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
		"https://ai-pendant-relay.evan20050827.workers.dev",
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
	* the wire contract has four parts that drift independently: the human
	* message (`error` or `message`), the machine name (`code` — e.g. the
	* ownership 403's `not_your_inbox` since relay 41dbc4b), the HTTP status, and
	* `retryAfter`. describeRelayFailure keys on status first and uses code only to
	* sharpen, so this must carry all of them — dropping `code` at this seam once
	* left the not_your_inbox branch unreachable from live traffic.
	*
	* `retryAfter` is DEVICE-SCOPED and the relay documents it as a contract
	* (cloud-relay/nodeInference.js): its presence means "this device should not
	* ask this relay again before then", never "this request was unlucky". brain.js
	* parks on the field rather than on a list of status codes, so a reason the
	* relay adds later is honoured with no change here — which only works if the
	* field survives this seam. It is read from the body first and the standard
	* header second, because a proxy can strip a header and the body is ours.
	*/
	async function relayResponseError(response) {
		let detail = "";
		let code = "";
		let retryAfter = 0;
		try {
			const payload = await response.json();
			detail = payload.error || payload.message || "";
			code = typeof payload.code === "string" ? payload.code : "";
			retryAfter = Number(payload.retryAfter) || 0;
		} catch {
			detail = await response.text().catch(() => "");
		}
		if (!retryAfter) retryAfter = Number(response.headers?.get?.("Retry-After")) || 0;
		const error = new Error(detail || `The relay returned HTTP ${response.status}.`);
		error.status = response.status;
		if (code) error.code = code;
		if (retryAfter > 0) error.retryAfter = retryAfter;
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
	//#region browser-extension/src/pairing.js
	const PAIR_LIFETIMES = Object.freeze([
		"session",
		"7d",
		"30d",
		"forever"
	]);
	const DEFAULT_PAIR_LIFETIME = "forever";
	const LIFETIME_TTL_MS = Object.freeze({
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
	/** Relay-side TTL for a lifetime; null means "mint with no expiry". */
	function lifetimeTtlMs(lifetime) {
		return LIFETIME_TTL_MS[normalizePairLifetime(lifetime)] ?? null;
	}
	/**
	* Reply → storage patch. Keys are the live contract: `agentToken` restarts
	* the Mac poll loop, the RELAY_STORAGE_KEYS quartet restarts the mesh socket
	* (background.js watches both). relayEnabled flips true ONLY when a token
	* actually arrived — flipping it on a failed relay leg would aim the drain
	* loop at a relay this browser cannot authenticate to, and the error state
	* that follows looks like a bug rather than an unfinished setup.
	*/
	function pairStoragePatch(payload, { agentUrl, lifetime, now = Date.now() } = {}) {
		if (!payload?.ok || !payload.agentToken) return {
			ok: false,
			error: String(payload?.error ?? "Pairing failed: the agent returned no token.")
		};
		const chosen = normalizePairLifetime(lifetime);
		const ttl = lifetimeTtlMs(chosen);
		const values = {
			...agentUrl ? { agentUrl } : {},
			agentToken: String(payload.agentToken),
			pairLifetime: chosen,
			pairExpiresAt: ttl ? new Date(now + ttl).toISOString() : null
		};
		if (payload.relay?.deviceToken) {
			values.relayEnabled = true;
			values.relayUrl = String(payload.relay.url ?? "");
			values.relayDeviceId = String(payload.relay.deviceId ?? "");
			values.deviceToken = String(payload.relay.deviceToken);
			return {
				ok: true,
				values,
				note: `Paired. This browser is ${values.relayDeviceId} on the relay — the brain is on.`
			};
		}
		return {
			ok: true,
			values,
			note: `Mac agent paired. Relay half failed: ${String(payload.relayError ?? "no credential returned")} — commands will use the Mac until you pair again.`
		};
	}
	const PAIR_OUTCOME_KEY = "pairOutcome";
	function pairOutcomeRecord(outcome, now = Date.now()) {
		return outcome?.ok ? {
			ok: true,
			note: String(outcome.note ?? "Paired."),
			at: now
		} : {
			ok: false,
			error: String(outcome?.error ?? "Pairing failed."),
			at: now
		};
	}
	const PAIR_WIPE_KEYS = Object.freeze([
		"agentToken",
		"deviceToken",
		"relayEnabled",
		"pairLifetime",
		"pairExpiresAt"
	]);
	function credentialExpiryCheck({ agentToken, pairLifetime, pairExpiresAt, sessionAlive, now = Date.now() } = {}) {
		if (!agentToken) return { wipe: false };
		const lifetime = normalizePairLifetime(pairLifetime);
		if (lifetime === "session" && !sessionAlive) return {
			wipe: true,
			reason: "This pairing was for the browser session only, and the browser has been closed since."
		};
		const expiresAt = Date.parse(pairExpiresAt ?? "");
		if (Number.isFinite(expiresAt) && expiresAt <= now) return {
			wipe: true,
			reason: `The ${lifetime === "7d" ? "7-day" : lifetime === "30d" ? "30-day" : "timed"} pairing has expired.`
		};
		return { wipe: false };
	}
	function shouldEscrow(lifetime) {
		return normalizePairLifetime(lifetime) !== "session";
	}
	function escrowRestorePlan(values, now = Date.now()) {
		if (!values || typeof values !== "object" || !values.agentToken) return {
			restore: false,
			reason: "nothing escrowed"
		};
		if (normalizePairLifetime(values.pairLifetime) === "session") return {
			restore: false,
			reason: "session-only pairings are never restored"
		};
		const verdict = credentialExpiryCheck({
			agentToken: values.agentToken,
			pairLifetime: values.pairLifetime,
			pairExpiresAt: values.pairExpiresAt,
			sessionAlive: false,
			now
		});
		if (verdict.wipe) return {
			restore: false,
			reason: verdict.reason
		};
		return {
			restore: true,
			values
		};
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
	//#region browser-extension/src/executor.js
	const api$2 = globalThis.browser ?? globalThis.chrome;
	const FETCH_TIMEOUT_MS = 7e3;
	const BACKGROUND_POLL_INTERVAL_MS = 5e3;
	const HEARTBEAT_INTERVAL_MS = 12e3;
	const STATUS_KEY = "bridgeStatus";
	const RELAY_STATUS_KEY = "relayStatus";
	const CONFIG_KEYS = [
		"agentUrl",
		"agentToken",
		"deviceName",
		"targetMode",
		"instanceId"
	];
	async function getConfig() {
		const values = await api$2.storage.local.get(CONFIG_KEYS);
		const config = normalizeConfig(values);
		if (!values.instanceId) {
			values.instanceId = crypto.randomUUID();
			await api$2.storage.local.set({ instanceId: values.instanceId });
		}
		return {
			...config,
			instanceId: values.instanceId,
			extensionId: `ai-pendant-${api$2.runtime.id}-${values.instanceId}`
		};
	}
	async function request(config, path, options = {}) {
		return fetch(`${config.agentUrl}${path}`, {
			...options,
			cache: "no-store",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${config.agentToken}`,
				...options.body ? { "Content-Type": "application/json" } : {},
				...options.headers
			},
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
		});
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
		const [tab] = await api$2.tabs.query({
			active: true,
			lastFocusedWindow: true
		});
		const scriptable = (await api$2.tabs.query({}).catch(() => [])).filter((t) => isScriptableUrl(t?.url));
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
	/**
	* One heartbeat, from whichever engine is alive. The IDENTITY comes from
	* config (stored instanceId → stable extensionId) so the fleet map lights up
	* the same node either way; the INCARNATION comes from the caller (nonce +
	* ledger), because "which evaluation of which context is holding the lease"
	* is exactly what the agent uses the nonce to tell apart.
	*/
	async function heartbeat(config, { nonce, ledger }) {
		const tab = await currentTabSummary();
		await postJson(config, "/browser/heartbeat", {
			extensionId: config.extensionId,
			deviceName: config.deviceName || platformLabel(),
			browserName: browserLabel(),
			extensionVersion: api$2.runtime.getManifest().version,
			userAgent: globalThis.navigator?.userAgent ?? "",
			nonce,
			capabilities: [
				"idempotency-ledger",
				"privacy-boundary",
				"provenance"
			],
			ledger: ledger.stats(),
			...tab
		});
	}
	async function pollOnce(config, { ledger }) {
		const response = await request(config, `/browser/poll?extensionId=${encodeURIComponent(config.extensionId)}`);
		if (response.status === 204) return false;
		if (!response.ok) throw await responseError(response);
		const command = (await response.json())?.command;
		const identity = commandIdentity(command);
		let result;
		const replayed = ledger.recall(identity);
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
		ledger.remember(identity, result);
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
	/**
	* One writer for bridgeStatus, shared by both engines. `engine` says which
	* one wrote it — 'background' unless the patch claims otherwise — so a stale
	* page-engine stamp cannot outlive the background taking back over.
	*/
	async function updateStatus(patch) {
		const status = {
			...(await api$2.storage.local.get("bridgeStatus"))["bridgeStatus"] ?? {},
			...patch,
			engine: patch.engine ?? "background",
			extensionId: api$2.runtime.id,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		await api$2.storage.local.set({ [STATUS_KEY]: status });
		await refreshBadge(status);
	}
	async function updateRelayStatus(patch) {
		const current = (await api$2.storage.local.get("relayStatus"))["relayStatus"] ?? {};
		await api$2.storage.local.set({ [RELAY_STATUS_KEY]: {
			...current,
			...patch,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		} });
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
		if (!api$2.action?.setBadgeText) return;
		const stored = await api$2.storage.local.get([STATUS_KEY, APPROVALS_KEY]);
		const current = status ?? stored["bridgeStatus"] ?? {};
		const badge = approvalBadge(stored["pendingApprovals"] ?? []) ?? {
			text: current.state === "connected" ? "ON" : current.state === "needs-setup" ? "SET" : "!",
			color: current.state === "connected" ? "#078B70" : "#B54736"
		};
		await api$2.action.setBadgeText({ text: badge.text });
		if (api$2.action.setBadgeBackgroundColor) await api$2.action.setBadgeBackgroundColor({ color: badge.color });
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
		const { type, params } = validateCommand({
			...command,
			action: {
				...command?.action,
				params: normalizeCommandParams(command?.action?.params)
			}
		});
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
		const firstResult = (await api$2.scripting.executeScript({
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
			if ((await api$2.scripting.executeScript({
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
		const rows = (await api$2.tabs.query({})).filter((tab) => isScriptableUrl(tab?.url)).sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0)).slice(0, max).map((tab) => ({
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
			await api$2.tabs.update(tab.id, { active: true });
			await delay(150);
		}
		const dataUrl = await api$2.tabs.captureVisibleTab(windowId, { format: "png" });
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
		if (openNewTab) tab = await api$2.tabs.create({
			url,
			active: params.active !== false,
			...Number.isInteger(params.windowId) ? { windowId: params.windowId } : {}
		});
		else {
			tab = await selectTargetTab(params, config.targetMode);
			tab = await api$2.tabs.update(tab.id, {
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
			const match = (await api$2.tabs.query({})).filter((tab) => Number.isInteger(tab?.id) && isScriptableUrl(tab.url) && String(tab.url).toLowerCase().includes(needle)).sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
			if (match) {
				const tab = await api$2.tabs.update(match.id, { active: true });
				if (api$2.windows?.update && Number.isInteger(tab?.windowId)) await api$2.windows.update(tab.windowId, { focused: true }).catch(() => {});
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
		let tab = await api$2.tabs.create({
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
		if (Number.isInteger(params.tabId)) return api$2.tabs.get(params.tabId);
		let tabs;
		if (Number.isInteger(params.windowId)) tabs = await api$2.tabs.query({ windowId: params.windowId });
		else if (params.urlContains) tabs = await api$2.tabs.query({});
		else if (targetMode === "current-active") tabs = await api$2.tabs.query({
			active: true,
			currentWindow: true
		});
		else tabs = await api$2.tabs.query({ active: true });
		const tab = pickTargetTab(tabs, params, targetMode);
		if (tab) return tab;
		throw new Error("No matching browser tab is available. Open a web page or specify a valid tabId.");
	}
	async function assertPageAccess(tab) {
		if (!tab?.id || !isScriptableUrl(tab.url)) throw new Error("This page cannot be controlled. Browser settings, extension pages, and local files are protected.");
		const pattern = originPattern(tab.url);
		if (!await api$2.permissions.contains({ origins: [pattern] })) throw new Error(`Website access is not granted for ${new URL(tab.url).origin}. Click “Allow this browser’s pages” in the extension popup.`);
	}
	function waitForTabLoad(tabId, timeoutMs) {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(async () => {
				cleanup();
				try {
					resolve(await api$2.tabs.get(tabId));
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
				api$2.tabs.onUpdated.removeListener(onUpdated);
				api$2.tabs.onRemoved.removeListener(onRemoved);
			};
			api$2.tabs.onUpdated.addListener(onUpdated);
			api$2.tabs.onRemoved.addListener(onRemoved);
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
			if (!el.checkVisibility({
				opacityProperty: true,
				visibilityProperty: true,
				contentVisibilityAuto: true
			})) return false;
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
	const clip$1 = (value, max) => {
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
			url: clip$1(withholdSecrets(url, {
				...PRIVACY_RULES,
				secretLabelPatterns: []
			}).text, 400),
			title: truncateTitle(page?.title ?? "", 120)
		};
	}
	/**
	* What goes in the /plan `command` field.
	*
	* THE TRAILER IS STILL HERE ON PURPOSE, even though /plan now takes a
	* first-class `context` (see commandContext below and local-agent/
	* callerContext.js). It is the only channel an agent older than that field has,
	* and an extension that dropped it would go silent about the page against every
	* such agent — a regression paid by the owner, to tidy a wire format.
	*
	* A current agent strips it: receiving `context` means it has the page
	* properly, so the redundant copy comes off the command before anything reads
	* that command as a sentence. Belt and braces, and the braces cost nothing.
	*/
	function buildCommandText(command, page = null) {
		const text = clip$1(command, MAX_COMMAND_CHARS);
		if (!page) return text;
		return `${text}\n\n[Sent from the browser extension. Active page: ${page.title ? `"${page.title}" — ${page.url}` : page.url}]`;
	}
	/**
	* The same page as a first-class `context` field, which is where an agent that
	* understands it will read it from.
	*
	* Why this beats the trailer, from one live command on 2026-08-09: as text, the
	* page became part of the owner's sentence. goalVerdict reads that sentence to
	* decide whether the run did what was asked, took the words after "cancel",
	* stopped at the first full stop — which "…browser extension." supplied — and
	* told the owner "Cancelling all your recurring investments on ibkr [Sent is
	* still to do." Every display that titles a job with its command showed the
	* provenance instead of the ask, too.
	*/
	function commandContext(page = null) {
		if (!page?.url) return null;
		return {
			surface: CONSOLE_SOURCE,
			page: {
				url: page.url,
				...page.title ? { title: page.title } : {}
			}
		};
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
			message: payload.error || "The local agent rejected the token. Pair again from the popup.",
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
				actions,
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
			return clip$1(`${result?.ok ? "✓" : "✗"} ${label}${text ? ` — ${text}` : ""}`, 300);
		});
	}
	function describePlanSteps(actions, preview) {
		const lines = actions.slice(0, 6).map((action, index) => `${index + 1}. ${clip$1(action?.label || action?.type || "step", 120)}`);
		if (actions.length > 6) lines.push(`… and ${actions.length - 6} more`);
		const touched = [
			...preview?.affected?.apps ?? [],
			...preview?.affected?.urls ?? [],
			...preview?.affected?.paths ?? []
		];
		if (touched.length) lines.push(`Touches: ${clip$1(touched.join(", "), 200)}`);
		return lines.join("\n");
	}
	function newHistoryEntry({ id, command, page = null, now = Date.now() }) {
		return {
			id,
			command: clip$1(command, MAX_COMMAND_CHARS),
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
			pending: null,
			startedAt: new Date(now).toISOString(),
			finishedAt: null
		};
	}
	function macPlanPending({ actions, jobId = null, sessionId = null, planner = null }, now = Date.now()) {
		const list = Array.isArray(actions) ? actions : [];
		if (!list.length) return null;
		return {
			kind: "mac-plan",
			actions: list,
			jobId,
			sessionId,
			planner,
			parkedAt: new Date(now).toISOString()
		};
	}
	function localStepPending({ call, effect, reason, runId, approvalId }, now = Date.now()) {
		if (!call?.type) return null;
		return {
			kind: "local-step",
			call: {
				type: String(call.type),
				params: call.params ?? {}
			},
			effect: effect ?? "outward",
			reason: String(reason ?? ""),
			runId: runId ?? null,
			approvalId: approvalId ?? null,
			parkedAt: new Date(now).toISOString()
		};
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
	function appendHistory(history, entry) {
		return [entry, ...Array.isArray(history) ? history : []].slice(0, 8);
	}
	function patchHistory(history, id, patch) {
		return (Array.isArray(history) ? history : []).map((entry) => entry?.id === id ? {
			...entry,
			...patch,
			headline: clip$1(patch.headline ?? entry.headline, HEADLINE_MAX),
			detail: clip$1(patch.detail ?? entry.detail, DETAIL_MAX)
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
				detail: [outcome.safety, outcome.detail].filter(Boolean).join("\n"),
				pending: macPlanPending({
					actions: outcome.actions,
					jobId: outcome.jobId ?? null,
					sessionId: outcome.sessionId ?? null,
					planner: outcome.planner ?? null
				}, now)
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
		const params = normalizeCommandParams(action?.params);
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
		const wanted = textLooksOutward(command);
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
	//#endregion
	//#region shared/domains/browser.js
	var browser_default = Object.freeze({
		name: "browser",
		what: "Live web pages in the logged-in browser: tabs, forms, reads — and the sites the owner uses.",
		tools: Object.freeze({
			exact: Object.freeze([
				"watch_page",
				"activate_tab",
				"navigate",
				"snapshot",
				"read_page",
				"click",
				"type",
				"select",
				"press_key",
				"wait_for",
				"list_tabs",
				"capture"
			]),
			prefixes: Object.freeze(["browser_"])
		}),
		capture: Object.freeze([]),
		clarify: Object.freeze([Object.freeze({
			id: "browser.site",
			trigger: /\b(order|checkout|log in|login|sign in|book|reserve)\b/i,
			distinguisher: "site",
			ask: (labels) => `On which site — ${labels.join(", ")}?`
		})])
	});
	//#endregion
	//#region shared/domains/calendar.js
	var calendar_default = Object.freeze({
		name: "calendar",
		what: "Reminders, meetings, day plans, focus blocks, and which list or calendar they land on.",
		tools: Object.freeze({
			exact: Object.freeze([
				"create_reminder",
				"remind_me",
				"plan_my_day",
				"prepare_for_meeting",
				"meeting_followup",
				"schedule_routine",
				"start_focus_session",
				"end_focus_session"
			]),
			prefixes: Object.freeze([])
		}),
		capture: Object.freeze([Object.freeze({
			id: "calendar.list-from-action",
			action: "create_reminder",
			param: "list",
			name: (value) => `list.${value}`,
			scope: "hive"
		})]),
		clarify: Object.freeze([Object.freeze({
			id: "calendar.list",
			trigger: /\b(remind(er)?s?|todo|to-do)\b/i,
			distinguisher: "list",
			ask: (labels) => `Which list should that go on — ${labels.join(", ")}?`
		})])
	});
	//#endregion
	//#region shared/domains/email.js
	var email_default = Object.freeze({
		name: "email",
		what: "Send or draft email, triage the inbox, and the accounts and people mail goes to.",
		tools: Object.freeze({
			exact: Object.freeze([
				"send_email",
				"triage_inbox",
				"triage_notifications"
			]),
			prefixes: Object.freeze([])
		}),
		capture: Object.freeze([Object.freeze({
			id: "email.account-from-command",
			pattern: /\bmy\s+(?<label>[\p{L}\p{N}-]{2,24})\s+(?:email|e-mail|mail|account)\s+(?:address\s+)?(?:is|=)\s+(?<value>[^\s@]+@[^\s@]+\.[\p{L}\p{N}-]+)/iu,
			name: (groups) => `account.${groups.label.toLowerCase()}`,
			value: (groups) => groups.value,
			scope: "hive"
		})]),
		clarify: Object.freeze([Object.freeze({
			id: "email.account",
			trigger: /\b(email|e-mail|mail|inbox)\b/i,
			distinguisher: "account",
			ask: (labels) => `Which email account should I use — ${labels.join(", ")}?`
		})])
	});
	//#endregion
	//#region shared/domains/files.js
	var files_default = Object.freeze({
		name: "files",
		what: "Files and folders: read, write, search, move, tidy — and where the owner keeps things.",
		tools: Object.freeze({
			exact: Object.freeze([
				"read_file",
				"write_file",
				"list_directory",
				"delete_path",
				"copy_path",
				"move_path",
				"open_path",
				"open_folder",
				"create_note",
				"search_file",
				"run_project"
			]),
			prefixes: Object.freeze(["sweep_folder_", "tidy_downloads_"])
		}),
		capture: Object.freeze([Object.freeze({
			id: "files.place-from-action",
			action: "write_file",
			param: "path",
			name: (value) => `place.${String(value).split("/").slice(-2, -1)[0] || "root"}`,
			value: (raw) => String(raw).split("/").slice(0, -1).join("/") || "/",
			scope: "node"
		})]),
		clarify: Object.freeze([Object.freeze({
			id: "files.place",
			trigger: /\b(save|file|put|store)\b.*\b(note|file|document|doc)s?\b/i,
			distinguisher: "place",
			ask: (labels) => `Where should I put it — ${labels.join(", ")}?`
		})])
	});
	//#endregion
	//#region shared/domains/music.js
	var music_default = Object.freeze({
		name: "music",
		what: "Music and audio playback, and the services and playlists the owner actually uses.",
		tools: Object.freeze({
			exact: Object.freeze(["play_youtube"]),
			prefixes: Object.freeze(["music_"])
		}),
		capture: Object.freeze([Object.freeze({
			id: "music.service-from-action",
			action: "play_youtube",
			param: null,
			name: () => "service.default",
			value: () => "youtube",
			scope: "hive"
		})]),
		clarify: Object.freeze([Object.freeze({
			id: "music.service",
			trigger: /\b(play|music|song|album|playlist)\b/i,
			distinguisher: "service",
			ask: (labels) => `Play it where — ${labels.join(", ")}?`
		})])
	});
	//#endregion
	//#region shared/domains/system.js
	var system_default = Object.freeze({
		name: "system",
		what: "Mac volume, brightness, battery, clipboard, keyboard language — and the owner’s standing levels.",
		tools: Object.freeze({
			exact: Object.freeze([
				"set_volume",
				"get_volume",
				"set_mute",
				"set_brightness",
				"get_brightness",
				"get_battery",
				"get_mac_status",
				"get_clipboard",
				"copy_to_clipboard",
				"set_clipboard",
				"set_input_source",
				"get_input_source",
				"set_keyboard_language",
				"open_app",
				"open_url"
			]),
			prefixes: Object.freeze([])
		}),
		capture: Object.freeze([Object.freeze({
			id: "system.input-language",
			action: "set_input_source",
			param: "language",
			name: (value) => `language.${value}`,
			scope: "node"
		})]),
		clarify: Object.freeze([])
	});
	//#endregion
	//#region shared/domains/index.js
	const DOMAIN_MODULES = Object.freeze([
		email_default,
		calendar_default,
		files_default,
		music_default,
		system_default,
		browser_default
	]);
	const MEMORY_DOMAINS = Object.freeze(DOMAIN_MODULES.map((mod) => mod.name));
	new Map(DOMAIN_MODULES.map((mod) => [mod.name, mod]));
	const MEMORY_TOOL_TYPES = Object.freeze(["memory_lookup", "memory_save"]);
	const MEMORY_TOOL_SPECS = Object.freeze({
		memory_lookup: Object.freeze({
			description: `Look up the owner's remembered facts for one capability domain (${MEMORY_DOMAINS.join(", ")}): accounts, defaults, contacts, places, sites. Use before acting when the request depends on which account/list/site the owner means.`,
			params: Object.freeze({
				domain: `one of ${MEMORY_DOMAINS.join(" | ")}`,
				query: "optional words to match against fact names and values"
			})
		}),
		memory_save: Object.freeze({
			description: "Save one durable fact about the owner into a capability domain (e.g. domain 'email', name 'account.school', value 'liu@uni.edu'). Only for identities, accounts, connections and defaults likely to be used again — never chat logs. scope 'hive' shares it with every node; 'node' keeps it on this one.",
			params: Object.freeze({
				domain: `one of ${MEMORY_DOMAINS.join(" | ")}`,
				name: "dotted fact name inside the domain, e.g. 'account.personal' or 'list.default'",
				value: "the fact itself, one short line",
				scope: "optional 'hive' (default — every node) or 'node' (this node only)"
			})
		})
	});
	function isMemoryToolType(type) {
		return MEMORY_TOOL_TYPES.includes(String(type ?? "").trim());
	}
	const MAX_RESULT_CHARS = 2e3;
	const MAX_SNAPSHOT_ELEMENTS = 45;
	const TOOL_DESCRIPTIONS = Object.freeze({
		activate_tab: "Focus the tab already showing a site, opening it only if none is open. params: {urlContains?, url?}. USE THIS to reach a site rather than navigate — it keeps the owner's signed-in session and does not clobber the page they were on.",
		navigate: "Point the current tab at a URL, replacing what it was showing. params: {url, newTab?}.",
		snapshot: "List the interactive elements on the page with a `ref` for each. params: {maxElements?}. Call this before any click/type/select: refs come from here and are the only reliable way to address an element.",
		read_page: "Read the page text. params: {mode?: \"text\"|\"main_text\"|\"html\"|\"forms\"|\"landmarks\", maxChars?}.",
		click: "Click one element. params: {ref} from a snapshot, or {selector}.",
		type: "Type into a field. params: {ref|selector, text, submit?}. submit:true files the form in the same breath — do not set it unless the owner asked to submit.",
		select: "Choose an option in a <select>. params: {ref|selector, value|label}.",
		scroll: "Scroll the page or an element. params: {ref|selector?, direction?, amount?}.",
		press_key: "Press one key. params: {key}. Enter submits whatever form has focus.",
		wait_for: "Wait for something to appear before continuing. params: {selector?, textContains?, timeoutMs?}.",
		list_tabs: "List the open tabs and their URLs. params: {}.",
		capture: "Screenshot the visible tab. params: {}. Costly — prefer snapshot."
	});
	function memoryParamHint(spec, { omit = [] } = {}) {
		return `params: {${Object.keys(spec.params).filter((key) => !omit.includes(key)).map((key) => /^optional/i.test(spec.params[key]) ? `${key}?` : key).join(", ")}}`;
	}
	const BRAIN_LOCAL_TOOLS = Object.freeze(MEMORY_TOOL_TYPES.map((type) => {
		const spec = MEMORY_TOOL_SPECS[type];
		const omit = type === "memory_save" ? ["scope"] : [];
		const trailer = type === "memory_save" ? " On this node every save is shared with the hive — there is no browser-local store." : "";
		return Object.freeze({
			type,
			description: `${spec.description} ${memoryParamHint(spec, { omit })}.${trailer}`,
			local: true
		});
	}));
	/** The verbs offered to the model: the executor's own, plus the memory pair. */
	const BRAIN_TOOLS = Object.freeze([...[...COMMAND_TYPES].map((type) => ({
		type,
		description: TOOL_DESCRIPTIONS[type] ?? ""
	})), ...BRAIN_LOCAL_TOOLS]);
	/**
	* What the model is told it is.
	*
	* Written to be read alongside affinity.js, because the two halves have to
	* agree: the guard will park an outward step whatever the prompt says, so a
	* prompt that promised the model it could submit orders would only produce
	* confused models and wasted inferences. It is told the rule up front instead.
	*/
	function brainSystemPrompt() {
		return `You are the browser node of a personal agent. You act INSIDE the owner's own browser, in their existing signed-in tabs, on their behalf.

Answer with ONE JSON object and nothing else. Exactly one of these four shapes:

  {"thought": "<one short line>", "tool": "<name>", "params": { ... }}
  {"thought": "<one short line>", "answer": "<what you found or did, for the owner>"}
  {"thought": "<one short line>", "handoff": "<why this needs the Mac and not a browser>"}
  {"thought": "<one short line>", "clarify": "<one question for the owner>"}

EVERY reply must carry one of "tool", "answer", "handoff" or "clarify". A reply with only
"thought" is not a reply — it does nothing, the task does not advance, and you
will simply be asked again.

Tools:
${BRAIN_TOOLS.map((tool) => `- ${tool.type}: ${tool.description}`).join("\n")}

How to work:
- Look before you act. snapshot gives you refs; click/type/select need one.
- Use activate_tab to reach a site. The owner is already signed in there; navigate replaces the page they were looking at.
- One tool per reply. You will be given its result and asked again.
- If a step fails twice the same way, stop and answer with what you learned.

The owner's memory:
- memory_lookup and memory_save run on the relay, not on the page. Use them for the owner's durable facts, never for page contents.
- Consult memory_lookup BEFORE acting when the request depends on WHICH account, site or list the owner means — "check my email" with two known accounts is a lookup first, not a guess.
- Save only durable identities and connections with memory_save — an account, a default list, a site the owner names as theirs. Never page contents, never chat.

Use "clarify" ONLY when the request is genuinely ambiguous — the memories know
several candidates, the request names none of them, and no remembered default
settles it. One short question, then stop; the owner's reply arrives as a new
command. If memory_lookup (or the memory shown to you) can settle it, act
instead of asking. clarify is for ambiguity, never for permission — for outward
steps the rule below applies.

About steps that commit something outward — submit, buy, sell, cancel, send,
delete, subscribe, sign:
- KEEP GOING AND CALL THE TOOL ANYWAY when you reach one. The system stops it
  for you and asks the owner to approve it. That is the design, and it is not
  your job to do it instead.
- So do not stop early to describe what you would have done, and do not ask the
  owner for permission yourself — that is what stopping early looks like from
  here, and it leaves the task neither done nor asked.
- Never disguise such a step as a different one to get past the check.

What you must not do:
- Do not claim you did something you did not do. If you only opened and read pages, say exactly that. The system computes what actually happened from a ledger of executed steps and will contradict you.
- If the task needs anything outside a browser — files, shell, native apps, other machines — use handoff and say so. Do not improvise.

Answer with the JSON object only. No prose, no code fences.`;
	}
	/**
	* A /v1/infer descriptor, in the same shape relay-peer.js builds for every
	* other relay call, so background.js's relayFetch carries it and the token
	* still never appears in this module.
	*/
	function inferRequest(config, messages, { maxTokens = 900 } = {}) {
		return {
			method: "POST",
			path: "/v1/infer",
			auth: "device",
			body: {
				messages,
				maxTokens,
				responseFormat: "json_object"
			}
		};
	}
	/** GET the owner's remembered facts — for one domain, or matched by query. */
	function memoryLookupRequest({ domain = "", query = "", limit = 0 } = {}) {
		const search = new URLSearchParams();
		const domainName = String(domain ?? "").trim();
		if (domainName) search.set("domain", domainName);
		const words = String(query ?? "").trim().slice(0, 200);
		if (words) search.set("query", words);
		const cap = Math.floor(Number(limit) || 0);
		if (cap > 0) search.set("limit", String(cap));
		const qs = search.toString();
		return {
			method: "GET",
			path: `/v1/memory/domains${qs ? `?${qs}` : ""}`,
			auth: "device"
		};
	}
	/**
	* POST one fact into the hive's domain memory.
	*
	* SCOPE IS PINNED TO 'hive', whatever the model asked for: this browser has no
	* local durable store, so a node-scoped fact saved here would be a fact saved
	* nowhere — and the hive rejects node-scoped facts anyway. `node` names the
	* author for provenance, not the storage location.
	*/
	function memorySaveRequest(node, { domain, name, value } = {}) {
		return {
			method: "POST",
			path: "/v1/memory/domains",
			auth: "device",
			body: {
				node: String(node ?? "").trim(),
				facts: [{
					domain: String(domain ?? "").trim(),
					name: String(name ?? "").trim(),
					value: String(value ?? "").trim(),
					scope: "hive"
				}]
			}
		};
	}
	/**
	* What the model is shown of a memory tool's outcome — compact on purpose,
	* like compactToolResult one section down: the transcript budget is for the
	* task, not for echoing the relay's envelope back at the model.
	*/
	function compactMemoryResult(type, params = {}, payload = null) {
		if (type === "memory_save") {
			const accepted = Number(payload?.accepted) || 0;
			const rejected = Number(payload?.rejected) || 0;
			const key = `dom.${params?.domain ?? "?"}.${params?.name ?? "?"}`;
			if (accepted > 0) return `Saved ${key} (hive).`;
			return `The hive did not keep ${key}${rejected ? ` (${rejected} rejected)` : ""} — check the domain and the dotted name.`;
		}
		const lines = Array.isArray(payload?.lines) ? payload.lines.filter(Boolean).map((line) => String(line)) : [];
		if (!lines.length) {
			const where = String(params?.domain ?? "").trim();
			return `No remembered facts${where ? ` in ${where}` : ""} matched.`;
		}
		return clip(`${lines.length} remembered fact(s):\n${lines.join("\n")}`);
	}
	/**
	* Why a /v1/infer call failed, and whether the brain should stop trying.
	*
	* KEYED ON THE PRESENCE OF `retryAfter`, NOT ON STATUS CODES. The relay states
	* this as a contract in nodeInference.js: `retryAfter` is DEVICE-SCOPED and
	* means "this device should not ask this relay again before then" — never
	* "this request was unlucky". So a reason the relay adds later (a third one
	* beyond rate_limited and not_configured) is honoured here with no change,
	* which is the whole point of reading the field instead of the number.
	*
	* `fatal` is different: a request this device must not repeat AS WRITTEN
	* (a bad model name, an over-budget prompt). Retrying is pointless but the
	* brain is not broken, so the command hands off rather than the peer parking.
	*/
	function describeInferFailure(error) {
		const status = Number(error?.status) || 0;
		const code = String(error?.code || "");
		const retryAfter = Number(error?.retryAfter) || 0;
		const message = error?.message || String(error ?? "The relay refused the request.");
		if (retryAfter > 0) return {
			message,
			code,
			status,
			retryAfter,
			parkBrain: true,
			fatal: false
		};
		return {
			message,
			code,
			status,
			retryAfter: 0,
			parkBrain: false,
			fatal: status === 400 || [
				"invalid_request",
				"invalid_messages",
				"prompt_too_large",
				"model_not_allowed"
			].includes(code)
		};
	}
	/**
	* Is this a usable answer at all?
	*
	* `complete` is a TRI-STATE and null means the provider said nothing about how
	* it stopped — which is not the same as "it stopped badly", so null passes. A
	* caller that checked only `truncated` would read a content-filtered
	* non-answer (short content, truncated:false) as a real one; that is the same
	* bug one field over, which is why `complete` exists and is checked here.
	*/
	function readInferPayload(payload) {
		if (payload?.refusal) return {
			ok: false,
			error: `The model declined: ${String(payload.refusal).slice(0, 300)}`
		};
		if (payload?.truncated) return {
			ok: false,
			error: "The model ran out of output budget mid-answer, so its reply is not valid JSON. The step was not run."
		};
		if (payload?.complete === false) return {
			ok: false,
			error: `The model stopped abnormally (${String(payload?.finishReason || "unknown")}), so its reply cannot be trusted.`
		};
		const content = String(payload?.content ?? "").trim();
		if (!content) return {
			ok: false,
			error: "The model returned an empty reply."
		};
		return {
			ok: true,
			content
		};
	}
	/**
	* The model's JSON turn, read into something the loop can act on.
	*
	* Tolerant of exactly one thing — a fenced code block — because models emit
	* them under json_object often enough that refusing would cost a step for no
	* safety gain. Everything else is strict: an unknown tool, a missing params
	* object or a shapeless reply is an error the loop feeds BACK to the model, so
	* it corrects rather than the command dying on a typo.
	*/
	function parseBrainReply(content) {
		const text = String(content ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
		let value;
		try {
			value = JSON.parse(text);
		} catch {
			return {
				kind: "error",
				error: "Your reply was not valid JSON. Answer with one JSON object."
			};
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) return {
			kind: "error",
			error: "Your reply must be a single JSON object."
		};
		const thought = String(value.thought ?? "").slice(0, 300);
		if (value.handoff) return {
			kind: "handoff",
			thought,
			reason: String(value.handoff).slice(0, 500)
		};
		if (value.clarify != null) return {
			kind: "clarify",
			thought,
			question: String(value.clarify).slice(0, 300)
		};
		if (value.tool != null) {
			const type = String(value.tool).trim();
			const params = value.params;
			if (params != null && (typeof params !== "object" || Array.isArray(params))) return {
				kind: "error",
				error: "params must be a JSON object."
			};
			if (isMemoryToolType(type)) return {
				kind: "call",
				thought,
				call: {
					type,
					params: params ?? {}
				},
				local: true
			};
			if (!COMMAND_TYPES.has(type)) return {
				kind: "error",
				error: `"${type}" is not a tool. Use one of: ${[...COMMAND_TYPES, ...MEMORY_TOOL_TYPES].join(", ")}.`
			};
			return {
				kind: "call",
				thought,
				call: {
					type,
					params: params ?? {}
				}
			};
		}
		if (value.answer != null) return {
			kind: "answer",
			thought,
			answer: String(value.answer).slice(0, 2e3)
		};
		return {
			kind: "error",
			error: "Your reply had none of \"tool\", \"answer\", \"handoff\" or \"clarify\". Answer with one of the four shapes."
		};
	}
	/**
	* One executed step, compacted for the transcript.
	*
	* Two jobs. The obvious one is size: a raw snapshot of a real page is 80
	* elements of bounds, selectors, hrefs and tags — most of the prompt budget
	* for three fields the model actually addresses elements by. The other is
	* FIDELITY: what goes in here is the post-sanitizeExtraction result, the same
	* text that would have crossed to the Mac, so a password field arrives as a
	* withheld field rather than as its contents. This function only shortens; it
	* is never the thing that makes a result safe.
	*/
	function compactToolResult(type, result) {
		if (!result || typeof result !== "object") return String(result ?? "done");
		if (Array.isArray(result.elements)) {
			const total = result.elements.length;
			const shown = result.elements.slice(0, MAX_SNAPSHOT_ELEMENTS).map((element) => {
				return [
					`${element?.ref ?? "?"}`,
					element?.role ? `<${element.role}>` : "",
					element?.name ? `"${String(element.name).slice(0, 80)}"` : "",
					element?.sensitivity && element.sensitivity !== "normal" ? `[${element.sensitivity} — contents withheld]` : "",
					element?.disabled ? "[disabled]" : ""
				].filter(Boolean).join(" ");
			});
			const header = `${result.title ? `${result.title} — ` : ""}${result.url ?? ""}`.trim();
			const more = total > shown.length ? `\n… ${total - shown.length} more element(s) not shown` : "";
			return clip(`${header}\n${total} interactive element(s):\n${shown.join("\n")}${more}`);
		}
		if (Array.isArray(result.tabs)) return clip(`${result.tabs.length} tab(s):\n${result.tabs.map((tab) => `- ${truncate(tab?.title, 60)} — ${truncate(tab?.url, 120)}`).join("\n")}`);
		if (typeof result.content === "string" && result.content) return clip(`${`${result.title ? `${result.title} — ` : ""}${result.url ?? ""}`.trim()}\n${result.content}`);
		return clip(`${String(result.message ?? "done")}${result.url ? ` (${truncate(result.url, 120)})` : ""}`);
	}
	function truncate(value, max) {
		const text = String(value ?? "").replace(/\s+/g, " ").trim();
		return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
	}
	function clip(text, max = MAX_RESULT_CHARS) {
		const value = String(text ?? "").trim();
		if (value.length <= max) return value;
		return `${value.slice(0, max - 1)}…\n[trimmed — ask for a narrower read if you need more]`;
	}
	/**
	* The conversation, kept inside the relay's ceilings BY CONSTRUCTION.
	*
	* The system message and the owner's original ask are pinned: they are the
	* task, and a transcript that drops them to fit is a loop that forgets what it
	* was doing. Everything else is a sliding window over the tool exchange —
	* oldest results fall out first, and the fact that they did is stated in the
	* transcript rather than left for the model to infer from a gap.
	*/
	function createBrainTranscript({ command, page = null, memoryLines = [], now = Date.now() } = {}) {
		const system = {
			role: "system",
			content: brainSystemPrompt()
		};
		const grounding = (Array.isArray(memoryLines) ? memoryLines : []).filter(Boolean).map((line) => String(line)).slice(0, 12);
		const user = {
			role: "user",
			content: [
				`The owner asked: ${String(command ?? "").trim()}`,
				page?.url ? `\nThey are currently looking at: ${page.title ? `"${page.title}" — ` : ""}${page.url}` : "",
				grounding.length ? `\nWhat the owner's memory says (domain memory):\n${clip(grounding.join("\n"))}` : "",
				`\nStarted at ${new Date(now).toISOString()}.`
			].filter(Boolean).join("")
		};
		let turns = [];
		let dropped = 0;
		const fit = () => {
			for (;;) {
				const messages = [
					system,
					user,
					...turns
				];
				const chars = messages.reduce((total, message) => total + message.content.length, 0);
				if (messages.length <= 30 && chars <= 17e3) return;
				if (!turns.length) return;
				turns = turns.slice(2);
				dropped += 1;
			}
		};
		return {
			/** What to send now. */
			messages() {
				fit();
				return [
					system,
					user,
					...dropped ? [{
						role: "user",
						content: `[${dropped} earlier step(s) were dropped from this transcript to stay within limits. Do not assume they succeeded — if you need something from them, look again.]`
					}] : [],
					...turns
				];
			},
			/** The model's own turn, verbatim, so it can see what it said. */
			pushAssistant(content) {
				turns.push({
					role: "assistant",
					content: String(content ?? "")
				});
			},
			/** What running its tool produced — or why nothing ran. */
			pushResult(text) {
				turns.push({
					role: "user",
					content: String(text ?? "")
				});
			},
			/** Diagnostics for the run record, not for the model. */
			stats() {
				const messages = [
					system,
					user,
					...turns
				];
				return {
					messages: messages.length,
					chars: messages.reduce((total, message) => total + message.content.length, 0),
					dropped
				};
			}
		};
	}
	//#endregion
	//#region browser-extension/src/execution-status.js
	const EXECUTION_STATUS_KEY = "localExecutionStatus";
	const PENDING_APPROVALS_KEY = "localPendingApprovals";
	const APPROVAL_TTL_MS = 10 * 6e4;
	const MAX_RUNS_KEPT = 8;
	const MAX_PENDING_KEPT = 12;
	/**
	* @param {object} options
	* @param {object} options.storage  a storage.local-shaped object
	*                                  ({get(keys), set(values)}) — injected so
	*                                  tests hand in a plain fake.
	* @param {() => number} [options.now]
	*
	* All writes go through one promise chain, same as background.js's
	* withHistory: storage.local has no transactions, and two steps finishing
	* together must not eat each other's entries.
	*/
	function createExecutionJournal({ storage, now = Date.now } = {}) {
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
			return runs[index];
		});
		return {
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
			* Park an outward step. The run stops here; the entry records what was
			* refused and why, and expires unrun after APPROVAL_TTL_MS.
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
						expiresAt: new Date(now() + APPROVAL_TTL_MS).toISOString()
					};
					await storage.set({ [PENDING_APPROVALS_KEY]: [entry, ...pending].slice(0, MAX_PENDING_KEPT) });
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
	//#endregion
	//#region browser-extension/src/console-engine.js
	const api$1 = globalThis.browser ?? globalThis.chrome;
	const RELAY_LEDGER_KEY = "relaySeenEnvelopes";
	async function getRelayConfig() {
		return normalizeRelayConfig(await api$1.storage.local.get(RELAY_STORAGE_KEYS));
	}
	async function relayFetch(relayConfig, descriptor, timeoutMs = FETCH_TIMEOUT_MS) {
		const response = await fetch(`${relayConfig.relayUrl}${descriptor.path}`, {
			method: descriptor.method,
			cache: "no-store",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${relayConfig.deviceToken}`,
				...descriptor.body ? { "Content-Type": "application/json" } : {}
			},
			...descriptor.body ? { body: JSON.stringify(descriptor.body) } : {},
			signal: AbortSignal.timeout(timeoutMs)
		});
		if (!response.ok) throw await relayResponseError(response);
		return response.status === 204 ? null : await response.json();
	}
	let approvalWrites = Promise.resolve();
	function withApprovals(mutate) {
		const run = approvalWrites.then(async () => {
			const next = await mutate((await api$1.storage.local.get("pendingApprovals"))["pendingApprovals"] ?? []);
			if (next) await api$1.storage.local.set({ [APPROVALS_KEY]: next });
			return next;
		});
		approvalWrites = run.then(() => {}, (error) => {
			console.warn("approval store write failed:", error?.message || error);
		});
		return run;
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
	async function runMeshEnvelope(envelope, handling, relayConfig, macConfig, ctx) {
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
				extensionVersion: api$1.runtime.getManifest().version,
				macFresh: Boolean(ctx.macFresh?.()),
				observedAt: (/* @__PURE__ */ new Date()).toISOString()
			}, relayConfig));
			return;
		}
		let outcome;
		try {
			const command = envelopeToCommand(envelope);
			const identity = commandIdentity(command);
			const replayed = ctx.ledger.recall(identity);
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
				ctx.ledger.remember(identity, outcome);
			}
		} catch (error) {
			outcome = {
				ok: false,
				error: error?.message || String(error)
			};
		}
		await relayFetch(relayConfig, resultMessageFor(envelope, outcome, relayConfig));
	}
	async function drainRelayOnce(relayConfig, macConfig, ctx) {
		const page = await relayFetch(relayConfig, inboxRequest(relayConfig));
		const stored = (await api$1.storage.local.get("relaySeenEnvelopes"))["relaySeenEnvelopes"] ?? {};
		const accepted = acceptEnvelopes(page?.messages, {
			ledger: createEnvelopeLedger(stored),
			config: relayConfig
		});
		await api$1.storage.local.set({ [RELAY_LEDGER_KEY]: pruneEnvelopeLedger(accepted.ledger) });
		if (accepted.ackIds.length) await relayFetch(relayConfig, ackRequest(relayConfig, accepted.ackIds));
		for (const { envelope, handling } of accepted.run) try {
			await runMeshEnvelope(envelope, handling, relayConfig, macConfig, ctx);
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
	async function drainRelayUntilEmpty(relayConfig, macConfig, ctx, maxPages = 5) {
		let report = await drainRelayOnce(relayConfig, macConfig, ctx);
		let totals = {
			...report,
			pages: 1
		};
		for (let page = 1; page < maxPages && report.more; page += 1) {
			report = await drainRelayOnce(relayConfig, macConfig, ctx);
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
	/**
	* The mesh doorbell, as a controller each context holds for its own lifetime.
	*
	* Bodies verbatim from background.js's ensureMeshSocket/closeMeshSocket; the
	* module-level socket globals became closure state so the background worker
	* and a page engine can each hold their own doorbell without sharing wires.
	* The refusal latch (1008/4001/4003) lives here too: a credential the relay
	* will not accept must not be retried on every tick, and clearRefusal() is
	* how a pasted re-pair lifts it.
	*/
	function createMeshSocket() {
		let socket = null;
		let open = false;
		let pingTimer = null;
		let refused = false;
		const close = () => {
			if (pingTimer) {
				clearInterval(pingTimer);
				pingTimer = null;
			}
			if (socket) try {
				socket.close();
			} catch {}
			socket = null;
			open = false;
		};
		return {
			isOpen: () => open,
			isRefused: () => refused,
			clearRefusal() {
				refused = false;
			},
			close,
			ensure(relayConfig, onMail) {
				if (socket || refused) return;
				const url = socketUrl(relayConfig);
				const protocols = socketProtocols(relayConfig);
				if (!url || !protocols.length) return;
				let candidate;
				try {
					candidate = new WebSocket(url, protocols);
				} catch (error) {
					console.warn(`mesh socket could not be created: ${error?.message || error}`);
					return;
				}
				socket = candidate;
				candidate.addEventListener("open", () => {
					if (!socketProtocolAccepted(candidate.protocol)) {
						console.warn("mesh socket selected an unexpected subprotocol; closing.");
						try {
							candidate.close();
						} catch {}
						return;
					}
					open = true;
					updateRelayStatus({
						state: "connected",
						connected: true,
						transport: "socket",
						message: "The relay is pushing over its own socket.",
						lastConnectedAt: (/* @__PURE__ */ new Date()).toISOString(),
						error: ""
					});
					pingTimer = setInterval(() => {
						try {
							candidate.send(BRIDGE_PING_FRAME);
						} catch {}
					}, BRIDGE_PING_INTERVAL_MS);
				});
				candidate.addEventListener("message", (event) => {
					if (reactToFrame(event?.data).drain) onMail();
				});
				candidate.addEventListener("close", (event) => {
					open = false;
					socket = null;
					if (pingTimer) {
						clearInterval(pingTimer);
						pingTimer = null;
					}
					if (event?.code === 1008 || event?.code === 4001 || event?.code === 4003) {
						refused = true;
						updateRelayStatus({
							state: "unauthorized",
							connected: false,
							transport: "poll",
							message: "The relay refused this browser's socket credential.",
							lastErrorAt: (/* @__PURE__ */ new Date()).toISOString()
						});
					}
				});
				candidate.addEventListener("error", () => {
					open = false;
				});
			}
		};
	}
	let historyWrites = Promise.resolve();
	function withHistory(mutate) {
		historyWrites = historyWrites.then(async () => {
			const next = mutate((await api$1.storage.local.get("consoleHistory"))["consoleHistory"] ?? []);
			await api$1.storage.local.set({ [HISTORY_KEY]: next });
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
				signal: AbortSignal.timeout(timeoutMs)
			});
			const body = await response.json().catch(() => null);
			return interpret({
				status: response.status,
				payload: body
			});
		} catch (error) {
			return {
				kind: "error",
				message: error?.name === "TimeoutError" ? `The local agent did not answer within ${Math.round(timeoutMs / 1e3)}s. Check the dashboard — the job may still be running.` : error?.message || String(error)
			};
		}
	}
	let journalInstance = null;
	function executionJournal() {
		if (!journalInstance) journalInstance = createExecutionJournal({ storage: api$1.storage.local });
		return journalInstance;
	}
	/**
	* Tell the hive about a locally executed run — the owner's rule: "it should
	* stay in the browser extension but of course it can record the task to the
	* hive." Sent as node-mesh mail addressed to '@relay', which the Mac agent
	* can NEVER claim. A record, not a job. Best effort by design.
	*
	* FIRE-AND-FORGET AT EVERY CALL SITE (2026-08-12). The owner asked "why
	* didn't my question in the browser extension carried to the dashboard?" —
	* the answer was a relay-side feed gap, but auditing the path surfaced this
	* side's hazard: every settle path AWAITED this send, so a relay that was
	* down cost the popup a full fetch timeout before the finished run appeared.
	* The local history entry is the popup's source of truth; the hive record is
	* a report about it. Reporting must therefore never block or fail the run it
	* reports on — callers use `void recordRunToHive(...)`, and this function
	* swallows every failure into the journal's hiveRecord field (or the console)
	* rather than ever rejecting into an unhandled-promise warning. The relay's
	* fold is idempotent on taskId and accepts claim/verdict in any order, so
	* un-awaited records racing each other cannot corrupt the shared history.
	*/
	async function recordRunToHive(runId, phase) {
		try {
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
		} catch (error) {
			console.warn(`hive record for ${runId} did not send: ${error?.message || error}`);
		}
	}
	async function handleConsoleSubmit({ command, page }) {
		const text = String(command ?? "").trim();
		if (!text) return {
			ok: false,
			error: "Type a command first."
		};
		const config = await getConfig();
		const brain = await brainAvailability();
		if (!config.agentToken && !brain.ok) return {
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
		const brain = await brainAvailability();
		if (brain.ok) {
			await patchEntry(id, { headline: "Thinking in this browser…" });
			const outcome = await runBrainLocally({
				id,
				command,
				page,
				config,
				relayConfig: brain.relayConfig
			});
			if (!outcome.handoff) return;
			if (!config.agentToken) {
				await patchEntry(id, {
					state: "failed",
					headline: `This browser could not do it and there is no Mac agent configured: ${outcome.reason}`,
					finishedAt: (/* @__PURE__ */ new Date()).toISOString()
				});
				return;
			}
			await patchEntry(id, { headline: `Handing this to the Mac — ${outcome.reason}` });
		} else if (!config.agentToken) {
			await patchEntry(id, {
				state: "failed",
				headline: brain.reason,
				finishedAt: (/* @__PURE__ */ new Date()).toISOString()
			});
			return;
		}
		const commandText = buildCommandText(command, page);
		const context = commandContext(page);
		const stored = await api$1.storage.local.get(SESSION_KEY);
		const sessionId = String(stored["consoleSessionId"] ?? "").trim();
		const planOutcome = await consolePost(config, "/plan", {
			command: commandText,
			...context ? { context } : {},
			...sessionId ? { sessionId } : {},
			source: CONSOLE_SOURCE
		}, PLAN_TIMEOUT_MS, interpretPlanResponse);
		if (planOutcome.sessionId) await api$1.storage.local.set({ [SESSION_KEY]: planOutcome.sessionId });
		if (planOutcome.kind !== "execute") {
			await patchEntry(id, outcomeToPatch(planOutcome));
			return;
		}
		const affinity = routePlan(planOutcome.actions);
		if (affinity.route === "browser") {
			await patchEntry(id, { headline: "Plan is all browser work — running it in this browser…" });
			await executePlanLocally({
				id,
				command,
				steps: affinity.steps,
				config
			});
			return;
		}
		await patchEntry(id, { headline: "Plan ready — executing…" });
		await patchEntry(id, outcomeToPatch(await consolePost(config, "/execute", {
			command: commandText,
			...context ? { context } : {},
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
	async function executePlanLocally({ id, command, steps, config }) {
		const journal = executionJournal();
		await journal.beginRun({
			runId: id,
			command,
			route: "local-plan"
		});
		recordRunToHive(id, "claim");
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
				recordRunToHive(id, "verdict");
				await patchEntry(id, {
					state: "failed",
					headline: `Stopped at step ${step.index + 1} (${step.label}): ${message}`,
					detail: verdict.detail,
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
		recordRunToHive(id, "verdict");
		await patchEntry(id, {
			state: parked.length ? "parked" : verdict.verdict === "incomplete" ? "failed" : "executed",
			headline: verdict.headline,
			detail: [
				`Ran in this browser (affinity: all steps browser-capable).`,
				verdict.detail,
				...parked.length ? [`The parked step (${parked[0].id}) has not run. Approve below to run exactly that step — nothing after it runs either way.`] : []
			].filter(Boolean).join("\n"),
			pending: parked.length ? localStepPending({
				call: parked[0].call,
				effect: parked[0].effect,
				reason: parked[0].reason,
				runId: id,
				approvalId: parked[0].id
			}) : null,
			finishedAt: (/* @__PURE__ */ new Date()).toISOString()
		});
	}
	let brainParkedUntil = 0;
	/** Can this node think for itself right now, and if not, why not? */
	async function brainAvailability(now = Date.now()) {
		const relayConfig = await getRelayConfig();
		if (!relayConfig.ready) return {
			ok: false,
			reason: "No relay credential is configured, so this browser has no brain of its own."
		};
		if (brainParkedUntil > now) return {
			ok: false,
			reason: `The relay asked this device to stop calling its brain for another ${Math.ceil((brainParkedUntil - now) / 1e3)}s.`
		};
		return {
			ok: true,
			relayConfig
		};
	}
	/** One turn: ask the relay, and read the answer strictly. */
	async function brainTurn(relayConfig, transcript) {
		let payload;
		try {
			payload = await relayFetch(relayConfig, inferRequest(relayConfig, transcript.messages()), 7e4);
		} catch (error) {
			const failure = describeInferFailure(error);
			if (failure.parkBrain) brainParkedUntil = Date.now() + failure.retryAfter * 1e3;
			return {
				kind: "unavailable",
				...failure
			};
		}
		const read = readInferPayload(payload);
		if (!read.ok) return {
			kind: "retry",
			error: read.error,
			raw: ""
		};
		const reply = parseBrainReply(read.content);
		if (reply.kind === "error") return {
			kind: "retry",
			error: reply.error,
			raw: read.content
		};
		return {
			...reply,
			raw: read.content
		};
	}
	/**
	* Think and act in this browser until the task is done, parked, or out of
	* steps. Writes the same journal and history a Mac-planned run writes, so
	* nothing downstream has to know which brain produced it.
	*/
	async function runBrainLocally({ id, command, page, config, relayConfig }) {
		const journal = executionJournal();
		const guard = createOutwardGuard();
		let memoryLines = [];
		try {
			const remembered = await relayFetch(relayConfig, memoryLookupRequest({
				query: command,
				limit: 10
			}));
			if (Array.isArray(remembered?.lines)) memoryLines = remembered.lines;
		} catch {}
		const transcript = createBrainTranscript({
			command,
			page,
			memoryLines
		});
		await journal.beginRun({
			runId: id,
			command,
			route: "local-brain",
			executor: "browser-brain"
		});
		recordRunToHive(id, "claim");
		const parked = [];
		let answer = "";
		let clarifyQuestion = "";
		let steps = 0;
		const handOff = async (reason) => {
			await journal.finishRun(id, {
				state: "finished",
				verdict: "handed-off",
				headline: `Handed to the Mac: ${reason}`,
				detail: `This node ran ${steps} step(s) of thinking and executed nothing.`
			});
			recordRunToHive(id, "verdict");
			return {
				handoff: true,
				reason,
				steps
			};
		};
		while (steps < 12) {
			const turn = await brainTurn(relayConfig, transcript);
			if (turn.kind === "unavailable") return await handOff(turn.message);
			if (turn.kind === "retry") {
				transcript.pushAssistant(turn.raw || "");
				transcript.pushResult(`That reply could not be used: ${turn.error}`);
				steps += 1;
				continue;
			}
			transcript.pushAssistant(turn.raw);
			if (turn.kind === "handoff") {
				if (!((await journal.getStatus()).runs.find((run) => run.runId === id)?.steps ?? []).length) return await handOff(turn.reason);
				answer = `Stopped: ${turn.reason}`;
				break;
			}
			if (turn.kind === "answer") {
				answer = turn.answer;
				break;
			}
			if (turn.kind === "clarify") {
				clarifyQuestion = turn.question || "Which one did you mean?";
				answer = clarifyQuestion;
				break;
			}
			if (turn.local) {
				const call = turn.call;
				try {
					const payload = await relayFetch(relayConfig, call.type === "memory_save" ? memorySaveRequest(relayConfig.relayDeviceId, call.params) : memoryLookupRequest(call.params));
					const compact = compactMemoryResult(call.type, call.params, payload);
					await journal.recordStep(id, {
						tool: call.type,
						effect: EFFECT_READ,
						ok: true,
						summary: compact.slice(0, 300)
					});
					transcript.pushResult(compact);
				} catch (error) {
					const message = error?.message || String(error);
					await journal.recordStep(id, {
						tool: call.type,
						effect: EFFECT_READ,
						ok: false,
						summary: message.slice(0, 300)
					});
					transcript.pushResult(`That step failed: ${message}`);
				}
				steps += 1;
				continue;
			}
			const assessment = guard.assess(turn.call);
			if (!assessment.allow) {
				parked.push(await journal.parkStep(id, {
					call: turn.call,
					effect: assessment.effect,
					reason: assessment.reason,
					targetName: assessment.targetName
				}));
				break;
			}
			try {
				const result = await executeCommand({
					commandId: `brain-${id}-${steps}`,
					createdAt: (/* @__PURE__ */ new Date()).toISOString(),
					action: turn.call
				}, config);
				guard.observe(turn.call, result);
				await journal.recordStep(id, {
					tool: turn.call.type,
					effect: assessment.effect,
					ok: true,
					summary: String(result?.message ?? turn.call.type).slice(0, 300)
				});
				transcript.pushResult(compactToolResult(turn.call.type, result));
			} catch (error) {
				const message = error?.message || String(error);
				await journal.recordStep(id, {
					tool: turn.call.type,
					effect: assessment.effect,
					ok: false,
					summary: message.slice(0, 300)
				});
				transcript.pushResult(`That step failed: ${message}`);
			}
			steps += 1;
		}
		const executed = (await journal.getStatus()).runs.find((run) => run.runId === id)?.steps ?? [];
		if (!executed.length && !parked.length && !answer) return await handOff("this browser produced no usable step");
		const exhausted = steps >= 12 && !answer && !parked.length;
		const verdict = clarifyQuestion ? {
			verdict: "needs-answer",
			headline: clarifyQuestion,
			detail: "Needs your answer — reply in the console. Nothing ran past this question."
		} : honestVerdict({
			command,
			steps: executed,
			parked,
			response: answer
		});
		await journal.finishRun(id, {
			state: parked.length ? "parked" : "finished",
			...verdict
		});
		recordRunToHive(id, "verdict");
		await patchEntry(id, {
			state: parked.length ? "parked" : verdict.verdict === "incomplete" || exhausted ? "failed" : "executed",
			headline: exhausted ? `Stopped after 12 steps without finishing. ${verdict.headline}` : verdict.headline,
			detail: [
				"Thought and run in this browser (brain: relay inference, execution: this node).",
				verdict.detail,
				...parked.length ? ["The parked step has not run. Approve below to run exactly that step — nothing after it runs either way."] : []
			].filter(Boolean).join("\n"),
			pending: parked.length ? localStepPending({
				call: parked[0].call,
				effect: parked[0].effect,
				reason: parked[0].reason,
				runId: id,
				approvalId: parked[0].id
			}) : null,
			finishedAt: (/* @__PURE__ */ new Date()).toISOString()
		});
		return {
			handoff: false,
			steps
		};
	}
	async function decidePlan({ id, decision }) {
		const entryId = String(id ?? "");
		const history = (await api$1.storage.local.get("consoleHistory"))["consoleHistory"] ?? [];
		const entry = (Array.isArray(history) ? history : []).find((candidate) => candidate?.id === entryId);
		const preflight = planDecisionPreflight(entry);
		if (!preflight.ok) return {
			ok: false,
			error: preflight.error
		};
		const { pending } = preflight;
		if (decision === "deny") return denyPlan(entry, pending);
		if (decision !== "approve") return {
			ok: false,
			error: `Unknown decision "${decision}".`
		};
		const config = await getConfig();
		if (!config.agentToken) return {
			ok: false,
			needsSetup: true
		};
		if (pending.kind === "mac-plan") {
			const stillWaiting = await confirmPlanStillWaiting(config, pending.jobId);
			if (!stillWaiting.ok) return stillWaiting;
		}
		await patchEntry(entryId, {
			state: "working",
			headline: "Approved — running it…",
			pending: null,
			startedAt: (/* @__PURE__ */ new Date()).toISOString(),
			finishedAt: null
		});
		runApprovedPlan({
			entry,
			pending,
			config
		}).catch((error) => patchEntry(entryId, {
			state: "failed",
			headline: error?.message || String(error),
			finishedAt: (/* @__PURE__ */ new Date()).toISOString()
		}));
		return { ok: true };
	}
	/**
	* Deny: the plan does not run, and the Mac's parked job is dismissed so the
	* dashboard does not keep offering the same decision the owner just made.
	*/
	async function denyPlan(entry, pending) {
		let note = "";
		if (pending.kind === "mac-plan" && pending.jobId) {
			const config = await getConfig();
			try {
				const response = await fetch(`${config.agentUrl}/jobs/${encodeURIComponent(pending.jobId)}/dismiss`, {
					method: "POST",
					cache: "no-store",
					headers: {
						Accept: "application/json",
						Authorization: `Bearer ${config.agentToken}`
					},
					signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
				});
				if (!response.ok) note = `The Mac still lists this plan as parked (HTTP ${response.status}).`;
			} catch (error) {
				note = `The Mac was not told (${error?.message || error}), so its dashboard may still offer this plan.`;
			}
		}
		await patchEntry(entry.id, {
			state: "denied",
			headline: "Denied — nothing ran.",
			detail: [entry.detail, note].filter(Boolean).join("\n"),
			pending: null,
			finishedAt: (/* @__PURE__ */ new Date()).toISOString()
		});
		return {
			ok: true,
			note
		};
	}
	/** Is the Mac's parked job still waiting for a decision? */
	async function confirmPlanStillWaiting(config, jobId) {
		if (!jobId) return { ok: true };
		try {
			const response = await fetch(`${config.agentUrl}/jobs/${encodeURIComponent(jobId)}`, {
				cache: "no-store",
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${config.agentToken}`
				},
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
			});
			if (response.status === 404) return { ok: true };
			if (!response.ok) return {
				ok: false,
				error: `The Mac would not confirm this plan is still waiting (HTTP ${response.status}).`
			};
			const body = await response.json().catch(() => null);
			const job = body?.job ?? body;
			const status = String(job?.status ?? "");
			if (status && status !== "plan_ready") return {
				ok: false,
				error: `This plan is no longer waiting: the Mac now reports "${status}". It may already have been approved on the dashboard.`
			};
			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				error: `Could not reach the Mac to check this plan is still waiting (${error?.message || error}).`
			};
		}
	}
	/** Run what was approved — the whole plan, or the single parked step. */
	async function runApprovedPlan({ entry, pending, config }) {
		if (pending.kind === "local-step") {
			await runApprovedStep({
				entry,
				pending,
				config
			});
			return;
		}
		const affinity = routePlan(pending.actions);
		if (affinity.route === "browser") {
			await executePlanLocally({
				id: entry.id,
				command: entry.command,
				steps: affinity.steps,
				config
			});
			return;
		}
		const approvedContext = commandContext(entry.page);
		const outcome = await consolePost(config, "/execute", {
			command: buildCommandText(entry.command, entry.page),
			...approvedContext ? { context: approvedContext } : {},
			actions: pending.actions,
			...pending.sessionId ? { sessionId: pending.sessionId } : {},
			planMeta: {
				planner: pending.planner ?? null,
				source: CONSOLE_SOURCE
			},
			source: CONSOLE_SOURCE
		}, EXECUTE_TIMEOUT_MS, interpretExecuteResponse);
		await patchEntry(entry.id, outcomeToPatch(outcome));
	}
	/**
	* The approved outward step, run alone.
	*
	* Only this call runs. The steps that would have followed it did not run and
	* are not resumed — the run that parked has already reported what it did, and
	* quietly continuing past the approval point would make that report a lie.
	*/
	async function runApprovedStep({ entry, pending, config }) {
		const journal = executionJournal();
		const runId = pending.runId || entry.id;
		try {
			const result = await executeCommand({
				commandId: `approved-${runId}`,
				createdAt: (/* @__PURE__ */ new Date()).toISOString(),
				action: pending.call
			}, config);
			await journal.recordStep(runId, {
				tool: pending.call.type,
				effect: pending.effect,
				ok: true,
				summary: String(result?.message ?? "Approved step ran.").slice(0, 300)
			});
			await journal.finishRun(runId, {
				state: "finished",
				verdict: "achieved",
				headline: `Approved and ran: ${pending.call.type}.`
			});
			recordRunToHive(runId, "verdict");
			await patchEntry(entry.id, {
				state: "executed",
				headline: `You approved it and it ran: ${result?.message || pending.call.type}.`,
				detail: "Only the approved step ran. Any later steps from the original plan did not — send the command again if more is left to do.",
				finishedAt: (/* @__PURE__ */ new Date()).toISOString()
			});
		} catch (error) {
			const message = error?.message || String(error);
			await journal.recordStep(runId, {
				tool: pending.call.type,
				effect: pending.effect,
				ok: false,
				summary: message.slice(0, 300)
			});
			await journal.finishRun(runId, {
				state: "failed",
				verdict: "failed",
				headline: `The approved step failed: ${message}`
			});
			recordRunToHive(runId, "verdict");
			await patchEntry(entry.id, {
				state: "failed",
				headline: `The approved step failed: ${message}`,
				finishedAt: (/* @__PURE__ */ new Date()).toISOString()
			});
		}
	}
	//#endregion
	//#region browser-extension/src/page-engine.js
	const ENGINE_LEASE_KEY = "engineLease";
	const BACKGROUND_HOLDER = "background";
	//#endregion
	//#region browser-extension/src/background.js
	const api = globalThis.browser ?? globalThis.chrome;
	const POLL_ALARM = "ai-pendant-poll";
	const POLL_WINDOW_MS = 25e3;
	let activePoll = null;
	let activeRelayDrain = null;
	let configRevision = 0;
	const mesh = createMeshSocket();
	let macLastOkAt = 0;
	const INCARNATION_NONCE = crypto.randomUUID();
	const commandLedger = createCommandLedger();
	const relayCtx = {
		ledger: commandLedger,
		macFresh: () => Date.now() - macLastOkAt <= MAC_FRESH_MS
	};
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
	async function pollWindow(revision) {
		const config = await getConfig();
		if (!config.agentToken) {
			await updateStatus({
				state: "needs-setup",
				connected: false,
				message: "Paste the pairing code in the extension popup to connect."
			});
			return;
		}
		const deadline = Date.now() + POLL_WINDOW_MS;
		let nextHeartbeatAt = 0;
		let failures = 0;
		while (Date.now() < deadline && revision === configRevision) try {
			if (Date.now() >= nextHeartbeatAt) {
				await heartbeat(config, {
					nonce: INCARNATION_NONCE,
					ledger: commandLedger
				});
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
			const handledCommand = await pollOnce(config, { ledger: commandLedger });
			failures = 0;
			if (!handledCommand) await delay(BACKGROUND_POLL_INTERVAL_MS);
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
		mesh.ensure(relayConfig, () => drainRelayUntilEmpty(relayConfig, macConfig, relayCtx).catch((error) => console.warn(`mesh doorbell drain failed: ${error?.message || error}`)));
		while (Date.now() < deadline && revision === configRevision) {
			const choice = choosePeer({
				macConfigured: Boolean(macConfig.agentToken),
				macLastOkAt,
				relayReady: true,
				socketOpen: mesh.isOpen()
			});
			try {
				const report = await drainRelayUntilEmpty(relayConfig, macConfig, relayCtx);
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
					transport: mesh.isOpen() ? "socket" : "poll",
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
	function startPeers() {
		enforceCredentialLifetime().then(() => maybeRestorePairingFromEscrow()).catch(() => {}).finally(() => {
			startPolling();
			startRelayDrain();
		});
		api.storage.local.set({ [ENGINE_LEASE_KEY]: {
			holder: BACKGROUND_HOLDER,
			at: Date.now()
		} }).catch(() => {});
	}
	let escrowUnavailable = false;
	async function escrowSend(message) {
		if (escrowUnavailable) return null;
		if (typeof api?.runtime?.sendNativeMessage !== "function") {
			escrowUnavailable = true;
			return null;
		}
		try {
			return await api.runtime.sendNativeMessage("application.id", message);
		} catch {
			escrowUnavailable = true;
			return null;
		}
	}
	async function escrowStorePairing(values) {
		await escrowSend({
			type: "escrow:store",
			values
		});
	}
	async function escrowClearPairing() {
		await escrowSend({ type: "escrow:clear" });
	}
	async function maybeRestorePairingFromEscrow() {
		const { agentToken } = await api.storage.local.get("agentToken");
		if (agentToken) return;
		const plan = escrowRestorePlan((await escrowSend({ type: "escrow:fetch" }))?.values);
		if (!plan.restore) return;
		await api.storage.local.set(plan.values);
		console.log("[ai-pendant] Pairing restored from the app escrow after a storage reset.");
	}
	async function enforceCredentialLifetime() {
		const values = await api.storage.local.get([
			"agentToken",
			"pairLifetime",
			"pairExpiresAt"
		]);
		const sessionValues = api.storage.session ? await api.storage.session.get("pairSessionAlive").catch(() => ({})) : { pairSessionAlive: true };
		const verdict = credentialExpiryCheck({
			agentToken: values.agentToken,
			pairLifetime: values.pairLifetime,
			pairExpiresAt: values.pairExpiresAt,
			sessionAlive: Boolean(sessionValues?.pairSessionAlive)
		});
		if (!verdict.wipe) return;
		await api.storage.local.remove([...PAIR_WIPE_KEYS]);
		await updateStatus({
			state: "needs-setup",
			connected: false,
			message: `${verdict.reason} Paste the pairing code in the popup to connect again.`
		});
	}
	api.runtime.onInstalled.addListener(async ({ reason: _reason }) => {
		await migrateSyncedCredentials();
		await api.alarms.create(POLL_ALARM, { periodInMinutes: .5 });
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
		if (changes.agentToken && changes.agentToken.newValue === void 0) escrowClearPairing();
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
			mesh.clearRefusal();
			mesh.close();
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
			api.storage.local.get(STATUS_KEY).then((values) => sendResponse(values["bridgeStatus"] ?? null));
			return true;
		}
		if (message?.type === "peers:get-status") {
			Promise.all([
				api.storage.local.get([STATUS_KEY, RELAY_STATUS_KEY]),
				getRelayConfig(),
				getConfig()
			]).then(([values, relayConfig, macConfig]) => sendResponse({
				mac: values["bridgeStatus"] ?? null,
				relay: values["relayStatus"] ?? null,
				choice: choosePeer({
					macConfigured: Boolean(macConfig.agentToken),
					macLastOkAt,
					relayReady: relayConfig.ready,
					socketOpen: mesh.isOpen()
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
		if (message?.type === "console:submit") {
			handleConsoleSubmit(message).then(sendResponse).catch((error) => sendResponse({
				ok: false,
				error: error?.message || String(error)
			}));
			return true;
		}
		if (message?.type === "pair:run") {
			(async () => {
				let outcome;
				try {
					const origin = String(message.agentUrl ?? "").replace(/\/$/, "");
					const lifetime = normalizePairLifetime(message.lifetime);
					const response = await fetch(`${origin}/pair/browser`, {
						method: "POST",
						cache: "no-store",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							code: String(message.code ?? ""),
							deviceId: String(message.deviceId ?? ""),
							deviceName: String(message.deviceName ?? ""),
							lifetime
						}),
						signal: AbortSignal.timeout(2e4)
					});
					outcome = pairStoragePatch(await response.json().catch(() => null) ?? {
						ok: false,
						error: `The agent returned HTTP ${response.status} with no body.`
					}, {
						agentUrl: origin,
						lifetime
					});
					if (outcome.ok) {
						if (lifetime === "session" && api.storage.session) await api.storage.session.set({ pairSessionAlive: true });
						await api.storage.local.set(outcome.values);
						if (api.storage.sync) await api.storage.sync.remove("agentToken");
						if (shouldEscrow(lifetime)) await escrowStorePairing(outcome.values).catch(() => {});
					}
				} catch (error) {
					outcome = {
						ok: false,
						error: error?.name === "TimeoutError" ? "The agent did not answer within 20s. Is it running on this Mac?" : error?.message || String(error)
					};
				}
				await api.storage.local.set({ [PAIR_OUTCOME_KEY]: pairOutcomeRecord(outcome) }).catch(() => {});
				try {
					sendResponse(outcome);
				} catch {}
			})();
			return true;
		}
		if (message?.type === "plan:decide") {
			decidePlan(message).then(sendResponse).catch((error) => sendResponse({
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
