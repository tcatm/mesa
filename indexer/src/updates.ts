import type { DatabaseSync } from 'node:sqlite'
import { utils } from 'ethers'

/**
 * The build log: short updates a token's team posts ("shipped v0.2", a demo,
 * a repo), each signed by the creator's wallet (or the token's fee wallet),
 * so anyone can check who wrote it. Shown on the token's page, newest first.
 *
 * The signed text is fixed, so a signature can't be reused for another token,
 * another update or another time:
 *
 *   Mesa build log
 *   Token: 0x… (lower case)
 *   Update: <text>
 *   Link: <https link, or ->
 *   Time: <unix seconds>
 */
export const UPDATE_MAX = 280
const PER_DAY = 10
const CLOCK_SKEW = 10 * 60

export interface UpdateInput {
  token: string
  text: string
  link?: string | null
  time: number
  signature: string
}

export function updateMessage(u: { token: string; text: string; link?: string | null; time: number }) {
  return `Mesa build log\nToken: ${u.token.toLowerCase()}\nUpdate: ${u.text}\nLink: ${u.link || '-'}\nTime: ${u.time}`
}

export function migrateUpdates(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS build_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL,
      author TEXT NOT NULL,
      text TEXT NOT NULL,
      link TEXT,
      time INTEGER NOT NULL,
      signature TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS build_updates_token ON build_updates(token, time);
    CREATE INDEX IF NOT EXISTS build_updates_time ON build_updates(time);
  `)
}

/** Who may post for a token: whoever launched it, and its fee wallet on Mesa. */
export function authorsOf(db: DatabaseSync, token: string): Set<string> {
  const out = new Set<string>()
  const add = (v: unknown) => typeof v === 'string' && /^0x[0-9a-f]{40}$/i.test(v) && out.add(v.toLowerCase())
  for (const r of db.prepare(`SELECT creator, fee_recipient FROM mesa_launches WHERE token = ?`).all(token) as Record<string, unknown>[]) {
    add(r.creator)
    add(r.fee_recipient)
  }
  for (const r of db.prepare(`SELECT creator FROM pools WHERE token = ?`).all(token) as Record<string, unknown>[]) add(r.creator)
  return out
}

export class UpdateError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

export function postUpdate(db: DatabaseSync, u: UpdateInput) {
  const token = String(u.token ?? '').toLowerCase()
  const text = String(u.text ?? '').trim()
  const link = u.link ? String(u.link).trim() : ''
  const time = Number(u.time)
  if (!/^0x[0-9a-f]{40}$/.test(token)) throw new UpdateError('token: not an address')
  if (!text || [...text].length > UPDATE_MAX) throw new UpdateError(`text: 1 to ${UPDATE_MAX} characters`)
  if (/[\u0000-\u0008\u000b-\u001f]/.test(text)) throw new UpdateError('text: no control characters')
  if (link && !/^https:\/\/[^\s]{3,300}$/.test(link)) throw new UpdateError('link: a full https:// link')
  const now = Math.floor(Date.now() / 1000)
  if (!Number.isInteger(time) || Math.abs(now - time) > CLOCK_SKEW) throw new UpdateError('time: must be within 10 minutes of now')
  let author: string
  try {
    author = utils.verifyMessage(updateMessage({ token, text, link, time }), String(u.signature)).toLowerCase()
  } catch {
    throw new UpdateError('signature: not valid')
  }
  const authors = authorsOf(db, token)
  if (!authors.size) throw new UpdateError('token: not a launch Mesa knows', 404)
  if (!authors.has(author)) throw new UpdateError("signature: not from this token's creator or fee wallet", 403)
  const recent = db.prepare(`SELECT COUNT(*) n FROM build_updates WHERE token = ? AND created_at > ?`).get(token, now - 86_400) as { n: number }
  if (recent.n >= PER_DAY) throw new UpdateError(`at most ${PER_DAY} updates a day per token`, 429)
  try {
    db.prepare(
      `INSERT INTO build_updates (token, author, text, link, time, signature, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(token, author, text, link || null, time, String(u.signature).toLowerCase(), now)
  } catch {
    throw new UpdateError('this update was already posted', 409)
  }
  return { token, author, text, link: link || null, time }
}

export function listUpdates(db: DatabaseSync, token: string | null, limit: number) {
  return (
    token
      ? db.prepare(`SELECT token, author, text, link, time, signature FROM build_updates WHERE token = ? ORDER BY time DESC LIMIT ?`).all(token, limit)
      : db.prepare(`SELECT token, author, text, link, time, signature FROM build_updates ORDER BY time DESC LIMIT ?`).all(limit)
  ) as Record<string, unknown>[]
}
