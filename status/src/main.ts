/**
 * status.mesa.cx: checks Mesa's services every 15 seconds, keeps the history
 * for uptime, and serves a public page (/) and JSON (/api/status).
 *
 * Nothing secret is published: no RPC URLs, keys or secret paths.
 *
 * Env:
 *   NODE_RPC       our Elysium node                 (default http://elysium:8547)
 *   RELAY_URL      the relay                        (default http://relay:8545)
 *   INDEXER_URL    the terminal API                 (default http://indexer:8080)
 *   PARENT_RPC     HyperEVM, for the confirmed chain head
 *   LIVE_RPC       an independent Elysium RPC, for the live chain head (optional)
 *   STATE          SQLite file for history          (default /state/status.db)
 *   HOST_PROC      host /proc mounted read-only      (default /host/proc)
 *   DISK_PATH      a path on the host disk           (default /data)
 *   PORT           (default 8090)
 */
import { statfsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'

import { page } from './page.js'

const env = process.env
const NODE_RPC = env.NODE_RPC ?? 'http://elysium:8547'
const RELAY_URL = env.RELAY_URL ?? 'http://relay:8545'
const INDEXER_URL = env.INDEXER_URL ?? 'http://indexer:8080'
const PARENT_RPC = env.PARENT_RPC ?? 'https://rpc.hyperliquid.xyz/evm'
const LIVE_RPC = env.LIVE_RPC
const HOST_PROC = env.HOST_PROC ?? '/host/proc'
const DISK_PATH = env.DISK_PATH ?? '/data'
/** Elysium mainnet's Bridge on HyperEVM: its reported message count is the confirmed head. */
const BRIDGE = '0x503D572157113fAaaD4DbeD2647Bb10b949216B6'
const INTERVAL = 15_000

type State = 'up' | 'degraded' | 'down'
interface Check {
  state: State
  note: string
  [k: string]: unknown
}

const db = new DatabaseSync(env.STATE ?? '/state/status.db')
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS checks (ts INTEGER NOT NULL, service TEXT NOT NULL, state TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS checks_service_ts ON checks(service, ts);
`)

async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8_000),
  })
  const body = (await res.json()) as { result?: unknown; error?: { message: string } }
  if (body.error) throw new Error(body.error.message)
  return body.result
}
async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as Record<string, unknown>
}
const hex = (v: unknown) => parseInt(String(v), 16)
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 120)

/** The chain's heads, from sources that are not our node. */
async function references() {
  const confirmed = await rpc(PARENT_RPC, 'eth_call', [
    { to: BRIDGE, data: '0x5fca4a16' }, // sequencerReportedSubMessageCount()
    'latest',
  ])
    .then((r) => hex(r) - 1)
    .catch(() => null)
  const live = LIVE_RPC ? await rpc(LIVE_RPC, 'eth_blockNumber').then(hex).catch(() => null) : null
  return { confirmed, live }
}

async function checkNode(ref: { confirmed: number | null; live: number | null }): Promise<Check> {
  try {
    const block = (await rpc(NODE_RPC, 'eth_getBlockByNumber', ['latest', false])) as { number: string; timestamp: string }
    const head = hex(block.number)
    const behindConfirmed = ref.confirmed === null ? null : Math.max(0, ref.confirmed - head)
    const behindLive = ref.live === null ? null : Math.max(0, ref.live - head)
    const synced = behindConfirmed !== null && behindConfirmed <= 5
    const progress = ref.confirmed ? Math.min(100, (head / ref.confirmed) * 100) : null
    return {
      state: synced ? 'up' : 'degraded',
      note: synced ? (behindLive && behindLive > 50 ? 'Caught up to the last batch' : 'Caught up') : `Syncing: ${progress?.toFixed(1)}%`,
      head,
      headTime: hex(block.timestamp),
      confirmedHead: ref.confirmed,
      liveHead: ref.live,
      behindConfirmed,
      behindLive,
      progress,
    }
  } catch (e) {
    return { state: 'down', note: `Not responding (${msg(e)})` }
  }
}

async function checkRelay(): Promise<Check> {
  try {
    const h = await getJson(`${RELAY_URL}/health`)
    const balance = parseFloat(String(h.relayerBalance ?? '0'))
    const low = balance < 0.02
    return {
      state: low ? 'degraded' : 'up',
      note: low ? 'Relayer balance low: relaying may stop' : 'Relaying',
      mode: h.mode,
      relayer: h.relayer,
      relayerBalance: balance,
      relayedTotal: h.relayedTotal,
      rejected: h.rejected,
      spentLastHour: h.spentLastHour,
      budgetPerHour: h.budgetPerHour,
      pending: h.pending,
      lastRelayAt: h.lastRelayAt,
      startedAt: h.startedAt,
    }
  } catch (e) {
    return { state: 'down', note: `Not responding (${msg(e)})` }
  }
}

async function checkIndexer(): Promise<Check> {
  try {
    const s = await getJson(`${INDEXER_URL}/stats`)
    const lag = Math.max(0, Number(s.head) - Number(s.indexedTo))
    return {
      state: lag <= 200 ? 'up' : 'degraded',
      note: lag <= 200 ? 'Up to date' : `Catching up: ${lag} blocks behind`,
      network: env.INDEXER_NETWORK ?? 'testnet',
      lag,
      tokensLaunched: s.tokensLaunched ?? s.tokens,
      trades24h: s.trades24h,
    }
  } catch (e) {
    return { state: 'down', note: `Not responding (${msg(e)})` }
  }
}

function host() {
  try {
    const [l1, l5, l15] = readFileSync(`${HOST_PROC}/loadavg`, 'utf8').split(' ').map(Number)
    const mem = Object.fromEntries(
      readFileSync(`${HOST_PROC}/meminfo`, 'utf8')
        .split('\n')
        .map((l) => l.split(/:\s+/))
        .filter((p) => p.length === 2)
        .map(([k, v]) => [k, parseInt(v) * 1024]),
    ) as Record<string, number>
    const uptime = parseFloat(readFileSync(`${HOST_PROC}/uptime`, 'utf8').split(' ')[0])
    const cpus = readFileSync(`${HOST_PROC}/cpuinfo`, 'utf8').split('\n').filter((l) => l.startsWith('processor')).length
    const fs = statfsSync(DISK_PATH)
    return {
      load: [l1, l5, l15],
      cpus,
      memory: { total: mem.MemTotal, used: mem.MemTotal - mem.MemAvailable },
      disk: { total: fs.blocks * fs.bsize, used: (fs.blocks - fs.bavail) * fs.bsize },
      uptimeSeconds: Math.floor(uptime),
    }
  } catch {
    return null
  }
}

const SERVICES = ['node', 'relay', 'indexer'] as const
let latest: Record<string, unknown> = { checkedAt: null }

/** Share of checks that were up or degraded (answering), over `days`. */
function uptime(service: string, days: number): number | null {
  const r = db
    .prepare(`SELECT COUNT(*) n, SUM(state != 'down') ok FROM checks WHERE service = ? AND ts > ?`)
    .get(service, Date.now() - days * 86_400_000) as { n: number; ok: number }
  return r.n ? (r.ok / r.n) * 100 : null
}
/** One entry per day for the last 30: share answering, or null with no data. */
function daily(service: string): (number | null)[] {
  const start = Math.floor(Date.now() / 86_400_000) - 29
  const rows = db
    .prepare(
      `SELECT ts / 86400000 day, COUNT(*) n, SUM(state != 'down') ok FROM checks WHERE service = ? AND ts >= ? GROUP BY day`,
    )
    .all(service, start * 86_400_000) as { day: number; n: number; ok: number }[]
  const byDay = new Map(rows.map((r) => [r.day, (r.ok / r.n) * 100]))
  return Array.from({ length: 30 }, (_, i) => byDay.get(start + i) ?? null)
}

async function tick() {
  const ref = await references()
  const [node, relay, indexer] = await Promise.all([checkNode(ref), checkRelay(), checkIndexer()])
  const now = Date.now()
  const insert = db.prepare('INSERT INTO checks (ts, service, state) VALUES (?, ?, ?)')
  const checks: Record<string, Check> = { node, relay, indexer }
  for (const s of SERVICES) insert.run(now, s, checks[s].state)
  db.prepare('DELETE FROM checks WHERE ts < ?').run(now - 31 * 86_400_000)
  const states = SERVICES.map((s) => checks[s].state)
  latest = {
    checkedAt: new Date(now).toISOString(),
    overall: states.includes('down') ? 'down' : states.includes('degraded') ? 'degraded' : 'up',
    services: Object.fromEntries(
      SERVICES.map((s) => [
        s,
        { ...checks[s], uptime: { day: uptime(s, 1), week: uptime(s, 7), month: uptime(s, 30) }, daily: daily(s) },
      ]),
    ),
    host: host(),
  }
}

async function loop() {
  for (;;) {
    try {
      await tick()
    } catch (e) {
      console.error(JSON.stringify({ statusError: msg(e) }))
    }
    await new Promise((r) => setTimeout(r, INTERVAL))
  }
}

createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*')
  if (req.url?.startsWith('/api/status')) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    return res.end(JSON.stringify(latest))
  }
  if (req.url === '/' || req.url?.startsWith('/?')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(page)
  }
  res.writeHead(404).end()
}).listen(Number(env.PORT ?? 8090))

void loop()
