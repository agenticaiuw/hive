const INTENTS = [
  {
    id: 'time',
    builtin: 'time',
    exemplars: [
      'what time is it',
      'current time',
      'tell me the time',
      'what is the date today',
      '몇 시야',
      '지금 몇 시',
      '시간 알려줘',
      '오늘 날짜',
    ],
  },
  {
    id: 'weather',
    builtin: 'weather',
    exemplars: [
      'weather today',
      'how is the weather',
      'check the weather',
      'weather in seoul',
      'what is the weather',
      'tell me the weather',
      '날씨 어때',
      '오늘 날씨',
      '날씨 알려줘',
      '서울 날씨',
      '밖 날씨',
      '비 와?',
      'is it raining',
      'is it raining right now',
      'is it snowing',
      'will it rain',
    ],
    slotPatterns: [
      {
        name: 'location',
        regex:
          /(?:in|at|for)\s+([A-Za-z][A-Za-z\s,]+?)(?:\s+right\s+now)?[?.!]*$/i,
      },
      { name: 'location', regex: /(?:in|at|for)\s+([A-Za-z가-힣][A-Za-z가-힣\s,]*)/i },
      { name: 'location', regex: /([가-힣]+)\s*날씨/ },
    ],
  },
  {
    id: 'translate',
    builtin: 'translate',
    exemplars: [
      'translate hello to korean',
      'translate this to english',
      'how do you say hello in korean',
      '번역해줘',
      '영어로 번역',
      '한국어로 번역',
      'translate',
    ],
    slotPatterns: [
      {
        name: 'text',
        regex: /translate\s+(.+?)\s+(?:to|into)\s+/i,
      },
      {
        name: 'targetLang',
        regex: /(?:to|into)\s+(korean|english|japanese|spanish|french|한국어|영어|일본어)/i,
      },
      { name: 'text', regex: /번역해줘\s*(.+)$/ },
    ],
  },
  {
    id: 'meeting',
    builtin: 'meeting',
    exemplars: [
      'start meeting notes',
      'record this meeting',
      'take meeting notes',
      'log this meeting',
      '미팅 기록',
      '회의록 작성',
      '회의 기록해줘',
      '미팅 노트',
    ],
    slotPatterns: [
      { name: 'title', regex: /meeting(?: notes)?(?: for| about)?\s+(.+)$/i },
      { name: 'title', regex: /(?:회의|미팅)\s*(?:기록|노트)\s*(.+)$/ },
    ],
  },
  {
    id: 'brightness',
    builtin: 'brightness',
    exemplars: [
      'set brightness to 50%',
      'change the brightness to 50',
      'make the screen brighter',
      'dim the display',
      'brightness 30 percent',
      '밝기 50%',
      '화면 밝기 조절',
      '밝기 낮춰줘',
      '밝기 높여줘',
    ],
    slotPatterns: [
      { name: 'level', regex: /(\d{1,3})\s*%/ },
      { name: 'level', regex: /brightness(?:\s+to)?\s+(\d{1,3}|\d?\.\d+)/i },
      { name: 'level', regex: /밝기(?:\s*(?:를|을))?\s*(\d{1,3})/ },
    ],
  },
  {
    id: 'volume',
    builtin: 'volume',
    exemplars: [
      'set volume to 40%',
      'turn the volume up',
      'mute the sound',
      'unmute',
      'volume 20',
      '소리 줄여줘',
      '볼륨 50%',
      '음소거',
    ],
    slotPatterns: [
      { name: 'level', regex: /(\d{1,3})\s*%/ },
      { name: 'level', regex: /volume(?:\s+to)?\s+(\d{1,3})/i },
      { name: 'level', regex: /볼륨(?:\s*(?:을|를))?\s*(\d{1,3})/ },
    ],
  },
  {
    id: 'reminder',
    builtin: 'reminder',
    exemplars: [
      'remind me to take out the trash tonight at 9pm',
      'add a reminder to call mom tomorrow',
      'set a reminder for the meeting at 3pm',
      'create a reminder',
      '리마인더 추가해줘',
      '오늘 밤 9시에 쓰레기 버리라고 리마인더',
      '내일 리마인더 설정',
    ],
    slotPatterns: [
      {
        name: 'title',
        regex: /remind(?:er)?\s+(?:me\s+)?(?:to\s+)?(.+?)(?:\s+(?:tonight|today|tomorrow|at|on|by)\b|$)/i,
      },
      {
        name: 'title',
        regex: /add(?:\s+a)?\s+reminder(?:\s+to)?\s+(.+?)(?:\s+(?:tonight|today|tomorrow|at|on|by)\b|$)/i,
      },
    ],
  },
]

const CONFIDENCE_INSTANT = 0.62
const CONFIDENCE_HINT = 0.38

export function classifyIntent(command) {
  const normalized = normalizeText(command)
  const tokens = tokenize(normalized)
  let best = { intent: null, confidence: 0, slots: {} }

  for (const intent of INTENTS) {
    const score = scoreIntent(intent, normalized, tokens)

    if (score > best.confidence) {
      best = {
        intent: intent.id,
        builtin: intent.builtin,
        confidence: score,
        slots: extractSlots(intent, command),
      }
    }
  }

  // Strong keyword hits should go through dedicated builtins, not fragile LLM shell plans.
  if (best.intent === 'reminder' && /\bremind|\breminder|리마인더/.test(normalized)) {
    best.confidence = Math.max(best.confidence, CONFIDENCE_INSTANT)
  }
  if (best.intent === 'brightness' && /brightness|밝기/.test(normalized)) {
    best.confidence = Math.max(best.confidence, CONFIDENCE_INSTANT)
  }
  if (
    best.intent === 'volume' &&
    /\bvolume\b|\bmute\b|볼륨|음소거/.test(normalized)
  ) {
    best.confidence = Math.max(best.confidence, CONFIDENCE_INSTANT)
  }
  if (
    /weather|forecast|raining|rainy|snowing|\brain\b|\bsnow\b|날씨|기온|우산|비\s*오|눈\s*오|습도|미세먼지|비\s*와/.test(
      normalized,
    ) &&
    !/\b(play|song|music|youtube|spotify|노래|음악|틀어|재생)\b/.test(normalized)
  ) {
    best = {
      intent: 'weather',
      builtin: 'weather',
      confidence: CONFIDENCE_INSTANT,
      slots: extractSlots(
        INTENTS.find((item) => item.id === 'weather'),
        command,
      ),
    }
  }
  if (
    /\b(time|date|clock)\b|몇\s*시|지금\s*시간|시간\s*알려|오늘\s*날짜/.test(
      normalized,
    ) &&
    !/weather|날씨|timer|stopwatch/.test(normalized)
  ) {
    best = {
      intent: 'time',
      builtin: 'time',
      confidence: Math.max(best.confidence, CONFIDENCE_INSTANT),
      slots: {},
    }
  }

  return {
    ...best,
    route:
      best.confidence >= CONFIDENCE_INSTANT
        ? 'builtin'
        : best.confidence >= CONFIDENCE_HINT
          ? 'hint'
          : 'llm',
  }
}

function scoreIntent(intent, normalized, tokens) {
  let best = 0

  for (const exemplar of intent.exemplars) {
    const example = normalizeText(exemplar)
    const exampleTokens = tokenize(example)
    const overlap = jaccard(tokens, exampleTokens)
    const substring = normalized.includes(example) ? 0.92 : 0
    const prefix = normalized.startsWith(example) ? 0.15 : 0
    const score = Math.max(overlap, substring) + prefix
    best = Math.max(best, Math.min(score, 1))
  }

  return best
}

function extractSlots(intent, command) {
  const slots = {}

  for (const pattern of intent.slotPatterns ?? []) {
    if (slots[pattern.name]) continue
    const match = command.match(pattern.regex)

    if (match?.[1]) {
      slots[pattern.name] = match[1].trim().replace(/[?.!,]+$/, '')
    }
  }

  return slots
}

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenize(value) {
  return new Set(value.split(' ').filter(Boolean))
}

function jaccard(left, right) {
  if (!left.size || !right.size) {
    return 0
  }

  let intersection = 0

  for (const token of left) {
    if (right.has(token)) {
      intersection += 1
    }
  }

  const union = new Set([...left, ...right]).size
  return union ? intersection / union : 0
}

export { CONFIDENCE_INSTANT, CONFIDENCE_HINT }
