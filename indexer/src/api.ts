import { createServer, type ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'

import { BUNDLE_BLOCKS, DEAD, SUPPLY, type Deployment } from './config.js'
import { getMeta } from './db.js'
import { live } from './indexer.js'

const DAY = 86_400
const ZERO = '0x0000000000000000000000000000000000000000'

type Row = Record<string, unknown>

/**
 * The terminal's read API. All amounts are in whole units (HYPE or the
 * pool's quote, and tokens); prices are quote per token; market caps are in
 * the quote.
 *
 *   GET /tokens?sort=new|trending|volume|mcap&q=&limit=&offset=
 *   GET /tokens/:address
 *   GET /tokens/:address/trades?limit=&before=<unix seconds>
 *   GET /tokens/:address/candles?interval=<seconds>&limit=
 *   GET /tokens/:address/holders?limit=
 *   GET /stats
 *   GET /stream            server-sent events: launch, trade
 *   GET /health
 */
export function serve(db: DatabaseSync, d: Deployment, port: number) {
  const excluded = new Set([d.poolManager.toLowerCase(), d.hook.toLowerCase(), DEAD, ZERO])
  const now = () => Math.floor(Date.now() / 1000)
  const all = (sql: string, ...p: (string | number)[]) => db.prepare(sql).all(...p) as Row[]
  const one = (sql: string, ...p: (string | number)[]) => db.prepare(sql).get(...p) as Row | undefined

  /** Every column the token table shows, computed for all tokens at once. */
  function table(): Row[] {
    const t = now()
    const tokens = all('SELECT * FROM tokens')
    const last = new Map(
      all(
        `SELECT token, price FROM (SELECT token, price, ROW_NUMBER() OVER (PARTITION BY token ORDER BY block DESC, log_index DESC) rn FROM trades) WHERE rn = 1`,
      ).map((r) => [r.token, r.price as number]),
    )
    const dayAgo = new Map(
      all(
        `SELECT token, price FROM (SELECT token, price, ROW_NUMBER() OVER (PARTITION BY token ORDER BY block DESC, log_index DESC) rn FROM trades WHERE timestamp <= ?) WHERE rn = 1`,
        t - DAY,
      ).map((r) => [r.token, r.price as number]),
    )
    const vol = new Map(
      all('SELECT token, SUM(quote_amount) v, COUNT(*) n FROM trades WHERE timestamp > ? GROUP BY token', t - DAY).map((r) => [
        r.token,
        r,
      ]),
    )
    const balances = holdersByToken()
    const bundles = new Map(
      all(
        `SELECT tr.token, SUM(tr.token_amount) amt FROM trades tr JOIN tokens tk ON tk.address = tr.token
         WHERE tr.side = 'buy' AND tr.kind = 'trade' AND tr.trader != tk.creator AND tr.block < tk.block + ?
         GROUP BY tr.token`,
        BUNDLE_BLOCKS,
      ).map((r) => [r.token, r.amt as number]),
    )
    return tokens.map((tk) => {
      const a = tk.address as string
      const price = last.get(a) ?? (tk.initial_price as number | null) ?? 0
      const before = dayAgo.get(a) ?? (tk.initial_price as number | null) ?? price
      const holders = balances.get(a) ?? new Map<string, number>()
      const v = vol.get(a)
      return {
        address: a,
        name: tk.name,
        symbol: tk.symbol,
        metadataUri: tk.metadata_uri,
        creator: tk.creator,
        quote: tk.quote,
        genesis: tk.genesis === 1,
        launchedAt: tk.timestamp,
        price,
        marketCap: price * SUPPLY,
        change24h: before ? (price / before - 1) * 100 : 0,
        volume24h: (v?.v as number) ?? 0,
        trades24h: (v?.n as number) ?? 0,
        holders: holders.size,
        devPct: ((holders.get(tk.creator as string) ?? 0) / SUPPLY) * 100,
        bundlePct: ((bundles.get(a) ?? 0) / SUPPLY) * 100,
      }
    })
  }

  /** token -> holder -> balance, excluding the pool, the hook and burns. */
  function holdersByToken(token?: string): Map<string, Map<string, number>> {
    const rows = all(
      `SELECT token, addr, SUM(delta) bal FROM (
         SELECT token, dst addr, amount delta FROM transfers ${token ? 'WHERE token = ?' : ''}
         UNION ALL SELECT token, src addr, -amount FROM transfers ${token ? 'WHERE token = ?' : ''}
       ) GROUP BY token, addr HAVING bal > 1e-9`,
      ...(token ? [token, token] : []),
    )
    const out = new Map<string, Map<string, number>>()
    for (const r of rows) {
      if (excluded.has(r.addr as string)) continue
      const m = out.get(r.token as string) ?? new Map<string, number>()
      m.set(r.addr as string, r.bal as number)
      out.set(r.token as string, m)
    }
    return out
  }

  function tokenDetail(address: string) {
    const tk = one('SELECT * FROM tokens WHERE address = ?', address)
    if (!tk) return null
    const row = table().find((r) => r.address === address)!
    const holders = [...(holdersByToken(address).get(address) ?? new Map()).entries()].sort((a, b) => b[1] - a[1])
    const snipeEnd = (tk.timestamp as number) + (tk.snipe_seconds as number)
    const early = one(
      `SELECT COUNT(DISTINCT trader) wallets, COALESCE(SUM(token_amount), 0) tokens, COALESCE(SUM(sniper_fee), 0) sniperFees
       FROM trades WHERE token = ? AND side = 'buy' AND kind = 'trade' AND timestamp < ?`,
      address,
      snipeEnd,
    )
    const history = table()
      .filter((r) => r.creator === tk.creator && r.address !== address)
      .map((r) => ({ address: r.address, symbol: r.symbol, launchedAt: r.launchedAt, marketCap: r.marketCap }))
    const volume = one('SELECT COALESCE(SUM(quote_amount), 0) v, COUNT(*) n FROM trades WHERE token = ?', address)
    return {
      ...row,
      poolId: tk.pool_id,
      feeRecipient: tk.fee_recipient,
      launchTx: tk.tx,
      config: {
        buyFeeBps: tk.buy_fee_bps,
        sellFeeBps: tk.sell_fee_bps,
        sniperFeeBps: tk.sniper_fee_bps,
        snipeSeconds: tk.snipe_seconds,
        maxBuyBps: tk.max_buy_bps,
      },
      volumeAllTime: volume?.v,
      tradesAllTime: volume?.n,
      forensics: {
        devBuy: { quote: tk.dev_buy_quote, tokens: tk.dev_buy_tokens, pct: ((tk.dev_buy_tokens as number) / SUPPLY) * 100 },
        devHoldsPct: row.devPct,
        bundlePct: row.bundlePct,
        snipeWindow: { wallets: early?.wallets, tokensPct: ((early?.tokens as number) / SUPPLY) * 100, sniperFeesPaid: early?.sniperFees },
        top10Pct: (holders.slice(0, 10).reduce((s, [, b]) => s + b, 0) / SUPPLY) * 100,
        topHolders: holders.slice(0, 10).map(([address, bal]) => ({ address, pct: (bal / SUPPLY) * 100 })),
        creatorLaunches: history,
      },
    }
  }

  function candles(address: string, interval: number, limit: number) {
    const tk = one('SELECT initial_price FROM tokens WHERE address = ?', address)
    if (!tk) return null
    const rows = all('SELECT timestamp, price, quote_amount FROM trades WHERE token = ? ORDER BY block, log_index', address)
    const out: { t: number; o: number; h: number; l: number; c: number; v: number }[] = []
    let prev = (tk.initial_price as number | null) ?? rows[0]?.price
    for (const r of rows) {
      const t = Math.floor((r.timestamp as number) / interval) * interval
      const p = r.price as number
      let c = out[out.length - 1]
      if (!c || c.t !== t) {
        c = { t, o: prev as number, h: Math.max(prev as number, p), l: Math.min(prev as number, p), c: p, v: 0 }
        out.push(c)
      }
      c.h = Math.max(c.h, p)
      c.l = Math.min(c.l, p)
      c.c = p
      c.v += r.quote_amount as number
      prev = p
    }
    return out.slice(-limit)
  }

  function stats() {
    const t = now()
    const day = one('SELECT COALESCE(SUM(quote_amount), 0) v, COUNT(*) n FROM trades WHERE timestamp > ?', t - DAY)
    const genesis = one('SELECT address FROM tokens WHERE genesis = 1')
    const burned = genesis
      ? one(`SELECT COALESCE(SUM(amount), 0) a FROM transfers WHERE token = ? AND dst = ?`, genesis.address as string, DEAD)
      : undefined
    return {
      tokensLaunched: one('SELECT COUNT(*) n FROM tokens')?.n,
      volume24h: day?.v,
      trades24h: day?.n,
      mesaBurned: burned?.a ?? 0,
      buybacks: one('SELECT COUNT(*) n, COALESCE(SUM(hype_in), 0) hype FROM burns'),
      indexedTo: Number(getMeta(db, 'cursor') ?? d.startBlock) - 1,
      head: Number(getMeta(db, 'head') ?? 0),
    }
  }

  const streams = new Set<ServerResponse>()
  const push = (event: string, data: unknown) => {
    for (const s of streams) s.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  live.on('launch', (r) => push('launch', r))
  live.on('trade', (r) => push('trade', r))

  const server = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*')
    if (req.method === 'OPTIONS') return res.writeHead(204).end()
    const url = new URL(req.url ?? '/', 'http://x')
    const q = url.searchParams
    const parts = url.pathname.split('/').filter(Boolean)
    const num = (k: string, def: number, max: number) => Math.min(max, Math.max(1, Number(q.get(k) ?? def) || def))
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' })
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
      if (parts[0] === 'tokens' && parts.length === 1) {
        const search = (q.get('q') ?? '').toLowerCase()
        let rows = table()
        if (search) {
          rows = rows.filter(
            (r) => (r.symbol as string).toLowerCase().includes(search) || (r.name as string).toLowerCase().includes(search) || r.address === search,
          )
        }
        const sort = q.get('sort') ?? 'new'
        const key = { new: 'launchedAt', volume: 'volume24h', mcap: 'marketCap', trending: 'trades24h' }[sort] ?? 'launchedAt'
        rows.sort((a, b) => (b[key] as number) - (a[key] as number))
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
              'SELECT * FROM trades WHERE token = ? AND timestamp < ? ORDER BY block DESC, log_index DESC LIMIT ?',
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
          const h = [...(holdersByToken(a).get(a) ?? new Map()).entries()].sort((x, y) => y[1] - x[1])
          return json(h.slice(0, num('limit', 100, 1_000)).map(([address, balance]) => ({ address, balance, pct: (balance / SUPPLY) * 100 })))
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
