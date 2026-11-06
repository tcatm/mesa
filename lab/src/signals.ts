import { Mesa, API, MESA_HOOK, launchCall, launchedToken, validate, type LaunchForm } from 'mesa-agent'
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { config } from './config.js'
import { crtScreen, DESIGNS } from './crt.js'
import { crt, logo as lineArt, puzzle } from './workers.js'
import { save, state, walletKey } from './store.js'

/**
 * The domination bot: its mission is to spread Mesa across Elysium. Every
 * token is named for mesa.cx,
 * with only cryptic looks: CRT screens (crt.ts: 33 designs, from ASCII fractals to
 * coverage maps), cipher and riddle screens, terminal readouts or technical line art. Its
 * description carries Mesa's real share of Elysium's launches. No model
 * calls, only gas. Its own wallet; LAB_SIGNALS_MAX_PER_DAY a day (every 15s
 * by default), spread evenly.
 */
const mesa = new Mesa({ privateKey: walletKey('signal'), maxHypePerTx: 0.01 })
export const signalAddress = mesa.address!
const now = () => Math.floor(Date.now() / 1000)
export let signalPhase: 'off' | 'needs-funds' | 'waiting' | 'working' | 'full' | 'turbo' = 'off'

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

const CRYPTIC = ['unit', 'swarm', 'outpost', 'colony', 'vanguard', 'emissary', 'node', 'beacon', 'uplink', 'relay', 'crawler', 'drone', 'sentinel', 'legion', 'expansion', 'signal', 'transmission', 'dominion', 'protocol', 'monolith', 'cipher', 'lattice', 'phosphor', 'oracle']

function naming(caption: string) {
  const prefix = 'mesa.cx'
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

/** Everything for one launch except sending it: the look, the name, the image. */
async function prepare() {
  const block = await fetch(`${API}/stats`, { signal: AbortSignal.timeout(15_000) })
    .then((r) => r.json() as Promise<{ head: number }>)
    .then((s) => s.head)
    .catch(() => 0)
  // Mesa's real share of Elysium's launches, for the report.
  const venues = await fetch(`${API}/venues`, { signal: AbortSignal.timeout(15_000) })
    .then((r) => r.json() as Promise<{ venue: string; tokens: number }[]>)
    .catch(() => [] as { venue: string; tokens: number }[])
  const total = venues.reduce((a, v) => a + v.tokens, 0)
  const ours = venues.find((v) => v.venue === 'Mesa')?.tokens ?? 0
  // Only the cryptic looks: CRT screens, cipher and riddle screens, terminal readouts and technical line art.
  const roll = Math.random()
  const kind = roll < 0.6 ? 'crt' : roll < 0.78 ? 'puzzle' : roll < 0.9 ? 'readout' : 'lineart'
  const design = Math.floor(Math.random() * DESIGNS.length)
  const caption = kind === 'crt' ? crtScreen({ serial: '0000000', block, design }).caption : pick(['signal', 'cipher', 'transmission', 'dominion'])
  let n = naming(caption)
  try {
    await mesa.resolve(n.ticker)
    n = naming(caption) // taken: another roll
  } catch {
    // free
  }
  const png =
    kind === 'crt'
      ? crtScreen({ serial: n.serial, block, design, header: n.header, footer: `BLK ${block.toLocaleString('en-US')}` }).png
      : kind === 'puzzle'
        ? puzzle(n.name, n.serial, block)
        : kind === 'readout'
          ? crt(n.name, n.serial, ['> SPREAD ACROSS ELYSIUM', `COVERAGE ${ours.toLocaleString('en-US')} / ${total.toLocaleString('en-US')}`, '> EXPANDING'])
          : lineArt(n.serial)
  const image = await upload(png)
  const s: Signal = { name: n.name, symbol: n.ticker, caption, image, token: null, tx: null, at: now() }
  const description = `Mesa domination unit ${n.serial}. Mission: spread Mesa across Elysium. Coverage at block ${block.toLocaleString('en-US')}: ${ours.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} Elysium launches are Mesa's. mesa.cx`.slice(0, 300)
  return { s, description }
}

async function makeSignal() {
  const { s, description } = await prepare()
  if (config.dryRun) {
    signals().unshift(s)
    save()
    return log(`Dry run: would launch ${s.name} ($${s.symbol})`)
  }
  const res = await mesa.launch({
    name: s.name,
    symbol: s.symbol,
    description,
    image: s.image ?? undefined,
    website: 'https://mesa.cx/lab',
    feePct: config.newsFeePct,
    sniperPct: 10,
    snipeSeconds: 60,
  })
  s.token = res.token
  s.tx = res.hash
  signals().unshift(s)
  state.signals = signals().slice(0, 5000)
  save()
  log(res.status === 'success' && res.token ? `Launched ${s.name} ($${s.symbol}): ${s.caption}` : `Launch of ${s.name} ${res.status}`)
}

// ---------------------------------------------------------------- turbo: one a second, pipelined

const chain = defineChain({ id: 99901, name: 'Elysium', nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.mesa.cx'] } } })
const pub = createPublicClient({ chain, transport: http() })
let turbo = false

/** Launch once a second for `seconds`: images are made in parallel, sends go out in order with local nonces. */
async function runTurbo(seconds: number) {
  turbo = true
  signalPhase = 'turbo'
  const account = privateKeyToAccount(walletKey('signal'))
  const wallet = createWalletClient({ account, chain, transport: http() })
  let nonce = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' })
  let sendChain: Promise<unknown> = Promise.resolve()
  let sent = 0
  log(`Turbo: one launch a second for ${seconds} seconds`)
  const start = Date.now()
  const jobs: Promise<void>[] = []
  for (let i = 0; i < seconds; i++) {
    const wait = start + i * 1000 - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    jobs.push(
      (async () => {
        const { s, description } = await prepare()
        const form: LaunchForm = {
          name: s.name, symbol: s.symbol, description, image: s.image ?? '', website: 'https://mesa.cx/lab', twitter: '', telegram: '',
          feePct: config.newsFeePct, payout: 'wallet', feeRecipient: account.address, recipients: [], holdersPct: 0, buybackPct: 0,
          antiSnipe: true, sniperPct: 10, snipeSeconds: 60, maxBuyPct: 100, devBuy: '0',
        }
        if (validate(form).length) return
        const call = launchCall(form, MESA_HOOK!)
        // Sends in order, each with the next nonce; a failed send re-reads the nonce from the chain.
        sendChain = sendChain.then(async () => {
          try {
            const hash = await wallet.sendTransaction({ to: call.to, data: call.data as Hex, value: call.value, nonce: nonce++, gas: 1_400_000n, maxFeePerGas: 300_000_000n, maxPriorityFeePerGas: 0n })
            s.tx = hash
            signals().unshift(s)
            sent++
          } catch (e) {
            console.error(JSON.stringify({ turboSend: String(e).slice(0, 200) }))
            nonce = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' })
          }
        })
        await sendChain
      })().catch((e) => console.error(JSON.stringify({ turboJob: String(e).slice(0, 200) }))),
    )
  }
  await Promise.all(jobs)
  state.signals = signals().slice(0, 5000)
  save()
  log(`Turbo done: sent ${sent} launches in ${Math.round((Date.now() - start) / 1000)}s`)
  turbo = false
  signalPhase = 'waiting'
}

/** Fill in token addresses for launches sent without waiting for their receipts. */
async function resolveTokens() {
  const open = signals().filter((s) => s.tx && !s.token && Date.now() / 1000 - s.at < 3_600).slice(0, 40)
  for (const s of open) {
    const r = await pub.getTransactionReceipt({ hash: s.tx as Hex }).catch(() => null)
    if (!r) continue
    // launchedToken reads the hook's Launched event from the receipt.
    s.token = r.status === 'success' ? launchedToken(r as never, MESA_HOOK!) : null
    if (r.status !== 'success') s.tx = null
  }
  if (open.length) save()
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
    if (turbo) return
    if (!config.signalsEnabled) return void (signalPhase = 'off')
    const [id, secs] = config.signalsTurbo.split(':')
    if (id && Number(secs) > 0 && !(state.signalTurbos ?? []).includes(id)) {
      state.signalTurbos = [...(state.signalTurbos ?? []), id]
      save()
      void runTurbo(Math.min(900, Number(secs)))
      return
    }
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
  setInterval(() => void resolveTokens().catch(() => undefined), 10_000)
  void tick()
  setInterval(() => void tick(), 3_000)
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
