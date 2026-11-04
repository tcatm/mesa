import type { DatabaseSync } from 'node:sqlite'

/**
 * Token images and links, from what each launchpad published at launch.
 *
 * Launchpads put a token's metadata in its launch transaction in different
 * ways: ElysPump and BOXA as inline JSON (`{"image": ..., "twitter": ...}`) in
 * the calldata and a log, Flaunch as an `ipfs://` link to a JSON file. This
 * worker reads each new token's pool-creation transaction once, finds either,
 * and stores the fields it can trust (http(s) URLs only, bounded lengths).
 *
 * It runs beside the indexer, a few tokens at a time, so it never slows
 * indexing; tokens are checked once, whether or not anything was found.
 */
const IPFS_GATEWAY = 'https://ipfs.io/ipfs/'
const BATCH = 20

interface Meta {
  image?: string
  description?: string
  website?: string
  twitter?: string
  telegram?: string
}

/** Printable ASCII runs of at least 10 characters in hex data. */
function strings(hex: string): string[] {
  if (!hex || hex.length < 4) return []
  const b = Buffer.from(hex.slice(2), 'hex')
  const out: string[] = []
  let cur = ''
  for (const c of b) {
    if (c >= 0x20 && c <= 0x7e) cur += String.fromCharCode(c)
    else {
      if (cur.length >= 10) out.push(cur)
      cur = ''
    }
  }
  if (cur.length >= 10) out.push(cur)
  return out
}

const ipfs = (u: string) => (u.startsWith('ipfs://') ? IPFS_GATEWAY + u.slice(7).replace(/^ipfs\//, '') : u)

function url(v: unknown, max = 500): string | undefined {
  if (typeof v !== 'string') return undefined
  const u = ipfs(v.trim())
  if (u.length > max || !/^https:\/\/[^\s"'<>]+$/i.test(u)) return undefined
  return u
}

function text(v: unknown, max = 600): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined
}

/** The fields we keep from a metadata object, under the names launchpads use. */
function fromJson(o: Record<string, unknown>): Meta {
  const socials = (o.socials ?? o.links ?? {}) as Record<string, unknown>
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = o[k] ?? socials[k]
      if (v !== undefined) return v
    }
    return undefined
  }
  const twitter = url(pick('twitter', 'x', 'twitterUrl'))
  return {
    image: url(pick('image', 'imageUrl', 'logo', 'icon')),
    description: text(pick('description', 'desc')),
    website: url(pick('website', 'websiteUrl', 'web')),
    twitter: twitter && /^https:\/\/(x|twitter)\.com\//i.test(twitter) ? twitter : undefined,
    telegram: (() => {
      const t = url(pick('telegram', 'telegramUrl', 'tg'))
      return t && /^https:\/\/(t\.me|telegram\.me)\//i.test(t) ? t : undefined
    })(),
  }
}

/** A JSON object embedded in a string, if it holds metadata. */
function embeddedJson(s: string): Meta | null {
  const i = s.indexOf('{')
  const j = s.lastIndexOf('}')
  if (i < 0 || j <= i) return null
  try {
    const o = JSON.parse(s.slice(i, j + 1)) as unknown
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      const m = fromJson(o as Record<string, unknown>)
      return Object.values(m).some(Boolean) ? m : null
    }
  } catch {
    // not JSON
  }
  return null
}

async function fetchJson(u: string): Promise<Meta | null> {
  try {
    const res = await fetch(u, { signal: AbortSignal.timeout(8_000), headers: { accept: 'application/json' } })
    if (!res.ok) return null
    const type = res.headers.get('content-type') ?? ''
    if (type.startsWith('image/')) return { image: u }
    const body = await res.text()
    if (body.length > 200_000) return null
    return embeddedJson(body)
  } catch {
    return null
  }
}

export class MetadataWorker {
  constructor(
    private db: DatabaseSync,
    private rpcUrl: string,
  ) {}

  private async rpcBatch(calls: { method: string; params: unknown[] }[]) {
    const res = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(calls.map((c, id) => ({ jsonrpc: '2.0', id, ...c }))),
      signal: AbortSignal.timeout(30_000),
    })
    const out = (await res.json()) as { id: number; result?: unknown }[]
    return calls.map((_, i) => out.find((r) => r.id === i)?.result)
  }

  /** Metadata for one launch transaction: inline JSON first, then a linked file. */
  private async metaOf(tx: { input?: string } | undefined, receipt: { logs?: { data: string }[] } | undefined): Promise<Meta> {
    const found = [...strings(tx?.input ?? ''), ...(receipt?.logs ?? []).flatMap((l) => strings(l.data))]
    for (const s of found) {
      const m = embeddedJson(s)
      if (m) return m
    }
    for (const s of found) {
      const link = s.match(/(ipfs:\/\/[A-Za-z0-9/._-]{20,}|https:\/\/[^\s"'<>]{10,})/)?.[1]
      if (!link) continue
      const u = ipfs(link)
      const m = await fetchJson(u)
      if (m) {
        if (m.image) m.image = url(m.image)
        return m
      }
    }
    return {}
  }

  async step(): Promise<number> {
    const todo = this.db
      .prepare(
        `SELECT p.token, p.tx FROM pools p
         JOIN (SELECT token, MIN(block) b FROM pools GROUP BY token) f ON f.token = p.token AND f.b = p.block
         LEFT JOIN token_meta m ON m.token = p.token
         WHERE m.token IS NULL LIMIT ?`,
      )
      .all(BATCH) as { token: string; tx: string }[]
    if (!todo.length) return 0
    const [txs, receipts] = await Promise.all([
      this.rpcBatch(todo.map((t) => ({ method: 'eth_getTransactionByHash', params: [t.tx] }))),
      this.rpcBatch(todo.map((t) => ({ method: 'eth_getTransactionReceipt', params: [t.tx] }))),
    ])
    const put = this.db.prepare(
      `INSERT OR REPLACE INTO token_meta (token, image, description, website, twitter, telegram, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    const metas = await Promise.all(
      todo.map((_, i) => this.metaOf(txs[i] as { input?: string }, receipts[i] as { logs?: { data: string }[] })),
    )
    const now = Math.floor(Date.now() / 1000)
    todo.forEach((t, i) => {
      const m = metas[i] ?? {}
      put.run(t.token, m.image ?? null, m.description ?? null, m.website ?? null, m.twitter ?? null, m.telegram ?? null, now)
    })
    return todo.length
  }

  async run() {
    for (;;) {
      try {
        const n = await this.step()
        await sleep(n === BATCH ? 500 : 5_000)
      } catch (e) {
        console.error(JSON.stringify({ metadataError: e instanceof Error ? e.message.slice(0, 200) : String(e) }))
        await sleep(15_000)
      }
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
