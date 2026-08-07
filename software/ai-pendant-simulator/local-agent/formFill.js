import path from 'node:path'
import crypto from 'node:crypto'
import fs from 'node:fs'

import {
  ensureJsonStore,
  readJsonWithRecovery,
  writeJsonAtomic,
} from './atomicJsonStore.js'
import { addressPage, isHttpUrl, runBrowserActions } from './browserPage.js'
import { workspacePath } from './config.js'

/*
 * Fill the form, then stop and show the owner the envelope.
 *
 * Four agents asked for the same thing in four wordings, and every one of them
 * put the brake in the sentence: "stop before submitting and show me exactly
 * what will be sent", "show me exactly what is ready before I submit". So the
 * stop is not a safety feature bolted on afterwards, it is the deliverable —
 * the product is the manifest, and the typing is just how the manifest gets
 * filled in. Nothing here prompts for permission and nothing is refused; the
 * run simply ends one click short, with that click named and located so the
 * owner can take it.
 *
 * "Exactly what will be sent" is taken literally. The destination and method
 * come out of the page's own <form> tag, the wire names come out of the
 * controls' name attributes, and untouched fields are reported with their real
 * defaults — because those get submitted too, and a manifest that only lists
 * what the agent typed is not what will be sent.
 */
const STORE_PATH = path.join(workspacePath, '.pendant-form-fills.json')
const MAX_FILLS = 20
const MAX_FORM_HTML = 40_000

/* Fill actions only. click is here for checkboxes and radios, which cannot be
 * set any other way — and is refused for buttons and links below, which is
 * where "stop before submitting" actually lives. */
const FILL_ACTIONS = new Set([
  'list_tabs',
  'navigate',
  'read_page',
  'snapshot',
  'type',
  'select',
  'click',
  'capture',
])

/* Roles that send the form. Never clicked, always reported. */
const SUBMIT_ROLES = new Set(['button', 'link'])
const SUBMIT_INPUT_TYPES = new Set(['submit', 'image', 'button', 'reset'])

const isValidStore = (value) => value && Array.isArray(value.fills)

function load(filePath = STORE_PATH) {
  ensureJsonStore(filePath, { fills: [] }, { validate: isValidStore })
  return readJsonWithRecovery(filePath, {
    fallback: { fills: [] },
    validate: isValidStore,
  })
}

function save(store, filePath = STORE_PATH) {
  writeJsonAtomic(filePath, store)
}

const ATTRIBUTE_PATTERN =
  /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+)))?/g

export function parseAttributes(source) {
  const attributes = {}
  ATTRIBUTE_PATTERN.lastIndex = 0
  let match
  while ((match = ATTRIBUTE_PATTERN.exec(String(source ?? ''))) !== null) {
    const name = match[1].toLowerCase()
    /* A bare attribute (required, checked, disabled) is its own truth value. */
    attributes[name] = match[2] ?? match[3] ?? match[4] ?? ''
  }
  return attributes
}

const TAG_PATTERN = /<(\/?)(form|label|input|select|textarea|button|option)\b([^>]*)>/gi

/* The text a person reads, from just after a start tag to the next tag. */
function textAfter(source, index) {
  const end = source.indexOf('<', index)
  return String(source.slice(index, end < 0 ? source.length : end))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Pull the submit contract out of the form's own markup.
 *
 * A regex over HTML is normally a mistake; here it is reading start tags and
 * their attributes out of one bounded, already-parsed fragment the browser
 * handed back, which is the one shape it does reliably. Node has no DOM, and
 * the alternative — asking the extension for values it does not expose — does
 * not exist.
 */
export function parseFormHtml(html, pageUrl = 'https://example.invalid/') {
  const source = String(html ?? '').slice(0, MAX_FORM_HTML)
  const controls = []
  const labelFor = new Map()
  let form = null
  let currentSelect = null
  /*
   * The name a person would use for a field lives in its <label>, and the
   * snapshot cannot always see it: for a <select> the extension's accessible
   * name falls back to the name attribute, so "Dropdown (select)" — the only
   * words on screen — matched nothing until this was read out of the markup.
   */
  let pendingLabel = ''
  let match

  TAG_PATTERN.lastIndex = 0
  while ((match = TAG_PATTERN.exec(source)) !== null) {
    const closing = match[1] === '/'
    const tag = match[2].toLowerCase()
    const attributes = closing ? {} : parseAttributes(match[3])

    if (tag === 'label') {
      if (!closing) {
        const text = textAfter(source, match.index + match[0].length)
        pendingLabel = text
        if (attributes.for) labelFor.set(attributes.for, text)
      }
      continue
    }

    if (tag === 'form') {
      if (!closing && !form) {
        const action = attributes.action ?? ''
        form = {
          action,
          submitsTo: absoluteUrl(action, pageUrl),
          method: String(attributes.method || 'GET').toUpperCase(),
          enctype:
            attributes.enctype ||
            (String(attributes.method || 'GET').toUpperCase() === 'POST'
              ? 'application/x-www-form-urlencoded'
              : ''),
          id: attributes.id ?? '',
          name: attributes.name ?? '',
        }
      }
      continue
    }

    if (tag === 'option') {
      if (!closing && currentSelect) {
        const text = textAfter(source, match.index + match[0].length)
        currentSelect.options.push({
          /* An option with no value attribute submits its own text. Reading
           * only the attribute reported an empty value for a select that would
           * really have sent "Open this select menu". */
          value: attributes.value ?? text,
          text,
          selected: 'selected' in attributes,
        })
      }
      continue
    }

    if (tag === 'select') {
      if (closing) {
        currentSelect = null
        continue
      }
      currentSelect = {
        tag: 'select',
        type: 'select',
        name: attributes.name ?? '',
        id: attributes.id ?? '',
        label:
          attributes['aria-label'] ??
          labelFor.get(attributes.id) ??
          pendingLabel ??
          '',
        value: '',
        required: 'required' in attributes,
        disabled: 'disabled' in attributes,
        options: [],
      }
      pendingLabel = ''
      controls.push(currentSelect)
      continue
    }

    if (closing) continue

    const type = String(attributes.type || (tag === 'textarea' ? 'textarea' : 'text')).toLowerCase()
    controls.push({
      tag,
      type,
      name: attributes.name ?? '',
      id: attributes.id ?? '',
      label:
        attributes['aria-label'] ??
        labelFor.get(attributes.id) ??
        pendingLabel ??
        attributes.placeholder ??
        '',
      value: attributes.value ?? '',
      required: 'required' in attributes,
      disabled: 'disabled' in attributes,
      checked: 'checked' in attributes,
      readonly: 'readonly' in attributes,
    })
    pendingLabel = ''
  }

  return { form, controls }
}

function absoluteUrl(action, pageUrl) {
  try {
    /* An empty action posts back to the page itself — that is the spec, and it
     * is the difference between "we know where this goes" and a guess. */
    return new URL(String(action || ''), pageUrl).href
  } catch {
    return String(pageUrl)
  }
}

/** Compare the way a human reads a label, not the way HTML writes it. */
export function normalizeKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

const SELECTOR_KEY = /^[#.[]/

/**
 * Decide which control on the page each supplied value belongs to.
 *
 * The owner dictates from notes ("email", "phone number"), the page names
 * things for its backend ("custemail", "cust_tel"), and the accessible label
 * sits between them. Try the strictest link first so an exact name attribute
 * always beats a fuzzy label.
 */
export function matchField(key, elements) {
  const raw = String(key)
  if (SELECTOR_KEY.test(raw)) {
    const bySelector = elements.find((element) => element.selector === raw)
    if (bySelector) return { element: bySelector, matchedBy: 'selector' }
    if (raw.startsWith('#')) {
      const byId = elements.find((element) => element.control?.id === raw.slice(1))
      if (byId) return { element: byId, matchedBy: 'id' }
    }
    return null
  }

  const wanted = normalizeKey(raw)
  const rules = [
    ['name', (element) => normalizeKey(element.control?.name) === wanted],
    ['id', (element) => normalizeKey(element.control?.id) === wanted],
    ['label', (element) => normalizeKey(element.label) === wanted],
    ['markup-label', (element) => normalizeKey(element.markupLabel) === wanted],
    [
      'label-contains',
      (element) =>
        wanted.length >= 3 &&
        (normalizeKey(element.label).includes(wanted) ||
          normalizeKey(element.markupLabel).includes(wanted)),
    ],
    [
      'name-contains',
      (element) =>
        wanted.length >= 3 && normalizeKey(element.control?.name).includes(wanted),
    ],
  ]

  for (const [matchedBy, test] of rules) {
    const element = elements.find((candidate) => !candidate.isSubmit && test(candidate))
    if (element) return { element, matchedBy }
  }
  return null
}

/**
 * Tie each interactive element the extension can act on to the markup that
 * says what it is called on the wire.
 *
 * The snapshot knows how to reach an element (ref) and what a person would call
 * it (accessible name); the parsed HTML knows its name attribute, its default
 * value and whether it is required. Neither alone can answer "what will be
 * sent".
 */
export function linkElements(snapshotElements, controls) {
  const used = new Set()

  const takeOrdinal = (predicate) => {
    for (let index = 0; index < controls.length; index += 1) {
      if (used.has(index)) continue
      if (predicate(controls[index])) {
        used.add(index)
        return controls[index]
      }
    }
    return null
  }

  return snapshotElements.map((element) => {
    const inputType = String(element.inputType || '').toLowerCase()
    const tag = String(element.tag || '').toLowerCase()
    const selectorId = String(element.selector || '').startsWith('#')
      ? element.selector.slice(1)
      : ''

    let control = null
    if (selectorId) {
      const index = controls.findIndex((candidate) => candidate.id === selectorId)
      if (index >= 0) {
        used.add(index)
        control = controls[index]
      }
    }
    if (!control) {
      const label = normalizeKey(element.name)
      control =
        takeOrdinal(
          (candidate) =>
            candidate.tag === tag &&
            (tag !== 'input' || candidate.type === (inputType || 'text')) &&
            (normalizeKey(candidate.name) === label ||
              normalizeKey(candidate.label) === label),
        ) ??
        /* Last resort: same kind of control, in document order. Both lists come
         * from the same DOM in the same order, so the nth text input in one is
         * the nth text input in the other. */
        takeOrdinal(
          (candidate) =>
            candidate.tag === tag &&
            (tag !== 'input' || candidate.type === (inputType || 'text')),
        )
    }

    const isSubmit =
      SUBMIT_ROLES.has(String(element.role || '')) ||
      SUBMIT_INPUT_TYPES.has(inputType) ||
      tag === 'button'

    /* When the snapshot's accessible name is just the wire name, the markup's
     * <label> is the only thing that reads like what the owner dictated. */
    const accessible = String(element.name ?? '')
    const markupLabel = String(control?.label ?? '')
    const label =
      markupLabel && normalizeKey(accessible) === normalizeKey(control?.name)
        ? markupLabel
        : accessible

    return {
      ref: element.ref,
      selector: element.selector,
      role: element.role,
      tag,
      inputType,
      label,
      markupLabel,
      disabled: Boolean(element.disabled),
      checked: element.checked,
      href: element.href,
      control,
      isSubmit,
    }
  })
}

/** How to reach an element, preferring the ref the snapshot just stamped. */
function locator(element) {
  return element.ref ? { ref: element.ref } : { selector: element.selector }
}

function isTextLike(element) {
  if (element.tag === 'textarea') return true
  if (element.tag !== 'input') return element.role === 'textbox'
  return !['checkbox', 'radio', 'file', 'submit', 'button', 'image', 'reset'].includes(
    element.inputType,
  )
}

function truthy(value) {
  if (typeof value === 'boolean') return value
  const text = String(value).trim().toLowerCase()
  return !['', 'false', 'no', 'off', '0', 'unchecked'].includes(text)
}

/**
 * Everything the browser would put on the wire if the owner pressed submit now.
 *
 * Untouched controls are included with their real defaults, disabled and
 * unnamed controls are excluded, and unchecked boxes are absent — those are the
 * browser's rules, and a manifest that does not follow them is fiction.
 */
export function buildPayload(elements, filledByRef) {
  const entries = []
  const omitted = []

  for (const element of elements) {
    const control = element.control
    const name = control?.name ?? ''
    const filled = filledByRef.get(element.ref)

    if (element.isSubmit) {
      continue
    }
    if (!name) {
      omitted.push({
        label: element.label,
        reason: 'no name attribute — the browser does not send this field',
      })
      continue
    }
    if (element.disabled || control?.disabled) {
      omitted.push({ name, label: element.label, reason: 'disabled' })
      continue
    }
    if (element.inputType === 'file') {
      omitted.push({
        name,
        label: element.label,
        reason: 'file input — a file has to be chosen in the browser',
      })
      continue
    }

    if (element.inputType === 'checkbox' || element.inputType === 'radio') {
      const checked = filled ? truthy(filled.value) : Boolean(element.checked)
      if (!checked) continue
      entries.push({
        name,
        value: control?.value || 'on',
        label: element.label,
        source: filled ? 'provided' : 'already on the page',
        verified: 'read back from the page',
      })
      continue
    }

    if (element.tag === 'select') {
      const selected =
        control?.options?.find((option) => option.selected) ?? control?.options?.[0]
      entries.push({
        name,
        value: filled ? String(filled.value) : (selected?.value ?? ''),
        label: element.label,
        source: filled ? 'provided' : 'page default',
        verified: filled ? 'accepted by the page' : 'from the page markup',
      })
      continue
    }

    const value = filled ? String(filled.value) : String(control?.value ?? '')
    if (!value && !control?.required && !filled) {
      /* Empty optional fields are still sent, but listing every one of them
       * buries the fields that matter. Keep them, mark them. */
      entries.push({
        name,
        value: '',
        label: element.label,
        source: 'left blank',
        verified: 'from the page markup',
      })
      continue
    }
    entries.push({
      name,
      value,
      label: element.label,
      source: filled ? 'provided' : 'already on the page',
      verified: filled
        ? filled.redacted
          ? 'not entered'
          : 'accepted by the page'
        : 'from the page markup',
      ...(filled?.redacted ? { redacted: true } : {}),
    })
  }

  return { entries, omitted }
}

/** The request line and body, spelled out. */
export function renderPreview({ method, submitsTo, enctype }, entries) {
  const query = entries
    .filter((entry) => !entry.redacted)
    .map(
      (entry) =>
        `${encodeURIComponent(entry.name)}=${encodeURIComponent(entry.value ?? '')}`,
    )
    .join('&')

  if (method === 'GET') {
    const separator = submitsTo.includes('?') ? '&' : '?'
    return `GET ${submitsTo}${query ? `${separator}${query}` : ''}`
  }
  return `POST ${submitsTo}\nContent-Type: ${enctype || 'application/x-www-form-urlencoded'}\n\n${query}`
}

/**
 * Navigate, fill, and stop.
 *
 * Returns the manifest. Never returns a submitted form: there is no code path
 * from here to clicking the submit control, and the guard below is what keeps
 * that true when someone adds a "just press it" option later.
 */
export async function fillForm(
  {
    url,
    values = {},
    formSelector = 'form',
    name,
    capture = false,
    reload = true,
    maxElements = 80,
  } = {},
  { filePath = STORE_PATH } = {},
) {
  if (!isHttpUrl(url)) {
    throw new Error('A form fill needs an http(s) url.')
  }

  const options = {
    command: `fill form at ${url}`,
    source: 'form-fill',
    allow: FILL_ACTIONS,
  }

  const page = await addressPage(url, { reload, options })

  /* One trip for both halves of the picture: the snapshot says how to reach
   * each control, the markup says what it is called on the wire. */
  const [snapResult, htmlResult] = await runBrowserActions(
    [
      {
        type: 'browser_snapshot',
        label: 'find the fields',
        params: { ...page.target, maxElements },
      },
      {
        type: 'browser_read_page',
        label: 'read the form markup',
        params: {
          ...page.target,
          mode: 'html',
          selector: formSelector,
          maxChars: MAX_FORM_HTML,
        },
      },
    ],
    options,
  )
  if (!snapResult?.ok) {
    throw new Error(snapResult?.error || 'The form could not be read.')
  }

  const { form, controls } = parseFormHtml(
    htmlResult?.ok ? String(htmlResult.data?.content ?? '') : '',
    page.url,
  )
  const elements = linkElements(
    Array.isArray(snapResult.data?.elements) ? snapResult.data.elements : [],
    controls,
  )

  const filledByRef = new Map()
  const applied = []
  const warnings = []
  const unmatched = []
  const planned = []

  for (const [key, rawValue] of Object.entries(values)) {
    const hit = matchField(key, elements)
    if (!hit) {
      unmatched.push({ key, value: String(rawValue), reason: 'no field on the page matched' })
      continue
    }
    const { element, matchedBy } = hit

    if (element.isSubmit) {
      /* Structural, not advisory: the one thing this function must never do. */
      warnings.push(`"${key}" points at the submit control; skipped.`)
      continue
    }
    if (element.disabled) {
      warnings.push(`"${key}" maps to a disabled field; the page will not accept it.`)
      continue
    }
    if (element.inputType === 'password') {
      /*
       * Not a permission gate — nothing here asks the owner for approval. A
       * password typed by an automation is a password that lives in a JSON
       * store, a job log and a manifest. The field is named in the manifest so
       * the owner can type it in the one place it belongs.
       */
      filledByRef.set(element.ref, { value: '', redacted: true })
      warnings.push(
        `"${element.label || key}" is a password field — left for you to type before submitting.`,
      )
      continue
    }
    if (element.inputType === 'file') {
      warnings.push(`"${key}" is a file input; a file has to be chosen in the browser.`)
      continue
    }

    const entry = { key, element, matchedBy }
    if (element.tag === 'select') {
      entry.action = {
        type: 'browser_select',
        label: `set ${element.label || key}`,
        params: {
          ...page.target,
          ...locator(element),
          value: String(rawValue),
          label: String(rawValue),
        },
      }
    } else if (element.inputType === 'checkbox' || element.inputType === 'radio') {
      if (truthy(rawValue) === Boolean(element.checked)) {
        /* Already in the state the owner asked for; clicking would undo it. */
        filledByRef.set(element.ref, { value: rawValue })
        continue
      }
      /* The only click this function makes, and only on a box or a radio. */
      entry.action = {
        type: 'browser_click',
        label: `tick ${element.label || key}`,
        params: { ...page.target, ...locator(element) },
      }
    } else if (isTextLike(element)) {
      entry.action = {
        type: 'browser_type',
        label: `type ${element.label || key}`,
        params: {
          ...page.target,
          ...locator(element),
          text: String(rawValue),
          /* The extension presses Enter or calls requestSubmit() when this is
           * true. It is never true here, and that is the whole product. */
          submit: false,
        },
      }
    } else {
      warnings.push(`"${key}" maps to a ${element.role || element.tag} that cannot be typed into.`)
      continue
    }
    entry.value = rawValue
    planned.push(entry)
  }

  /* Every field in one trip. Each action still succeeds or fails on its own —
   * a selector that stopped matching becomes a warning, not a dead fill. */
  const fillResults = planned.length
    ? await runBrowserActions(
        planned.map((entry) => entry.action),
        options,
      )
    : []

  planned.forEach((entry, index) => {
    const result = fillResults[index]
    if (!result?.ok) {
      warnings.push(
        `"${entry.key}" could not be filled: ${result?.error ?? 'no result from the browser'}`,
      )
      return
    }
    filledByRef.set(entry.element.ref, { value: entry.value })
    applied.push({
      key: entry.key,
      field: entry.element.control?.name || entry.element.label || entry.element.selector,
      label: entry.element.label,
      matchedBy: entry.matchedBy,
      ref: entry.element.ref,
      selector: entry.element.selector,
    })
  })

  /* Read the page back rather than trusting the writes: checkbox and radio
   * state is the part the snapshot can actually confirm, and the screenshot is
   * the part a person can. Both in one trip. */
  const [verifyResult, captureResult] = await runBrowserActions(
    [
      {
        type: 'browser_snapshot',
        label: 'read the filled form back',
        params: { ...page.target, maxElements },
      },
      ...(capture
        ? [{ type: 'browser_capture', label: 'photograph the filled form', params: { ...page.target } }]
        : []),
    ],
    options,
  ).catch(() => [])

  const verifiedRaw = verifyResult?.ok
    ? (verifyResult.data?.elements ?? [])
    : []
  const verifiedElements = verifiedRaw.length
    ? linkElements(verifiedRaw, controls)
    : elements

  const { entries, omitted } = buildPayload(verifiedElements, filledByRef)
  const submitControl = elements.find(
    (element) => element.isSubmit && !element.disabled && element.role !== 'link',
  )
  const contract = {
    method: form?.method ?? 'GET',
    submitsTo: form?.submitsTo ?? page.url,
    enctype: form?.enctype ?? '',
  }

  const missingRequired = verifiedElements
    .filter(
      (element) =>
        element.control?.required &&
        !element.disabled &&
        !filledByRef.has(element.ref) &&
        !String(element.control?.value ?? '').trim(),
    )
    .map((element) => element.control?.name || element.label)

  let screenshot = null
  if (capture) {
    screenshot = captureResult?.ok
      ? writeCapture(captureResult.data)
      : { error: captureResult?.error ?? 'the browser returned no screenshot' }
  }

  const manifest = {
    id: `fill_${crypto.randomUUID()}`,
    name: String(name || form?.name || form?.id || page.title || url).slice(0, 120),
    at: new Date().toISOString(),
    page: { url: page.url, title: page.title, disposition: page.disposition },
    stoppedBefore: 'submit',
    submit: submitControl
      ? {
          label: submitControl.label,
          ref: submitControl.ref,
          selector: submitControl.selector,
          clicked: false,
          howToSend: `browser_click with selector ${submitControl.selector}`,
        }
      : { label: null, clicked: false, howToSend: 'no submit control was found on the page' },
    willSend: { ...contract, fields: entries },
    preview: renderPreview(contract, entries),
    filled: applied,
    unmatched,
    notSent: omitted,
    missingRequired,
    warnings,
    screenshotPath: screenshot?.path ?? null,
    screenshotError: screenshot?.error ?? null,
    summary: summarize({ applied, entries, contract, submitControl, missingRequired }),
  }

  const store = load(filePath)
  store.fills.unshift(manifest)
  store.fills = store.fills.slice(0, MAX_FILLS)
  save(store, filePath)

  return manifest
}

function summarize({ applied, entries, contract, submitControl, missingRequired }) {
  const parts = [
    `Filled ${applied.length} field${applied.length === 1 ? '' : 's'}.`,
    `${entries.length} value${entries.length === 1 ? '' : 's'} would go to ${contract.method} ${contract.submitsTo}.`,
    submitControl
      ? `Stopped before "${submitControl.label || 'Submit'}" — not clicked.`
      : 'Stopped before submitting.',
  ]
  if (missingRequired.length) {
    parts.push(`Still required: ${missingRequired.join(', ')}.`)
  }
  return parts.join(' ')
}

/*
 * The screenshot is the only proof that the values landed as a person sees
 * them: the extension can read an input's markup but not the value property a
 * fill writes, so "show me what is ready" ends in a picture. It goes to disk
 * rather than into the store — a base64 PNG in a JSON file is how a durable
 * store becomes a megabyte per fill.
 */
function writeCapture(data) {
  try {
    const base64 = String(data?.imageDataUrl ?? '').split(',')[1] ?? ''
    if (!base64) return { error: 'The browser returned no image data.' }
    const directory = path.join(workspacePath, 'form-fills')
    fs.mkdirSync(directory, { recursive: true })
    const file = path.join(directory, `fill-${Date.now()}.png`)
    fs.writeFileSync(file, Buffer.from(base64, 'base64'), { mode: 0o600 })
    return { path: file }
  } catch (error) {
    return { error: String(error?.message || error) }
  }
}

export function listFills({ filePath = STORE_PATH } = {}) {
  return load(filePath).fills
}

export function getFill(id, { filePath = STORE_PATH } = {}) {
  return load(filePath).fills.find((fill) => fill.id === id) ?? null
}

export const formFillLocation = () => STORE_PATH
