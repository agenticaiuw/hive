// tools/list proves that an MCP server registered tools, not that the owner task's model
// received them on the surface it uses. Inspect every request from that very exec thread,
// including Responses Lite's additional_tools and code-mode declarations. Keep only names
// and the verdict in the task's report; a repaired transfer also needs its own live probe.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const toolName = name => name.replace(/^(mcp__[^_]+|hivefiles)__(.+)$/, '$1.$2');

export function requestCatalog(request, threadId) {
  const tools = new Map();
  for (const tool of [...(request.tools ?? []),
    ...(request.input ?? []).filter(item => item.type === 'additional_tools').flatMap(item => item.tools ?? [])]) {
    if (tool.type === 'namespace') {
      for (const child of tool.tools ?? []) tools.set(`${tool.name}.${child.name}`, child);
    } else if (tool.name) {
      // Older runtimes flatten an MCP namespace into the function name.
      tools.set(toolName(tool.name), tool);
    }
  }
  // Code mode declares its callable methods inside exec, not as top-level tools. Only
  // read declarations from that tool's own description; task words are not evidence.
  const exec = tools.get('functions.exec') ?? tools.get('exec');
  const codeTools = new Map();
  for (const match of (exec?.description ?? '').matchAll(/declare const tools: \{ (\w+)\(args: \{([\s\S]*?)\}\): Promise<[^;]+>; \};/g)) {
    codeTools.set(toolName(match[1]), match[2].replace(/^\s*\/\/.*$/gm, ''));
  }
  // When exec is present, a direct-only schema cannot prove the route the task uses.
  // The stable desktop fallback remains callable alongside the dedicated server.
  const ok = ['hivefiles.transfer_file', 'mcp__hivefiles.transfer_file', 'mcp__desktop.transfer_file'].some(name => {
    const transfer = tools.get(name);
    const schema = transfer?.parameters ?? transfer?.inputSchema;
    const declaration = codeTools.get(name) ?? '';
    return exec ? /^\s*check_only\??: boolean;$/m.test(declaration)
      && /^\s*direction: (?:"[^"]+"\s*\|\s*)*"to_vm"(?:\s*\|\s*"[^"]+")*;$/m.test(declaration)
      : schema?.properties?.check_only?.type === 'boolean' && schema?.properties?.direction?.enum?.includes('to_vm');
  });
  return { thread_id: threadId, model: request.model, tools: [...tools.keys()].sort(),
    code_tools: [...codeTools.keys()].sort(), ok: Boolean(ok),
    ...(!ok ? { why: `The owner task model did not receive hivefiles.transfer_file or desktop.transfer_file with the Mac-to-VM probe schema${exec ? ' inside functions.exec' : ''}.` } : {}) };
}

// againBrief appends this paragraph when a repair lands. Only a transfer repair
// requires the Mac before the task can act; ordinary VM tasks may run without it.
export function needsTransferProbe(text) {
  return [...text.matchAll(/Hive just changed itself for this task, because it couldn't ([^\n]+):\n/g)]
    .some(([, need]) => /transfer|mac.{0,30}file/i.test(need));
}

export function transferProbed(path, threadId) {
  try {
    const probe = JSON.parse(readFileSync(`${path}.probe`, 'utf8'));
    return Boolean(threadId && probe.thread_id === threadId && probe.ready === true);
  } catch { return false; }
}

// againBrief appends this line when a repair returns to the owner task, including when the
// board later continues that task in a new run. Ordinary tasks need no Mac readiness probe.
export function transferProbeRequired(brief) {
  return [...brief.matchAll(/^Hive just changed itself for this task, because it couldn't (.+):$/gm)]
    .some(([, need]) => /\bMac[- ]to[- ]VM\b/i.test(need) && /\btransfer\b|\bcopy\b/i.test(need));
}

/** The actual exec event, not a model's claim or a previous task's successful probe. */
export function transferProbeSucceeded(event) {
  const call = event.item;
  if (event.type !== 'item.completed' || call?.type !== 'mcp_tool_call' || call.status !== 'completed'
    || !['hivefiles', 'desktop', 'mac'].includes(call.server) || call.tool !== 'transfer_file'
    || call.arguments?.check_only !== true || call.arguments?.direction !== 'to_vm'
    || call.result?.isError || call.error) return false;
  return (call.result?.content ?? []).some(part => {
    if (part.type !== 'text') return false;
    try {
      const result = JSON.parse(part.text);
      return result.ready === true && result.copied === false && result.direction === 'to_vm'
        && result.mac_path === call.arguments.mac_path;
    } catch { return false; }
  });
}

/** null until all recorded requests are readable; another thread's catalog is not evidence.
 * Cache parsed payloads, which never change once complete, so polling doesn't reread task history. */
export function readTaskCatalog(root, threadId, seen = new Map()) {
  if (!threadId) return null;
  let dirs;
  try { dirs = readdirSync(root, { withFileTypes: true }); } catch { return null; }
  let catalog = null, requests = 0;
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
        const key = `${threadId}/${dir.name}/${path}`;
        let next = seen.get(key);
        if (!next) {
          next = requestCatalog(JSON.parse(readFileSync(join(root, dir.name, path), 'utf8')), threadId);
          seen.set(key, next);
        }
        catalog = { ...next, requests: ++requests };
        // A later healthy catalog cannot erase a request that ran without the tool.
        if (!catalog.ok) return catalog;
      } catch { return null; } // the payload may not have finished writing yet
    }
  }
  return catalog;
}

// Codex writes private traces as root, while hive-task runs as the VM user. The
// privileged reader returns only tool names and the verdict, never the raw request.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${JSON.stringify(readTaskCatalog(process.argv[2], process.argv[3]))}\n`);
}
