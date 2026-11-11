// Import observations from the local Rust request-ledger helper's JSON output.
// This never sends a request or grants authority to dispatch one.
export function reconcilePersonalAgentReceipts({ ledger, receipts, observedAt = new Date().toISOString() }) {
  if (!ledger || !Array.isArray(receipts) || !Number.isFinite(Date.parse(observedAt))) throw new Error('Invalid receipt snapshot');
  let imported = 0, matched = 0;
  for (const receipt of receipts) {
    if (!/^[a-f0-9]{32}$/.test(receipt?.receiptId) || !['accepted', 'rejected', 'unknown', 'dispatching'].includes(receipt?.status) || (receipt.text !== null && typeof receipt.text !== 'string')) throw new Error('Invalid receipt');
    const reference = `receipt:${receipt.receiptId}`;
    let task = ledger.snapshot().tasks.find(item => item.externalReceipt?.receiptId === receipt.receiptId || item.observations?.some(observation => observation.reference === reference));
    if (task) matched++;
    else {
      const id = `pc-receipt-${receipt.receiptId}`;
      task = ledger.recordInstruction({ id, sourceId: `personal-agent:${reference}`, text: receipt.text || '[Instruction content withheld by personal-agent ingress]' });
      imported++;
    }
    ledger.adoptReceipt(task.id, { receiptId: receipt.receiptId, status: receipt.status, observedAt });
  }
  return { imported, matched };
}

// Page cursors are for one descending scan only, never a permanent checkpoint.
// Collect the full snapshot before updating anything; an incomplete scan cannot
// be mistaken for absence, completion, or permission to resume work.
export async function reconcilePersonalAgentPages({ ledger, fetchPage, observedAt = new Date().toISOString(), maxPages = 10000 }) {
  if (typeof fetchPage !== 'function' || !Number.isInteger(maxPages) || maxPages < 1) throw new Error('Invalid receipt reader');
  let cursor = null; const seenCursors = new Set(); const receipts = []; const seenReceipts = new Set();
  for (let page = 0; page < maxPages; page++) {
    const result = await fetchPage(cursor);
    if (!result || !Array.isArray(result.receipts) || (result.nextCursor !== null && typeof result.nextCursor !== 'string')) throw new Error('Invalid receipt page');
    for (const receipt of result.receipts) {
      if (seenReceipts.has(receipt?.receiptId)) throw new Error('Duplicate receipt across pages');
      seenReceipts.add(receipt?.receiptId); receipts.push(receipt);
    }
    if (result.nextCursor === null) return { ...reconcilePersonalAgentReceipts({ ledger, receipts, observedAt }), pages: page + 1 };
    if (!result.nextCursor || seenCursors.has(result.nextCursor)) throw new Error('Invalid receipt cursor');
    seenCursors.add(result.nextCursor); cursor = result.nextCursor;
  }
  throw new Error('Receipt pagination limit exceeded');
}
