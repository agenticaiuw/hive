const STORAGE_KEY = 'pendant-ops-settings'

function defaults() {
  const isServedByAgent =
    window.location.port === '8000' ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1'

  const relayUrl = String(import.meta.env.VITE_RELAY_URL || '').replace(/\/$/, '')
  const useRelay =
    !isServedByAgent &&
    Boolean(relayUrl) &&
    import.meta.env.VITE_OPS_VIA_RELAY !== 'false'

  return {
    agentUrl: isServedByAgent
      ? `${window.location.protocol}//${window.location.host}`
      : import.meta.env.VITE_AGENT_URL ||
        (useRelay ? relayUrl : 'http://localhost:8000'),
    agentToken:
      import.meta.env.VITE_AGENT_TOKEN ||
      localStorage.getItem('macAgentToken') ||
      '',
    useRelayProxy: useRelay,
    relayApiKey: import.meta.env.VITE_RELAY_API_KEY || '',
  }
}

function isLocalOrSelfHostedAgentUrl(url) {
  const value = String(url || '')
  if (!value) return true
  if (/localhost|127\.0\.0\.1/.test(value)) return true
  try {
    const host = new URL(value, window.location.origin).hostname
    return (
      host === window.location.hostname ||
      host.endsWith('.vercel.app') ||
      host === 'aipendant.vercel.app'
    )
  } catch {
    return true
  }
}

export function loadOpsSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const saved = JSON.parse(raw)
      const base = defaults()
      const merged = { ...base, ...saved }

      // Public hosts must talk to the Cloudflare relay — never this same site
      // (same-site /ops/* returns HTML and causes "Unexpected token '<'").
      if (base.useRelayProxy) {
        merged.useRelayProxy = true
        if (isLocalOrSelfHostedAgentUrl(saved.agentUrl)) {
          merged.agentUrl = base.agentUrl
        }
        if (!merged.relayApiKey) {
          merged.relayApiKey = base.relayApiKey
        }
      }

      return merged
    }
  } catch {
    // ignore
  }
  return defaults()
}

export function saveOpsSettings(settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

export function createOpsClient(settings) {
  const useRelayProxy = Boolean(settings.useRelayProxy)
  const relayFromEnv = String(import.meta.env.VITE_RELAY_URL || '').replace(/\/$/, '')
  const baseUrl = (
    useRelayProxy
      ? relayFromEnv || settings.agentUrl
      : settings.agentUrl || ''
  ).replace(/\/$/, '')
  const relayApiKey =
    settings.relayApiKey || import.meta.env.VITE_RELAY_API_KEY || ''
  const agentToken = settings.agentToken || ''

  async function request(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase()
    let body = undefined
    if (options.body != null) {
      body =
        typeof options.body === 'string' ? JSON.parse(options.body) : options.body
    }

    const response = useRelayProxy
      ? await fetch(`${baseUrl}/v1/ops/proxy`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${relayApiKey}`,
          },
          body: JSON.stringify({
            method,
            path,
            body: body ?? null,
            deviceId: 'ops-dashboard',
          }),
        })
      : await fetch(`${baseUrl}${path}`, {
          ...options,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${agentToken}`,
            ...(options.headers || {}),
          },
        })

    const contentType = response.headers.get('content-type') || ''
    if (response.status === 204) {
      return null
    }

    if (!contentType.includes('application/json')) {
      throw new Error(
        useRelayProxy
          ? 'Cloud relay returned a non-JSON response. Check RELAY_URL / bridge.'
          : 'Got an HTML page instead of API JSON. Connection URL is probably wrong (do not point at the Vercel site itself).',
      )
    }

    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(payload.error || `Request failed (${response.status})`)
    }
    return payload
  }

  return {
    baseUrl,
    useRelayProxy,
    getSnapshot: async () => {
      let lastError = null
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await request('/ops/snapshot')
        } catch (error) {
          lastError = error
          if (!/Superseded|Timed out|504|502/i.test(String(error.message || ''))) {
            throw error
          }
          await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)))
        }
      }
      throw lastError
    },
    getStatus: () => request('/ops/status'),
    getSessions: () => request('/sessions'),
    createSession: (title) =>
      request('/sessions', {
        method: 'POST',
        body: JSON.stringify({ title }),
      }),
    renameSession: (sessionId, title) =>
      request(`/sessions/${sessionId}`, {
        method: 'PATCH',
        body: JSON.stringify({ title }),
      }),
    deleteSession: (sessionId) =>
      request(`/sessions/${sessionId}`, { method: 'DELETE' }),
    clearSession: (sessionId) =>
      request(`/sessions/${sessionId}/clear`, { method: 'POST' }),
    getContext: () => request('/context-graph'),
    resetContext: () => request('/context-graph/reset', { method: 'POST' }),
    demoContext: () => request('/context-graph/demo', { method: 'POST' }),
    getProjects: () => request('/projects'),
    getActiveProject: () => request('/projects/active'),
    setActiveProject: (projectId) =>
      request('/projects/active', {
        method: 'POST',
        body: JSON.stringify({ projectId }),
      }),
    updateActiveProject: (body) =>
      request('/projects/active', {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    upsertEntity: (body) =>
      request('/context-graph/entities', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    deleteEntity: (entityId) =>
      request(`/context-graph/entities/${entityId}`, { method: 'DELETE' }),
    addRelation: (body) =>
      request('/context-graph/relations', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    deleteRelation: (relationId) =>
      request(`/context-graph/relations/${relationId}`, { method: 'DELETE' }),
    getJobs: () => request('/jobs'),
    clearJobs: () => request('/jobs', { method: 'DELETE' }),
    cancelJob: (jobId) =>
      request(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }),
    undoJob: (jobId) =>
      request(`/jobs/${encodeURIComponent(jobId)}/undo`, { method: 'POST' }),
    undoLastJob: () => request('/jobs/undo-last', { method: 'POST' }),
    getPipeline: () => request('/pipeline'),
    clearPipeline: () => request('/pipeline', { method: 'DELETE' }),
    getPipelineAudio: async (pipelineId, direction = 'output') => {
      if (useRelayProxy) {
        throw new Error(
          'Audio preview is available only on the local Mac dashboard.',
        )
      }
      const response = await fetch(
        `${baseUrl}/pipeline/${encodeURIComponent(pipelineId)}/audio/${encodeURIComponent(direction)}`,
        {
          headers: {
            Authorization: `Bearer ${agentToken}`,
          },
        },
      )
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        throw new Error(
          payload.error || `Pipeline audio failed (${response.status})`,
        )
      }
      return response.blob()
    },
    openPipelineStream: ({ onMessage, onError, signal } = {}) => {
      // Relay cannot stream SSE — callers should rely on snapshot polling.
      if (useRelayProxy) {
        return {
          close: () => {},
          done: Promise.resolve(),
        }
      }

      const controller = signal ? null : new AbortController()
      const activeSignal = signal || controller.signal

      const run = (async () => {
        const response = await fetch(`${baseUrl}/pipeline/stream`, {
          headers: {
            Authorization: `Bearer ${agentToken}`,
            Accept: 'text/event-stream',
          },
          signal: activeSignal,
        })

        if (!response.ok) {
          const payload = await response.json().catch(() => ({}))
          throw new Error(payload.error || `Pipeline stream failed (${response.status})`)
        }

        const reader = response.body?.getReader()
        if (!reader) {
          throw new Error('Pipeline stream is unavailable in this browser.')
        }

        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const parts = buffer.split('\n\n')
          buffer = parts.pop() ?? ''

          for (const part of parts) {
            const lines = part.split('\n')
            const dataLine = lines.find((line) => line.startsWith('data:'))
            if (!dataLine) continue
            try {
              onMessage?.(JSON.parse(dataLine.slice(5).trim()))
            } catch {
              // Ignore malformed or partial SSE messages.
            }
          }
        }
      })()

      run.catch((error) => {
        if (error.name !== 'AbortError') {
          onError?.(error)
        }
      })

      return {
        close: () => controller?.abort(),
        done: run,
      }
    },
    getThinking: () => request('/thinking'),
    getLatestThinking: () => request('/thinking/latest'),
    openThinkingStream: ({ onMessage, onError, signal } = {}) => {
      // Relay cannot stream SSE — callers should rely on polling.
      if (useRelayProxy) {
        return {
          close: () => {},
          done: Promise.resolve(),
        }
      }

      const controller = signal ? null : new AbortController()
      const activeSignal = signal || controller.signal

      const run = (async () => {
        const response = await fetch(`${baseUrl}/thinking/stream`, {
          headers: {
            Authorization: `Bearer ${agentToken}`,
            Accept: 'text/event-stream',
          },
          signal: activeSignal,
        })

        if (!response.ok) {
          const payload = await response.json().catch(() => ({}))
          throw new Error(payload.error || `Thinking stream failed (${response.status})`)
        }

        const reader = response.body?.getReader()
        if (!reader) {
          throw new Error('Thinking stream is unavailable in this browser.')
        }

        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const parts = buffer.split('\n\n')
          buffer = parts.pop() ?? ''

          for (const part of parts) {
            const lines = part.split('\n')
            const dataLine = lines.find((line) => line.startsWith('data:'))
            if (!dataLine) continue
            try {
              const payload = JSON.parse(dataLine.slice(5).trim())
              onMessage?.(payload)
            } catch {
              // ignore malformed chunks
            }
          }
        }
      })()

      run.catch((error) => {
        if (error.name !== 'AbortError') {
          onError?.(error)
        }
      })

      return {
        close: () => controller?.abort(),
        done: run,
      }
    },
    getLogs: () => request('/logs'),
    refreshMachine: () =>
      request('/machine-context/refresh', { method: 'POST' }),
  }
}
