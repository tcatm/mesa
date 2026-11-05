/**
 * Market data for chains Mesa does not index itself, from Codex
 * (https://docs.codex.io), served at api.mesa.cx/<chain>/... HyperEVM first.
 *
 * The Codex key stays here: browsers only ever talk to this service. Every
 * answer is cached for a few seconds and identical requests in flight share
 * one Codex call, so many visitors on one page cost about one visitor.
 *
 * Env:
 *   CODEX_API_KEY   secret Codex key                                 (required)
 *   PORT            default 8085
 *
 * Routes (all GET, JSON):
 *   /hyperevm/tokens?sort=trending|volume|gainers|new&limit=50
 *   /hyperevm/search?q=kntq
 *   /hyperevm/tokens/:address
 *   /hyperevm/tokens/:address/bars?resolution=5&from=<unix>&to=<unix>
 *   /hyperevm/tokens/:address/trades?cursor=<opaque>
 *   /img?u=<https url>   a token image, checked and cached (see images.ts)
 *   POST /upload, GET /media/<file>   images uploaded at launch (see media.ts)
 *   /health
 */
import { createServer, type ServerResponse } from 'node:http'
import { image, ImageError, imageHeaders } from './images.js'
import { media, MediaError, upload } from './media.js'

const KEY = process.env.CODEX_API_KEY
if (!KEY) throw new Error('CODEX_API_KEY is required')
const PORT = Number(process.env.PORT ?? 8085)
const ENDPOINT = 'https://graph.codex.io/graphql'

const CHAINS: Record<string, { networkId: number; name: string }> = {
  hyperevm: { networkId: 999, name: 'HyperEVM' },
}

// ---------------------------------------------------------------- codex, cached

const stats = { codexCalls: 0, codexErrors: 0, cacheHits: 0, startedAt: new Date().toISOString() }

async function codex<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  stats.codexCalls += 1
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { authorization: KEY!, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = (await res.json().catch(() => null)) as { data?: T; errors?: { message: string }[] } | null
  if (!res.ok || !body || body.errors?.length || !body.data) {
    stats.codexErrors += 1
    throw new Error(body?.errors?.[0]?.message ?? `codex http ${res.status}`)
  }
  return body.data
}

const cache = new Map<string, { at: number; ttl: number; value: Promise<unknown> }>()

/** One Codex call per key per `ttl` ms, shared by everyone asking meanwhile. */
function cached<T>(key: string, ttl: number, f: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < hit.ttl) {
    stats.cacheHits += 1
    return hit.value as Promise<T>
  }
  const value = f()
  cache.set(key, { at: Date.now(), ttl, value })
  // A failure is not cached beyond the request that saw it.
  value.catch(() => cache.get(key)?.value === value && cache.delete(key))
  if (cache.size > 5_000) {
    for (const [k, v] of cache) if (Date.now() - v.at > v.ttl) cache.delete(k)
  }
  return value
}

// ---------------------------------------------------------------- shaping

interface RawToken {
  token: { address: string; symbol: string | null; name: string | null; info?: { imageSmallUrl?: string | null } | null }
  priceUSD: string | null
  change1: string | null
  change24: string | null
  volume24: string | null
  marketCap: string | null
  circulatingMarketCap: string | null
  liquidity: string | null
  txnCount24: number | null
  buyCount24: number | null
  sellCount24: number | null
  holders: number | null
  createdAt: number | null
  pair: { address: string } | null
}

const TOKEN_FIELDS = `
  token { address symbol name info { imageSmallUrl } }
  priceUSD change1 change24 volume24 marketCap circulatingMarketCap liquidity
  txnCount24 buyCount24 sellCount24 holders createdAt pair { address }`

const num = (s: string | null | undefined) => (s === null || s === undefined || s === '' ? null : Number(s))

/**
 * Market caps come from total supply, which for bridged and multichain assets
 * (USDC, UBTC, UETH) counts every chain, not this one. Such a figure is many
 * thousand times the token's liquidity here, so above that ratio (or above
 * $500B outright) it is dropped rather than shown. Real tokens sit far below:
 * WHYPE ~55x, KNTQ ~200x its liquidity.
 */
const MAX_PLAUSIBLE_MCAP = 5e11
const MAX_MCAP_TO_LIQUIDITY = 20_000

function plausibleMcap(mcap: number | null, liquidity: number | null): number | null {
  if (mcap === null || mcap > MAX_PLAUSIBLE_MCAP) return null
  if (liquidity !== null && liquidity > 0 && mcap / liquidity > MAX_MCAP_TO_LIQUIDITY) return null
  return mcap
}

function shape(t: RawToken) {
  const mcap = plausibleMcap(num(t.circulatingMarketCap) ?? num(t.marketCap), num(t.liquidity))
  return {
    address: t.token.address,
    symbol: t.token.symbol ?? '?',
    name: t.token.name ?? '',
    image: t.token.info?.imageSmallUrl ?? null,
    priceUsd: num(t.priceUSD),
    change1h: num(t.change1),
    change24h: num(t.change24),
    volume24hUsd: num(t.volume24),
    marketCapUsd: mcap,
    liquidityUsd: num(t.liquidity),
    trades24h: t.txnCount24,
    buys24h: t.buyCount24,
    sells24h: t.sellCount24,
    holders: t.holders,
    createdAt: t.createdAt,
    pair: t.pair?.address ?? null,
  }
}

const SORTS: Record<string, { attribute: string; filters?: Record<string, unknown> }> = {
  trending: { attribute: 'trendingScore24' },
  volume: { attribute: 'volume24' },
  gainers: { attribute: 'change24', filters: { volume24: { gt: 5_000 } } },
  new: { attribute: 'createdAt' },
}

// Resolutions Codex accepts, and how long one bar lasts (for cache keys).
const RESOLUTIONS: Record<string, number> = { '1': 60, '5': 300, '15': 900, '60': 3600, '240': 14_400, '1D': 86_400 }

// ---------------------------------------------------------------- routes

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const isAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a)

async function route(url: URL): Promise<unknown> {
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[0] === 'health') return { ok: true, ...stats, cacheEntries: cache.size }

  const chain = CHAINS[parts[0] ?? '']
  if (!chain) throw new HttpError(404, 'unknown chain')
  const net = chain.networkId

  // /<chain>/tokens
  if (parts[1] === 'tokens' && parts.length === 2) {
    const sort = SORTS[url.searchParams.get('sort') ?? 'trending']
    if (!sort) throw new HttpError(400, 'sort must be trending, volume, gainers or new')
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50))
    const key = `tokens:${net}:${url.searchParams.get('sort') ?? 'trending'}:${limit}`
    return cached(key, 10_000, async () => {
      const d = await codex<{ filterTokens: { results: RawToken[] } }>(
        `query($filters: TokenFilters, $rankings: [TokenRanking], $limit: Int) {
          filterTokens(filters: $filters, rankings: $rankings, limit: $limit) { results { ${TOKEN_FIELDS} } } }`,
        {
          filters: { network: [net], liquidity: { gt: 5_000 }, ...sort.filters },
          rankings: [{ attribute: sort.attribute, direction: 'DESC' }],
          limit,
        },
      )
      return { chain: chain.name, tokens: d.filterTokens.results.map(shape) }
    })
  }

  // /<chain>/search?q=
  if (parts[1] === 'search' && parts.length === 2) {
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 64)
    if (q.length < 2) throw new HttpError(400, 'q must be at least 2 characters')
    return cached(`search:${net}:${q.toLowerCase()}`, 30_000, async () => {
      const d = await codex<{ filterTokens: { results: RawToken[] } }>(
        `query($filters: TokenFilters, $phrase: String) {
          filterTokens(filters: $filters, phrase: $phrase, limit: 20,
            rankings: [{ attribute: volume24, direction: DESC }]) { results { ${TOKEN_FIELDS} } } }`,
        { filters: { network: [net] }, phrase: q },
      )
      return { chain: chain.name, tokens: d.filterTokens.results.map(shape) }
    })
  }

  // /<chain>/tokens/:address[/bars|/trades]
  if (parts[1] === 'tokens' && parts[2]) {
    const address = parts[2].toLowerCase()
    if (!isAddress(address)) throw new HttpError(400, 'bad address')

    if (parts.length === 3) {
      return cached(`token:${net}:${address}`, 10_000, async () => {
        const d = await codex<{ filterTokens: { results: RawToken[] } }>(
          `query($tokens: [String]) { filterTokens(tokens: $tokens, limit: 1) { results { ${TOKEN_FIELDS} } } }`,
          { tokens: [`${address}:${net}`] },
        )
        const t = d.filterTokens.results[0]
        if (!t) throw new HttpError(404, 'token not found')
        return { chain: chain.name, token: shape(t) }
      })
    }

    if (parts[3] === 'bars' && parts.length === 4) {
      const resolution = url.searchParams.get('resolution') ?? '5'
      const seconds = RESOLUTIONS[resolution]
      if (!seconds) throw new HttpError(400, `resolution must be one of ${Object.keys(RESOLUTIONS).join(', ')}`)
      const now = Math.floor(Date.now() / 1000)
      const to = Math.min(now, Number(url.searchParams.get('to') ?? now) || now)
      const from = Math.max(to - seconds * 1_500, Number(url.searchParams.get('from') ?? to - seconds * 300) || 0)
      // Bucketed to the bar, so everyone viewing the same chart shares one call.
      const bucket = (x: number) => Math.floor(x / seconds) * seconds
      const key = `bars:${net}:${address}:${resolution}:${bucket(from)}:${bucket(to)}`
      return cached(key, Math.min(15_000, seconds * 1000), async () => {
        const d = await codex<{ getBars: { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; volume: string[] } | null }>(
          `query($symbol: String!, $from: Int!, $to: Int!, $resolution: String!) {
            getBars(symbol: $symbol, from: $from, to: $to, resolution: $resolution, removeLeadingNullValues: true, symbolType: TOKEN) {
              t o h l c volume } }`,
          { symbol: `${address}:${net}`, from: bucket(from), to: bucket(to) + seconds, resolution },
        )
        const b = d.getBars
        const bars = b ? b.t.map((t, i) => ({ t, o: b.o[i], h: b.h[i], l: b.l[i], c: b.c[i], v: Number(b.volume[i] ?? 0) })) : []
        return { chain: chain.name, resolution, bars }
      })
    }

    if (parts[3] === 'trades' && parts.length === 4) {
      const cursor = url.searchParams.get('cursor')
      if (cursor && cursor.length > 2_000) throw new HttpError(400, 'bad cursor')
      return cached(`trades:${net}:${address}:${cursor ?? ''}`, cursor ? 60_000 : 4_000, async () => {
        const d = await codex<{
          getTokenEvents: {
            cursor: string | null
            items: {
              timestamp: number
              transactionHash: string
              maker: string
              eventDisplayType: string
              data: { priceUsd?: string; priceUsdTotal?: string; amountNonLiquidityToken?: string } | null
            }[]
          } | null
        }>(
          `query($query: EventsQueryInput!, $cursor: String) {
            getTokenEvents(query: $query, cursor: $cursor, limit: 50) { cursor items {
              timestamp transactionHash maker eventDisplayType
              data { ... on SwapEventData { priceUsd priceUsdTotal amountNonLiquidityToken } } } } }`,
          { query: { address, networkId: net, eventDisplayType: ['Buy', 'Sell'] }, cursor },
        )
        const e = d.getTokenEvents
        return {
          chain: chain.name,
          cursor: e?.cursor ?? null,
          trades: (e?.items ?? []).map((x) => ({
            time: x.timestamp,
            tx: x.transactionHash,
            trader: x.maker,
            side: x.eventDisplayType === 'Buy' ? 'buy' : 'sell',
            priceUsd: num(x.data?.priceUsd),
            valueUsd: num(x.data?.priceUsdTotal),
            amount: num(x.data?.amountNonLiquidityToken),
          })),
        }
      })
    }
  }
  throw new HttpError(404, 'not found')
}

// ---------------------------------------------------------------- server

/** Simple per-IP limit, so one client cannot spend the Codex budget. */
const hits = new Map<string, { n: number; at: number }>()
const PER_MINUTE = Number(process.env.PER_IP_PER_MIN ?? 300)
function allowed(ip: string, table = hits, limit = PER_MINUTE): boolean {
  const now = Date.now()
  const h = table.get(ip)
  if (!h || now - h.at > 60_000) {
    table.set(ip, { n: 1, at: now })
    if (table.size > 50_000) table.clear()
    return true
  }
  h.n += 1
  return h.n <= limit
}
/** Images have their own, looser limit: a page of tokens is dozens of them. */
const imageHits = new Map<string, { n: number; at: number }>()
const IMAGES_PER_MINUTE = Number(process.env.IMAGES_PER_IP_PER_MIN ?? 1200)

function send(res: ServerResponse, status: number, body: unknown, maxAge = 0) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'cache-control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
  })
  res.end(JSON.stringify(body))
}

createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res
      .writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '86400',
      })
      .end()
    return
  }
  const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? ''
  const url = new URL(req.url ?? '/', 'http://local')
  if (url.pathname === '/upload') {
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
    upload(req, ip).then(
      (r) => send(res, 200, r),
      (e: unknown) => send(res, e instanceof MediaError ? e.status : 500, { error: e instanceof MediaError ? e.message : 'upload failed' }),
    )
    return
  }
  if (req.method !== 'GET') return send(res, 405, { error: 'GET only' })
  if (url.pathname.startsWith('/media/')) {
    if (!allowed(ip, imageHits, IMAGES_PER_MINUTE)) return send(res, 429, { error: 'too many requests' })
    media(url.pathname.slice('/media/'.length)).then(
      (m) => {
        if (!m) return send(res, 404, { error: 'not found' }, 60)
        res.writeHead(200, { ...imageHeaders(m.type, m.body.length), 'cache-control': 'public, max-age=31536000, immutable' })
        res.end(m.body)
      },
      () => send(res, 500, { error: 'unavailable' }),
    )
    return
  }
  if (url.pathname === '/img') {
    if (!allowed(ip, imageHits, IMAGES_PER_MINUTE)) return send(res, 429, { error: 'too many requests' })
    image(url.searchParams.get('u') ?? '').then(
      ({ type, body }) => {
        res.writeHead(200, imageHeaders(type, body.length))
        res.end(body)
      },
      (e: unknown) => send(res, e instanceof ImageError ? e.status : 502, { error: e instanceof ImageError ? e.message : 'image unavailable' }, 60),
    )
    return
  }
  if (!allowed(ip)) return send(res, 429, { error: 'too many requests' })
  route(url).then(
    (body) => send(res, 200, body, url.pathname === '/health' ? 0 : 5),
    (e: unknown) => {
      const status = e instanceof HttpError ? e.status : 502
      if (status === 502) console.error(JSON.stringify({ path: url.pathname, error: e instanceof Error ? e.message : String(e) }))
      send(res, status, { error: status === 502 ? 'market data unavailable' : (e as Error).message })
    },
  )
}).listen(PORT, () => console.log(JSON.stringify({ market: PORT, chains: Object.keys(CHAINS) })))
