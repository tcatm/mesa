import type { DatabaseSync } from 'node:sqlite'

import { BUNDLE_BLOCKS, DEAD, IMAGE_OVERRIDES, ZERO, type Network } from './config.js'
import { marketHypeUsd, startHypeUsd } from './hypeUsd.js'

const DAY = 86_400
const HOUR = 3_600
type Row = Record<string, unknown>

/**
 * A trade's HYPE price, robustly: the pool's price after the swap, unless that
 * is far (over 5x) from what the trade actually paid. A swap that exhausts a
 * pool's liquidity leaves the price at the tick bounds (up to 3.4e38), so then
 * the execution price (HYPE paid / tokens) is used instead.
 */
export const PX = `(CASE WHEN token_amount > 0 AND value_hype > 0 AND (price_hype IS NULL OR price_hype > 5 * value_hype / token_amount OR price_hype < 0.2 * value_hype / token_amount) THEN value_hype / token_amount ELSE price_hype END)`

/**
 * The terminal's token table: every listed token with its price, changes and
 * volumes over each window, holders and forensics. Built by the table worker
 * (tableWorker.ts) in two layers, so it never scans the whole trade history:
 *  - every minute, what moves slowly: pools, names, holders, dev and bundle
 *    shares, 6h/7d volume, and each token's price at the start of each window
 *    and its last price (one index lookup per token);
 *  - every build, the last day's trading (one scan of the last 24h) and fresh
 *    prices for the tokens that traded in it.
 */
export function tableBuilder(db: DatabaseSync, n: Network) {
  startHypeUsd()
  const hype = new Set(n.hype.map((a) => a.toLowerCase()))
  const usd = n.usd?.address.toLowerCase()
  const notListed = new Set([...hype, ...(usd ? [usd] : [])])
  const excludedNow = () => [
    ...new Set([
      ...n.poolManagers.map((p) => p.address.toLowerCase()),
      DEAD,
      ZERO,
      ...(db.prepare('SELECT DISTINCT hook FROM pools').all() as { hook: string }[]).map((h) => h.hook),
    ]),
  ]
  const now = () => Math.floor(Date.now() / 1000)
  const managerVenue = new Map(n.poolManagers.filter((p) => p.venue).map((p) => [p.address.toLowerCase(), p.venue!]))
  const uniswap = n.poolManagers[0]?.address.toLowerCase()
  /** A launchpad's name from its hook, or its PoolManager's; hooks nobody has named yet are "Other". */
  const venueOf = (hook: string, manager: string) =>
    n.venues[hook] ?? managerVenue.get(manager) ?? (hook === ZERO && manager === uniswap ? 'Uniswap v4' : 'Other')
  const all = (sql: string, ...p: (string | number)[]) => db.prepare(sql).all(...p) as Row[]
  const one = (sql: string, ...p: (string | number)[]) => db.prepare(sql).get(...p) as Row | undefined
  const placeholders = (k: number) => Array(k).fill('?').join(',')
  function hypeUsd(): number | null {
    const market = marketHypeUsd()
    if (market !== null) return market
    if (!usd) return null
    const r = one(`SELECT ${PX} price_hype FROM trades WHERE token = ? AND price_hype IS NOT NULL ORDER BY block DESC, log_index DESC LIMIT 1`, usd)
    return r?.price_hype ? 1 / (r.price_hype as number) : null
  }

  type Slow = {
    at: number
    pools: Row[]
    tokens: Map<unknown, Row>
    images: Map<unknown, unknown>
    first: Map<string, number>
    last: Map<string, number>
    at6h: Map<string, number>
    at24h: Map<string, number>
    at7d: Map<string, number>
    vol: Map<unknown, Row>
    holders: Map<unknown, number>
    creatorBal: Map<unknown, number>
    bundles: Map<unknown, number>
  }
  let slow: Slow | null = null
  const lastPrice = db.prepare(
    `SELECT ${PX} p FROM trades WHERE token = ? AND price_hype IS NOT NULL ORDER BY timestamp DESC, block DESC, log_index DESC LIMIT 1`,
  )
  const firstPrice = db.prepare(
    `SELECT ${PX} p FROM trades WHERE token = ? AND price_hype IS NOT NULL ORDER BY timestamp, block, log_index LIMIT 1`,
  )
  const priceAt = db.prepare(
    `SELECT ${PX} p FROM trades WHERE token = ? AND timestamp <= ? AND price_hype IS NOT NULL ORDER BY timestamp DESC, block DESC, log_index DESC LIMIT 1`,
  )
  const val = (r: unknown) => (r as Row | undefined)?.p as number | undefined

  function buildSlow(): Slow {
    const t = now()
    const ex = excludedNow()
    const pools = all(
      `SELECT p.token, p.venue, p.quote, p.creator, p.block, p.timestamp, p.initial_price, p.hook, p.pool_manager FROM pools p
       JOIN (SELECT token, MIN(block) b FROM pools GROUP BY token) f ON f.token = p.token AND f.b = p.block`,
    )
    const first = new Map<string, number>()
    const last = new Map<string, number>()
    const at6h = new Map<string, number>()
    const at24h = new Map<string, number>()
    const at7d = new Map<string, number>()
    for (const a of new Set(pools.map((p) => p.token as string))) {
      const l = val(lastPrice.get(a))
      if (l === undefined) continue
      last.set(a, l)
      // A token's first price only changes when it is new.
      const f = slow?.first.get(a) ?? val(firstPrice.get(a))
      if (f !== undefined) first.set(a, f)
      for (const [m, w] of [
        [at6h, 6 * HOUR],
        [at24h, DAY],
        [at7d, 7 * DAY],
      ] as const) {
        const v = val(priceAt.get(a, t - w))
        if (v !== undefined) m.set(a, v)
      }
    }
    return {
      at: Date.now(),
      pools,
      tokens: new Map(all('SELECT * FROM tokens').map((r) => [r.address, r])),
      images: new Map([
        ...all('SELECT token, image FROM token_meta WHERE image IS NOT NULL').map((r) => [r.token, r.image] as [unknown, unknown]),
        ...Object.entries(IMAGE_OVERRIDES),
      ]),
      first,
      last,
      at6h,
      at24h,
      at7d,
      vol: new Map(
        all(
          `SELECT token, SUM(CASE WHEN timestamp > ? THEN value_hype ELSE 0 END) v6h, SUM(value_hype) v7d
           FROM trades WHERE timestamp > ? GROUP BY token`,
          t - 6 * HOUR,
          t - 7 * DAY,
        ).map((r) => [r.token, r]),
      ),
      holders: new Map(
        all(
          `SELECT token, COUNT(*) n FROM balances WHERE balance > 1e-9 AND holder NOT IN (${placeholders(ex.length)}) GROUP BY token`,
          ...ex,
        ).map((r) => [r.token, r.n as number]),
      ),
      creatorBal: new Map(
        all(
          `SELECT p.token, b.balance FROM pools p JOIN (SELECT token, MIN(block) blk FROM pools GROUP BY token) f ON f.token = p.token AND f.blk = p.block
           JOIN balances b ON b.token = p.token AND b.holder = p.creator`,
        ).map((r) => [r.token, r.balance as number]),
      ),
      bundles: new Map(
        all(
          `SELECT tr.token, SUM(tr.token_amount) amt FROM trades tr
           JOIN (SELECT token, MIN(block) blk, creator FROM pools GROUP BY token) f ON f.token = tr.token
           WHERE tr.side = 'buy' AND tr.kind = 'trade' AND tr.trader IS NOT NULL AND tr.trader != f.creator AND tr.block < f.blk + ?
           GROUP BY tr.token`,
          BUNDLE_BLOCKS,
        ).map((r) => [r.token, r.amt as number]),
      ),
    }
  }

  function build(): Row[] {
    if (!slow || Date.now() - slow.at > 60_000) slow = buildSlow()
    const S = slow
    const t = now()
    const day = new Map(
      all(
        `SELECT token,
           SUM(CASE WHEN timestamp > ? THEN value_hype ELSE 0 END) v1h,
           SUM(value_hype) v,
           COUNT(*) n,
           COUNT(DISTINCT trader) traders,
           MAX(timestamp) last
         FROM trades WHERE timestamp > ? GROUP BY token`,
        t - HOUR,
        t - DAY,
      ).map((r) => [r.token as string, r]),
    )
    const usdRate = hypeUsd()
    const rows: Row[] = []
    const seen = new Set<string>()
    for (const p of S.pools) {
      const a = p.token as string
      // A token whose first two pools share a block is listed once.
      if (notListed.has(a) || seen.has(a)) continue
      seen.add(a)
      const tk = S.tokens.get(a)
      const supply = (tk?.supply as number | null) ?? null
      const v = day.get(a)
      // Tokens that traded today get a fresh price; the rest haven't moved.
      const live = v ? val(lastPrice.get(a)) : undefined
      const price = live ?? S.last.get(a) ?? (hype.has(p.quote as string) ? (p.initial_price as number) : null)
      const first = S.first.get(a) ?? price
      const startOf = (w: number, at?: number) => {
        if ((p.timestamp as number) > t - w) return first
        return at ?? first
      }
      const pct = (b: number | null | undefined) => (price && b ? (price / b - 1) * 100 : 0)
      const at1h = v && (v.last as number) > t - HOUR ? val(priceAt.get(a, t - HOUR)) : price ?? undefined
      const slowVol = S.vol.get(a)
      const trades24h = (v?.n as number) ?? 0
      const traders24h = (v?.traders as number) ?? 0
      const holderCount = S.holders.get(a) ?? 0
      const mcap = price !== null && supply !== null ? price * supply : null
      rows.push({
        address: a,
        image: (S.images.get(a) as string | undefined) ?? null,
        name: tk?.name ?? null,
        symbol: tk?.symbol ?? null,
        venue: venueOf(p.hook as string, p.pool_manager as string),
        hook: p.hook,
        quote: p.quote,
        quoteSymbol: hype.has(p.quote as string) ? 'HYPE' : ((S.tokens.get(p.quote)?.symbol as string) ?? null),
        creator: p.creator,
        launchedAt: p.timestamp,
        priceHype: price,
        priceUsd: price !== null && usdRate ? price * usdRate : null,
        marketCapHype: mcap,
        marketCapUsd: mcap !== null && usdRate ? mcap * usdRate : null,
        change1h: pct(startOf(HOUR, at1h)),
        change6h: pct(startOf(6 * HOUR, S.at6h.get(a))),
        change24h: pct(startOf(DAY, S.at24h.get(a))),
        change7d: pct(startOf(7 * DAY, S.at7d.get(a))),
        volume1hHype: (v?.v1h as number) ?? 0,
        volume6hHype: (slowVol?.v6h as number) ?? 0,
        volume24hHype: (v?.v as number) ?? 0,
        volume7dHype: Math.max((slowVol?.v7d as number) ?? 0, (v?.v as number) ?? 0),
        trades24h,
        traders24h,
        lastTradeAt: (v?.last as number) ?? null,
        holders: holderCount,
        // Wash trading: lots of trades between a handful of wallets.
        // Wash trading (lots of trades between a handful of wallets), or a token
        // left empty for over a day. New launches always show, and Mesa's own.
        spam:
          (trades24h >= 100 && traders24h <= 5) ||
          (holderCount < 3 && trades24h < 3 && (p.timestamp as number) < t - DAY && venueOf(p.hook as string, p.pool_manager as string) !== 'Mesa'),
        supply,
        devPct: supply ? ((S.creatorBal.get(a) ?? 0) / supply) * 100 : null,
        bundlePct: supply ? ((S.bundles.get(a) ?? 0) / supply) * 100 : null,
      })
    }
    const genesis = (one(`SELECT token FROM mesa_launches WHERE genesis = 1`)?.token as string | undefined) ?? null
    // Exact copies of $MESA (name "Mesa" and ticker "MESA") are hidden.
    // Anything else goes: MesaCat, MesaDoge, "Mesa" with another ticker.
    if (genesis) {
      for (const r of rows) {
        const exact = String(r.name ?? '').trim().toLowerCase() === 'mesa' && String(r.symbol ?? '').trim().toLowerCase() === 'mesa'
        if (exact && r.address !== genesis) r.spam = true
      }
    }
    // Tickers shared by more than one visible token. Launch time alone picks
    // the wrong one (a copy is often launched first, or the real token's pool
    // came late), so the original is the one holders chose: most holders,
    // earliest launch on a tie, and $MESA is always its own original. Hidden
    // tokens don't count.
    const byTicker = new Map<string, Row[]>()
    for (const r of rows) {
      if (r.spam) continue
      const k = String(r.symbol ?? '').trim().toLowerCase()
      if (!k) continue
      byTicker.set(k, [...(byTicker.get(k) ?? []), r])
    }
    for (const list of byTicker.values()) {
      if (list.length < 2) continue
      list.sort(
        (a, b) =>
          Number(b.address === genesis) - Number(a.address === genesis) ||
          (b.holders as number) - (a.holders as number) ||
          (a.launchedAt as number) - (b.launchedAt as number),
      )
      list.forEach((r, i) => {
        r.og = i === 0
        r.sameTicker = list.length - 1
        r.ogAddress = list[0]!.address
      })
    }
    return rows
  }

  return { build }
}
