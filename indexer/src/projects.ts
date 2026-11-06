import type { DatabaseSync } from 'node:sqlite'
import { utils } from 'ethers'
import { UpdateError, authorsOf } from './updates.js'

/**
 * Project profiles: what a token is building, shown on its page. A tagline,
 * what it is, links, the team and a roadmap, signed by the token's creator or
 * fee wallet (the same wallets that may post to its build log), so anyone can
 * check who wrote it. The newest signed profile replaces the last one.
 *
 * The signed text carries the whole profile, so a wallet shows exactly what is
 * being published:
 *
 *   Mesa project profile
 *   Token: 0x… (lower case)
 *   Time: <unix seconds>
 *
 *   <the profile as JSON, keys in a fixed order>
 *
 * A builder can also verify a GitHub account: sign "Mesa builder / Token / GitHub:
 * <username>" and post it, with the signature, in a public gist from that
 * account. Mesa reads the gist from GitHub's API and checks both ends.
 */

export interface Profile {
  tagline: string
  about: string
  website: string
  x: string
  telegram: string
  repo: string
  links: { label: string; url: string }[]
  team: { name: string; role: string; x: string }[]
  roadmap: { title: string; status: 'done' | 'now' | 'next'; when: string }[]
}

const CLOCK_SKEW = 10 * 60
const HANDLE = /^[A-Za-z0-9_]{1,15}$/
const TG = /^[A-Za-z0-9_]{4,32}$/
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/
const HTTPS = /^https:\/\/[^\s]{3,300}$/

const str = (v: unknown, max: number, what: string) => {
  const s = typeof v === 'string' ? v.trim() : ''
  if ([...s].length > max) throw new UpdateError(`${what}: at most ${max} characters`)
  if (/[\u0000-\u0008\u000b-\u001f]/.test(s)) throw new UpdateError(`${what}: no control characters`)
  return s
}
const match = (v: unknown, re: RegExp, what: string) => {
  const s = typeof v === 'string' ? v.trim().replace(/^@/, '') : ''
  if (s && !re.test(s)) throw new UpdateError(`${what}: not valid`)
  return s
}
const list = (v: unknown, max: number, what: string) => {
  const a = Array.isArray(v) ? v : []
  if (a.length > max) throw new UpdateError(`${what}: at most ${max}`)
  return a as Record<string, unknown>[]
}

/** The profile, checked and in a fixed shape and key order (what gets signed). */
export function cleanProfile(p: Record<string, unknown>): Profile {
  return {
    tagline: str(p.tagline, 120, 'tagline'),
    about: str(p.about, 1200, 'about'),
    website: match(p.website, HTTPS, 'website'),
    x: match(p.x, HANDLE, 'x'),
    telegram: match(p.telegram, TG, 'telegram'),
    repo: match(p.repo, REPO, 'repo'),
    links: list(p.links, 6, 'links').map((l) => ({
      label: str(l.label, 24, 'link label'),
      url: match(l.url, HTTPS, 'link'),
    })).filter((l) => l.url),
    team: list(p.team, 8, 'team').map((m) => ({
      name: str(m.name, 40, 'team name'),
      role: str(m.role, 40, 'team role'),
      x: match(m.x, HANDLE, 'team x'),
    })).filter((m) => m.name),
    roadmap: list(p.roadmap, 12, 'roadmap').map((r) => {
      const status = r.status === 'done' || r.status === 'now' ? r.status : 'next'
      return { title: str(r.title, 80, 'roadmap item'), status, when: str(r.when, 20, 'roadmap date') } as Profile['roadmap'][number]
    }).filter((r) => r.title),
  }
}

export function profileMessage(token: string, time: number, profile: Profile) {
  return `Mesa project profile\nToken: ${token.toLowerCase()}\nTime: ${time}\n\n${JSON.stringify(profile)}`
}

export function githubMessage(token: string, username: string) {
  return `Mesa builder\nToken: ${token.toLowerCase()}\nGitHub: ${username}`
}

export function migrateProjects(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_profiles (
      token TEXT PRIMARY KEY,
      author TEXT NOT NULL,
      profile TEXT NOT NULL,
      time INTEGER NOT NULL,
      signature TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_github (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      gist TEXT NOT NULL,
      author TEXT NOT NULL,
      verified_at INTEGER NOT NULL
    );
  `)
}

export function saveProfile(db: DatabaseSync, body: Record<string, unknown>) {
  const token = String(body.token ?? '').toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(token)) throw new UpdateError('token: not an address')
  const time = Number(body.time)
  const now = Math.floor(Date.now() / 1000)
  if (!Number.isInteger(time) || Math.abs(now - time) > CLOCK_SKEW) throw new UpdateError('time: must be within 10 minutes of now')
  const profile = cleanProfile((body.profile ?? {}) as Record<string, unknown>)
  let author: string
  try {
    author = utils.verifyMessage(profileMessage(token, time, profile), String(body.signature)).toLowerCase()
  } catch {
    throw new UpdateError('signature: not valid')
  }
  const authors = authorsOf(db, token)
  if (!authors.size) throw new UpdateError('token: not a launch Mesa knows', 404)
  if (!authors.has(author)) throw new UpdateError("signature: not from this token's creator or fee wallet", 403)
  const prev = db.prepare('SELECT time FROM project_profiles WHERE token = ?').get(token) as { time: number } | undefined
  if (prev && prev.time >= time) throw new UpdateError('a newer profile is already saved', 409)
  db.prepare(
    `INSERT INTO project_profiles (token, author, profile, time, signature) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET author = excluded.author, profile = excluded.profile, time = excluded.time, signature = excluded.signature`,
  ).run(token, author, JSON.stringify(profile), time, String(body.signature).toLowerCase())
  return { token, author, time, profile }
}

const lastTry = new Map<string, number>()

/** Checks a gist: from the named GitHub account, holding a valid signature by the token's creator or fee wallet. */
export async function verifyGithub(db: DatabaseSync, body: Record<string, unknown>) {
  const token = String(body.token ?? '').toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(token)) throw new UpdateError('token: not an address')
  const id = /^(?:https:\/\/gist\.github\.com\/(?:[A-Za-z0-9-]+\/)?)?([0-9a-f]{20,40})\/?$/i.exec(String(body.gist ?? '').trim())?.[1]
  if (!id) throw new UpdateError('gist: paste the link to your public gist')
  const now = Date.now()
  if (now - (lastTry.get(token) ?? 0) < 15_000) throw new UpdateError('one check every 15 seconds', 429)
  lastTry.set(token, now)
  const r = await fetch(`https://api.github.com/gists/${id}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'mesa-indexer' },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)
  if (!r) throw new UpdateError("GitHub isn't answering, try again in a minute", 502)
  if (r.status === 404) throw new UpdateError('gist: not found (it must be public)', 404)
  if (!r.ok) throw new UpdateError(`GitHub answered ${r.status}, try again in a minute`, 502)
  const g = (await r.json()) as { owner?: { login?: string }; files?: Record<string, { content?: string }> }
  const username = g.owner?.login
  if (!username) throw new UpdateError('gist: has no owner (anonymous gists cannot verify)')
  const text = Object.values(g.files ?? {})
    .map((f) => f.content ?? '')
    .join('\n')
    .replace(/\r/g, '')
  const sig = /Signature:\s*(0x[0-9a-fA-F]{130})/.exec(text)?.[1]
  if (!sig) throw new UpdateError('gist: no "Signature: 0x…" line found')
  // The name as the builder typed it when signing (GitHub names ignore case).
  const named = /GitHub:\s*([A-Za-z0-9-]{1,39})/.exec(text)?.[1] ?? username
  if (named.toLowerCase() !== username.toLowerCase())
    throw new UpdateError(`gist: signed for GitHub user ${named}, but posted by ${username}`, 403)
  let author: string
  try {
    author = utils.verifyMessage(githubMessage(token, named), sig).toLowerCase()
  } catch {
    throw new UpdateError('signature: not valid')
  }
  const authors = authorsOf(db, token)
  if (!authors.size) throw new UpdateError('token: not a launch Mesa knows', 404)
  if (!authors.has(author))
    throw new UpdateError(`signature: not for GitHub user ${username}, or not from this token's creator or fee wallet`, 403)
  const gist = `https://gist.github.com/${username}/${id}`
  db.prepare(
    `INSERT INTO project_github (token, username, gist, author, verified_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET username = excluded.username, gist = excluded.gist, author = excluded.author, verified_at = excluded.verified_at`,
  ).run(token, username, gist, author, Math.floor(now / 1000))
  return { token, username, gist, author }
}

export function getProject(db: DatabaseSync, token: string) {
  const p = db.prepare('SELECT author, profile, time, signature FROM project_profiles WHERE token = ?').get(token) as
    | { author: string; profile: string; time: number; signature: string }
    | undefined
  const gh = db.prepare('SELECT username, gist, author, verified_at FROM project_github WHERE token = ?').get(token) as
    | Record<string, unknown>
    | undefined
  const last = db.prepare('SELECT MAX(time) t, COUNT(*) n FROM build_updates WHERE token = ?').get(token) as { t: number | null; n: number }
  return {
    token,
    profile: p ? (JSON.parse(p.profile) as Profile) : null,
    author: p?.author ?? null,
    time: p?.time ?? null,
    signature: p?.signature ?? null,
    github: gh ?? null,
    lastShipped: last.t,
    updates: last.n,
  }
}
