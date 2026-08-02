const LANGUAGE_CODES = {
  korean: 'ko',
  english: 'en',
  japanese: 'ja',
  spanish: 'es',
  french: 'fr',
  한국어: 'ko',
  영어: 'en',
  일본어: 'ja',
}

export async function runTranslateBuiltin({ slots, command }) {
  const text = slots.text ?? inferText(command)

  if (!text) {
    throw new Error('Could not detect text to translate.')
  }

  const targetLang = normalizeLang(slots.targetLang ?? inferTargetLang(command) ?? 'ko')
  const url = new URL('https://translate.googleapis.com/translate_a/single')
  url.searchParams.set('client', 'gtx')
  url.searchParams.set('sl', 'auto')
  url.searchParams.set('tl', targetLang)
  url.searchParams.set('dt', 't')
  url.searchParams.set('q', text)

  const response = await fetch(url)
  const payload = await response.json()
  const translated = payload?.[0]?.map((part) => part?.[0]).join('') ?? ''

  if (!translated) {
    throw new Error('Translation service returned an empty result.')
  }

  return {
    summary: `Translate to ${targetLang}`,
    response: translated,
    metadata: {
      sourceText: text,
      targetLang,
    },
    actions: [
      {
        type: 'copy_to_clipboard',
        label: 'Copy translation to clipboard',
        params: { text: translated },
      },
    ],
  }
}

function inferText(command) {
  const match =
    command.match(/translate\s+(.+?)\s+(?:to|into)\s+/i) ??
    command.match(/how do you say\s+(.+?)\s+in\s+/i) ??
    command.match(/번역해줘\s*(.+)$/)

  return match?.[1]?.trim() ?? null
}

function inferTargetLang(command) {
  const match = command.match(
    /(?:to|into|in)\s+(korean|english|japanese|spanish|french|한국어|영어|일본어)/i,
  )
  return match?.[1] ?? null
}

function normalizeLang(value) {
  const key = String(value ?? '').toLowerCase()
  return LANGUAGE_CODES[key] ?? (key.slice(0, 2) || 'ko')
}
