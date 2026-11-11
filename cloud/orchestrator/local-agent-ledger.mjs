// HTTP integration for the existing authenticated local-agent router.
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TaskLedger } from './task-ledger.mjs';
import { reconcilePersonalAgentPages } from './personal-agent-reconcile.mjs';

export function defaultLedgerPath() { return process.env.HIVEMIND_TASK_LEDGER || join(homedir(), '.hivemind', 'orchestrator', 'tasks.jsonl'); }

export function assertExecutionAllowed(ledger = new TaskLedger(defaultLedgerPath())) {
  if (ledger.snapshot().stopped) throw new Error('Execution stopped by user');
}

// Reconciliation only observes; it never dispatches or resumes work.
export function startReconciliationMonitor(ledger, { intervalMs = 10000, now = () => Date.now(), fetchReceiptPage = null } = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1000) throw new Error('Invalid reconciliation interval');
  let lastCheckedAt = null, error = null, receiptCheckedAt = null, receiptError = null, receiptRunning = false;
  function check() {
    try { ledger.reconcile(); lastCheckedAt = new Date(now()).toISOString(); error = null; }
    catch { error = 'Ledger reconciliation failed'; }
    if (fetchReceiptPage && !receiptRunning) {
      receiptRunning = true;
      void reconcilePersonalAgentPages({ ledger, fetchPage: fetchReceiptPage, observedAt: new Date(now()).toISOString() })
        .then(() => { receiptCheckedAt = new Date(now()).toISOString(); receiptError = null; })
        .catch(() => { receiptError = 'Personal-agent receipt reconciliation failed'; })
        .finally(() => { receiptRunning = false; });
    }
  }
  check();
  const timer = setInterval(check, intervalMs); timer.unref?.();
  return { check, close: () => clearInterval(timer), status: () => ({ lastCheckedAt, error, stale: lastCheckedAt === null || now() - Date.parse(lastCheckedAt) > intervalMs * 2, receiptCheckedAt, receiptError, receiptStale: !fetchReceiptPage || receiptCheckedAt === null || now() - Date.parse(receiptCheckedAt) > intervalMs * 2 }) };
}

export function registerInstructionLedgerRoutes(app, { ledger = new TaskLedger(defaultLedgerPath()), cancelAll = () => [], monitorIntervalMs = 0, fetchReceiptPage = null } = {}) {
  const monitor = monitorIntervalMs ? startReconciliationMonitor(ledger, { intervalMs: monitorIntervalMs, fetchReceiptPage }) : null;
  const fail = (res, error) => res.status(503).json({ ok: false, error: 'Instruction ledger unavailable or operation refused', detail: error.message });
  app.get('/instruction-ledger', (_req, res) => { try { res.json({ ok: true, ...ledger.reconcile(), monitor: monitor?.status() ?? null }); } catch (e) { fail(res, e); } });
  app.post('/instruction-ledger/stop', (req, res) => {
    // Cancel active local jobs even if the ledger is unavailable.
    const cancellations = cancelAll();
    try {
      ledger.stop(typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason : 'Explicit user stop');
      res.json({ ok: true, stopped: true, cancellations });
    } catch (e) { res.status(503).json({ ok: false, error: 'Stop could not be persisted', cancellations }); }
  });
  app.post('/instruction-ledger/resume', (req, res) => {
    try { ledger.resume({ authorization: 'explicit_user', reason: req.body?.reason }); res.json({ ok: true, stopped: false }); } catch (e) { fail(res, e); }
  });
  app.post('/instruction-ledger/:id/approve', (req, res) => {
    try { res.json({ ok: true, task: ledger.approve(req.params.id, { authorization: 'explicit_user', reason: req.body?.reason }) }); } catch (e) { fail(res, e); }
  });
  app.post('/instruction-ledger/:id/complete', (req, res) => {
    try { res.json({ ok: true, task: ledger.complete(req.params.id, req.body?.evidence) }); } catch (e) { fail(res, e); }
  });
  // Direct research and briefing requests have their own handlers and do not
  // pass through /execute. Heartbeats and result callbacks are not ingress.
  for (const route of ['/plan', '/execute', '/research', '/briefing', '/handle-this', '/handle-this/investigate']) app.use(route, (req, res, next) => {
    if (req.method !== 'POST' || req.path !== '/') return next();
    try {
      const text = (route.startsWith('/handle-this') ? JSON.stringify({ ask: req.body?.ask ?? null, questions: req.body?.questions ?? null, message: req.body?.message ?? null, note: req.body?.note ?? null }) : '') ||
        (typeof req.body?.command === 'string' ? req.body.command.trim() : '') ||
        (route === '/research' && typeof req.body?.topic === 'string' && req.body.topic.trim() ? `Research: ${req.body.topic.trim()}` : '') ||
        (route === '/briefing' ? `Prepare briefing: ${typeof req.body?.kind === 'string' && req.body.kind.trim() ? req.body.kind.trim() : 'morning'}` : '') ||
        (route === '/execute' && Array.isArray(req.body?.actions) && req.body.actions.length ? `Execute actions: ${JSON.stringify(req.body.actions)}` : '');
      if (!text) { if (ledger.snapshot().stopped) return res.status(409).json({ ok: false, error: 'Execution stopped' }); return next(); }
      const suppliedId = req.body?.instructionId;
      if (suppliedId != null && (typeof suppliedId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(suppliedId))) return res.status(400).json({ ok: false, error: 'Invalid instruction ID' });
      const id = suppliedId || randomUUID();
      const existing = ledger.snapshot().tasks.find(task => task.id === id);
      if (existing) {
        if (existing.sourceId !== `local-agent:${id}` || !ledger.matchesInstruction(existing, text)) return res.status(409).json({ ok: false, error: 'Instruction identity conflict', instructionId: id });
      } else {
        if ([req.body?.requiresApproval, req.body?.irreversible].some(value => value != null && typeof value !== 'boolean')) return res.status(400).json({ ok: false, error: 'Invalid instruction boundary' });
        ledger.recordInstruction({ id, sourceId: `local-agent:${id}`, text, requiresApproval: req.body?.requiresApproval ?? false, irreversible: req.body?.irreversible ?? false });
      }
      if (ledger.snapshot().stopped) return res.status(409).json({ ok: false, error: 'Execution stopped', instructionId: id });
      if (route !== '/plan') {
        try { ledger.startAttempt(id, id); }
        catch (error) { return res.status(409).json({ ok: false, error: error.message, instructionId: id }); }
      }
      if (route !== '/plan' && route !== '/execute') {
        // An interrupted process leaves dispatching; a completed HTTP handler
        // is admission only and is never treated as verified task completion.
        res.once('finish', () => {
          try { ledger.recordAdmission(id, id, res.statusCode < 400 ? 'accepted' : 'unknown'); } catch { /* remains uncertain */ }
        });
      }
      req.hivemindInstructionId = id;
      res.set('X-Hivemind-Instruction-Id', id);
      next();
    } catch (error) { fail(res, error); }
  });
  return ledger;
}
