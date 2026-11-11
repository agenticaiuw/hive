// Durable record of every post and the only path by which one may be sent.
//
//   drafted -> approved -> sending -> sent | failed | unknown
//                 \-> cancelled
//
// A post is sent only while an approval for its exact content (platform, destination, text and
// attachment bytes) is fresh. `failed` means nothing was submitted. `unknown` means the submit
// went out but no proof of delivery was seen; it is never retried automatically, because a
// second attempt could publish the same words twice under the owner's name.
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export const postDigest = ({ platform, destination, text, attachments = [] }) =>
  createHash('sha256').update(JSON.stringify([platform, destination, text, attachments])).digest('hex');

export class PostError extends Error {
  constructor(code, message) { super(message); this.name = 'PostError'; this.code = code; }
}

const row = record => record && {
  id: record.id, platform: record.platform, destination: record.destination, text: record.text,
  attachments: JSON.parse(record.attachments), digest: record.digest, status: record.status, label: record.label,
  createdAt: record.created_at, updatedAt: record.updated_at, approvedAt: record.approved_at,
  detail: record.detail ? JSON.parse(record.detail) : null,
};

export class PostStore {
  #db;

  constructor(path, { now = () => Date.now() } = {}) {
    this.now = now;
    this.#db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.#db.exec(`CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY, platform TEXT NOT NULL, destination TEXT NOT NULL, text TEXT NOT NULL,
      attachments TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL, label TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, approved_at INTEGER, detail TEXT)`);
    // A send interrupted by a crash or restart may or may not have gone out.
    this.#db.prepare(`UPDATE posts SET status = 'unknown', updated_at = ?, detail = ? WHERE status = 'sending'`)
      .run(this.now(), JSON.stringify({ reason: 'interrupted_during_send', submitted: null }));
  }

  get(id) { return row(this.#db.prepare('SELECT * FROM posts WHERE id = ?').get(id)); }

  list(limit = 20) {
    return this.#db.prepare('SELECT * FROM posts ORDER BY created_at DESC LIMIT ?').all(Math.max(1, Math.min(200, limit))).map(row);
  }

  draft({ id = randomUUID(), platform, destination, text, attachments = [], label = null }) {
    const digest = postDigest({ platform, destination, text, attachments });
    const existing = this.get(id);
    if (existing) {
      if (existing.digest !== digest) throw new PostError('conflict', 'a different post already uses this id');
      return existing;
    }
    const at = this.now();
    this.#db.prepare(`INSERT INTO posts (id, platform, destination, text, attachments, digest, status, label, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'drafted', ?, ?, ?)`).run(id, platform, destination, text, JSON.stringify(attachments), digest, label, at, at);
    return this.get(id);
  }

  setLabel(id, label) { this.#db.prepare('UPDATE posts SET label = ? WHERE id = ?').run(label, id); }

  approve(id, digest) {
    const post = this.#require(id);
    if (!['drafted', 'approved'].includes(post.status)) throw new PostError('not_approvable', `post is ${post.status}`);
    if (digest !== post.digest) throw new PostError('digest_mismatch', 'approval does not match the drafted content');
    const at = this.now();
    this.#db.prepare(`UPDATE posts SET status = 'approved', approved_at = ?, updated_at = ? WHERE id = ?`).run(at, at, id);
    return this.get(id);
  }

  // Claim the post for sending. Exactly one caller can win; everything else is refused.
  begin(id, { approvalTtlMs }) {
    const post = this.#require(id);
    if (post.status === 'drafted') throw new PostError('not_approved', 'the owner has not approved this post');
    if (post.status !== 'approved') throw new PostError('not_sendable', `post is ${post.status}; it will not be sent again`);
    const at = this.now();
    if (at - post.approvedAt > approvalTtlMs) {
      this.#db.prepare(`UPDATE posts SET status = 'drafted', approved_at = NULL, updated_at = ? WHERE id = ? AND status = 'approved'`).run(at, id);
      throw new PostError('approval_expired', 'the approval is too old; approve the post again');
    }
    const claimed = this.#db.prepare(`UPDATE posts SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'approved'`).run(at, id);
    if (Number(claimed.changes) !== 1) throw new PostError('not_sendable', 'post is already being sent');
    return this.get(id);
  }

  finish(id, status, detail) {
    if (!['sent', 'failed', 'unknown'].includes(status)) throw new Error(`invalid final status ${status}`);
    const done = this.#db.prepare(`UPDATE posts SET status = ?, detail = ?, updated_at = ? WHERE id = ? AND status = 'sending'`)
      .run(status, JSON.stringify(detail ?? null), this.now(), id);
    if (Number(done.changes) !== 1) throw new PostError('not_sending', 'post was not being sent');
    return this.get(id);
  }

  cancel(id) {
    const post = this.#require(id);
    if (!['drafted', 'approved'].includes(post.status)) throw new PostError('not_cancellable', `post is ${post.status}`);
    this.#db.prepare(`UPDATE posts SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('drafted', 'approved')`).run(this.now(), id);
    return this.get(id);
  }

  close() { this.#db.close(); }

  #require(id) {
    const post = this.get(id);
    if (!post) throw new PostError('not_found', 'no such post');
    return post;
  }
}
