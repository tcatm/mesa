import { createServer, type ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'

import { BUNDLE_BLOCKS, DEAD, ZERO, type Network } from './config.js'
import { getMeta } from './db.js'
import { live } from './indexer.js'

const DAY = 86_400
type Row = Record<string, unknown>

/**
 * A trade's HYPE price, robustly: the pool's price after the swap, unless that
 * is far (over 5x) from what the trade actually paid. A swap that exhausts a
 * pool's liquidity leaves the price at the tick bounds (up to 3.4e38), so then
 * the execution price (HYPE paid / tokens) is used instead.
 */
const PX = `(CASE WHEN token_amount > 0 AND value_hype > 0 AND (price_hype IS NULL OR price_hype > 5 * value_hype / token_amount OR price_hype < 0.2 * value_hype / token_amount) THEN value_hype / token_amount ELSE price_hype END)`

/**
 * The terminal's read API, across every launchpad on Elysium's v4
 * PoolManagers. Prices and market caps are in HYPE, and in USD when HYPE's
 * dollar price is known from an on-chain HYPE/USDC pool.
 *
 *   GET /tokens?venue=&sort=new|trending|volume|mcap&q=&limit=&offset=
 *   GET /tokens/:address
 *   GET /tokens/:address/trades?limit=&before=<unix seconds>
 *   GET /tokens/:address/candles?interval=<seconds>&limit=
 *   GET /tokens/:address/holders?limit=
 *   GET /venues
 *   GET /stats
 *   GET /stream            server-sent events: pool, trade
 *   GET /health
 */
export function serve(db: DatabaseSync, n: Network, port: number) {
  const hype = new Set(n.hype.map((a) => a.toLowerCase()))
  const usd = n.usd?.address.toLowerCase()
  const notListed = new Set([...hype, ...(usd ? [usd] : [])])
  const excluded = new Set([
    ...n.poolManagers.map((p) => p.address.toLowerCase()),
    DEAD,
    ZERO,
    ...(db.prepare('SELECT DISTINCT hook FROM pools').all() as { hook: string }[]).map((h) => h.hook),
  ])
  const now = () => Math.floor(Date.now() / 1000)
  const all = (sql: string, ...p: (string | number)[]) => db.prepare(sql).all(...p) as Row[]
  const one = (sql: string, ...p: (string | number)[]) => db.prepare(sql).get(...p) as Row | undefined
  const placeholders = (k: number) => Array(k).fill('?').join(',')

  /** HYPE's price in dollars, from the latest HYPE/USDC trade. */
  function hypeUsd(): number | null {
    if (!usd) return null
    const r = one(`SELECT ${PX} price_hype FROM trades WHERE token = ? AND price_hype IS NOT NULL ORDER BY block DESC, log_index DESC LIMIT 1`, usd)
    return r?.price_hype ? 1 / (r.price_hype as number) : null
  }

  // A short cache: the table is recomputed at most every 5 seconds.
  let cached: { at: number; rows: Row[] } | null = null
  function table(): Row[] {
    if (cached && Date.now() - cached.at < 5_000) return cached.rows
    const t = now()
    const ex = [...excluded]
    const pools = all(
      `SELECT p.token, p.venue, p.quote, p.creator, p.block, p.timestamp, p.initial_price, p.hook FROM pools p
       JOIN (SELECT token, MIN(block) b FROM pools GROUP BY token) f ON f.token = p.token AND f.b = p.block`,
    )
    const tokens = new Map(all('SELECT * FROM tokens').map((r) => [r.address, r]))
    const lastHype = new Map(
      all(
        `SELECT token, price_hype FROM (SELECT token, ${PX} price_hype, ROW_NUMBER() OVER (PARTITION BY token ORDER BY block DESC, log_index DESC) rn FROM trades WHERE price_hype IS NOT NULL) WHERE rn = 1`,
      ).map((r) => [r.token, r.price_hype as number]),
    )
    const dayAgo = new Map(
      all(
        `SELECT token, price_hype FROM (SELECT token, ${PX} price_hype, ROW_NUMBER() OVER (PARTITION BY token ORDER BY block DESC, log_index DESC) rn FROM trades WHERE price_hype IS NOT NULL AND timestamp <= ?) WHERE rn = 1`,
        t - DAY,
      ).map((r) => [r.token, r.price_hype as number]),
    )
    const firstHype = new Map(
      all(
        `SELECT token, price_hype FROM (SELECT token, ${PX} price_hype, ROW_NUMBER() OVER (PARTITION BY token ORDER BY block, log_index) rn FROM trades WHERE price_hype IS NOT NULL) WHERE rn = 1`,
      ).map((r) => [r.token, r.price_hype as number]),
    )
    const vol = new Map(
      all('SELECT token, SUM(value_hype) v, COUNT(*) n, MAX(timestamp) last FROM trades WHERE timestamp > ? GROUP BY token', t - DAY).map((r) => [
        r.token,
        r,
      ]),
    )
    const holders = new Map(
      all(
        `SELECT token, COUNT(*) n FROM balances WHERE balance > 1e-9 AND holder NOT IN (${placeholders(ex.length)}) GROUP BY token`,
        ...ex,
      ).map((r) => [r.token, r.n as number]),
    )
    const creatorBal = new Map(
      all(
        `SELECT p.token, b.balance FROM pools p JOIN (SELECT token, MIN(block) blk FROM pools GROUP BY token) f ON f.token = p.token AND f.blk = p.block
         JOIN balances b ON b.token = p.token AND b.holder = p.creator`,
      ).map((r) => [r.token, r.balance as number]),
    )
    const bundles = new Map(
      all(
        `SELECT tr.token, SUM(tr.token_amount) amt FROM trades tr
         JOIN (SELECT token, MIN(block) blk, creator FROM pools GROUP BY token) f ON f.token = tr.token
         WHERE tr.side = 'buy' AND tr.kind = 'trade' AND tr.trader IS NOT NULL AND tr.trader != f.creator AND tr.block < f.blk + ?
         GROUP BY tr.token`,
        BUNDLE_BLOCKS,
      ).map((r) => [r.token, r.amt as number]),
    )
    const usdRate = hypeUsd()
    const rows: Row[] = []
    for (const p of pools) {
      const a = p.token as string
      if (notListed.has(a)) continue
      const tk = tokens.get(a)
      const supply = (tk?.supply as number | null) ?? null
      const price = lastHype.get(a) ?? (hype.has(p.quote as string) ? (p.initial_price as number) : null)
      const before = dayAgo.get(a) ?? firstHype.get(a) ?? price
      const v = vol.get(a)
      const mcap = price !== null && supply !== null ? price * supply : null
      rows.push({
        address: a,
        name: tk?.name ?? null,
        symbol: tk?.symbol ?? null,
        venue: p.venue,
        quote: p.quote,
        quoteSymbol: hype.has(p.quote as string) ? 'HYPE' : ((tokens.get(p.quote)?.symbol as string) ?? null),
        creator: p.creator,
        launchedAt: p.timestamp,
        priceHype: price,
        priceUsd: price !== null && usdRate ? price * usdRate : null,
        marketCapHype: mcap,
        marketCapUsd: mcap !== null && usdRate ? mcap * usdRate : null,
        change24h: price && before ? (price / before - 1) * 100 : 0,
        volume24hHype: (v?.v as number) ?? 0,
        trades24h: (v?.n as number) ?? 0,
        lastTradeAt: (v?.last as number) ?? null,
        holders: holders.get(a) ?? 0,
        supply,
        devPct: supply ? ((creatorBal.get(a) ?? 0) / supply) * 100 : null,
        bundlePct: supply ? ((bundles.get(a) ?? 0) / supply) * 100 : null,
      })
    }
    cached = { at: Date.now(), rows }
    return rows
  }

  function tokenDetail(address: string) {
    const row = table().find((r) => r.address === address)
    if (!row) return null
    const ex = [...excluded]
    const supply = (row.supply as number | null) ?? 0
    const holders = all(
      `SELECT holder, balance FROM balances WHERE token = ? AND balance > 1e-9 AND holder NOT IN (${placeholders(ex.length)}) ORDER BY balance DESC LIMIT 10`,
      address,
      ...ex,
    )
    const pools = all(
      `SELECT id, venue, hook, pool_manager, currency0, currency1, quote, fee, tick_spacing, block, timestamp, tx FROM pools WHERE token = ? ORDER BY block`,
      address,
    )
    const first = pools[0]
    const mesa = one('SELECT * FROM mesa_launches WHERE token = ?', address)
    const snipeEnd = mesa ? (first.timestamp as number) + (mesa.snipe_seconds as number) : (first.timestamp as number) + 300
    const early = one(
      `SELECT COUNT(DISTINCT trader) wallets, COALESCE(SUM(token_amount), 0) tokens, COALESCE(SUM(sniper_fee), 0) sniperFees
       FROM trades WHERE token = ? AND side = 'buy' AND kind = 'trade' AND timestamp < ?`,
      address,
      snipeEnd,
    )
    const devBought = one(
      `SELECT COALESCE(SUM(CASE WHEN side = 'buy' THEN token_amount ELSE -token_amount END), 0) net FROM trades WHERE token = ? AND trader = ?`,
      address,
      row.creator as string,
    )
    const creatorLaunches = table()
      .filter((r) => r.creator === row.creator && r.address !== address)
      .sort((a, b) => (b.launchedAt as number) - (a.launchedAt as number))
      .slice(0, 20)
      .map((r) => ({ address: r.address, symbol: r.symbol, venue: r.venue, launchedAt: r.launchedAt, marketCapHype: r.marketCapHype }))
    const totals = one('SELECT COALESCE(SUM(value_hype), 0) v, COUNT(*) n FROM trades WHERE token = ?', address)
    return {
      ...row,
      pools,
      volumeAllTimeHype: totals?.v,
      tradesAllTime: totals?.n,
      mesa: mesa
        ? {
            buyFeeBps: mesa.buy_fee_bps,
            sellFeeBps: mesa.sell_fee_bps,
            sniperFeeBps: mesa.sniper_fee_bps,
            snipeSeconds: mesa.snipe_seconds,
            maxBuyBps: mesa.max_buy_bps,
            feeRecipient: mesa.fee_recipient,
            metadataUri: mesa.metadata_uri,
            devBuy: { quote: mesa.dev_buy_quote, tokens: mesa.dev_buy_tokens, pct: supply ? ((mesa.dev_buy_tokens as number) / supply) * 100 : null },
          }
        : null,
      forensics: {
        creator: row.creator,
        devHoldsPct: row.devPct,
        devNetBoughtPct: supply ? ((devBought?.net as number) / supply) * 100 : null,
        bundlePct: row.bundlePct,
        earlyBuys: { windowSeconds: snipeEnd - (first.timestamp as number), wallets: early?.wallets, pct: supply ? ((early?.tokens as number) / supply) * 100 : null, sniperFeesPaid: early?.sniperFees },
        top10Pct: supply ? (holders.reduce((s, h) => s + (h.balance as number), 0) / supply) * 100 : null,
        topHolders: holders.map((h) => ({ address: h.holder, pct: supply ? ((h.balance as number) / supply) * 100 : null })),
        creatorLaunches,
      },
    }
  }

  function candles(address: string, interval: number, limit: number) {
    if (!one('SELECT 1 FROM pools WHERE token = ?', address)) return null
    const rows = all(
      `SELECT timestamp, ${PX} p, value_hype v FROM trades WHERE token = ? AND price_hype IS NOT NULL ORDER BY block, log_index`,
      address,
    )
    const out: { t: number; o: number; h: number; l: number; c: number; v: number }[] = []
    let prev: number | null = null
    for (const r of rows) {
      const t = Math.floor((r.timestamp as number) / interval) * interval
      const p = r.p as number
      const o = prev ?? p
      let c = out[out.length - 1]
      if (!c || c.t !== t) {
        c = { t, o, h: Math.max(o, p), l: Math.min(o, p), c: p, v: 0 }
        out.push(c)
      }
      c.h = Math.max(c.h, p)
      c.l = Math.min(c.l, p)
      c.c = p
      c.v += (r.v as number) ?? 0
      prev = p
    }
    return out.slice(-limit)
  }

  function venues() {
    const t = now()
    const day = new Map(
      all(
        `SELECT p.venue, COALESCE(SUM(tr.value_hype), 0) v, COUNT(tr.tx) n FROM trades tr JOIN pools p ON p.id = tr.pool WHERE tr.timestamp > ? GROUP BY p.venue`,
        t - DAY,
      ).map((r) => [r.venue, r]),
    )
    return all(`SELECT venue, COUNT(*) pools, COUNT(DISTINCT token) tokens, MIN(timestamp) since FROM pools GROUP BY venue`)
      .map((r) => ({ ...r, volume24hHype: day.get(r.venue)?.v ?? 0, trades24h: day.get(r.venue)?.n ?? 0 }))
      .sort((a, b) => (b.trades24h as number) - (a.trades24h as number))
  }

  function stats() {
    const t = now()
    const d = one('SELECT COALESCE(SUM(value_hype), 0) v, COUNT(*) n FROM trades WHERE timestamp > ?', t - DAY)
    const mesa = one(`SELECT token FROM mesa_launches WHERE genesis = 1`)
    const burned = mesa ? one(`SELECT COALESCE(SUM(amount), 0) a FROM transfers WHERE token = ? AND dst = ?`, mesa.token as string, DEAD) : undefined
    return {
      tokens: table().length,
      pools: one('SELECT COUNT(*) n FROM pools')?.n,
      volume24hHype: d?.v,
      trades24h: d?.n,
      hypeUsd: hypeUsd(),
      mesaBurned: burned?.a ?? 0,
      indexedTo: Number(getMeta(db, 'cursor') ?? n.startBlock) - 1,
      head: Number(getMeta(db, 'head') ?? 0),
    }
  }

  const streams = new Set<ServerResponse>()
  const push = (event: string, data: unknown) => {
    for (const s of streams) s.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  live.on('pool', (r) => push('pool', r))
  live.on('trade', (r) => push('trade', r))

  const server = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*')
    if (req.method === 'OPTIONS') return res.writeHead(204).end()
    const url = new URL(req.url ?? '/', 'http://x')
    const q = url.searchParams
    const parts = url.pathname.split('/').filter(Boolean)
    const num = (k: string, def: number, max: number) => Math.min(max, Math.max(1, Number(q.get(k) ?? def) || def))
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    try {
      if (parts[0] === 'stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        res.write(': connected\n\n')
        streams.add(res)
        req.on('close', () => streams.delete(res))
        return
      }
      if (parts[0] === 'health' || parts.length === 0) return json({ ok: true, ...stats() })
      if (parts[0] === 'stats') return json(stats())
      if (parts[0] === 'venues') return json(venues())
      if (parts[0] === 'tokens' && parts.length === 1) {
        const search = (q.get('q') ?? '').toLowerCase().trim()
        const venue = q.get('venue')
        let rows = table()
        if (venue) rows = rows.filter((r) => r.venue === venue)
        if (search) {
          rows = rows.filter(
            (r) =>
              String(r.symbol ?? '').toLowerCase().includes(search) ||
              String(r.name ?? '').toLowerCase().includes(search) ||
              r.address === search,
          )
        }
        const sort = q.get('sort') ?? 'trending'
        const key = { new: 'launchedAt', volume: 'volume24hHype', mcap: 'marketCapHype', trending: 'trades24h' }[sort] ?? 'trades24h'
        rows = [...rows].sort((a, b) => ((b[key] as number) ?? -1) - ((a[key] as number) ?? -1))
        const offset = Math.max(0, Number(q.get('offset') ?? 0) || 0)
        return json({ total: rows.length, tokens: rows.slice(offset, offset + num('limit', 50, 200)) })
      }
      if (parts[0] === 'tokens' && parts[1]) {
        const a = parts[1].toLowerCase()
        if (parts.length === 2) {
          const t = tokenDetail(a)
          return t ? json(t) : json({ error: 'unknown token' }, 404)
        }
        if (parts[2] === 'trades') {
          const before = Number(q.get('before') ?? 1e12)
          return json(
            all(
              `SELECT tx, timestamp, trader, side, kind, quote_amount, token_amount, fee, sniper_fee, price, ${PX} price_hype, value_hype
               FROM trades WHERE token = ? AND timestamp < ? ORDER BY block DESC, log_index DESC LIMIT ?`,
              a,
              before,
              num('limit', 50, 500),
            ),
          )
        }
        if (parts[2] === 'candles') {
          const c = candles(a, num('interval', 60, 86_400), num('limit', 500, 2_000))
          return c ? json(c) : json({ error: 'unknown token' }, 404)
        }
        if (parts[2] === 'holders') {
          const ex = [...excluded]
          const supply = (one('SELECT supply FROM tokens WHERE address = ?', a)?.supply as number | null) ?? null
          return json(
            all(
              `SELECT holder address, balance FROM balances WHERE token = ? AND balance > 1e-9 AND holder NOT IN (${placeholders(ex.length)}) ORDER BY balance DESC LIMIT ?`,
              a,
              ...ex,
              num('limit', 100, 1_000),
            ).map((h) => ({ ...h, pct: supply ? ((h.balance as number) / supply) * 100 : null })),
          )
        }
      }
      json({ error: 'not found' }, 404)
    } catch (e) {
      json({ error: e instanceof Error ? e.message : String(e) }, 500)
    }
  })
  server.listen(port)
  return server
}
