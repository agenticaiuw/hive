/*
 * One question, one answer: does this utterance look like a SMALL request —
 * the kind a cheap background-tier model handles fine? Sole consumer is
 * policyRouter.js's tier hint. This file used to be a fuzzy intent router
 * (exemplar tables, jaccard scoring, slot extraction) that picked actions;
 * that was disabled in the orchestrator because token overlap chose actions
 * it should not have, and everything but the smallness signal was dead weight.
 * A miss here only costs a model choice, never a capability.
 */
const SMALL_REQUEST_PATTERNS = [
  ['time', /\b(time|date|clock)\b|몇\s*시|지금\s*시간|시간\s*알려|오늘\s*날짜/],
  ['weather', /weather|forecast|raining|rainy|snowing|\brain\b|\bsnow\b|날씨|기온|우산|비\s*오|눈\s*오|습도|미세먼지|비\s*와/],
  ['translate', /\btranslate\b|번역|how do you say/],
  ['meeting', /meeting notes|record this meeting|미팅 기록|회의록|회의 기록|미팅 노트/],
  ['brightness', /brightness|밝기/],
  ['volume', /\bvolume\b|\bmute\b|\bunmute\b|볼륨|음소거|소리 줄여|소리 키워/],
  ['reminder', /\bremind\b|\breminder\b|리마인더/],
]

// Media playback wording defeats the weather words ("play rain sounds"), and
// weather/timer wording defeats the time words ("weather right now", "timer").
const NOT_WEATHER = /\b(play|song|music|youtube|spotify|노래|음악|틀어|재생)\b/
const NOT_TIME = /weather|날씨|timer|stopwatch/

export function isSmallRequest(text) {
  const normalized = String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  for (const [intent, pattern] of SMALL_REQUEST_PATTERNS) {
    if (!pattern.test(normalized)) continue
    if (intent === 'weather' && NOT_WEATHER.test(normalized)) continue
    if (intent === 'time' && NOT_TIME.test(normalized)) continue
    return { small: true, intent }
  }

  return { small: false, intent: null }
}
