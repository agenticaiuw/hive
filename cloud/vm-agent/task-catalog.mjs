// tools/list proves that an MCP server registered tools, not that the owner task's model
// received them. Inspect the first request from that very exec thread, including Responses
// Lite's additional_tools items. Keep only names and the verdict in the task's report.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function requestCatalog(request, threadId) {
  const tools = new Map();
  for (const tool of [...(request.tools ?? []),
    ...(request.input ?? []).filter(item => item.type === 'additional_tools').flatMap(item => item.tools ?? [])]) {
    if (tool.type === 'namespace') {
      for (const child of tool.tools ?? []) tools.set(`${tool.name}.${child.name}`, child);
    } else if (tool.name) {
      // Older runtimes flatten an MCP namespace into the function name.
      tools.set(tool.name.replace(/^(mcp__[^_]+)__(.+)$/, '$1.$2'), tool);
    }
  }
  const transfer = tools.get('mcp__desktop.transfer_file');
  const schema = transfer?.parameters ?? transfer?.inputSchema;
  const ok = schema?.properties?.check_only?.type === 'boolean'
    && schema?.properties?.direction?.enum?.includes('to_vm');
  return { thread_id: threadId, model: request.model, tools: [...tools.keys()].sort(), ok: Boolean(ok),
    ...(!ok ? { why: 'The owner task model did not receive desktop.transfer_file with the Mac-to-VM probe schema.' } : {}) };
}

/** null until this thread has made a model request; another thread's catalog is not evidence. */
export function readTaskCatalog(root, threadId) {
  if (!threadId) return null;
  let dirs;
  try { dirs = readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const dir of dirs.filter(d => d.isDirectory())) {
    let lines;
    try { lines = readFileSync(join(root, dir.name, 'trace.jsonl'), 'utf8').split('\n'); } catch { continue; }
    for (const line of lines) {
      let event;
      try { event = JSON.parse(line); } catch { continue; } // the writer may still be finishing this line
      if (event.payload?.type !== 'inference_started' || event.thread_id !== threadId) continue;
      const path = event.payload.request_payload?.path;
      if (!/^payloads\/[\w-]+\.json$/.test(path ?? '')) continue;
      try {
        return requestCatalog(JSON.parse(readFileSync(join(root, dir.name, path), 'utf8')), threadId);
      } catch { return null; } // the payload may not have finished writing yet
    }
  }
  return null;
}
