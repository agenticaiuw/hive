/*
 * Runs one browser command Hive's agents send through the cloud (cloud-peer.js asks the board for
 * the next one and posts back what this returns): open or pick a tab, read it, click, type, and so
 * on. Everything a command produces goes through the privacy boundary (sanitizeExtraction) before
 * it leaves this browser, stamped with where it came from (provenanceFor).
 */
import {
  DEFAULT_TARGET_MODE,
  TARGET_MODES,
  isScriptableUrl,
  normalizeCommandParams,
  originPattern,
  pickTargetTab,
  provenanceFor,
  sanitizeExtraction,
  validateCommand,
  validateNavigationUrl,
} from './bridge-core.js'
import { CLOUD_STATUS_KEY, connectionBadge } from './cloud-peer.js'

const api = globalThis.browser ?? globalThis.chrome

/* Which tab a command acts in when it doesn't say: the owner's choice, if one is stored. */
export async function getConfig() {
  const stored = await api.storage.local.get(['targetMode']).catch(() => ({}))
  return { targetMode: TARGET_MODES.has(stored.targetMode) ? stored.targetMode : DEFAULT_TARGET_MODE }
}

/* The toolbar badge: whether Hive reaches this browser through the cloud. */
export async function refreshBadge() {
  if (!api.action?.setBadgeText) return
  const stored = await api.storage.local.get([CLOUD_STATUS_KEY])
  const badge = connectionBadge(stored[CLOUD_STATUS_KEY])
  await api.action.setBadgeText({ text: badge.text })
  if (api.action.setBadgeBackgroundColor) await api.action.setBadgeBackgroundColor({ color: badge.color })
}

/**
 * Run one command, then take everything it produced through the privacy
 * boundary and stamp it with where it came from.
 *
 * The order is the whole point. sanitizeExtraction runs after execution and
 * before the result is handed back to the cloud peer, which is the last moment
 * it is still inside the browser: past here it is in Hive's cloud, and a
 * credential that reaches it has effectively left the machine.
 */
export async function executeCommand(command, config) {
  // A caller that forgets the config (background.js once did, and every Safari read, snapshot and
  // screenshot failed on config.targetMode, 2026-11-19) still gets the owner's choice.
  config ??= await getConfig()
  /*
   * Normalized before the gate: the cloud board passes on whatever an agent
   * sent, so what this browser cannot honour is dropped here.
   *
   * It only removes what cannot be honoured. validateCommand is still the gate
   * and still refuses everything it refused before.
   */
  const { type, params } = validateCommand({
    ...command,
    action: {
      ...command?.action,
      params: normalizeCommandParams(command?.action?.params),
    },
  })
  const { result, tab } = await runCommand(type, params, config)
  const clean = sanitizeExtraction(result)

  return {
    ...clean.result,
    provenance: provenanceFor({
      command,
      tab,
      result: clean.result,
      locator: params.ref || params.selector,
    }),
  }
}

async function runCommand(type, params, config) {
  if (type === 'navigate') {
    return { result: await navigate(params, config), tab: null }
  }

  if (type === 'activate_tab') {
    return { result: await activateTab(params, config), tab: null }
  }

  if (type === 'list_tabs') {
    return { result: await listTabs(params), tab: null }
  }

  const tab = await selectTargetTab(params, config.targetMode)
  await assertPageAccess(tab)

  if (type === 'capture') {
    return { result: await captureTab(tab), tab }
  }

  if (type === 'wait_for') {
    return { result: await waitForInTab(tab, params), tab }
  }

  const injection = await api.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [0] },
    func: runInPage,
    args: [type, params],
  })
  const firstResult = injection?.[0]

  if (!firstResult) {
    throw new Error('The browser returned no result from the active page.')
  }

  if (firstResult.error) {
    throw new Error(firstResult.error.message || String(firstResult.error))
  }

  return {
    result: {
      ...firstResult.result,
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url ?? '',
      title: tab.title ?? firstResult.result?.title ?? '',
    },
    tab,
  }
}

async function waitForInTab(tab, params) {
  const timeoutMs = Math.max(
    100,
    Math.min(Number(params.timeoutMs) || 10_000, 30_000),
  )
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const injection = await api.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      func: checkWaitCondition,
      args: [params],
    })
    const ok = injection?.[0]?.result === true
    if (ok) {
      return {
        message: 'wait_for satisfied',
        waitedMs: Date.now() - started,
        tabId: tab.id,
        windowId: tab.windowId,
        url: tab.url ?? '',
      }
    }
    await delay(150)
  }
  throw new Error(`wait_for timed out after ${timeoutMs}ms`)
}

/** Injected: returns true if wait condition holds. */
function checkWaitCondition(params) {
  const selector = String(params.selector || '').trim()
  const textNeedle = String(params.textContains || params.text || '')
    .trim()
    .toLowerCase()
  if (selector) {
    try {
      const el = document.querySelector(selector)
      if (el) {
        const style = window.getComputedStyle(el)
        const rect = el.getBoundingClientRect()
        if (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0
        ) {
          return true
        }
      }
    } catch {
      throw new Error(`Invalid CSS selector: ${selector}`)
    }
  }
  if (textNeedle) {
    const bodyText = (document.body?.innerText || '').toLowerCase()
    if (bodyText.includes(textNeedle)) return true
  }
  return false
}

async function listTabs(params = {}) {
  const max = Math.max(1, Math.min(Number(params.limit) || 30, 80))
  const tabs = await api.tabs.query({})
  const rows = tabs
    .filter((tab) => isScriptableUrl(tab?.url))
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
    .slice(0, max)
    .map((tab) => ({
      tabId: tab.id,
      windowId: tab.windowId,
      active: Boolean(tab.active),
      title: String(tab.title || '').slice(0, 120),
      // Full URL for agent targeting; fleet heartbeat still uses origin only.
      url: tab.url || '',
      origin: isScriptableUrl(tab.url) ? new URL(tab.url).origin : '',
    }))

  return {
    message: `${rows.length} open web tab(s)`,
    tabs: rows,
    tabCount: rows.length,
  }
}

async function captureTab(tab) {
  const windowId = tab.windowId
  // Capture the tab's window; may capture active tab in that window.
  if (tab.active === false) {
    await api.tabs.update(tab.id, { active: true })
    await delay(150)
  }
  const dataUrl = await api.tabs.captureVisibleTab(windowId, {
    format: 'png',
  })
  return {
    message: 'Captured visible tab',
    tabId: tab.id,
    windowId,
    url: tab.url ?? '',
    title: tab.title ?? '',
    mimeType: 'image/png',
    // The data URL can be large.
    imageDataUrl: dataUrl,
  }
}

async function navigate(params, config) {
  const url = validateNavigationUrl(params.url)
  const openNewTab = params.newTab === true || config.targetMode === 'new-tab'
  let tab

  if (openNewTab) {
    tab = await api.tabs.create({
      url,
      active: params.active !== false,
      ...(Number.isInteger(params.windowId) ? { windowId: params.windowId } : {}),
    })
  } else {
    tab = await selectTargetTab(params, config.targetMode)
    tab = await api.tabs.update(tab.id, {
      url,
      active: params.active !== false,
    })
  }

  if (params.waitForLoad !== false) {
    tab = await waitForTabLoad(tab.id, 15_000)
  }

  return {
    message: `Navigated to ${url}`,
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url || url,
  }
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
  const needle = String(params.urlContains ?? '').trim().toLowerCase()
  const fallbackUrl = String(params.url ?? '').trim()

  if (needle) {
    const tabs = await api.tabs.query({})
    const match = tabs
      .filter(
        (tab) =>
          Number.isInteger(tab?.id) &&
          isScriptableUrl(tab.url) &&
          String(tab.url).toLowerCase().includes(needle),
      )
      .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0]

    if (match) {
      const tab = await api.tabs.update(match.id, { active: true })
      if (api.windows?.update && Number.isInteger(tab?.windowId)) {
        await api.windows.update(tab.windowId, { focused: true }).catch(() => {})
      }
      return {
        message: `Activated the existing tab matching "${needle}"`,
        tabId: tab.id,
        windowId: tab.windowId,
        url: tab.url ?? match.url ?? '',
        title: tab.title ?? match.title ?? '',
        activatedExisting: true,
      }
    }
  }

  if (!fallbackUrl) {
    throw new Error(
      `No open tab matches "${needle}" and no url was given to open instead.`,
    )
  }

  const url = validateNavigationUrl(fallbackUrl)
  let tab = await api.tabs.create({ url, active: true })
  if (params.waitForLoad !== false) {
    tab = await waitForTabLoad(tab.id, 15_000)
  }
  return {
    message: `No matching tab was open; opened ${url}`,
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url || url,
    activatedExisting: false,
  }
}

async function selectTargetTab(params, targetMode) {
  if (Number.isInteger(params.tabId)) {
    return api.tabs.get(params.tabId)
  }

  let tabs
  if (Number.isInteger(params.windowId)) {
    tabs = await api.tabs.query({ windowId: params.windowId })
  } else if (params.urlContains) {
    tabs = await api.tabs.query({})
  } else if (targetMode === 'current-active') {
    tabs = await api.tabs.query({ active: true, currentWindow: true })
  } else {
    tabs = await api.tabs.query({ active: true })
  }

  const tab = pickTargetTab(tabs, params, targetMode)
  if (tab) return tab

  throw new Error(
    'No matching browser tab is available. Open a web page or specify a valid tabId.',
  )
}

async function assertPageAccess(tab) {
  if (!tab?.id || !isScriptableUrl(tab.url)) {
    throw new Error(
      'This page cannot be controlled. Browser settings, extension pages, and local files are protected.',
    )
  }

  const pattern = originPattern(tab.url)
  const granted = await api.permissions.contains({ origins: [pattern] })
  if (!granted) {
    throw new Error(
      `Website access is not granted for ${new URL(tab.url).origin}. Click “Allow this browser’s pages” in the extension popup.`,
    )
  }
}

function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(async () => {
      cleanup()
      try {
        resolve(await api.tabs.get(tabId))
      } catch {
        reject(new Error('The destination tab closed before it finished loading.'))
      }
    }, timeoutMs)

    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        cleanup()
        resolve(tab)
      }
    }

    const onRemoved = (removedTabId) => {
      if (removedTabId === tabId) {
        cleanup()
        reject(new Error('The destination tab closed before it finished loading.'))
      }
    }

    const cleanup = () => {
      clearTimeout(timeout)
      api.tabs.onUpdated.removeListener(onUpdated)
      api.tabs.onRemoved.removeListener(onRemoved)
    }

    api.tabs.onUpdated.addListener(onUpdated)
    api.tabs.onRemoved.addListener(onRemoved)
  })
}

/**
 * Injected into the page (isolated world). Keep pure-page; no chrome.* APIs.
 */
function runInPage(type, params) {
  const ATTR = 'data-hive-ref'
  const MAX_ELEMENTS = 80

  const cssPath = (el) => {
    if (!(el instanceof Element)) return ''
    if (el.id) {
      const id = CSS.escape(el.id)
      if (document.querySelectorAll(`#${id}`).length === 1) return `#${id}`
    }
    const parts = []
    let node = el
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.nodeName.toLowerCase()
      if (node.id) {
        parts.unshift(`#${CSS.escape(node.id)}`)
        break
      }
      const parent = node.parentElement
      if (parent) {
        const siblings = [...parent.children].filter(
          (c) => c.nodeName === node.nodeName,
        )
        if (siblings.length > 1) {
          const index = siblings.indexOf(node) + 1
          part += `:nth-of-type(${index})`
        }
      }
      parts.unshift(part)
      node = parent
    }
    return parts.join(' > ')
  }

  const resolveElement = () => {
    if (params.ref) {
      const ref = String(params.ref).trim()
      const byAttr = document.querySelector(`[${ATTR}="${ref.replace(/"/g, '')}"]`)
      if (byAttr) return byAttr
      throw new Error(
        `Snapshot ref not found: ${ref}. Call snapshot again and use a fresh ref.`,
      )
    }
    const selector = String(params.selector ?? '')
    let element
    try {
      element = document.querySelector(selector)
    } catch {
      throw new Error(`Invalid CSS selector: ${selector}`)
    }
    if (!element) throw new Error(`Element not found: ${selector}`)
    return element
  }

  const isVisible = (el) => {
    if (!(el instanceof Element)) return false
    if (
      !el.checkVisibility({
        opacityProperty: true,
        visibilityProperty: true,
        contentVisibilityAuto: true,
      })
    ) {
      return false
    }
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  const accessibleName = (el) => {
    const aria = el.getAttribute('aria-label')
    if (aria) return aria.trim().slice(0, 120)
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText)
        .filter(Boolean)
        .join(' ')
        .trim()
      if (text) return text.slice(0, 120)
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const lab = el.labels?.[0]?.innerText
      if (lab) return lab.trim().slice(0, 120)
      if (el.placeholder) return el.placeholder.trim().slice(0, 120)
      if (el.name) return el.name.slice(0, 120)
    }
    if (el instanceof HTMLSelectElement && el.name) return el.name.slice(0, 120)
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
    return text.slice(0, 120)
  }

  const roleOf = (el) => {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit
    const tag = el.tagName.toLowerCase()
    if (tag === 'a' && el.hasAttribute('href')) return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase()
      if (t === 'checkbox') return 'checkbox'
      if (t === 'radio') return 'radio'
      if (t === 'submit' || t === 'button') return 'button'
      return 'textbox'
    }
    if (el.isContentEditable) return 'textbox'
    return tag
  }

  if (type === 'snapshot') {
    const max = Math.max(
      1,
      Math.min(Number(params.maxElements) || MAX_ELEMENTS, MAX_ELEMENTS),
    )
    document.querySelectorAll(`[${ATTR}]`).forEach((el) => el.removeAttribute(ATTR))

    const selector =
      'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="menuitem"], [contenteditable="true"]'
    const candidates = [...document.querySelectorAll(selector)].filter(
      (el) => isVisible(el) && !el.closest('[aria-hidden="true"]'),
    )

    const elements = []
    for (const el of candidates) {
      if (elements.length >= max) break
      if (
        el instanceof HTMLInputElement &&
        (el.type === 'hidden' || el.type === 'password') &&
        params.includeSensitive !== true
      ) {
        if (el.type === 'hidden') continue
        // password: include as role only, no value
      }
      const ref = `e${elements.length}`
      el.setAttribute(ATTR, ref)
      const rect = el.getBoundingClientRect()
      elements.push({
        ref,
        role: roleOf(el),
        name: accessibleName(el),
        tag: el.tagName.toLowerCase(),
        selector: cssPath(el),
        disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
        checked:
          el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')
            ? Boolean(el.checked)
            : el.getAttribute('aria-checked') === 'true'
              ? true
              : undefined,
        href: el instanceof HTMLAnchorElement ? el.href?.slice(0, 300) : undefined,
        inputType:
          el instanceof HTMLInputElement ? (el.type || 'text').toLowerCase() : undefined,
        /* Not for the agent to act on — these are what the privacy boundary
         * classifies with. A field's own name and autocomplete token are the
         * only reliable way to tell a card number from a quantity box, and
         * without them every snapshot ships credential fields as plain
         * textboxes. sanitizeExtraction strips fieldName back out for anything
         * it classifies as sensitive. */
        fieldName: el.getAttribute?.('name') || undefined,
        autocomplete: el.getAttribute?.('autocomplete') || undefined,
        bounds: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
      })
    }

    return {
      message: `Snapshot: ${elements.length} interactive element(s)`,
      title: document.title,
      url: location.href,
      elementCount: elements.length,
      elements,
    }
  }

  if (type === 'click') {
    const element = resolveElement()
    element.scrollIntoView({ block: 'center', inline: 'center' })
    element.click()
    const label = params.ref || params.selector
    return { message: `Clicked ${label}` }
  }

  if (type === 'type') {
    const element = resolveElement()
    if (
      element instanceof HTMLInputElement &&
      element.type === 'password' &&
      params.allowSensitiveInput !== true
    ) {
      throw new Error(
        'Typing into password fields requires allowSensitiveInput=true.',
      )
    }

    const text = String(params.text ?? '')
    element.focus()

    if (element instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set
      setter?.call(element, text)
    } else if (element instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set
      setter?.call(element, text)
    } else if (element.isContentEditable) {
      element.textContent = text
    } else {
      throw new Error('The selected element is not editable.')
    }

    element.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: text,
      }),
    )
    element.dispatchEvent(new Event('change', { bubbles: true }))

    if (params.submit) {
      if (element.form?.requestSubmit) {
        element.form.requestSubmit()
      } else {
        element.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            bubbles: true,
          }),
        )
      }
    }

    return { message: `Typed into ${params.ref || params.selector}` }
  }

  if (type === 'select') {
    const element = resolveElement()
    if (!(element instanceof HTMLSelectElement)) {
      throw new Error('select requires a <select> element.')
    }
    const value = String(params.value ?? '')
    const label = String(params.label ?? '')
    let matched = false
    for (const opt of element.options) {
      if (
        (value && opt.value === value) ||
        (label && opt.textContent.trim() === label) ||
        (label && opt.textContent.trim().includes(label))
      ) {
        element.value = opt.value
        matched = true
        break
      }
    }
    if (!matched) throw new Error('No matching option for select.')
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return { message: `Selected option on ${params.ref || params.selector}` }
  }

  if (type === 'scroll') {
    if (params.selector || params.ref) {
      const element = resolveElement()
      element.scrollIntoView({
        block: params.block || 'center',
        inline: 'nearest',
        behavior: 'instant',
      })
      return { message: `Scrolled to ${params.ref || params.selector}` }
    }
    const dy = Number(params.dy) || 0
    const dx = Number(params.dx) || 0
    window.scrollBy(dx, dy)
    return { message: `Scrolled by (${dx}, ${dy})` }
  }

  if (type === 'press_key') {
    const key = String(params.key || '')
    const target =
      params.selector || params.ref ? resolveElement() : document.activeElement || document.body
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, code: key, bubbles: true }),
    )
    target.dispatchEvent(
      new KeyboardEvent('keyup', { key, code: key, bubbles: true }),
    )
    return { message: `Pressed ${key}` }
  }

  if (type === 'read_page') {
    const maximum = Math.max(
      1,
      Math.min(Number(params.maxChars) || 12_000, 50_000),
    )
    const mode = String(params.mode || 'text')

    if (params.selector || params.ref) {
      const element = resolveElement()
      const content =
        mode === 'html'
          ? element.outerHTML
          : element.innerText || element.textContent || ''
      return {
        message: 'Read selected content',
        content: String(content ?? '').slice(0, maximum),
        title: document.title,
        mode,
      }
    }

    let content = ''
    if (mode === 'html') {
      content = document.documentElement?.outerHTML || ''
    } else if (mode === 'forms') {
      content = [...document.querySelectorAll('form')]
        .map((form, i) => {
          const fields = [...form.querySelectorAll('input,select,textarea')]
            .map((el) => {
              const name = el.name || el.id || el.getAttribute('aria-label') || el.type
              const kind = el.tagName.toLowerCase()
              return `  - ${kind}${el.type ? `[${el.type}]` : ''} name=${name}`
            })
            .join('\n')
          return `form#${i}\n${fields}`
        })
        .join('\n\n')
    } else if (mode === 'landmarks') {
      content = [
        ...document.querySelectorAll(
          'main, nav, header, footer, [role="main"], [role="navigation"], h1, h2',
        ),
      ]
        .map((el) => {
          const tag = el.tagName.toLowerCase()
          const name = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160)
          return `${tag}: ${name}`
        })
        .join('\n')
    } else if (mode === 'main_text') {
      const main =
        document.querySelector('main, [role="main"], article') || document.body
      content = main?.innerText || ''
    } else {
      content = document.body?.innerText || ''
    }

    return {
      message: `Read page (${mode})`,
      content: String(content ?? '').slice(0, maximum),
      title: document.title,
      mode,
    }
  }

  throw new Error(`Unsupported browser command: ${type}`)
}
