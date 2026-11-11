export async function runTimeBuiltin() {
  const now = new Date()
  const formatter = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  })

  const response = formatter.format(now)

  return {
    summary: 'Current date and time',
    response,
    metadata: {
      iso: now.toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  }
}
