const MAX_SPEECH_CHARS = 180

let unlockedAudio = null

export function buildPlanSpeech(plan) {
  if (!plan || plan.status === 'error') {
    return plan?.message || 'Planning failed.'
  }

  const actions = Array.isArray(plan.actions) ? plan.actions : []
  if (!actions.length) {
    return 'Plan ready. Tap to confirm.'
  }

  const steps = actions
    .slice(0, 3)
    .map((action) => String(action.label || action.type || 'step').trim())
    .filter(Boolean)
    .join('. ')

  const extra =
    actions.length > 3 ? ` Plus ${actions.length - 3} more.` : ''

  return `Plan ready. ${steps}.${extra} Tap to confirm.`
}

export function buildResultSpeech({ result, message, failed = false } = {}) {
  const text = String(result || message || '').replace(/\s+/g, ' ').trim()

  if (!text) {
    return failed ? 'Failed.' : 'Done.'
  }

  if (failed) {
    return truncateSpeech(`Failed. ${text}`)
  }

  if (/^done$/i.test(text)) {
    return 'Done.'
  }

  // Instant answers (weather/time) should be spoken as-is, quickly.
  if (!/^done\b/i.test(text) && text.length <= 140) {
    return truncateSpeech(text)
  }

  const parts = text
    .split(/(?<=[.!?])\s+|\s{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 3)

  const compact = parts.length ? parts.join(' ') : text
  return truncateSpeech(compact)
}

export function preferKoreanSpeech(text = '') {
  if (/[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(text)) {
    return true
  }

  return Boolean(navigator.language?.startsWith('ko'))
}

export function isMobileClient() {
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || '')
}

/** Call from a user gesture (pendant tap) so later TTS can play on iOS. */
export async function unlockSpeechAudio() {
  try {
    if (!unlockedAudio) {
      unlockedAudio = new Audio()
      unlockedAudio.preload = 'auto'
    }

    unlockedAudio.src =
      'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='
    unlockedAudio.volume = 0.01
    await unlockedAudio.play()
    unlockedAudio.pause()
    unlockedAudio.currentTime = 0
  } catch {
    // ignore — still try later play()
  }

  try {
    window.speechSynthesis?.getVoices?.()
  } catch {
    // ignore
  }
}

export async function speakText(text, options = {}) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim()

  if (!cleaned) {
    return false
  }

  const utteranceText = truncateSpeech(cleaned)
  const lang =
    options.lang ||
    (preferKoreanSpeech(utteranceText) ? 'ko-KR' : 'en-US')
  const language = lang.startsWith('ko') ? 'ko' : 'en'

  stopSpeaking()

  const preferCloud =
    Boolean(options.cloudSpeak) &&
    (options.preferCloud || options.mode === 'remote' || isMobileClient())
  const mobileCloudFirst = preferCloud && isMobileClient()

  // Prefetch cloud audio while browser speech tries to start — removes wait
  // when on-device TTS is blocked (common on mobile Safari).
  const cloudPrefetch =
    preferCloud && options.cloudSpeak
      ? options
          .cloudSpeak({ text: utteranceText, language })
          .catch(() => null)
      : null

  // On phones, browser speech often never starts after async work — skip the
  // failed attempt delay and play cloud audio as soon as it arrives.
  if (!mobileCloudFirst) {
    const browserOk = await speakWithBrowser(utteranceText, lang)
    if (browserOk) {
      return true
    }
  }

  if (cloudPrefetch) {
    const payload = await cloudPrefetch
    if (payload) {
      return playCloudPayload(payload)
    }
  }

  // Desktop remote fallback if cloud failed.
  if (mobileCloudFirst) {
    const browserOk = await speakWithBrowser(utteranceText, lang)
    if (browserOk) {
      return true
    }
  }

  if (options.cloudSpeak && !preferCloud) {
    return speakWithCloud(utteranceText, {
      cloudSpeak: options.cloudSpeak,
      lang,
    })
  }

  return false
}

export function stopSpeaking() {
  try {
    window.speechSynthesis?.cancel()
  } catch {
    // ignore
  }

  try {
    if (unlockedAudio && !unlockedAudio.paused) {
      unlockedAudio.pause()
    }
  } catch {
    // ignore
  }
}

function truncateSpeech(text) {
  if (text.length <= MAX_SPEECH_CHARS) {
    return text
  }

  return `${text.slice(0, MAX_SPEECH_CHARS - 3)}...`
}

function speakWithBrowser(text, lang) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') {
      resolve(false)
      return
    }

    try {
      window.speechSynthesis.cancel()
    } catch {
      // ignore
    }

    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = lang
    utterance.rate = 1.05

    const voices = window.speechSynthesis.getVoices?.() || []
    const matched =
      voices.find(
        (voice) =>
          voice.lang?.toLowerCase().startsWith(lang.toLowerCase()) ||
          voice.lang?.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()),
      ) || null
    if (matched) {
      utterance.voice = matched
    }

    let settled = false
    let started = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      resolve(ok)
    }

    utterance.onstart = () => {
      started = true
      finish(true)
    }
    utterance.onend = () => finish(started)
    utterance.onerror = () => finish(false)

    // If speech never actually starts, fail fast so cloud TTS can play.
    window.setTimeout(() => {
      if (!started) {
        try {
          window.speechSynthesis.cancel()
        } catch {
          // ignore
        }
        finish(false)
      }
    }, 350)

    const start = () => {
      try {
        window.speechSynthesis.speak(utterance)
      } catch {
        finish(false)
      }
    }

    if (!voices.length && window.speechSynthesis.getVoices) {
      const warmup = () => {
        const nextVoices = window.speechSynthesis.getVoices() || []
        const nextMatched = nextVoices.find((voice) =>
          voice.lang?.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()),
        )
        if (nextMatched) {
          utterance.voice = nextMatched
        }
        start()
      }
      window.speechSynthesis.onvoiceschanged = warmup
      window.setTimeout(warmup, 40)
      return
    }

    start()
  })
}

async function speakWithCloud(text, { cloudSpeak, lang }) {
  try {
    const payload = await cloudSpeak({
      text,
      language: lang?.startsWith('ko') ? 'ko' : 'en',
    })
    return playCloudPayload(payload)
  } catch {
    return false
  }
}

async function playCloudPayload(payload) {
  try {
    const audioBase64 = payload?.audioBase64
    const mimeType = payload?.mimeType || 'audio/mpeg'

    if (!audioBase64) {
      return false
    }

    const src = `data:${mimeType};base64,${audioBase64}`
    const player = unlockedAudio || new Audio()
    unlockedAudio = player
    player.src = src
    player.volume = 1
    await player.play()

    await new Promise((resolve) => {
      player.onended = resolve
      player.onerror = resolve
    })
    return true
  } catch {
    return false
  }
}
