const EXTENSION_ID = 'home-chrome'

async function getConfig() {
  return chrome.storage.sync.get(['agentUrl', 'agentToken'])
}

async function authHeaders(config) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.agentToken ?? ''}`,
  }
}

async function heartbeat() {
  const config = await getConfig()

  if (!config.agentUrl || !config.agentToken) {
    return
  }

  await fetch(`${config.agentUrl}/browser/heartbeat`, {
    method: 'POST',
    headers: await authHeaders(config),
    body: JSON.stringify({
      extensionId: EXTENSION_ID,
      userAgent: navigator.userAgent,
    }),
  })
}

async function pollLoop() {
  const config = await getConfig()

  if (!config.agentUrl || !config.agentToken) {
    setTimeout(pollLoop, 3000)
    return
  }

  try {
    await heartbeat()
    const response = await fetch(
      `${config.agentUrl}/browser/poll?extensionId=${EXTENSION_ID}`,
      {
        headers: await authHeaders(config),
      },
    )

    if (response.status === 204) {
      setTimeout(pollLoop, 1000)
      return
    }

    const payload = await response.json()
    const result = await executeCommand(payload.command)
    await fetch(`${config.agentUrl}/browser/result/${payload.command.commandId}`, {
      method: 'POST',
      headers: await authHeaders(config),
      body: JSON.stringify(result),
    })
  } catch (error) {
    console.warn('[pendant-bridge]', error.message)
  }

  setTimeout(pollLoop, 400)
}

async function executeCommand(command) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const targetTab = tab ?? (await chrome.tabs.create({ url: 'about:blank' }))
  const { type, params } = command.action

  try {
    if (type === 'navigate') {
      await chrome.tabs.update(targetTab.id, { url: params.url, active: true })
      return {
        ok: true,
        result: { message: `Navigated to ${params.url}` },
      }
    }

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      func: runInPage,
      args: [type, params],
    })

    return { ok: true, result }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

function runInPage(type, params) {
  if (type === 'click') {
    const element = document.querySelector(params.selector)

    if (!element) {
      throw new Error(`Element not found: ${params.selector}`)
    }

    element.click()
    return { message: `Clicked ${params.selector}` }
  }

  if (type === 'type') {
    const element = document.querySelector(params.selector)

    if (!element) {
      throw new Error(`Element not found: ${params.selector}`)
    }

    element.focus()
    element.value = params.text ?? ''

    element.dispatchEvent(new Event('input', { bubbles: true }))

    if (params.submit) {
      element.form?.submit()
    }

    return { message: `Typed into ${params.selector}` }
  }

  if (type === 'read_page') {
    if (params.selector) {
      const element = document.querySelector(params.selector)
      return {
        message: 'Read selected content',
        content: element?.innerText ?? '',
      }
    }

    if (params.mode === 'html') {
      return {
        message: 'Read page HTML',
        content: document.documentElement.outerHTML.slice(0, 20000),
      }
    }

    return {
      message: 'Read page text',
      content: document.body?.innerText?.slice(0, 12000) ?? '',
    }
  }

  throw new Error(`Unsupported browser command: ${type}`)
}

pollLoop()
