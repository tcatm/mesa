import type { DatabaseSync } from 'node:sqlite'

import { DEAD, ZERO, type Network } from './config.js'

/**
 * The Mesa Builder Drop: 88,888,888 $MESA, scored from what's on chain and
 * what builders post to Mesa. Points are provisional: a final sybil review
 * runs before the snapshot, and some checks (GitHub commit activity, funding
 * clusters, the $HYPE / $KNTQ snapshot) are added later.
 *
 * Each pool is split by points within that pool only, so one category can't
 * be farmed into another:
 *   builders 30M · Mesa traders 30M · $MESA holders & burners 10M ·
 *   traders across Elysium 10M · $HYPE & $KNTQ OGs 8.888888M
 */
export const POOLS = {
  builders: 30_000_000,
  mesaTraders: 30_000_000,
  holders: 10_000_000,
  elysium: 10_000_000,
  og: 8_888_888,
} as const
export type PoolName = keyof typeof POOLS
export const TOTAL = Object.values(POOLS).reduce((a, b) => a + b, 0)
const WALLET_CAP = 1_000_000

/** Wallets that never earn: the team, dev-linked wallets, both Mesa Lab agents, the drop wallet. */
const EXCLUDED = [
  '0x25db99d67481aaeb389a57ae097f2a02e48f0e13', // Mesa dev wallet
  '0xde4bf01f33295478233580d692ea9174a0041f9b', // dev-linked (the drop's supply)
  '0xa1dbea738a09b70576ce95e7e782c4196381bd17',
  '0x415dd9343b04f953cfce0d0ce96cf17a9e314db7',
  '0x6b9e2294dc291f9b99c6b1ef876e889092827669',
  '0xe6db85515b798f33e3e56663ab22cd951917d87e', // Mesa Lab builder agent
  '0xca1d5ee87992ba1e6b8f67789e316f36274327f8', // Mesa Lab idea agent
  ...(process.env.AIRDROP_EXCLUDE ?? '').split(',').map((a) => a.trim().toLowerCase()).filter(Boolean),
]

const DAY = 86_400
const ROUND_TRIP = 120 // a buy and a sell of the same coin this close together don't count
const MIN_DAY_HYPE = 0.05
const MIN_ACTIVE_DAYS = 3
const LIVE_HOLDERS = 25

export interface Item {
  label: string
  points: number
  detail?: string
}
export interface WalletScore {
  pools: Partial<Record<PoolName, { points: number; items: Item[] }>>
}
export interface Result {
  at: number
  totals: Record<PoolName, number>
  wallets: number
  live: string[] // Mesa coins that count as live
  scores: Map<string, WalletScore>
}

export function computeAirdrop(db: DatabaseSync, n: Network, isBot: (a: string) => boolean): Result {
  const all = <T>(sql: string, ...p: (string | number)[]) => db.prepare(sql).all(...p) as T[]
  const mesaHook = n.mesa!.hook.toLowerCase()
  const mesaToken = (
    db.prepare("SELECT token FROM mesa_launches WHERE genesis = 1 LIMIT 1").get() as { token: string } | undefined
  )?.token.toLowerCase()
  const excluded = new Set<string>([
    ...EXCLUDED,
    DEAD,
    ZERO,
    mesaHook,
    n.mesa!.burner.toLowerCase(),
    ...n.poolManagers.map((p) => p.address.toLowerCase()),
    ...all<{ hook: string }>('SELECT DISTINCT hook FROM pools').map((h) => h.hook.toLowerCase()),
  ])
  const skip = (a: string | null | undefined) => !a || excluded.has(a) || isBot(a)

  const scores = new Map<string, WalletScore>()
  const add = (w: string, pool: PoolName, label: string, points: number, detail?: string) => {
    if (points <= 0) return
    const s = scores.get(w) ?? { pools: {} }
    const p = (s.pools[pool] ??= { points: 0, items: [] })
    p.points += points
    p.items.push({ label, points: Math.round(points), detail })
    scores.set(w, s)
  }

  // ------------------------------------------------------------------ Mesa coins
  const launches = all<{ token: string; creator: string; builder: string | null; builder_fee_bps: number; genesis: number; t: number }>(
    `SELECT m.token, m.creator, m.builder, m.builder_fee_bps, m.genesis, p.timestamp t
       FROM mesa_launches m JOIN pools p ON p.token = m.token AND p.hook = ?`,
    mesaHook,
  ).map((l) => ({ ...l, token: l.token.toLowerCase(), creator: l.creator.toLowerCase(), builder: l.builder?.toLowerCase() ?? null }))
  const creatorOf = new Map(launches.map((l) => [l.token, l.creator]))
  const launchAt = new Map(launches.map((l) => [l.token, l.t]))

  // ------------------------------------------------------------------ one pass over every trade
  interface Agg {
    mesaVol: number
    mesaBoost: number
    mesaDays: Map<number, number>
    otherVol: number
    otherDays: Map<number, number>
    tokens: Set<string>
  }
  const agg = new Map<string, Agg>()
  const get = (w: string) => {
    let a = agg.get(w)
    if (!a) agg.set(w, (a = { mesaVol: 0, mesaBoost: 0, mesaDays: new Map(), otherVol: 0, otherDays: new Map(), tokens: new Set() }))
    return a
  }
  // Per coin: who bought how much, and when they first bought / last sold (for holders and early backers).
  const buys = new Map<string, Map<string, { hype: number; first: number; firstHourBuy: number; soldWithinDay: boolean }>>()
  const outsideVol = new Map<string, number>() // Mesa coin -> HYPE traded by others
  const builderFees = new Map<string, number>() // builder app -> HYPE earned

  const mesaPool = new Set(all<{ id: string }>('SELECT id FROM pools WHERE hook = ?', mesaHook).map((p) => p.id))
  const launchBy = new Map(launches.map((l) => [l.token, l]))
  type Tr = { trader: string; token: string; pool: string; side: string; ts: number; v: number }
  let prev: Tr | null = null
  const stmt = db.prepare(
    `SELECT lower(trader) trader, lower(token) token, pool, side, timestamp ts, value_hype v FROM trades
      WHERE kind = 'trade' AND trader IS NOT NULL AND value_hype IS NOT NULL AND value_hype > 0
      ORDER BY trader, token, timestamp`,
  )
  const rows = stmt.all() as unknown as Tr[]
  // Count a trade only once we know the next one isn't its round trip.
  const pending: Tr[] = []
  const flush = (t: Tr) => {
    if (skip(t.trader)) return
    const a = get(t.trader)
    const day = Math.floor(t.ts / DAY)
    a.tokens.add(t.token)
    const isMesa = mesaPool.has(t.pool)
    if (isMesa) {
      if (creatorOf.get(t.token) === t.trader) return // trading your own coin doesn't count
      a.mesaVol += t.v
      a.mesaDays.set(day, (a.mesaDays.get(day) ?? 0) + t.v)
      outsideVol.set(t.token, (outsideVol.get(t.token) ?? 0) + t.v)
      const l = launchBy.get(t.token)
      if (l?.builder && l.builder !== l.creator && l.builder_fee_bps > 0)
        builderFees.set(l.builder, (builderFees.get(l.builder) ?? 0) + (t.v * l.builder_fee_bps) / 10_000)
    } else {
      a.otherVol += t.v
      a.otherDays.set(day, (a.otherDays.get(day) ?? 0) + t.v)
    }
    if (isMesa) {
      const m = buys.get(t.token) ?? new Map()
      buys.set(t.token, m)
      const b = m.get(t.trader) ?? { hype: 0, first: 0, firstHourBuy: 0, soldWithinDay: false }
      if (t.side === 'buy') {
        b.hype += t.v
        if (!b.first) b.first = t.ts
        const at = launchAt.get(t.token) ?? 0
        if (t.ts - at <= 3_600) b.firstHourBuy += t.v
      } else if (b.first && t.ts - b.first < DAY) b.soldWithinDay = true
      m.set(t.trader, b)
    }
  }
  for (const r of rows) {
    if (prev && prev.trader === r.trader && prev.token === r.token && prev.side === 'buy' && r.side === 'sell' && r.ts - prev.ts <= ROUND_TRIP) {
      pending.pop() // the buy and this sell are a round trip: neither counts
      prev = null
      continue
    }
    if (pending.length) flush(pending.pop()!)
    pending.push(r)
    prev = r
  }
  if (pending.length) flush(pending.pop()!)

  // ------------------------------------------------------------------ live coins and qualifying holders
  const now = Math.floor(Date.now() / 1000)
  const holderRows = all<{ token: string; holder: string }>(
    `SELECT lower(token) token, lower(holder) holder FROM balances WHERE balance > 0 AND token IN (${launches.map(() => '?').join(',') || "''"})`,
    ...launches.map((l) => l.token),
  )
  const holdersOf = new Map<string, Set<string>>()
  for (const h of holderRows) (holdersOf.get(h.token) ?? holdersOf.set(h.token, new Set()).get(h.token)!).add(h.holder)
  const qualifying = new Map<string, number>()
  for (const l of launches) {
    const m = buys.get(l.token)
    let q = 0
    for (const h of holdersOf.get(l.token) ?? []) {
      if (h === l.creator || skip(h)) continue
      const b = m?.get(h)
      if (!b || b.hype < 0.02 || now - b.first < DAY) continue
      const others = [...(agg.get(h)?.tokens ?? [])].filter((t) => t !== l.token).length
      if (others < 2) continue
      q++
    }
    qualifying.set(l.token, q)
  }
  const live = new Set(launches.filter((l) => !l.genesis && (qualifying.get(l.token) ?? 0) >= LIVE_HOLDERS).map((l) => l.token))

  // ------------------------------------------------------------------ builders
  const profiles = new Map(
    all<{ token: string; profile: string }>('SELECT lower(token) token, profile FROM project_profiles').map((p) => [p.token, JSON.parse(p.profile) as { tagline?: string; about?: string; roadmap?: { status: string }[] }]),
  )
  const github = new Set(all<{ token: string }>('SELECT lower(token) token FROM project_github').map((g) => g.token))
  const posts = all<{ token: string; author: string; time: number }>('SELECT lower(token) token, lower(author) author, time FROM build_updates')
  const meta = new Map(all<{ token: string; description: string | null }>('SELECT lower(token) token, description FROM token_meta').map((m) => [m.token, m.description ?? '']))
  const ideaSymbols = new Set(
    launches
      .filter((l) => l.creator === '0xca1d5ee87992ba1e6b8f67789e316f36274327f8')
      .map((l) => (all<{ symbol: string }>('SELECT symbol FROM tokens WHERE lower(address) = ?', l.token)[0]?.symbol ?? '').toUpperCase())
      .filter(Boolean),
  )
  const byCreator = new Map<string, typeof launches>()
  for (const l of launches) if (live.has(l.token) && !skip(l.creator)) (byCreator.get(l.creator) ?? byCreator.set(l.creator, []).get(l.creator)!).push(l)
  for (const [w, coins] of byCreator) {
    const counted = coins.sort((a, b) => (qualifying.get(b.token) ?? 0) - (qualifying.get(a.token) ?? 0)).slice(0, 3)
    let holderPts = 0
    let volPts = 0
    let gh = false
    const weeks = new Set<number>()
    for (const c of counted) {
      add(w, 'builders', 'Live coin', 200, `25+ real holders`)
      const p = profiles.get(c.token)
      if (p?.tagline && p.about && (p.roadmap?.length ?? 0) > 0) add(w, 'builders', 'Project page', 250)
      if (github.has(c.token)) gh = true
      const done = Math.min(5, (p?.roadmap ?? []).filter((r) => r.status === 'done').length)
      const myPosts = posts.filter((x) => x.token === c.token && x.author === w)
      if (done && myPosts.length) add(w, 'builders', 'Milestones shipped', done * 250, `${done} done`)
      for (const x of myPosts) weeks.add(Math.floor(x.time / (7 * DAY)))
      holderPts += 5 * (qualifying.get(c.token) ?? 0)
      volPts += 20 * (outsideVol.get(c.token) ?? 0)
      // A fork of an idea from the Mesa Lab idea agent.
      const fork = /fork of \$([A-Z0-9]{2,10})/i.exec(meta.get(c.token) ?? '')?.[1]?.toUpperCase()
      if (fork && ideaSymbols.has(fork)) {
        add(w, 'builders', 'Forked an open idea', 300, `$${fork}`)
        if (github.has(c.token) && myPosts.length >= 3) add(w, 'builders', 'Shipped the fork', 1_500)
      }
    }
    if (gh) add(w, 'builders', 'Verified GitHub', 1_000)
    const wk = [...weeks].sort((a, b) => a - b)
    const logPts = wk.reduce((s, _, i) => s + (i >= 3 ? 150 : 100), 0)
    if (logPts) add(w, 'builders', 'Build-log weeks', logPts, `${wk.length} weeks`)
    add(w, 'builders', 'Real holders', Math.min(2_500, holderPts))
    add(w, 'builders', 'Outside volume', Math.min(2_500, volPts))
  }
  // Agent apps that launch coins for others (the builder fee).
  for (const [app, fees] of builderFees) {
    if (skip(app)) continue
    add(app, 'builders', 'Builder fees earned', 1_000 * fees, `${fees.toFixed(3)} HYPE`)
    const n2 = launches.filter((l) => l.builder === app && l.creator !== app && live.has(l.token)).length
    add(app, 'builders', 'Live coins through your app', 300 * n2)
  }

  // ------------------------------------------------------------------ traders
  const builderCoins = new Set([...live].filter((t) => github.has(t)))
  for (const [w, a] of agg) {
    const mesaDays = [...a.mesaDays.values()].filter((v) => v >= MIN_DAY_HYPE).length
    if (mesaDays >= MIN_ACTIVE_DAYS) {
      add(w, 'mesaTraders', 'Mesa volume', 10 * Math.min(500, a.mesaVol), `${a.mesaVol.toFixed(2)} HYPE`)
      add(w, 'mesaTraders', 'Active days', 20 * mesaDays, `${mesaDays} days`)
      let early = 0
      let boost = 0
      for (const t of live) {
        const b = buys.get(t)?.get(w)
        if (b && b.firstHourBuy > 0 && !b.soldWithinDay && creatorOf.get(t) !== w) early++
        if (builderCoins.has(t) && b) boost += b.hype
      }
      add(w, 'mesaTraders', 'Early backer', 25 * Math.min(40, early), `${Math.min(40, early)} coins`)
      add(w, 'mesaTraders', 'Backing builders (×2)', 10 * Math.min(500, boost), 'coins with a verified GitHub')
    }
    const otherDays = [...a.otherDays.values()].filter((v) => v >= MIN_DAY_HYPE).length
    if (otherDays >= MIN_ACTIVE_DAYS) {
      add(w, 'elysium', 'Volume on other launchpads', 5 * Math.min(1_000, a.otherVol), `${a.otherVol.toFixed(2)} HYPE`)
      add(w, 'elysium', 'Active days', 10 * otherDays, `${otherDays} days`)
    }
  }

  // ------------------------------------------------------------------ $MESA holders and burners
  if (mesaToken) {
    // Time-weighted balance from every $MESA transfer, block times interpolated from trades.
    const marks = all<{ block: number; ts: number }>('SELECT block, MIN(timestamp) ts FROM trades GROUP BY block / 500 ORDER BY block')
    const timeOf = (block: number) => {
      let lo = 0
      let hi = marks.length - 1
      if (hi < 0) return now
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (marks[mid]!.block <= block) lo = mid
        else hi = mid - 1
      }
      const a = marks[lo]!
      const b = marks[lo + 1]
      if (!b || b.block === a.block) return a.ts
      return a.ts + ((block - a.block) / (b.block - a.block)) * (b.ts - a.ts)
    }
    const bal = new Map<string, { b: number; since: number; acc: number }>()
    const move = (w: string, d: number, t: number) => {
      const s = bal.get(w) ?? { b: 0, since: t, acc: 0 }
      s.acc += s.b * (t - s.since)
      s.b += d
      s.since = t
      bal.set(w, s)
    }
    for (const r of db.prepare('SELECT lower(src) src, lower(dst) dst, amount, block FROM transfers WHERE lower(token) = ? ORDER BY block, log_index').all(mesaToken) as unknown as { src: string; dst: string; amount: number; block: number }[]) {
      const t = timeOf(r.block)
      move(r.src, -r.amount, t)
      move(r.dst, r.amount, t)
    }
    for (const [w, s] of bal) {
      if (skip(w)) continue
      const acc = s.acc + Math.max(0, s.b) * (now - s.since)
      add(w, 'holders', 'Holding $MESA', acc / 10_000 / DAY, 'time-weighted')
    }
    const buybackTx = new Set(all<{ tx: string }>("SELECT tx FROM trades WHERE lower(token) = ? AND kind = 'buyback'", mesaToken).map((r) => r.tx))
    const burns = new Map<string, number>()
    for (const r of all<{ tx: string; src: string; amount: number }>('SELECT tx, lower(src) src, amount FROM transfers WHERE lower(token) = ? AND lower(dst) = ? AND amount >= 1', mesaToken, DEAD))
      if (!buybackTx.has(r.tx)) burns.set(r.src, (burns.get(r.src) ?? 0) + r.amount)
    for (const [w, amt] of burns) if (!skip(w)) add(w, 'holders', 'Burned $MESA by hand', (5 * amt) / 1_000, `${Math.round(amt).toLocaleString('en-US')} MESA`)
  }

  const totals = { builders: 0, mesaTraders: 0, holders: 0, elysium: 0, og: 0 } as Record<PoolName, number>
  for (const s of scores.values()) for (const [k, v] of Object.entries(s.pools)) totals[k as PoolName] += v!.points
  return { at: now, totals, wallets: scores.size, live: [...live], scores }
}

/** One wallet's estimated share, capped at WALLET_CAP. */
export function estimate(r: { totals: Record<PoolName, number> }, s: WalletScore | undefined) {
  const pools = Object.fromEntries(
    (Object.keys(POOLS) as PoolName[]).map((k) => {
      const p = s?.pools[k]
      const mesa = p && r.totals[k] > 0 ? (POOLS[k] * p.points) / r.totals[k] : 0
      return [k, { points: Math.round(p?.points ?? 0), mesa, items: p?.items ?? [] }]
    }),
  ) as Record<PoolName, { points: number; mesa: number; items: Item[] }>
  const raw = Object.values(pools).reduce((a, p) => a + p.mesa, 0)
  return { pools, mesa: Math.min(WALLET_CAP, raw), capped: raw > WALLET_CAP }
}
