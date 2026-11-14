const PROTOCOL_TERMINATOR_LINE =
  /^(?:\[DONE\]|<\|(?:eot_id|im_end|end_of_text)\|>|(?:\[|<|__)?agent[_ -]*response[_ -]*complete(?:\]|>|__)?)$/i

export function isProtocolTerminatorLine(value) {
  return PROTOCOL_TERMINATOR_LINE.test(String(value || '').trim())
}

export function stripProtocolTerminators(value) {
  return String(value || '')
    .split(/\r?\n/)
    .filter((line) => !isProtocolTerminatorLine(line))
    .join('\n')
    .trim()
}

export function isProtocolOnlyText(value) {
  const text = String(value || '').trim()
  return Boolean(text) && !stripProtocolTerminators(text)
}
