import { createServer, type ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'

import { BUNDLE_BLOCKS, DEAD, ZERO, type Network } from './config.js'
import { getMeta } from './db.js'
import { live } from './indexer.js'
import { bridgeStats } from './bridgeTracker.js'

const DAY = 86_400
const HOUR = 3_600
/** The windows the terminal can show change and volume over. */
const WINDOWS = { '1h': HOUR, '6h': 6 * HOUR, '24h': DAY, '7d': 7 * DAY } as const
type Window = keyof typeof WINDOWS
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
 *   GET /tokens?venue=&sort=trending|volume|gainers|losers|mcap|new|trades&window=1h|6h|24h|7d&q=&spark=1&all=1&limit=&offset=
 *   GET /tokens/:address
 *   GET /tokens/:address/trades?limit=&before=<unix seconds>
 *   GET /tokens/:address/candles?interval=<seconds>&limit=
 *   GET /tokens/:address/holders?limit=
 *   GET /venues
 *   GET /wallets/:address   holdings and PnL
 *   GET /bridge             Mesa bridge totals and recent transfers
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
  /** A launchpad's name from its hook; hooks nobody has named yet are "Other". */
  const venueOf = (hook: string) => n.venues[hook] ?? (hook === ZERO ? 'Uniswap v4' : 'Other')
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
    const images = new Map(all('SELECT token, image FROM token_meta WHERE image IS NOT NULL').map((r) => [r.token, r.image]))
    const lastHype = new Map(
      all(
        `SELECT token, price_hype FROM (SELECT token, ${PX} price_hype, ROW_NUMBER() OVER (PARTITION BY token ORDER BY block DESC, log_index DESC) rn FROM trades WHERE price_hype IS NOT NULL) WHERE rn = 1`,
      ).map((r) => [r.token, r.price_hype as number]),
    )
    // Each token's price at the start of each window: its last trade before then.
    const priceAt = db.prepare(
      `SELECT ${PX} price_hype FROM trades WHERE token = ? AND timestamp <= ? AND price_hype IS NOT NULL ORDER BY timestamp DESC, block DESC, log_index DESC LIMIT 1`,
    )
    const firstHype = new Map(
      all(
        `SELECT token, price_hype FROM (SELECT token, ${PX} price_hype, ROW_NUMBER() OVER (PARTITION BY token ORDER BY block, log_index) rn FROM trades WHERE price_hype IS NOT NULL) WHERE rn = 1`,
      ).map((r) => [r.token, r.price_hype as number]),
    )
    const vol = new Map(
      all(
        `SELECT token,
           SUM(CASE WHEN timestamp > ? THEN value_hype ELSE 0 END) v1h,
           SUM(CASE WHEN timestamp > ? THEN value_hype ELSE 0 END) v6h,
           SUM(CASE WHEN timestamp > ? THEN value_hype ELSE 0 END) v,
           SUM(value_hype) v7d,
           SUM(CASE WHEN timestamp > ? THEN 1 ELSE 0 END) n,
           COUNT(DISTINCT CASE WHEN timestamp > ? THEN trader END) traders,
           MAX(timestamp) last
         FROM trades WHERE timestamp > ? GROUP BY token`,
        t - HOUR,
        t - 6 * HOUR,
        t - DAY,
        t - DAY,
        t - DAY,
        t - 7 * DAY,
      ).map((r) => [r.token, r]),
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
    const seen = new Set<string>()
    for (const p of pools) {
      const a = p.token as string
      // A token whose first two pools share a block is listed once.
      if (notListed.has(a) || seen.has(a)) continue
      seen.add(a)
      const tk = tokens.get(a)
      const supply = (tk?.supply as number | null) ?? null
      const price = lastHype.get(a) ?? (hype.has(p.quote as string) ? (p.initial_price as number) : null)
      const v = vol.get(a)
      const first = firstHype.get(a) ?? price
      const change = (w: number) => {
        if (!price) return 0
        const launched = (p.timestamp as number) > t - w
        const b = launched ? first : ((priceAt.get(a, t - w) as Row | undefined)?.price_hype as number | undefined) ?? first
        return b ? (price / b - 1) * 100 : 0
      }
      const trades24h = (v?.n as number) ?? 0
      const traders24h = (v?.traders as number) ?? 0
      const holderCount = holders.get(a) ?? 0
      const mcap = price !== null && supply !== null ? price * supply : null
      rows.push({
        address: a,
        image: (images.get(a) as string | undefined) ?? null,
        name: tk?.name ?? null,
        symbol: tk?.symbol ?? null,
        venue: venueOf(p.hook as string),
        hook: p.hook,
        quote: p.quote,
        quoteSymbol: hype.has(p.quote as string) ? 'HYPE' : ((tokens.get(p.quote)?.symbol as string) ?? null),
        creator: p.creator,
        launchedAt: p.timestamp,
        priceHype: price,
        priceUsd: price !== null && usdRate ? price * usdRate : null,
        marketCapHype: mcap,
        marketCapUsd: mcap !== null && usdRate ? mcap * usdRate : null,
        change1h: change(HOUR),
        change6h: change(6 * HOUR),
        change24h: change(DAY),
        change7d: change(7 * DAY),
        volume1hHype: (v?.v1h as number) ?? 0,
        volume6hHype: (v?.v6h as number) ?? 0,
        volume24hHype: (v?.v as number) ?? 0,
        volume7dHype: (v?.v7d as number) ?? 0,
        trades24h,
        traders24h,
        lastTradeAt: (v?.last as number) ?? null,
        holders: holderCount,
        // Wash trading: lots of trades between a handful of wallets.
        spam: (trades24h >= 100 && traders24h <= 5) || (holderCount < 3 && trades24h < 3),
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
    const meta = one('SELECT description, website, twitter, telegram FROM token_meta WHERE token = ?', address)
    return {
      ...row,
      pools,
      links: {
        description: meta?.description ?? null,
        website: meta?.website ?? null,
        twitter: meta?.twitter ?? null,
        telegram: meta?.telegram ?? null,
      },
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

  /**
   * A wallet's holdings and PnL, in HYPE. Cost basis is the average price of
   * the wallet's own buys (by transaction sender, so trades made through any
   * router count); tokens that arrived by transfer have no cost basis.
   *   realized   = HYPE from sells - tokens sold x average buy price
   *   unrealized = tokens held x (current price - average buy price)
   */
  function wallet(address: string) {
    const byToken = new Map(table().map((r) => [r.address as string, r]))
    const held = all('SELECT token, balance FROM balances WHERE holder = ? AND balance > 1e-9', address)
    const flows = all(
      `SELECT token,
         SUM(CASE WHEN side = 'buy' THEN token_amount ELSE 0 END) bought,
         SUM(CASE WHEN side = 'buy' THEN value_hype ELSE 0 END) spent,
         SUM(CASE WHEN side = 'sell' THEN token_amount ELSE 0 END) sold,
         SUM(CASE WHEN side = 'sell' THEN value_hype ELSE 0 END) received,
         COUNT(*) trades, MIN(timestamp) first, MAX(timestamp) last
       FROM trades WHERE trader = ? AND value_hype IS NOT NULL GROUP BY token`,
      address,
    )
    const f = new Map(flows.map((r) => [r.token as string, r]))
    const tokensSeen = new Set([...held.map((h) => h.token as string), ...flows.map((r) => r.token as string)])
    const positions = [...tokensSeen]
      .map((token) => {
        const t = byToken.get(token)
        if (!t) return null
        const balance = (held.find((h) => h.token === token)?.balance as number) ?? 0
        const fl = f.get(token)
        const bought = (fl?.bought as number) ?? 0
        const spent = (fl?.spent as number) ?? 0
        const sold = (fl?.sold as number) ?? 0
        const received = (fl?.received as number) ?? 0
        const avg = bought > 0 ? spent / bought : null
        const price = (t.priceHype as number | null) ?? null
        const value = price !== null ? balance * price : null
        return {
          token,
          symbol: t.symbol,
          name: t.name,
          image: t.image,
          venue: t.venue,
          balance,
          priceHype: price,
          valueHype: value,
          change24h: t.change24h,
          avgBuyPriceHype: avg,
          spentHype: spent,
          receivedHype: received,
          realizedHype: avg !== null ? received - Math.min(sold, bought) * avg : null,
          unrealizedHype: avg !== null && value !== null ? value - balance * avg : null,
          trades: (fl?.trades as number) ?? 0,
          lastTradeAt: (fl?.last as number) ?? null,
        }
      })
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .sort((a, b) => (b.valueHype ?? 0) - (a.valueHype ?? 0))
    const sum = (k: 'valueHype' | 'realizedHype' | 'unrealizedHype' | 'spentHype' | 'receivedHype') =>
      positions.reduce((s, p) => s + (p[k] ?? 0), 0)
    return {
      address,
      holdingsValueHype: sum('valueHype'),
      realizedHype: sum('realizedHype'),
      unrealizedHype: sum('unrealizedHype'),
      spentHype: sum('spentHype'),
      receivedHype: sum('receivedHype'),
      positions,
    }
  }

  /** Launchpads by name, with how many tokens each has listed and their volume. */
  function venues() {
    const by = new Map<string, { venue: string; tokens: number; volume24hHype: number; trades24h: number; since: number }>()
    for (const r of table()) {
      if (r.spam) continue
      const k = r.venue as string
      const v = by.get(k) ?? { venue: k, tokens: 0, volume24hHype: 0, trades24h: 0, since: Infinity }
      v.tokens += 1
      v.volume24hHype += r.volume24hHype as number
      v.trades24h += r.trades24h as number
      v.since = Math.min(v.since, r.launchedAt as number)
      by.set(k, v)
    }
    return [...by.values()].sort((a, b) => b.tokens - a.tokens)
  }

  /** Hourly closing prices over the last day, for a token row's sparkline. */
  const sparks = new Map<string, { at: number; points: number[] }>()
  const sparkRows = db.prepare(
    `SELECT timestamp, ${PX} p FROM trades WHERE token = ? AND timestamp > ? AND price_hype IS NOT NULL ORDER BY block, log_index`,
  )
  const lastBefore = db.prepare(
    `SELECT ${PX} p FROM trades WHERE token = ? AND timestamp <= ? AND price_hype IS NOT NULL ORDER BY timestamp DESC, block DESC, log_index DESC LIMIT 1`,
  )
  function sparkline(token: string): number[] {
    const c = sparks.get(token)
    if (c && Date.now() - c.at < 60_000) return c.points
    const t = now()
    const start = t - DAY
    let p = (lastBefore.get(token, start) as Row | undefined)?.p as number | undefined
    const points: number[] = []
    const rows = sparkRows.all(token, start) as Row[]
    let i = 0
    for (let h = 1; h <= 24; h++) {
      const end = start + h * HOUR
      while (i < rows.length && (rows[i].timestamp as number) <= end) p = rows[i++].p as number
      // Hours before the token's first trade are left out.
      if (p !== undefined) points.push(p)
    }
    sparks.set(token, { at: Date.now(), points })
    if (sparks.size > 5_000) sparks.clear()
    return points
  }

  function stats() {
    const t = now()
    const d = one('SELECT COALESCE(SUM(value_hype), 0) v, COUNT(*) n FROM trades WHERE timestamp > ?', t - DAY)
    const mesa = one(`SELECT token FROM mesa_launches WHERE genesis = 1`)
    const burned = mesa ? one(`SELECT COALESCE(SUM(amount), 0) a FROM transfers WHERE token = ? AND dst = ?`, mesa.token as string, DEAD) : undefined
    return {
      tokens: table().filter((r) => !r.spam).length,
      launchpads: new Set(table().map((r) => r.venue)).size,
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
      if (parts[0] === 'bridge' && parts.length === 1) return json(bridgeStats(db))
      if (parts[0] === 'wallets' && parts[1] && parts.length === 2) {
        const a = parts[1].toLowerCase()
        if (!/^0x[0-9a-f]{40}$/.test(a)) return json({ error: 'bad address' }, 400)
        return json(wallet(a))
      }
      if (parts[0] === 'tokens' && parts.length === 1) {
        const search = (q.get('q') ?? '').toLowerCase().trim()
        const venue = q.get('venue')
        const w = (q.get('window') ?? '24h') as Window
        const win = w in WINDOWS ? w : '24h'
        let rows = table()
        // Wash-traded and empty tokens are hidden unless asked for, or searched for by address.
        if (q.get('all') !== '1' && !/^0x[0-9a-f]{40}$/.test(search)) rows = rows.filter((r) => !r.spam)
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
        const vol = `volume${win}Hype`
        const chg = `change${win}`
        const value: (r: Row) => number =
          sort === 'new'
            ? (r) => r.launchedAt as number
            : sort === 'volume'
              ? (r) => r[vol] as number
              : sort === 'mcap'
                ? (r) => (r.marketCapHype as number) ?? -1
                : sort === 'gainers'
                  ? (r) => ((r[vol] as number) > 0 ? (r[chg] as number) : -Infinity)
                  : sort === 'losers'
                    ? (r) => ((r[vol] as number) > 0 ? -(r[chg] as number) : -Infinity)
                    : sort === 'trades'
                      ? (r) => r.trades24h as number
                      : // Trending: real activity, many wallets trading real size, not trade count alone.
                        (r) => ((r.traders24h as number) + 1) * Math.log10(1 + (r[vol] as number))
        rows = [...rows].sort((a, b) => value(b) - value(a))
        const offset = Math.max(0, Number(q.get('offset') ?? 0) || 0)
        const page = rows.slice(offset, offset + num('limit', 50, 200))
        const withSpark = q.get('spark') === '1'
        return json({ total: rows.length, tokens: withSpark ? page.map((r) => ({ ...r, spark: sparkline(r.address as string) })) : page })
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
