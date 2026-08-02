import fs from 'node:fs'
import path from 'node:path'
import { workspacePath } from '../config.js'

export async function runMeetingBuiltin({ slots, command, context }) {
  const now = new Date()
  const title = slots.title ?? inferTitle(command) ?? 'Meeting'
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/gi, '-')
    .replace(/^-+|-+$/g, '') || 'meeting'
  const filename = `${slug}-${now.toISOString().slice(0, 10)}.md`
  const filePath = path.join(workspacePath, 'meetings', filename)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })

  const recentNotes = (context?.recentTurns ?? [])
    .slice(-4)
    .map((turn) => `- ${turn.role}: ${turn.content}`)
    .join('\n')

  const content = `# ${title}

Started: ${now.toLocaleString()}
Session: ${context?.sessionId ?? 'unknown'}

## Agenda

-

## Notes

${recentNotes || '- '}

## Action Items

- [ ]
`

  fs.writeFileSync(filePath, content)

  return {
    summary: `Start meeting notes for ${title}`,
    response: `Meeting notes created at ${filePath}`,
    metadata: { path: filePath, title },
    actions: [
      {
        type: 'open_path',
        label: 'Open meeting notes',
        params: { path: filePath },
      },
    ],
  }
}

function inferTitle(command) {
  return (
    command.match(/meeting(?: notes)?(?: for| about)?\s+(.+)$/i)?.[1]?.trim() ??
    command.match(/(?:회의|미팅)\s*(?:기록|노트)\s*(.+)$/)?.[1]?.trim() ??
    null
  )
}
