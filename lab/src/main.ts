import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Mesa, API } from 'mesa-agent'
import { config } from './config.js'
import { BudgetError } from './llm.js'
import { build, icon, idea, review, type Idea } from './make.js'
import { serve } from './server.js'
import { live } from './live.js'
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
function setPhase(p: Phase) {
  if (p === phase) return
  phase = p
  live('phase', p)
}
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

/**
 * Projects the team hands the agent (lab/seed.json, one or a list): each is
 * built next, right away, once. Everything after the idea (the build, review, launch) is still its own.
 */
function seed(): Idea | null {
  try {
    const raw = JSON.parse(readFileSync(new URL('../seed.json', import.meta.url), 'utf8')) as Partial<Idea> | Partial<Idea>[]
    // A list is a queue: the first one not built yet goes next.
    for (const s of Array.isArray(raw) ? raw : [raw]) {
      if (!s.slug || !s.name || !s.symbol || !s.tagline || !s.about) continue
      if (state.projects.some((p) => p.slug === s.slug || p.symbol === s.symbol)) continue
      return { thought: '', ...s } as Idea
    }
    return null
  } catch {
    return null
  }
}

async function makeProject() {
  setPhase('working')
  const seeded = seed()
  note(seeded ? `Starting on a project the Mesa team suggested: ${seeded.name}` : 'Thinking of the next project')
  const symbols = await takenSymbols()
  let i: Idea | null = seeded && (await symbolFree(seeded.symbol)) ? seeded : null
  for (let k = 0; k < 3 && !i; k++) {
    const cand = await idea({ names: state.projects.map((p) => p.name), symbols })
    if (state.projects.some((p) => p.slug === cand.slug) || !(await symbolFree(cand.symbol))) {
      symbols.push(cand.symbol)
      continue
    }
    i = cand
  }
  if (!i) throw new Error('every idea clashed with an existing name or ticker')
  if (i.thought) live('thought', i.thought)
  note(`Building ${i.name} ($${i.symbol}): ${i.tagline}`)
  const url = `${config.publicUrl}/${i.slug}/`
  let html: string | null = null
  for (let k = 0; k < 2 && !html; k++) {
    try {
      html = await build(i, url)
    } catch (e) {
      if (e instanceof BudgetError || k === 1) throw e
      note(`First build of ${i.name} didn't pass checks (${e instanceof Error ? e.message : String(e)}), building again`.slice(0, 280))
    }
  }
  live('step', 'Asking a second model to review it')
  const verdict = await review(i, html!)
  live('thought', `Review: ${verdict.reason}`)
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
  live('step', `Launching $${i.symbol} on Mesa from my wallet (2% fee, anti-snipe on, no dev buy)`)

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
  if (!config.enabled) return setPhase('off')
  if (existsSync(join(config.dataDir, 'STOP'))) return setPhase('paused')
  if (!config.openrouterKey && !config.mock) return setPhase('needs-key')
  await maybeClaim().catch((e) => console.error('claim', e))
  if (state.projects.length >= config.maxTotal) return setPhase('paused')
  if (spentToday() >= config.budgetUsdPerDay) return setPhase('budget')
  // A suggested project skips the wait after a failed build.
  nextAt = seed() ? due() : Math.max(due(), (state.lastError?.at ?? 0) + 3600)
  if (now() < nextAt) return setPhase('waiting')
  if (!config.dryRun && (await balance()) < config.minHype) return setPhase('needs-funds')
  try {
    await makeProject()
    state.lastError = null
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    state.lastError = { at: now(), message: message.slice(0, 300) }
    note(e instanceof BudgetError ? 'Out of model budget for today' : `Something went wrong, trying again in an hour: ${message.slice(0, 160)}`)
  } finally {
    save()
    setPhase('waiting')
    nextAt = Math.max(due(), (state.lastError?.at ?? 0) + 3600)
  }
}

serve({ address, balance: () => balance().catch(() => null) })
// A restart in the middle of a project leaves its last line saying "Building…".
if (/^(Thinking of|Building) /.test(state.log[0]?.text ?? '')) note('Stopped before finishing that one: nothing was published or launched')
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
