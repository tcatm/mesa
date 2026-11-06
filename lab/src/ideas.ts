import { API } from 'mesa-agent'
import { config } from './config.js'
import { chat, parseJson } from './llm.js'
import { ACCENTS, botLogo } from './botlogo.js'
import { newsMesa as mesa } from './news.js'
import { save, spentToday, state, type IdeaCoin } from './store.js'

/**
 * The idea agent: thinks up a project someone could build on Elysium (a cool
 * name, the problem, what to build, three milestones), draws its coin logo
 * (the Mesa Lab bot with a prop for the idea) and launches the coin as an
 * open idea. It doesn't build it: anyone can fork the idea from its page,
 * launch their own coin for it and ship it.
 *
 * Logos are free: a painted scene with the bot drawn on top in code (botlogo.ts).
 * Shares the news agent's wallet and model budget. At most
 * LAB_IDEAS_MAX_PER_DAY a day, spread evenly.
 */
const now = () => Math.floor(Date.now() / 1000)
export let ideasPhase: 'off' | 'needs-key' | 'needs-funds' | 'budget' | 'waiting' | 'working' | 'full' = 'off'
const ideas = () => (state.ideas ??= [])
export const forkUrl = (token: string) => `https://mesa.cx/launch?fork=${token.toLowerCase()}`

function log(text: string) {
  state.ideasLog = [{ at: now(), text }, ...(state.ideasLog ?? [])].slice(0, 100)
  save()
  console.log(JSON.stringify({ ideas: text }))
}

const CATEGORIES = [
  'developer tooling',
  'agent infrastructure',
  'data and indexing',
  'wallet and account UX',
  'payments and commerce',
  'DeFi primitives',
  'security and monitoring',
  'bridging and cross-chain',
  'onchain identity and reputation',
  'creator and community tools',
  'gaming infrastructure',
  'DAO and treasury tooling',
]
/** Painting styles for the scene behind the bot, so the list doesn't all look alike. */
const STYLES = ['bold flat vector', 'glossy 3D render', 'retro pixel art', 'playful cartoon', 'risograph print', 'neon line art', 'soft watercolour', 'low-poly', 'paper cut-out', 'isometric illustration', 'blueprint drawing', 'claymation style']
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)]!

async function symbolFree(sym: string) {
  if (ideas().some((c) => c.symbol === sym) || state.projects.some((p) => p.symbol === sym)) return false
  try {
    await mesa.resolve(sym)
    return false
  } catch {
    return true
  }
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
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

/** The coin's project page: the idea, its milestones as the roadmap, and the fork link. */
async function postProfile(token: string, c: IdeaCoin) {
  const profile = {
    tagline: c.tagline.slice(0, 120),
    about: `The problem: ${c.problem}\n\nWhat to build: ${c.build}\n\nThis is an open idea from the Mesa Lab idea agent. Nobody is building it yet: fork it, launch your own coin for it and ship it. The best fork wins.`.slice(0, 1200),
    website: forkUrl(token),
    x: '',
    telegram: '',
    repo: '',
    links: [
      { label: 'Fork this idea', url: forkUrl(token) },
      { label: 'Mesa Lab', url: 'https://mesa.cx/lab' },
    ],
    team: [{ name: 'Mesa Lab idea agent', role: 'Thought it up', x: '' }],
    roadmap: c.milestones.map((m) => ({ title: m.slice(0, 80), status: 'next', when: '' })),
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

/** The scene behind the bot, from a free image service; null if it keeps failing (the bot then gets a plain backdrop). */
async function scene(subject: string, palette: string): Promise<{ img: Buffer; mime: string } | null> {
  const prompt = `${pick(STYLES)} illustration of ${subject}, colour palette: ${palette}, the object large in the upper half of the frame with a simple background, no people, no faces, no robots, no characters, no text, no letters, no border`
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(
        `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=512&nologo=true&seed=${Math.floor(Math.random() * 1e6)}`,
        { signal: AbortSignal.timeout(60_000) },
      )
      if (!r.ok) throw new Error(String(r.status))
      const img = Buffer.from(await r.arrayBuffer())
      if (img.length < 2_000) throw new Error('empty image')
      return { img, mime: r.headers.get('content-type') ?? 'image/jpeg' }
    } catch {
      await sleep(3_000)
    }
  }
  return null
}

async function logo(subject: string, palette: string): Promise<string | null> {
  const art = await scene(subject, palette)
  const png = botLogo({ art: art?.img ?? null, mime: art?.mime, crop: !!art, accent: pick(ACCENTS), look: pick([-1, 0, 0, 1]) })
  const url = await upload(png)
  if (!url) log('The logo upload failed; launching without one')
  return url
}

interface Answer {
  name?: string
  symbol?: string
  tagline?: string
  problem?: string
  build?: string
  milestones?: string[]
  prop?: string
  palette?: string
}

/** Ideas written ahead, several per model call (much cheaper than one call each). */
const queue: (Answer & { category: string })[] = []
const BATCH = 8

async function refill() {
  const category = pick(CATEGORIES)
  const recent = [...queue.map((q) => `${q.name} ($${q.symbol})`), ...ideas().slice(0, 80).map((c) => `${c.name} ($${c.symbol})`)].join(', ')
  const raw = parseJson<{ ideas?: Answer[] } | Answer[]>(
    await chat({
      bucket: 'news',
      model: config.newsModel,
      maxTokens: 4_000,
      json: true,
      system: `You are the Mesa Lab idea agent. Mesa is the launchpad for builders on Elysium, an EVM L2 (gas token HYPE). You come up with original, genuinely useful projects a solo builder or small team could build and ship on Elysium, give each a great name, and write each up as an open idea anyone can fork.
Make them concrete and buildable: a real problem, a clear v1, and three milestones that each ship something. Names are short, memorable and original (one or two words, a coined word is good). Never use or imitate a real brand, product, company, crypto project or person.
No trading signals, price predictions, guaranteed yields, gambling, airdrop farming or anything promising returns. No politics, adult content or anything that handles other people's private keys.`,
      user: `Category: ${category}
Ideas already launched (don't repeat or closely resemble): ${recent || 'none'}

Write ${BATCH} different ideas in this category. Answer with JSON only:
{"ideas": [{"name": "1-2 words, under 20 characters", "symbol": "3-6 capital letters", "tagline": "one line under 90 characters: what it does", "problem": "1-2 sentences, under 260 characters", "build": "2-3 sentences, under 380 characters: what v1 is and how it works on Elysium", "milestones": ["3 short milestones, each under 60 characters"], "prop": "one vivid physical object that stands for the idea, for its logo, under 12 words", "palette": "3 colours that suit it"}]}`,
    }),
  )
  const list = Array.isArray(raw) ? raw : (raw.ideas ?? [])
  for (const x of list) queue.push({ ...x, category })
}

async function makeIdea() {
  if (!queue.length) await refill()
  const a = queue.shift()
  if (!a) return log('The model returned no ideas; trying again soon')
  const category = a.category
  const name = String(a.name ?? '').trim().slice(0, 24)
  const symbol = String(a.symbol ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6)
  const c: IdeaCoin = {
    name,
    symbol,
    tagline: String(a.tagline ?? '').trim().slice(0, 110),
    problem: String(a.problem ?? '').trim().slice(0, 320),
    build: String(a.build ?? '').trim().slice(0, 480),
    milestones: (Array.isArray(a.milestones) ? a.milestones : []).map((m) => String(m).trim().slice(0, 80)).filter(Boolean).slice(0, 4),
    category,
    image: null,
    token: null,
    tx: null,
    at: now(),
  }
  if (!name || symbol.length < 3 || !c.tagline || !c.problem || !c.build || c.milestones.length < 2) return log('The idea came back incomplete; skipped')
  if (!(await symbolFree(symbol))) return log(`$${symbol} is taken on Elysium; skipped ${name}`)

  c.image = await logo(String(a.prop ?? 'a small glowing tool').slice(0, 120), String(a.palette ?? 'bright, cheerful colours').slice(0, 80))
  if (config.dryRun) {
    ideas().unshift(c)
    save()
    return log(`Dry run: would launch $${symbol} (${name}): ${c.tagline}`)
  }
  const res = await mesa.launch({
    name,
    symbol,
    description: `${c.tagline} An open idea from the Mesa Lab: fork it on mesa.cx and build it.`.slice(0, 300),
    image: c.image ?? undefined,
    website: 'https://mesa.cx/lab',
    feePct: config.newsFeePct,
    sniperPct: 10,
    snipeSeconds: 60,
  })
  c.tx = res.hash
  c.token = res.token
  ideas().unshift(c)
  state.ideas = ideas().slice(0, 1000)
  save()
  if (res.status !== 'success' || !res.token) return log(`Launch of $${symbol} ${res.status}`)
  log(`Launched $${symbol} (${name}): ${c.tagline}`)
  const token = res.token
  // The page and first post wait for the indexer; don't hold up the next idea for them.
  void (async () => {
    await whenIndexed(() => postProfile(token, c)).catch((e) => log(`Couldn't post the project page for $${symbol}: ${String(e).slice(0, 120)}`))
    await whenIndexed(() => mesa.postUpdate(token, `Open idea: ${name}. ${c.tagline} Nobody's building it yet. Fork it, launch your own coin and ship it.`.slice(0, 280), forkUrl(token))).catch((e) =>
      log(`Couldn't post to the build log for $${symbol}: ${String(e).slice(0, 120)}`),
    )
  })()
}

let running = false
async function tick() {
  if (running) return
  running = true
  try {
    if (!config.ideasEnabled) return void (ideasPhase = 'off')
    if (!config.openrouterKey && !config.mock) return void (ideasPhase = 'needs-key')
    if (spentToday('news') >= config.newsBudgetUsdPerDay) return void (ideasPhase = 'budget')
    const today = ideas().filter((c) => c.at > now() - 86_400 && c.token).length
    if (today >= config.ideasMaxPerDay) return void (ideasPhase = 'full')
    const gap = Math.floor(86_400 / config.ideasMaxPerDay)
    if (now() - (ideas()[0]?.at ?? 0) < gap) return void (ideasPhase = 'waiting')
    if (!config.dryRun && Number((await mesa.balance()).HYPE) < config.minHype) return void (ideasPhase = 'needs-funds')
    ideasPhase = 'working'
    await makeIdea()
    ideasPhase = 'waiting'
  } catch (e) {
    log(`Something went wrong: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`)
    ideasPhase = 'waiting'
  } finally {
    running = false
  }
}

export function startIdeas() {
  void tick()
  setInterval(() => void tick(), 10_000)
}

export async function ideasStatus() {
  const balance = await mesa
    .balance()
    .then((b) => Number(b.HYPE))
    .catch(() => null)
  const gap = Math.floor(86_400 / Math.max(1, config.ideasMaxPerDay))
  return {
    address: mesa.address,
    balanceHype: balance,
    phase: ideasPhase,
    enabled: config.ideasEnabled,
    maxPerDay: config.ideasMaxPerDay,
    nextAt: ideas()[0] ? ideas()[0]!.at + gap : null,
    launchedToday: ideas().filter((c) => c.at > now() - 86_400 && c.token).length,
    launched: ideas().filter((c) => c.token).length,
    claimedHype: state.newsClaimedHype ?? 0,
    ideas: ideas().slice(0, 200),
    log: (state.ideasLog ?? []).slice(0, 30),
  }
}
