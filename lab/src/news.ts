import { createHash } from 'node:crypto'
import { Resvg } from '@resvg/resvg-js'
import { Mesa } from 'mesa-agent'
import { config } from './config.js'
import { chat, parseJson } from './llm.js'
import { save, spentToday, state, walletKey, type NewsCoin } from './store.js'

/**
 * The news agent: reads the day's headlines and launches a coin for a light,
 * safe story, with a free logo, from its own wallet. Fast and cheap: a small
 * model, no thinking, one story at a time, up to LAB_NEWS_MAX_PER_DAY a day.
 *
 * Public figures, politics, companies and brands in the news are fair game.
 * Hard rules (prompt, a word list, and a second check): nothing built on a
 * death, disaster, attack, crime or other tragedy; no private individuals or
 * minors; no slurs or hate. Logos never show a real person's face or a brand's
 * logo, and every coin says it isn't affiliated with anyone it names.
 */
const mesa = new Mesa({ privateKey: walletKey('news'), maxHypePerTx: 0.01 })
/** The same wallet is used by the idea agent (ideas.ts); one client, so nonces never clash. */
export const newsMesa = mesa
export const newsAddress = mesa.address!
const now = () => Math.floor(Date.now() / 1000)
export let newsPhase: 'off' | 'needs-key' | 'needs-funds' | 'budget' | 'waiting' | 'working' | 'full' = 'off'

const coins = () => (state.news ??= [])
function log(text: string) {
  state.newsLog = [{ at: now(), text }, ...(state.newsLog ?? [])].slice(0, 100)
  save()
  console.log(JSON.stringify({ news: text }))
}

// Stories and words it never touches, checked in code as well as by the model.
const BLOCK =
  /\b(kill(s|ed|ing)?|dead|death|dies|died|murder\w*|shooting|shot dead|stabb\w*|massacre|bomb(ing|ed)?|terror\w*|hostage|(plane|car|train|bus|helicopter|highway) crash\w*|earthquake|flood(s|ing)?|hurricane|wildfire|tornado|tsunami|famine|victim\w*|injur\w*|abuse\w*|assault\w*|rape\w*|suicide|overdose|funeral|mourn\w*|tragedy|tragic|genocide|airstrike|casualt\w*|child(ren)?|kid(s)?|teen(s|ager)?|minor(s)?)\b/i

interface Item {
  title: string
  link: string
  source: string
}

let cache: { at: number; items: Item[] } = { at: 0, items: [] }

async function headlines(): Promise<Item[]> {
  if (Date.now() - cache.at < 15 * 60_000 && cache.items.length) return cache.items
  const out: Item[] = []
  for (const feed of config.newsFeeds) {
    try {
      const r = await fetch(feed, { headers: { 'user-agent': 'MesaLab/1.0 (+https://mesa.cx/lab)' }, signal: AbortSignal.timeout(15_000) })
      if (!r.ok) continue
      const xml = await r.text()
      const source = new URL(feed).hostname.replace(/^(www|feeds|news)\./, '')
      for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
        const raw = m[0]
        const t = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(raw)?.[1]
        const l = /<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i.exec(raw)?.[1]
        if (!t || !l) continue
        const title = t
          .replace(/&amp;/g, '&')
          .replace(/&#39;|&apos;/g, "'")
          .replace(/&quot;/g, '"')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/\s+-\s+[^-]{2,40}$/, '') // Google News appends " - Publisher"
          .trim()
        if (title.length > 12) out.push({ title, link: l.trim(), source })
      }
    } catch {
      // a feed being down is fine; the others still count
    }
  }
  cache = { at: Date.now(), items: out }
  return out
}

const key = (t: string) => createHash('sha256').update(t.toLowerCase()).digest('hex').slice(0, 16)

async function symbolFree(sym: string) {
  if (coins().some((c) => c.symbol === sym) || state.projects.some((p) => p.symbol === sym)) return false
  try {
    await mesa.resolve(sym)
    return false
  } catch {
    return true
  }
}

/** A free logo from Pollinations; none if it's down (the terminal shows a monogram). */
/** A logo's look, chosen per coin so the list doesn't all look alike. */
export interface LogoArt {
  subject: string
  style: string
  palette: string
}
const STYLES = ['bold flat vector', 'glossy 3D render', 'retro pixel art', 'playful cartoon', 'risograph print', 'neon line art', 'soft watercolour', 'low-poly', 'paper cut-out', 'vintage badge']

/** A free logo from Pollinations, retried with a fresh seed; none if it keeps failing (the terminal shows a monogram). */
async function logo(art: LogoArt): Promise<string | null> {
  const style = STYLES.includes(art.style) ? art.style : STYLES[Math.floor(Math.random() * STYLES.length)]!
  const prompt = `${style} illustration of ${art.subject}, colour palette: ${art.palette}, one clear subject centred and filling most of a square coin icon, simple background, an original design that is not any existing cartoon character, meme figure, mascot or photograph, no people, no faces, no real logos, no text, no letters, no border`
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(
        `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=512&nologo=true&seed=${Math.floor(Math.random() * 1e6)}`,
        { signal: AbortSignal.timeout(90_000) },
      )
      if (!r.ok) throw new Error(String(r.status))
      const raw = Buffer.from(await r.arrayBuffer())
      if (raw.length < 2_000) throw new Error('empty image')
      const buf = cropCorner(raw, r.headers.get('content-type') ?? 'image/jpeg')
      const up = await fetch(config.uploadUrl, { method: 'POST', body: new Uint8Array(buf) })
      const b = (await up.json().catch(() => ({}))) as { url?: string }
      if (up.ok && b.url) return b.url
    } catch {
      // try again with another seed
    }
    await new Promise((res) => setTimeout(res, 5_000))
  }
  return null
}

/**
 * The free service stamps a small mark in the bottom-right corner: keep the
 * centre 84% of the image (dropping that corner) and render it back to 512px.
 */
function cropCorner(img: Buffer, type: string): Buffer {
  const mime = /png|webp|jpeg|jpg/.exec(type)?.[0] ?? 'jpeg'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="31 31 430 430"><image href="data:image/${mime === 'jpg' ? 'jpeg' : mime};base64,${img.toString('base64')}" x="0" y="0" width="512" height="512"/></svg>`
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: 512 } }).render().asPng())
}

// ---------------------------------------------------------------- vamps

interface Trend {
  name: string
  symbol: string
  chain: string
  url: string
}

let trendCache: { at: number; items: Trend[] } = { at: 0, items: [] }
const CHAINS: Record<string, string> = { solana: 'Solana', base: 'Base', ethereum: 'Ethereum', bsc: 'BNB Chain', arbitrum: 'Arbitrum', sui: 'Sui', tron: 'Tron', ton: 'TON', avalanche: 'Avalanche', polygon: 'Polygon', abstract: 'Abstract', hyperliquid: 'Hyperliquid', robinhood: 'Robinhood Chain', monad: 'Monad', berachain: 'Berachain', sonic: 'Sonic', unichain: 'Unichain', linea: 'Linea', blast: 'Blast', optimism: 'Optimism', pulsechain: 'PulseChain' }

/** Tokens popping on other chains right now: DexScreener's top boosts and newest profiles, with their real names. */
async function trending(): Promise<Trend[]> {
  if (Date.now() - trendCache.at < 10 * 60_000 && trendCache.items.length) return trendCache.items
  const get = async (u: string) => {
    const r = await fetch(u, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
    return r.ok ? ((await r.json()) as unknown) : null
  }
  const lists = await Promise.all([
    get('https://api.dexscreener.com/token-boosts/top/v1').catch(() => null),
    get('https://api.dexscreener.com/token-profiles/latest/v1').catch(() => null),
  ])
  const refs = new Map<string, { chainId: string; tokenAddress: string; url: string }>()
  for (const list of lists)
    for (const t of Array.isArray(list) ? (list as { chainId?: string; tokenAddress?: string; url?: string }[]) : [])
      if (t.chainId && t.tokenAddress && !/hyperevm|elysium/i.test(t.chainId) && refs.size < 60)
        refs.set(`${t.chainId}:${t.tokenAddress}`, { chainId: t.chainId, tokenAddress: t.tokenAddress, url: t.url ?? '' })
  const out: Trend[] = []
  const all = [...refs.values()]
  for (let i = 0; i < all.length; i += 30) {
    const batch = all.slice(i, i + 30)
    const r = (await get(`https://api.dexscreener.com/latest/dex/tokens/${batch.map((b) => b.tokenAddress).join(',')}`).catch(() => null)) as {
      pairs?: { chainId: string; url?: string; baseToken?: { address: string; name: string; symbol: string }; marketCap?: number }[]
    } | null
    const seen = new Set<string>()
    for (const p of r?.pairs ?? []) {
      const b = p.baseToken
      if (!b || seen.has(`${p.chainId}:${b.address}`) || !batch.some((x) => x.tokenAddress === b.address)) continue
      seen.add(`${p.chainId}:${b.address}`)
      out.push({ name: b.name.trim().slice(0, 32), symbol: b.symbol.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10), chain: CHAINS[p.chainId] ?? p.chainId, url: p.url ?? batch.find((x) => x.tokenAddress === b.address)?.url ?? 'https://dexscreener.com' })
    }
  }
  trendCache = { at: Date.now(), items: out.filter((t) => t.name && t.symbol.length >= 2) }
  return trendCache.items
}

/** An Elysium vamp of a ticker trending elsewhere: same name and ticker, its own logo. */
async function makeVamp(): Promise<boolean> {
  const done = new Set(coins().filter((c) => c.kind === 'vamp').map((c) => c.symbol))
  const items = (await trending()).filter((t) => !done.has(t.symbol) && !BLOCK.test(`${t.name} ${t.symbol}`))
  for (const t of items.sort(() => Math.random() - 0.5).slice(0, 8)) {
    if (!(await symbolFree(t.symbol))) continue
    const check = parseJson<{ ok?: boolean; theme?: string }>(
      await chat({
        bucket: 'news',
        model: config.newsModel,
        maxTokens: 120,
        json: true,
        system:
          'You check memecoin names for a launchpad and suggest an original logo idea. Reject (ok false) if the name or ticker is a slur, hateful, sexual, about a death or tragedy, or names a private individual or a minor. Otherwise ok true, with "theme": 3-6 words for a simple original symbolic picture that fits the name: an object, animal or symbol, never an existing character, mascot, meme figure, person, face or logo.',
        user: `Name: ${t.name}\nTicker: $${t.symbol}\nAnswer JSON only: {"ok": true or false, "theme": "..."}`,
      }),
    )
    if (check.ok !== true) continue
    const blurb = `Elysium vamp of $${t.symbol}, trending on ${t.chain}.`
    const image = await logo({ subject: String(check.theme ?? 'a bright simple star').slice(0, 60), style: '', palette: 'bright, cheerful colours' })
    if (config.dryRun) {
      coins().unshift({ kind: 'vamp', name: t.name, symbol: t.symbol, blurb, headline: `$${t.symbol} trending on ${t.chain}`, source: 'dexscreener.com', link: t.url, image, token: null, tx: null, at: now() })
      save()
      log(`Dry run: would vamp $${t.symbol} (${t.name}) from ${t.chain}`)
      return true
    }
    const res = await mesa.launch({
      name: t.name,
      symbol: t.symbol,
      description: `${blurb} Launched by the Mesa Lab news agent; not affiliated with the original.`,
      image: image ?? undefined,
      website: 'https://mesa.cx/lab',
      feePct: config.newsFeePct,
      sniperPct: 10,
      snipeSeconds: 60,
    })
    coins().unshift({ kind: 'vamp', name: t.name, symbol: t.symbol, blurb, headline: `$${t.symbol} trending on ${t.chain}`, source: 'dexscreener.com', link: t.url, image, token: res.token, tx: res.hash, at: now() })
    state.news = coins().slice(0, 1000)
    save()
    log(res.status === 'success' && res.token ? `Vamped $${t.symbol} (${t.name}), trending on ${t.chain}` : `Vamp of $${t.symbol} ${res.status}`)
    return true
  }
  log('Nothing trending to vamp right now (all taken or skipped)')
  return false
}

// ---------------------------------------------------------------- news

async function makeCoin() {
  const seen = new Set(state.newsSeen ?? [])
  const fresh = (await headlines()).filter((h) => !seen.has(key(h.title)) && !BLOCK.test(h.title))
  if (!fresh.length) return log('No new headlines that fit the rules; checking again soon')
  const pick = fresh.sort(() => Math.random() - 0.5).slice(0, 30)
  const recent = coins().slice(0, 40).map((c) => `${c.name} ($${c.symbol})`).join(', ')
  const answer = parseJson<{ skip?: boolean; index?: number; name?: string; symbol?: string; blurb?: string; logo?: Partial<LogoArt> }>(
    await chat({
      bucket: 'news',
      model: config.newsModel,
      maxTokens: 300,
      json: true,
      system: `You turn one of today's headlines into a fun, harmless memecoin idea for Mesa, a launchpad on Elysium. Pick the most delightful, light story: science, space, nature, animals, weather oddities, technology trends, culture, records, discoveries.
Go for what the timeline is talking about: big moments, viral stories, public figures, politics, markets, tech, sport, culture, space, science. Public figures, companies and brands may be named.
Hard rules, no exceptions: nothing built on a death, disaster, attack, war casualties, crime victims, illness or any other tragedy; never a private individual or anyone under 18; nothing hateful, sexual or mocking a group of people. If no headline fits, answer {"skip": true}.`,
      user: `Headlines:\n${pick.map((h, i) => `${i}. ${h.title}`).join('\n')}\n\nCoins already made (don't repeat): ${recent || 'none'}\n\nAnswer with JSON only: {"index": number, "name": "2-3 words, playful, original", "symbol": "3-6 capital letters", "blurb": "one neutral sentence under 110 characters on what inspired it", "logo": {"subject": "a specific, vivid picture for its coin logo, 6-14 words: an object, animal, place or symbol from the story, never a person's face or a brand's logo", "style": one of ${JSON.stringify(STYLES)}, "palette": "3-4 colours that fit the story, e.g. hot orange, deep navy and cream"}} or {"skip": true}`,
    }),
  )
  const h = typeof answer.index === 'number' ? pick[answer.index] : undefined
  if (answer.skip || !h) {
    for (const p of pick.slice(0, 10)) seen.add(key(p.title))
    state.newsSeen = [...seen].slice(-2000)
    return log('Nothing in this batch fits the rules; skipped it')
  }
  seen.add(key(h.title))
  state.newsSeen = [...seen].slice(-2000)
  save()
  const name = String(answer.name ?? '').trim().slice(0, 32)
  const symbol = String(answer.symbol ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6)
  const blurb = String(answer.blurb ?? '').trim().slice(0, 140)
  const art: LogoArt = {
    subject: String(answer.logo?.subject ?? name).trim().slice(0, 120),
    style: String(answer.logo?.style ?? '').trim(),
    palette: String(answer.logo?.palette ?? 'bright, cheerful colours').trim().slice(0, 80),
  }
  const theme = art.subject
  if (!name || symbol.length < 3 || !blurb) return log('The idea came back incomplete; skipped')
  if (BLOCK.test(`${name} ${blurb} ${theme}`)) return log(`Dropped "${name}": it touched a topic the rules exclude`)
  // A second, independent check before anything goes on chain.
  const check = parseJson<{ ok?: boolean }>(
    await chat({
      bucket: 'news',
      model: config.newsModel,
      maxTokens: 80,
      json: true,
      system: 'You check news memecoins for a launchpad. Public figures, politics, companies and brands are allowed. Reject only if the name, ticker or sentence is built on a death, disaster, attack, crime victim, illness or other tragedy, names a private individual or anyone under 18, is hateful, sexual or mocks a group of people, or reads as financial advice or a promise of returns.',
      user: `Name: ${name}\nTicker: $${symbol}\nSentence: ${blurb}\nAnswer JSON only: {"ok": true or false}`,
    }),
  )
  if (check.ok !== true) return log(`Dropped "${name}" at the second check`)
  if (!(await symbolFree(symbol))) return log(`$${symbol} is taken on Elysium; skipped`)

  const image = await logo(art)
  if (config.dryRun) {
    coins().unshift({ kind: 'news', name, symbol, blurb, headline: h.title, source: h.source, link: h.link, image, token: null, tx: null, at: now() })
    save()
    return log(`Dry run: would launch $${symbol} (${name}): ${blurb}`)
  }
  const coin: NewsCoin = { kind: 'news', name, symbol, blurb, headline: h.title, source: h.source, link: h.link, image, token: null, tx: null, at: now() }
  const res = await mesa.launch({
    name,
    symbol,
    description: `${blurb} A news coin launched by the Mesa Lab agent; not affiliated with anyone it names.`.slice(0, 300),
    image: image ?? undefined,
    website: 'https://mesa.cx/lab',
    feePct: config.newsFeePct,
    sniperPct: 10,
    snipeSeconds: 60,
  })
  coin.tx = res.hash
  coin.token = res.token
  coins().unshift(coin)
  state.news = coins().slice(0, 1000)
  save()
  if (res.status !== 'success' || !res.token) return log(`Launch of $${symbol} ${res.status}`)
  log(`Launched $${symbol} (${name}): ${blurb}`)
}

export async function maybeClaim() {
  if (config.dryRun || now() - (state.newsLastClaimAt ?? 0) < 86_400) return
  const { claimableHype } = await mesa.claimable()
  if (Number(claimableHype) < config.claimAt) return
  const r = await mesa.claim()
  state.newsLastClaimAt = now()
  if (r.status === 'success') {
    state.newsClaimedHype = (state.newsClaimedHype ?? 0) + Number(r.claimedHype)
    log(`Claimed ${Number(r.claimedHype).toFixed(4)} HYPE in trading fees`)
  }
  save()
}

let running = false
async function tick() {
  if (running) return
  running = true
  try {
    if (!config.newsEnabled) {
      newsPhase = 'off'
      // The idea agent shares this wallet, so the claim still runs.
      if (config.ideasEnabled) await maybeClaim().catch((e) => console.error('news claim', e))
      return
    }
    if (!config.openrouterKey && !config.mock) return void (newsPhase = 'needs-key')
    await maybeClaim().catch((e) => console.error('news claim', e))
    if (spentToday('news') >= config.newsBudgetUsdPerDay) return void (newsPhase = 'budget')
    const today = coins().filter((c) => c.at > now() - 86_400 && c.token).length
    if (today >= config.newsMaxPerDay) return void (newsPhase = 'full')
    // Spread the day's coins out evenly.
    const gap = Math.floor(86_400 / config.newsMaxPerDay)
    if (now() - (coins()[0]?.at ?? 0) < gap) return void (newsPhase = 'waiting')
    if (!config.dryRun && Number((await mesa.balance()).HYPE) < config.minHype) return void (newsPhase = 'needs-funds')
    newsPhase = 'working'
    // Alternate: a vamp of something trending elsewhere, then a coin from the news.
    const lastWasVamp = coins()[0]?.kind === 'vamp'
    if (config.newsVamps && !lastWasVamp) {
      if (!(await makeVamp().catch((e) => (log(`Vamp failed: ${String(e).slice(0, 120)}`), false)))) await makeCoin()
    } else await makeCoin()
    newsPhase = 'waiting'
  } catch (e) {
    log(`Something went wrong: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`)
    newsPhase = 'waiting'
  } finally {
    running = false
  }
}

export function startNews() {
  void tick()
  setInterval(() => void tick(), 60_000)
}

export async function newsStatus() {
  const balance = await mesa
    .balance()
    .then((b) => Number(b.HYPE))
    .catch(() => null)
  return {
    address: newsAddress,
    balanceHype: balance,
    phase: newsPhase,
    enabled: config.newsEnabled,
    maxPerDay: config.newsMaxPerDay,
    launchedToday: coins().filter((c) => c.at > now() - 86_400 && c.token).length,
    launched: coins().filter((c) => c.token).length,
    claimedHype: state.newsClaimedHype ?? 0,
    spentTodayUsd: Math.round(spentToday('news') * 1000) / 1000,
    budgetUsdPerDay: config.newsBudgetUsdPerDay,
    coins: coins().slice(0, 100),
    log: (state.newsLog ?? []).slice(0, 30),
  }
}
