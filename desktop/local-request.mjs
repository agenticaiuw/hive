// Local integration boundary for the running PC agent. A successful response
// means only that the request was accepted, not that its work completed.
import net from 'node:net';

export function submitLocalRequest({ socketPath, text, sourceId, timeoutMs = 6000 }) {
  if (typeof socketPath !== 'string' || !socketPath || typeof text !== 'string' || !text.trim()) {
    return Promise.reject(new TypeError('socketPath and nonempty text are required'));
  }
  if (sourceId !== undefined && (typeof sourceId !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(sourceId))) return Promise.reject(new TypeError('Invalid sourceId'));
  const payload = JSON.stringify({ text, ...(sourceId ? { sourceId } : {}) }) + '\n';
  if (Buffer.byteLength(payload) > 16384) return Promise.reject(new RangeError('Request exceeds the PC agent limit'));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let result = Buffer.alloc(0);
    let settled = false;
    function finish(error, value) {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(value);
    }
    socket.setTimeout(timeoutMs, () => finish(new Error('PC agent request timed out; acceptance is unknown')));
    socket.on('connect', () => socket.write(payload));
    socket.on('data', chunk => {
      result = Buffer.concat([result, chunk]);
      if (result.length > 16384) return finish(new Error('PC agent response exceeds limit'));
      const end = result.indexOf(10);
      if (end < 0) return;
      try {
        const response = JSON.parse(result.subarray(0, end).toString('utf8'));
        if (typeof response?.ok !== 'boolean') throw new Error('Invalid response');
        const receiptId = typeof response.receiptId === 'string' && /^[a-f0-9]{32}$/.test(response.receiptId) ? response.receiptId : undefined;
        if (!response.ok && receiptId && ['dispatching', 'unknown'].includes(response.status)) return finish(null, { accepted: null, receiptId });
        if (!response.ok && receiptId && response.status === 'accepted' && response.error === 'Request already received; no repeat was started.') return finish(null, { accepted: true, receiptId });
        finish(null, { accepted: response.ok, error: response.ok ? undefined : response.error, ...(receiptId ? { receiptId } : {}) });
      } catch {
        finish(new Error('Invalid PC agent response; acceptance is unknown'));
      }
    });
    socket.on('error', () => finish(new Error('PC agent socket failed; acceptance is unknown')));
    socket.on('end', () => finish(new Error('PC agent closed without a complete response; acceptance is unknown')));
  });
}
