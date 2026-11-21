// A stable catalog even before Gmail or a local model is configured: the task can
// distinguish missing authorization from a missing tool without another repair.
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configuredReview } from './gmail-review.mjs';
import { withHeard } from './meanwhile.mjs';

const step = { type: 'string', description: 'What this step is for, in a few words.' };
const review_id = { type: 'string', description: 'Stable review name, normally the original request ID. Reuse it on continuation.' };
const message_id = { type: 'string', description: 'An individual message ID returned by list_messages.' };
const offset = { type: 'integer', minimum: 0, default: 0 };
const limit = { type: 'integer', minimum: 1, maximum: 100, default: 50 };
const tool = (name, description, properties = {}, required = []) => ({ name, description,
  inputSchema: { type: 'object', additionalProperties: false, properties: { step, review_id, ...properties },
    required: ['step', 'review_id', ...required] } });

export const TOOLS = [
  tool('status', 'Saved progress and availability of the no-extra-spending local model. Does not access mail or run inference.'),
  tool('snapshot_unread', 'Collect one page of all unread message IDs, including spam/trash, without changing flags. Repeat until state=ready. '
    + 'The original snapshot is never replaced. If the mailbox changes during collection, use a new review_id; an invalid snapshot cannot be reviewed.'),
  tool('list_messages', 'Page through individual snapshot IDs and saved completion/error status. For resume, use pending=true at offset=0 after each reviewed batch.',
    { offset, limit, pending: { type: 'boolean', default: false } }),
  tool('read_message', 'Retrieve one full Gmail message without changing labels or read status. Returns cached JSON in character pages; '
    + 'read through next_offset=null. Text MIME bodies are decoded, binary attachments are listed, not interpreted.',
    { message_id, offset, max_chars: { type: 'integer', minimum: 1, maximum: 50_000, default: 20_000 } }, ['message_id']),
  tool('review_message', 'Review exactly one message with an existing local model in a network-disabled process, additional spending limit zero. '
    + 'No downloads or paid fallback. Saves classification, exact evidence, importance, deadlines and provenance. Reuses completed reviews. '
    + 'Missing runtime, oversized messages or invalid evidence remain pending; binary attachments require uncertainty.', { message_id }, ['message_id']),
  tool('report', 'Paginated prioritized findings, including Gmail links, sender/date, importance, evidence, deadlines and reasons for marketing exclusions. '
    + 'Read every page; complete=false means the original snapshot is not fully reviewed. Saved results work without a model or network.', { offset, limit }),
];

export function server(ledger) {
  return async message => {
    if (message.id == null) return null;
    const reply = result => ({ jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'initialize') return reply({ protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} }, serverInfo: { name: 'gmail_review', version: '1.0' } });
    if (message.method === 'tools/list') return reply({ tools: TOOLS });
    if (message.method === 'ping') return reply({});
    if (message.method !== 'tools/call') return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown method' } };
    try {
      const a = message.params?.arguments ?? {}, name = message.params?.name;
      if (!TOOLS.some(t => t.name === name)) throw new Error('Unknown Gmail review tool.');
      ledger.snapshot(a.review_id);
      let result;
      if (name === 'status') {
        let model;
        try { model = { configured: true, ...ledger.reviewer.check(), isolation_verified: false,
          note: 'Network isolation is enforced on each inference; runtime failure leaves the message pending.' }; }
        catch (error) { model = { configured: false, reason: error.message, additional_spending_limit: 0 }; }
        result = { ...ledger.status(a.review_id), gmail_configured: !!ledger.gmail.config?.account, model };
      } else if (name === 'snapshot_unread') result = await ledger.inventory(a.review_id);
      else if (name === 'list_messages') result = ledger.rows(a.review_id, a);
      else if (name === 'read_message') result = await ledger.read(a.review_id, a.message_id, a.offset, a.max_chars);
      else if (name === 'review_message') result = await ledger.review(a.review_id, a.message_id);
      else if (name === 'report') result = ledger.report(a.review_id, a.offset, a.limit);
      return reply({ content: [{ type: 'text', text: JSON.stringify(result) }] });
    } catch (error) { return reply({ isError: true, content: [{ type: 'text', text: error.message }] }); }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ledger = configuredReview(process.env.HIVE_VM_STATE ?? join(homedir(), 'hive-vm-agent', 'state'));
  const answer = server(ledger);
  let chain = Promise.resolve();
  createInterface({ input: process.stdin }).on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    chain = chain.then(async () => {
      const out = withHeard(await answer(message));
      if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
    });
  }).on('close', () => { chain.finally(() => ledger.close()); });
}
