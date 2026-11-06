import type { DatabaseSync } from 'node:sqlite'

import { setMeta } from './db.js'

/**
 * The $HYPE & $KNTQ OG snapshot for the Builder Drop. For every wallet that
 * has used Elysium (and any wallet someone checks on mesa.cx/airdrop), it
 * records what the wallet held at the snapshot:
 *
 *   - kHYPE and KNTQ on HyperEVM, read at the snapshot block (historical
 *     eth_call, so buying later doesn't count);
 *   - HYPE staked on HyperCore at the snapshot time, rebuilt from the
 *     wallet's delegation history;
 *   - HYPE, kHYPE and KNTQ spot balances on HyperCore. Hyperliquid has no
 *     historical spot balances, so these are taken once, before the
 *     announcement (AIRDROP_ANNOUNCE); a wallet first seen after it only
 *     gets the historical parts.
 *
 * KNTQ is valued in HYPE at the snapshot (hourly candles), so the pool can
 * weigh everything as "HYPE held".
 */
const INFO = 'https://api.hyperliquid.xyz/info'
const EVM = process.env.HYPEREVM_RPC ?? 'https://rpc.hyperliquid.xyz/evm'
const KHYPE = '0xfd739d4e423301ce9385c1fb8850539d657c296d'
const KNTQ = '0x000000000000780555bd0bca3791f89f9542c2d6'
/** Snapshot: Nov 6, 2026 00:00 UTC, before the drop was announced. */
export const SNAPSHOT = Number(process.env.AIRDROP_SNAPSHOT ?? 1793923200)
/** Nov 7 00:00 UTC by default; set it to the announcement. After this, spot balances are no longer recorded (they can't be read back in time). */
export const ANNOUNCE = Number(process.env.AIRDROP_ANNOUNCE ?? 1794009600)

export function migrateOg(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS og_snapshot (
      wallet TEXT PRIMARY KEY,
      khype_evm REAL NOT NULL DEFAULT 0,
      kntq_evm REAL NOT NULL DEFAULT 0,
      staked REAL NOT NULL DEFAULT 0,
      spot_hype REAL NOT NULL DEFAULT 0,
      spot_khype REAL NOT NULL DEFAULT 0,
      spot_kntq REAL NOT NULL DEFAULT 0,
      spot_at INTEGER,
      checked_at INTEGER NOT NULL
    );
  `)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function info<T>(body: Record<string, unknown>): Promise<T> {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(INFO, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
    if (r.status === 429) {
      await sleep(5_000 * (i + 1))
      continue
    }
    if (!r.ok) throw new Error(`hyperliquid ${r.status}`)
    return (await r.json()) as T
  }
  throw new Error('hyperliquid rate limited')
}

async function rpc(calls: { method: string; params: unknown[] }[]): Promise<(string | null)[]> {
  const body = calls.map((c, id) => ({ jsonrpc: '2.0', id, ...c }))
  for (let i = 0; i < 4; i++) {
    const r = await fetch(EVM, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
    if (r.status === 429) {
      await sleep(5_000 * (i + 1))
      continue
    }
    const out = (await r.json()) as { id: number; result?: string }[] | { id: number; result?: string }
    const list = Array.isArray(out) ? out : [out]
    const byId = new Map(list.map((x) => [x.id, x.result ?? null]))
    return calls.map((_, id) => byId.get(id) ?? null)
  }
  throw new Error('hyperevm rate limited')
}

let snapshotBlock: string | null = null
/** The last HyperEVM block at or before the snapshot time (binary search on timestamps). */
async function blockAt(ts: number): Promise<string> {
  if (snapshotBlock) return snapshotBlock
  const [head] = await rpc([{ method: 'eth_blockNumber', params: [] }])
  let lo = 0
  let hi = Number(BigInt(head!))
  const time = async (b: number) => {
    const [r] = await rpc([{ method: 'eth_getBlockByNumber', params: [`0x${b.toString(16)}`, false] }])
    return Number(BigInt((r as unknown as { timestamp: string } | null)?.timestamp ?? '0x0'))
  }
  // HyperEVM blocks are about a second apart: start near the guess, then bisect.
  const guess = Math.max(0, hi - Math.max(0, Math.floor(Date.now() / 1000) - ts) - 50_000)
  if ((await time(guess)) <= ts) lo = guess
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if ((await time(mid)) <= ts) lo = mid
    else hi = mid - 1
  }
  snapshotBlock = `0x${lo.toString(16)}`
  return snapshotBlock
}

// rpc() returns the raw JSON-RPC result; for eth_getBlockByNumber that's an object.
const units = (hex: string | null, decimals = 18) => (hex && hex !== '0x' ? Number(BigInt(hex)) / 10 ** decimals : 0)
const pad = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0')

let kntqInHype: number | null = null
/** KNTQ's price in HYPE at the snapshot, from hourly spot candles (both priced in USDC). */
export async function kntqPrice(): Promise<number> {
  if (kntqInHype !== null) return kntqInHype
  const meta = await info<{ universe: { name: string; tokens: number[] }[]; tokens: { name: string; index: number }[] }>({ type: 'spotMeta' })
  const idx = (n: string) => meta.tokens.find((t) => t.name === n)?.index
  const pair = (n: string) => {
    const i = idx(n)
    const u = meta.universe.find((x) => x.tokens[0] === i && x.tokens[1] === 0)
    return u?.name
  }
  const close = async (coin: string | undefined) => {
    if (!coin) return 0
    const c = await info<{ c: string }[]>({ type: 'candleSnapshot', req: { coin, interval: '1h', startTime: (SNAPSHOT - 3_600) * 1000, endTime: SNAPSHOT * 1000 } })
    return Number(c.at(-1)?.c ?? 0)
  }
  const [k, h] = await Promise.all([close(pair('KNTQ')), close(pair('HYPE'))])
  kntqInHype = k > 0 && h > 0 ? k / h : 0
  return kntqInHype
}

/** Snapshot one wallet (and store it). */
export async function snapshotWallet(db: DatabaseSync, wallet: string) {
  const w = wallet.toLowerCase()
  const now = Math.floor(Date.now() / 1000)
  const block = await blockAt(SNAPSHOT)
  const [kh, kn] = await rpc([
    { method: 'eth_call', params: [{ to: KHYPE, data: `0x70a08231${pad(w)}` }, block] },
    { method: 'eth_call', params: [{ to: KNTQ, data: `0x70a08231${pad(w)}` }, block] },
  ])
  // Staked HYPE at the snapshot: today's delegations, with every change since the snapshot undone.
  let staked = 0
  const sum = await info<{ delegated?: string } | null>({ type: 'delegatorSummary', user: w }).catch(() => null)
  const delegatedNow = Number(sum?.delegated ?? 0)
  if (delegatedNow > 0) {
    const hist = await info<{ time: number; delta?: { delegate?: { amount: string; isUndelegate: boolean } } }[]>({ type: 'delegatorHistory', user: w }).catch(() => [])
    staked = delegatedNow
    for (const h of hist) {
      if (h.time / 1000 <= SNAPSHOT || !h.delta?.delegate) continue
      const a = Number(h.delta.delegate.amount)
      staked += h.delta.delegate.isUndelegate ? a : -a
    }
    staked = Math.max(0, staked)
  }
  const prev = db.prepare('SELECT spot_at FROM og_snapshot WHERE wallet = ?').get(w) as { spot_at: number | null } | undefined
  let spot: { hype: number; khype: number; kntq: number } | null = null
  if (now < ANNOUNCE && !prev?.spot_at) {
    const s = await info<{ balances?: { coin: string; total: string }[] }>({ type: 'spotClearinghouseState', user: w }).catch(() => ({ balances: [] }))
    const bal = (c: string) => Number(s.balances?.find((b) => b.coin === c)?.total ?? 0)
    spot = { hype: bal('HYPE'), khype: bal('KHYPE'), kntq: bal('KNTQ') }
  }
  db.prepare(
    `INSERT INTO og_snapshot (wallet, khype_evm, kntq_evm, staked, spot_hype, spot_khype, spot_kntq, spot_at, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(wallet) DO UPDATE SET khype_evm = excluded.khype_evm, kntq_evm = excluded.kntq_evm, staked = excluded.staked,
       spot_hype = CASE WHEN excluded.spot_at IS NOT NULL THEN excluded.spot_hype ELSE og_snapshot.spot_hype END,
       spot_khype = CASE WHEN excluded.spot_at IS NOT NULL THEN excluded.spot_khype ELSE og_snapshot.spot_khype END,
       spot_kntq = CASE WHEN excluded.spot_at IS NOT NULL THEN excluded.spot_kntq ELSE og_snapshot.spot_kntq END,
       spot_at = COALESCE(og_snapshot.spot_at, excluded.spot_at), checked_at = excluded.checked_at`,
  ).run(w, units(kh), units(kn), staked, spot?.hype ?? 0, spot?.khype ?? 0, spot?.kntq ?? 0, spot ? now : null, now)
}

/**
 * Works through every wallet that has used Elysium, a few a second, then
 * keeps up with new ones. Wallets someone checks on the page jump the queue.
 */
export function startOg(db: DatabaseSync) {
  migrateOg(db)
  const urgent: string[] = []
  const seen = new Set<string>()
  async function loop() {
    void kntqPrice()
      .then((p) => setMeta(db, 'kntq_hype', String(p)))
      .catch((e) => console.error(JSON.stringify({ ogPrice: String(e) })))
    for (;;) {
      let w = urgent.shift()
      if (!w) {
        const next = db
          .prepare(
            `SELECT a FROM (SELECT DISTINCT lower(trader) a FROM trades WHERE trader IS NOT NULL
                UNION SELECT DISTINCT lower(holder) a FROM balances WHERE balance > 0)
             WHERE a NOT IN (SELECT wallet FROM og_snapshot) LIMIT 50`,
          )
          .all() as { a: string }[]
        if (!next.length) {
          await sleep(60_000)
          continue
        }
        for (const n of next) if (!seen.has(n.a)) urgent.push(n.a)
        w = urgent.shift()
        if (!w) {
          await sleep(60_000)
          continue
        }
      }
      seen.add(w)
      try {
        await snapshotWallet(db, w)
      } catch (e) {
        console.error(JSON.stringify({ ogError: String(e).slice(0, 200), wallet: w }))
        await sleep(10_000)
      }
      await sleep(Number(process.env.OG_DELAY_MS ?? 300))
    }
  }
  void loop()
  return {
    /** Put a wallet at the front of the queue if it hasn't been snapshotted. */
    want(w: string) {
      const a = w.toLowerCase()
      if (seen.has(a) || urgent.includes(a)) return
      if (db.prepare('SELECT 1 FROM og_snapshot WHERE wallet = ?').get(a)) return
      urgent.unshift(a)
    },
  }
}
