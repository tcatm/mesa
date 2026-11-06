import { Mesa, API } from 'mesa-agent'
import { config } from './config.js'
import { crtScreen, DESIGNS } from './crt.js'
import { save, state, walletKey } from './store.js'

/**
 * The CRT deployer: every token it launches is a CRT screen (crt.ts: 28
 * procedural designs, from ASCII fractals to oscilloscopes), named half the
 * time for mesa.cx and half for x.com/mesa_elysium. No model calls, only gas.
 * Its own wallet; at most LAB_SIGNALS_MAX_PER_DAY a day, spread evenly.
 */
const mesa = new Mesa({ privateKey: walletKey('signal'), maxHypePerTx: 0.01 })
export const signalAddress = mesa.address!
const now = () => Math.floor(Date.now() / 1000)
export let signalPhase: 'off' | 'needs-funds' | 'waiting' | 'working' | 'full' = 'off'

export interface Signal {
  name: string
  symbol: string
  caption: string
  image: string | null
  token: string | null
  tx: string | null
  at: number
}
const signals = () => (state.signals ??= [])
const pick = <T>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)]!

function log(text: string) {
  state.signalLog = [{ at: now(), text }, ...(state.signalLog ?? [])].slice(0, 100)
  save()
  console.log(JSON.stringify({ signals: text }))
}

const CRYPTIC = ['signal', 'transmission', 'relay', 'beacon', 'terminal', 'uplink', 'carrier', 'frequency', 'echo', 'channel', 'static', 'vector', 'node', 'archive', 'cipher', 'lattice', 'void', 'phosphor', 'monolith', 'oracle']

function naming(caption: string) {
  const prefix = Math.random() < 0.5 ? 'mesa.cx' : 'x.com/mesa_elysium'
  const serial = String(Math.floor(1_000_000 + Math.random() * 9_000_000))
  const short = serial.slice(-4)
  const hex = Math.floor(Math.random() * 0xfffff).toString(16).toUpperCase().padStart(5, '0')
  const word = caption.toLowerCase().replace(/[^a-z0-9 ]/g, '')
  const c = pick(CRYPTIC)
  const name = pick([`${prefix} ${word} ${short}`, `${prefix} ${c} ${serial}`, `${prefix} ${c} 0x${hex}`, `${prefix} ${word}`])
  const ticker = pick([
    `${word.replace(/ /g, '').slice(0, 5).toUpperCase()}${short}`,
    `${c.slice(0, 4).toUpperCase()}${short}`,
    `X${hex}`,
    `CRT${short}`,
  ]).slice(0, 10)
  return { name: name.slice(0, 64), ticker, serial, header: prefix.toUpperCase() }
}

async function upload(png: Buffer): Promise<string | null> {
  try {
    const r = await fetch(config.uploadUrl, { method: 'POST', headers: { 'content-type': 'image/png' }, body: new Uint8Array(png) })
    const b = (await r.json()) as { url?: string }
    return r.ok && b.url ? b.url : null
  } catch {
    return null
  }
}

async function makeSignal() {
  const block = await fetch(`${API}/stats`, { signal: AbortSignal.timeout(15_000) })
    .then((r) => r.json() as Promise<{ head: number }>)
    .then((s) => s.head)
    .catch(() => 0)
  const design = Math.floor(Math.random() * DESIGNS.length)
  // Render first: the design's caption feeds the name.
  const probe = crtScreen({ serial: '0000000', block, design })
  let n = naming(probe.caption)
  try {
    await mesa.resolve(n.ticker)
    n = naming(probe.caption) // taken: another roll
  } catch {
    // free
  }
  const screen = crtScreen({ serial: n.serial, block, design, header: n.header, footer: `BLK ${block.toLocaleString('en-US')}` })
  const image = await upload(screen.png)
  const s: Signal = { name: n.name, symbol: n.ticker, caption: screen.caption, image, token: null, tx: null, at: now() }
  if (config.dryRun) {
    signals().unshift(s)
    save()
    return log(`Dry run: would launch ${s.name} ($${s.symbol})`)
  }
  const res = await mesa.launch({
    name: s.name,
    symbol: s.symbol,
    description: `Transmission ${n.serial}: ${screen.caption}, received on Elysium at block ${block.toLocaleString('en-US')}. A Mesa Lab CRT token. mesa.cx · x.com/mesa_elysium`.slice(0, 300),
    image: image ?? undefined,
    website: 'https://mesa.cx/lab',
    feePct: config.newsFeePct,
    sniperPct: 10,
    snipeSeconds: 60,
  })
  s.token = res.token
  s.tx = res.hash
  signals().unshift(s)
  state.signals = signals().slice(0, 2000)
  save()
  log(res.status === 'success' && res.token ? `Launched ${s.name} ($${s.symbol}): ${s.caption}` : `Launch of ${s.name} ${res.status}`)
}

async function maybeClaim() {
  if (config.dryRun || now() - (state.signalLastClaimAt ?? 0) < 86_400) return
  const { claimableHype } = await mesa.claimable()
  if (Number(claimableHype) < config.claimAt) return
  const r = await mesa.claim()
  state.signalLastClaimAt = now()
  if (r.status === 'success') {
    state.signalClaimedHype = (state.signalClaimedHype ?? 0) + Number(r.claimedHype)
    log(`Claimed ${Number(r.claimedHype).toFixed(4)} HYPE in trading fees`)
  }
  save()
}

let running = false
async function tick() {
  if (running) return
  running = true
  try {
    if (!config.signalsEnabled) return void (signalPhase = 'off')
    await maybeClaim().catch((e) => console.error('signal claim', e))
    const today = signals().filter((c) => c.at > now() - 86_400 && c.token).length
    if (today >= config.signalsMaxPerDay) return void (signalPhase = 'full')
    const gap = Math.floor(86_400 / config.signalsMaxPerDay)
    if (now() - (signals()[0]?.at ?? 0) < gap) return void (signalPhase = 'waiting')
    if (!config.dryRun && Number((await mesa.balance()).HYPE) < config.minHype) return void (signalPhase = 'needs-funds')
    signalPhase = 'working'
    await makeSignal()
    signalPhase = 'waiting'
  } catch (e) {
    log(`Something went wrong: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`)
    signalPhase = 'waiting'
  } finally {
    running = false
  }
}

export function startSignals() {
  void tick()
  setInterval(() => void tick(), 10_000)
}

export async function signalStatus() {
  const balance = await mesa
    .balance()
    .then((b) => Number(b.HYPE))
    .catch(() => null)
  return {
    address: signalAddress,
    balanceHype: balance,
    phase: signalPhase,
    enabled: config.signalsEnabled,
    maxPerDay: config.signalsMaxPerDay,
    launchedToday: signals().filter((c) => c.at > now() - 86_400 && c.token).length,
    launched: signals().filter((c) => c.token).length,
    claimedHype: state.signalClaimedHype ?? 0,
    signals: signals().slice(0, 200),
    log: (state.signalLog ?? []).slice(0, 30),
  }
}
