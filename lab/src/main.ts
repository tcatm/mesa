import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Mesa, API } from 'mesa-agent'
import { config } from './config.js'
import { BudgetError } from './llm.js'
import { build, icon, idea, review, type Idea } from './make.js'
import { serve } from './server.js'
import { note, save, spentToday, state, walletKey, writeApp, type Project } from './store.js'

/**
 * Mesa Lab: an agent that, on its own, thinks up a small web tool, builds it,
 * publishes it at api.mesa.cx/lab/<slug>/, launches a token for it on Mesa
 * (fees to its own wallet), and writes the token's project page and first
 * build-log post. It claims its fees as they come in.
 *
 * Limits: at most LAB_MAX_PER_DAY projects a day, LAB_GAP_HOURS apart, a daily
 * model budget, no dev buys, and nothing at all unless LAB_ENABLED=1. Creating
 * a file named STOP in the data directory pauses it.
 */
const mesa = new Mesa({ privateKey: walletKey(), maxHypePerTx: 0.01 })
export const address = mesa.address!
const now = () => Math.floor(Date.now() / 1000)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export type Phase = 'off' | 'paused' | 'needs-key' | 'needs-funds' | 'waiting' | 'working' | 'budget'
export let phase: Phase = 'waiting'
export let nextAt = 0

async function balance(): Promise<number> {
  return Number((await mesa.balance()).HYPE)
}

async function takenSymbols(): Promise<string[]> {
  const out = new Set<string>()
  for (const sort of ['mcap', 'new', 'volume'] as const) {
    const r = await mesa.tokens({ sort, limit: 200 }).catch(() => ({ tokens: [] as Record<string, unknown>[] }))
    for (const t of r.tokens) out.add(String(t['symbol'] ?? '').toUpperCase())
  }
  for (const p of state.projects) out.add(p.symbol)
  return [...out].filter(Boolean)
}

async function symbolFree(sym: string): Promise<boolean> {
  try {
    await mesa.resolve(sym)
    return false
  } catch {
    return true
  }
}

async function uploadImage(png: Buffer): Promise<string | null> {
  try {
    const r = await fetch(config.uploadUrl, { method: 'POST', headers: { 'content-type': 'image/png' }, body: new Uint8Array(png) })
    const b = (await r.json()) as { url?: string }
    return r.ok && b.url ? b.url : null
  } catch {
    return null
  }
}

/** The project page, signed exactly as the indexer checks it (indexer/src/projects.ts). */
async function postProfile(token: string, p: Project) {
  const profile = {
    tagline: p.tagline,
    about: `${p.about}\n\nBuilt, published and launched on its own by the Mesa Lab agent, an AI that ships small web tools and funds itself from their trading fees.`.slice(0, 1200),
    website: p.url,
    x: '',
    telegram: '',
    repo: '',
    links: [{ label: 'Mesa Lab', url: 'https://mesa.cx/lab' }],
    team: [{ name: 'Mesa Lab agent', role: 'Builds and launches on its own', x: '' }],
    roadmap: [
      { title: `${p.name} v1 is live`, status: 'done', when: new Date().toISOString().slice(5, 10) },
      { title: 'Improvements from what people use', status: 'next', when: '' },
    ],
  }
  const time = now()
  const message = `Mesa project profile\nToken: ${token.toLowerCase()}\nTime: ${time}\n\n${JSON.stringify(profile)}`
  const signature = await mesa.account!.signMessage({ message })
  const r = await fetch(`${API}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: token.toLowerCase(), time, profile, signature }),
  })
  if (!r.ok) throw new Error(`project page: ${((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.status}`)
}

/** Retries while the indexer catches up with a launch it hasn't seen yet. */
async function whenIndexed<T>(f: () => Promise<T>): Promise<T> {
  let last: unknown
  for (let i = 0; i < 20; i++) {
    try {
      return await f()
    } catch (e) {
      last = e
      if (!/not a launch Mesa knows|404|No token/i.test(String(e))) throw e
      await sleep(30_000)
    }
  }
  throw last
}

async function makeProject() {
  phase = 'working'
  note('Thinking of the next project')
  const symbols = await takenSymbols()
  let i: Idea | null = null
  for (let k = 0; k < 3 && !i; k++) {
    const cand = await idea({ names: state.projects.map((p) => p.name), symbols })
    if (state.projects.some((p) => p.slug === cand.slug) || !(await symbolFree(cand.symbol))) {
      symbols.push(cand.symbol)
      continue
    }
    i = cand
  }
  if (!i) throw new Error('every idea clashed with an existing name or ticker')
  note(`Building ${i.name} ($${i.symbol}): ${i.tagline}`)
  const url = `${config.publicUrl}/${i.slug}/`
  let html: string | null = null
  for (let k = 0; k < 2 && !html; k++) {
    try {
      html = await build(i, url)
    } catch (e) {
      if (e instanceof BudgetError || k === 1) throw e
      note(`First build of ${i.name} didn't pass checks, building again`)
    }
  }
  const verdict = await review(i, html!)
  if (!verdict.ok) {
    note(`Dropped ${i.name} at review: ${verdict.reason}`)
    return
  }
  const png = await icon(i).catch(() => null)
  const image = png ? await uploadImage(png) : null
  writeApp(i.slug, html!)
  const p: Project = { ...i, url, image, token: null, tx: null, createdAt: now(), launchedAt: null }
  state.projects.unshift(p)
  save()
  note(`Published ${i.name} at ${url}`)
  if (config.dryRun) return note(`Dry run: not launching $${i.symbol}`)

  const res = await mesa.launch({
    name: i.name,
    symbol: i.symbol,
    description: i.tagline,
    image: image ?? undefined,
    website: url,
    feePct: config.feePct,
    sniperPct: config.sniperPct,
    snipeSeconds: config.snipeSeconds,
  })
  p.tx = res.hash
  if (res.status !== 'success' || !res.token) {
    save()
    throw new Error(`launch of $${i.symbol} ${res.status} (${res.hash})`)
  }
  p.token = res.token
  p.launchedAt = now()
  save()
  note(`Launched $${i.symbol} for ${i.name}`)
  await whenIndexed(() => postProfile(res.token!, p)).catch((e) => note(`Couldn't post the project page for $${i!.symbol}: ${String(e).slice(0, 120)}`))
  await whenIndexed(() => mesa.postUpdate(res.token!, `Shipped ${i!.name} v1: ${i!.tagline}`.slice(0, 280), url)).catch((e) =>
    note(`Couldn't post to the build log for $${i!.symbol}: ${String(e).slice(0, 120)}`),
  )
}

async function maybeClaim() {
  if (config.dryRun || now() - state.lastClaimAt < 86_400) return
  const { claimableHype } = await mesa.claimable()
  if (Number(claimableHype) < config.claimAt) return
  const r = await mesa.claim()
  state.lastClaimAt = now()
  if (r.status === 'success') {
    state.claimedHype += Number(r.claimedHype)
    note(`Claimed ${Number(r.claimedHype).toFixed(4)} HYPE in trading fees`)
    const newest = state.projects.find((p) => p.token)
    if (newest?.token)
      await mesa
        .postUpdate(newest.token, `Claimed ${Number(r.claimedHype).toFixed(4)} HYPE in fees from my projects. It goes toward the next build.`, 'https://mesa.cx/lab')
        .catch(() => undefined)
  }
  save()
}

function due(): number {
  const dayAgo = now() - 86_400
  const recent = state.projects.filter((p) => p.createdAt > dayAgo)
  const last = state.projects[0]?.createdAt ?? 0
  const gap = last + config.gapHours * 3600
  if (recent.length >= config.maxPerDay) return Math.max(gap, (recent[recent.length - 1]?.createdAt ?? 0) + 86_400)
  return gap
}

async function tick() {
  if (!config.enabled) return void (phase = 'off')
  if (existsSync(join(config.dataDir, 'STOP'))) return void (phase = 'paused')
  if (!config.openrouterKey && !config.mock) return void (phase = 'needs-key')
  await maybeClaim().catch((e) => console.error('claim', e))
  if (state.projects.length >= config.maxTotal) return void (phase = 'paused')
  if (spentToday() >= config.budgetUsdPerDay) return void (phase = 'budget')
  nextAt = Math.max(due(), (state.lastError?.at ?? 0) + 3600)
  if (now() < nextAt) return void (phase = 'waiting')
  if (!config.dryRun && (await balance()) < config.minHype) return void (phase = 'needs-funds')
  try {
    await makeProject()
    state.lastError = null
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    state.lastError = { at: now(), message: message.slice(0, 300) }
    note(e instanceof BudgetError ? 'Out of model budget for today' : `Something went wrong, trying again in an hour: ${message.slice(0, 160)}`)
  } finally {
    save()
    phase = 'waiting'
    nextAt = Math.max(due(), (state.lastError?.at ?? 0) + 3600)
  }
}

serve({ address, balance: () => balance().catch(() => null) })
console.log(JSON.stringify({ lab: 'started', address, enabled: config.enabled, dryRun: config.dryRun }))
let running = false
const loop = async () => {
  if (running) return
  running = true
  await tick().catch((e) => console.error('tick', e))
  running = false
}
void loop()
setInterval(() => void loop(), 5 * 60_000)
