import { createServer, type ServerResponse } from 'node:http'
import { Worker } from 'node:worker_threads'
import type { DatabaseSync } from 'node:sqlite'

import { BUNDLE_BLOCKS, DEAD, LINK_OVERRIDES, ZERO, type Network } from './config.js'
import { marketHypeUsd, startHypeUsd } from './hypeUsd.js'
import { getMeta } from './db.js'
import { live } from './indexer.js'
import { bridgeLookup, bridgeStats } from './bridgeTracker.js'
import { UpdateError, listUpdates, migrateUpdates, postUpdate } from './updates.js'
import { PX, tableBuilder } from './table.js'
import { startMev } from './mev.js'
import { getProject, migrateProjects, saveProfile, verifyGithub } from './projects.js'
import { POOLS, TOTAL, estimate, type PoolName, type WalletScore } from './airdrop.js'
import { SNAPSHOT, startOg } from './og.js'
import { startGithub } from './github.js'

const DAY = 86_400
const HOUR = 3_600
/** The windows the terminal can show change and volume over. */
const WINDOWS = { '1h': HOUR, '6h': 6 * HOUR, '24h': DAY, '7d': 7 * DAY } as const
type Window = keyof typeof WINDOWS
type Row = Record<string, unknown>


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
 *   GET /tokens/:address/project    the signed project profile, verified GitHub, last build-log post
 *   POST /projects, POST /projects/github   (see projects.ts)
 *   GET /venues
 *   GET /wallets/:address   holdings and PnL
 *   GET /bridge             Mesa bridge totals and recent transfers
 *   GET /stats
 *   GET /mesa               $MESA burned, HYPE spent on buybacks, every buyback
 *   GET /stream            server-sent events: pool, trade, update (build log); a ping comment every 20s
 *   GET /health
 *   GET /airdrop            the Builder Drop: pools, point totals, when it was last scored
 *   GET /airdrop/:wallet    one wallet's provisional points and estimated $MESA
 */
export function serve(db: DatabaseSync, dbPath: string, n: Network, port: number) {
  startHypeUsd()
  migrateUpdates(db)
  migrateProjects(db)
  const mev = startMev(db)
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
  const managerVenue = new Map(n.poolManagers.filter((p) => p.venue).map((p) => [p.address.toLowerCase(), p.venue!]))
  const uniswap = n.poolManagers[0]?.address.toLowerCase()
  const venueOf = (hook: string, manager: string) =>
    n.venues[hook] ?? managerVenue.get(manager) ?? (hook === ZERO && manager === uniswap ? 'Uniswap v4' : 'Other')
  const all = (sql: string, ...p: (string | number)[]) => db.prepare(sql).all(...p) as Row[]
  const one = (sql: string, ...p: (string | number)[]) => db.prepare(sql).get(...p) as Row | undefined
  const placeholders = (k: number) => Array(k).fill('?').join(',')

  /** HYPE's price in dollars: Hyperliquid's market, else the latest Elysium HYPE/USDC trade. */
  function hypeUsd(): number | null {
    const market = marketHypeUsd()
    if (market !== null) return market
    if (!usd) return null
    const r = one(`SELECT ${PX} price_hype FROM trades WHERE token = ? AND price_hype IS NOT NULL ORDER BY block DESC, log_index DESC LIMIT 1`, usd)
    return r?.price_hype ? 1 / (r.price_hype as number) : null
  }

  // The token table is built in a worker thread (table.ts) with its own
  // database connection, so its queries never hold up a request. Requests
  // read the last table it sent.
  let rows: Row[] = []
  let worker: Worker | null = null
  const startWorker = () => {
    const ts = import.meta.url.endsWith('.ts')
    worker = new Worker(new URL(ts ? './tableWorker.ts' : './tableWorker.js', import.meta.url), {
      workerData: { dbPath, network: n },
      execArgv: ts ? ['--import', 'tsx/esm'] : [],
    })
    worker.on('message', (m: { rows: Row[] }) => (rows = m.rows))
    worker.on('error', (e) => {
      console.error(JSON.stringify({ tableWorkerError: e.message }))
      // Without a worker (tsx can fail to load one), build here instead: slower, still correct.
      if (!inProcess) {
        const { build } = tableBuilder(db, n)
        inProcess = setInterval(() => (rows = build()), 5_000)
        rows = build()
      }
    })
    worker.on('exit', () => {
      if (!inProcess) setTimeout(startWorker, 5_000)
    })
  }
  let inProcess: NodeJS.Timeout | null = null
  startWorker()

  function table(): Row[] {
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
        description: LINK_OVERRIDES[address]?.description ?? meta?.description ?? null,
        website: LINK_OVERRIDES[address]?.website ?? meta?.website ?? null,
        twitter: LINK_OVERRIDES[address]?.twitter ?? meta?.twitter ?? null,
        telegram: LINK_OVERRIDES[address]?.telegram ?? meta?.telegram ?? null,
      },
      volumeAllTimeHype: totals?.v,
      tradesAllTime: totals?.n,
      mesa: mesa
        ? {
            feeBps: mesa.buy_fee_bps,
            buyFeeBps: mesa.buy_fee_bps,
            sellFeeBps: mesa.sell_fee_bps,
            builder: mesa.builder ?? null,
            builderFeeBps: mesa.builder_fee_bps ?? 0,
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
  // The explorer: what Mesa knows about a transaction, and a wallet's activity.
  function meta(token: string) {
    const t = table().find((r) => r.address === token)
    return t ? { symbol: t.symbol, name: t.name, image: t.image, venue: t.venue } : { symbol: null, name: null, image: null, venue: null }
  }
  function txInfo(hash: string) {
    const trades = all(
      `SELECT tx, log_index, token, timestamp, trader, side, kind, quote_amount, token_amount, fee, sniper_fee, value_hype FROM trades WHERE tx = ? ORDER BY log_index`,
      hash,
    ).map((r) => ({ ...r, ...meta(r.token as string) }))
    const launches = all(`SELECT token, venue, creator, timestamp FROM pools WHERE tx = ?`, hash).map((r) => ({ ...r, ...meta(r.token as string) }))
    const burns = all(`SELECT hype_in, mesa_burned, timestamp FROM burns WHERE tx = ?`, hash)
    return { trades, launches, burns }
  }
  function activity(address: string, limit: number) {
    const trades = all(
      `SELECT tx, token, timestamp, side, kind, quote_amount, token_amount, value_hype FROM trades WHERE trader = ? ORDER BY timestamp DESC, log_index DESC LIMIT ?`,
      address,
      limit,
    ).map((r) => ({ ...r, ...meta(r.token as string) }))
    const launches = all(`SELECT token, venue, tx, timestamp FROM pools WHERE creator = ? ORDER BY timestamp DESC LIMIT 100`, address).map((r) => ({ ...r, ...meta(r.token as string) }))
    return { trades, launches }
  }

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
  /** A token younger than a day gets 24 points over its own life instead. */
  function sparkline(token: string, launchedAt = 0): number[] {
    const c = sparks.get(token)
    if (c && Date.now() - c.at < 60_000) return c.points
    const t = now()
    const start = Math.max(t - DAY, launchedAt - 60)
    const step = (t - start) / 24
    let p = (lastBefore.get(token, start) as Row | undefined)?.p as number | undefined
    const points: number[] = []
    const rows = sparkRows.all(token, start) as Row[]
    let i = 0
    for (let h = 1; h <= 24; h++) {
      const end = start + h * step
      while (i < rows.length && (rows[i].timestamp as number) <= end) p = rows[i++].p as number
      // Hours before the token's first trade are left out.
      if (p !== undefined) points.push(p)
    }
    sparks.set(token, { at: Date.now(), points })
    if (sparks.size > 5_000) sparks.clear()
    return points
  }

  /**
   * $MESA's flywheel: what has been burned, the HYPE spent buying it back,
   * and every buyback (each one burns what it buys, in the same transaction).
   */
  function mesaBurns() {
    const g = one(`SELECT token FROM mesa_launches WHERE genesis = 1`)
    if (!g) return { token: null }
    const token = g.token as string
    const supply = (one('SELECT supply FROM tokens WHERE address = ?', token)?.supply as number | null) ?? 1e9
    const burned = (one(`SELECT COALESCE(SUM(amount), 0) a FROM transfers WHERE token = ? AND dst = ?`, token, DEAD)?.a as number) ?? 0
    const buybacks = all(
      `SELECT tx, timestamp, quote_amount hype, token_amount mesa FROM trades WHERE token = ? AND kind = 'buyback' ORDER BY block DESC, log_index DESC LIMIT 1000`,
      token,
    )
    // Burns sent straight to the dead address outside a buyback, e.g. a holder burning by hand.
    // (A buyback's burn comes from the pool manager in the buyback's own transaction.)
    const manual = all(
      `SELECT tx, block, src, amount mesa FROM transfers WHERE token = ? AND dst = ?
         AND amount >= 1 AND tx NOT IN (SELECT tx FROM trades WHERE token = ? AND kind = 'buyback')
       ORDER BY block DESC LIMIT 200`,
      token,
      DEAD,
      token,
    ).map((b) => ({ ...b, timestamp: blockTime(b.block as number) }))
    const t = now()
    const fees = all(
      `SELECT p.venue, COUNT(DISTINCT p.token) tokens FROM pools p JOIN mesa_launches m ON m.token = p.token GROUP BY p.venue`,
    )
    return {
      token,
      burned,
      burnedPct: (burned / supply) * 100,
      hypeSpent: buybacks.reduce((a, b) => a + (b.hype as number), 0),
      buybacks: buybacks.length,
      burned24h: [...buybacks, ...manual]
        .filter((b) => (b.timestamp as number) > t - DAY)
        .reduce((a, b) => a + ((b as { mesa: number }).mesa), 0),
      lastAt: (buybacks[0]?.timestamp as number | undefined) ?? null,
      launches: fees.reduce((a, f) => a + (f.tokens as number), 0),
      recent: buybacks,
      manual,
    }
  }

  /** A block's time, read from the nearest indexed trades (transfers don't store one). */
  function blockTime(block: number): number {
    const a = one('SELECT block, timestamp FROM trades WHERE block <= ? ORDER BY block DESC LIMIT 1', block)
    const b = one('SELECT block, timestamp FROM trades WHERE block >= ? ORDER BY block ASC LIMIT 1', block)
    if (!a && !b) return now()
    if (!a || !b || a.block === b.block) return ((a ?? b)!.timestamp as number)
    const f = (block - (a.block as number)) / ((b.block as number) - (a.block as number))
    return Math.round((a.timestamp as number) + f * ((b.timestamp as number) - (a.timestamp as number)))
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
  // Keeps idle connections open through proxies and lets clients notice a dead one.
  setInterval(() => {
    for (const s of streams) s.write(': ping\n\n')
  }, 20_000).unref()

  // The Builder Drop is scored on its own thread every 10 minutes (airdrop.ts); og.ts and
  // github.ts gather the HyperEVM / HyperCore snapshot and GitHub activity it reads.
  const og = startOg(db)
  startGithub(db)
  /** The wallets that hold the drop's $MESA, spread out for distribution: the dev wallet and the dev-linked wallets. */
  const DROP_WALLETS = [
    '0x25db99d67481aaeb389a57ae097f2a02e48f0e13',
    '0xde4bf01f33295478233580d692ea9174a0041f9b',
    '0xa1dbea738a09b70576ce95e7e782c4196381bd17',
    '0x415dd9343b04f953cfce0d0ce96cf17a9e314db7',
    '0x6b9e2294dc291f9b99c6b1ef876e889092827669',
  ]
  const reserve = () => {
    const token = (one('SELECT token FROM mesa_launches WHERE genesis = 1 LIMIT 1')?.token as string | undefined)?.toLowerCase()
    const wallets = DROP_WALLETS.map((a) => ({
      address: a,
      balance: token ? ((one('SELECT balance FROM balances WHERE lower(token) = ? AND lower(holder) = ?', token, a)?.balance as number | undefined) ?? 0) : 0,
    }))
    return { wallets, total: wallets.reduce((x, w) => x + w.balance, 0) }
  }
  let drop: { at: number; totals: Record<PoolName, number>; wallets: number; live: string[]; scores: Map<string, WalletScore>; sorted: number[] } | null = null
  {
    const ts = import.meta.url.endsWith('.ts')
    const w = new Worker(new URL(ts ? './airdropWorker.ts' : './airdropWorker.js', import.meta.url), {
      workerData: { dbPath, network: n },
      execArgv: ts ? ['--import', 'tsx/esm'] : [],
    })
    w.on('message', (m: { at: number; totals: Record<PoolName, number>; wallets: number; live: string[]; scores: [string, WalletScore][] } | null) => {
      if (!m) return
      const scores = new Map(m.scores)
      const sorted = [...scores.values()].map((s) => estimate(m, s).mesa).sort((a, b) => b - a)
      drop = { ...m, scores, sorted }
    })
    w.on('error', (e) => console.error(JSON.stringify({ airdropWorkerError: e.message })))
    const run = () => w.postMessage({ bots: [...mev.bots.keys()].filter((b) => mev.isBot(b)) })
    setTimeout(run, 30_000).unref()
    setInterval(run, 10 * 60_000).unref()
  }

  const server = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
    res.setHeader('access-control-allow-headers', 'content-type')
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
      // Project profiles: POST /projects with a signed profile, POST /projects/github with a
      // gist that proves a GitHub account; GET /tokens/<a>/project.
      if (parts[0] === 'projects' && req.method === 'POST' && parts.length <= 2) {
        let body = ''
        let size = 0
        req.on('data', (c: Buffer) => {
          size += c.length
          if (size <= 32_768) body += c.toString('utf8')
        })
        req.on('end', () => {
          void (async () => {
            try {
              if (size > 32_768) throw new UpdateError('too large', 413)
              const b = JSON.parse(body || '{}') as Record<string, unknown>
              if (parts[1] === 'github') json({ ok: true, github: await verifyGithub(db, b) })
              else if (!parts[1]) json({ ok: true, project: saveProfile(db, b) })
              else json({ error: 'not found' }, 404)
            } catch (e) {
              if (e instanceof UpdateError) json({ error: e.message }, e.status)
              else json({ error: 'bad request' }, 400)
            }
          })()
        })
        return
      }
      // The build log: POST /updates with a signed update; GET /updates, /tokens/<a>/updates.
      if (parts[0] === 'updates' && parts.length === 1) {
        if (req.method === 'POST') {
          let body = ''
          let size = 0
          req.on('data', (c: Buffer) => {
            size += c.length
            if (size <= 8_192) body += c.toString('utf8')
          })
          req.on('end', () => {
            try {
              if (size > 8_192) throw new UpdateError('too large', 413)
              const update = postUpdate(db, JSON.parse(body || '{}'))
              json({ ok: true, update })
              push('update', update)
            } catch (e) {
              if (e instanceof UpdateError) json({ error: e.message }, e.status)
              else json({ error: 'bad request' }, 400)
            }
          })
          return
        }
        return json(
          listUpdates(db, null, num('limit', 20, 100)).map((u) => {
            const t = table().find((r) => r.address === u.token)
            return { ...u, symbol: t?.symbol ?? null, name: t?.name ?? null, image: t?.image ?? null }
          }),
        )
      }
      if (parts[0] === 'health' || parts.length === 0) return json({ ok: true, ...stats() })
      if (parts[0] === 'stats') return json(stats())
      if (parts[0] === 'mesa' && parts.length === 1) return json(mesaBurns())
      if (parts[0] === 'airdrop' && parts.length === 1)
        return json({ total: TOTAL, pools: POOLS, ready: !!drop, at: drop?.at ?? null, totals: drop?.totals ?? null, wallets: drop?.wallets ?? 0, liveCoins: drop?.live.length ?? 0, snapshot: SNAPSHOT, reserve: reserve() })
      if (parts[0] === 'airdrop' && parts.length === 2) {
        const w = parts[1]!.toLowerCase()
        if (!/^0x[0-9a-f]{40}$/.test(w)) return json({ error: 'not an address' }, 400)
        og.want(w) // snapshot its $HYPE / $KNTQ holdings if it hasn't been yet
        if (!drop) return json({ ready: false })
        const e = estimate(drop, drop.scores.get(w))
        let rank: number | null = null
        if (e.mesa > 0) {
          // Binary search the sorted (descending) estimates.
          let lo = 0
          let hi = drop.sorted.length
          while (lo < hi) {
            const mid = (lo + hi) >> 1
            if (drop.sorted[mid]! > e.mesa) lo = mid + 1
            else hi = mid
          }
          rank = lo + 1
        }
        return json({ ready: true, wallet: w, at: drop.at, total: TOTAL, poolsTotal: POOLS, totals: drop.totals, wallets: drop.wallets, rank, ...e })
      }
      if (parts[0] === 'venues') return json(venues())
      if (parts[0] === 'bridge' && parts.length === 1) return json(bridgeStats(db))
      if (parts[0] === 'bridge' && parts[1] === 'lookup') {
        const m = q.get('message')
        const tx = (q.get('tx') ?? '').toLowerCase()
        if (m !== null && /^\d+$/.test(m)) return json(bridgeLookup(db, { message: Number(m) }))
        if (/^0x[0-9a-f]{64}$/.test(tx)) return json(bridgeLookup(db, { tx }))
        return json({ error: 'give message or tx' }, 400)
      }
      if (parts[0] === 'tx' && parts[1] && parts.length === 2) {
        const h = parts[1].toLowerCase()
        if (!/^0x[0-9a-f]{64}$/.test(h)) return json({ error: 'bad hash' }, 400)
        return json(txInfo(h))
      }
      if (parts[0] === 'wallets' && parts[1] && parts[2] === 'activity' && parts.length === 3) {
        const a = parts[1].toLowerCase()
        if (!/^0x[0-9a-f]{40}$/.test(a)) return json({ error: 'bad address' }, 400)
        return json(activity(a, num('limit', 50, 500)))
      }
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
        return json({ total: rows.length, tokens: withSpark ? page.map((r) => ({ ...r, spark: sparkline(r.address as string, r.launchedAt as number) })) : page })
      }
      if (parts[0] === 'tokens' && parts[1]) {
        const a = parts[1].toLowerCase()
        if (parts.length === 2) {
          const t = tokenDetail(a)
          return t ? json(t) : json({ error: 'unknown token' }, 404)
        }
        if (parts[2] === 'updates') return json(listUpdates(db, a, num('limit', 50, 200)))
        if (parts[2] === 'project') return json(getProject(db, a))
        if (parts[2] === 'trades') {
          const before = Number(q.get('before') ?? 1e12)
          return json(
            all(
              `SELECT tx, timestamp, trader, side, kind, quote_amount, token_amount, fee, sniper_fee, price, ${PX} price_hype, value_hype
               FROM trades WHERE token = ? AND timestamp < ? ORDER BY block DESC, log_index DESC LIMIT ?`,
              a,
              before,
              num('limit', 50, 500),
            ).map((t) => ({
              ...t,
              // A sandwich bot's trade, or a trade a bot sandwiched (see mev.ts).
              mev: mev.isBot(t.trader as string | null),
              sandwiched: mev.isVictim(t.tx as string),
            })),
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
            ).map((h) => ({
              ...h,
              pct: supply ? ((h.balance as number) / supply) * 100 : null,
              mev: mev.isBot(h.address as string),
            })),
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
