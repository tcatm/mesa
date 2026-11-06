import { createHash } from 'node:crypto'
import { Mesa } from 'mesa-agent'
import { config } from './config.js'
import { chat, parseJson } from './llm.js'
import { save, spentToday, state, walletKey, type NewsCoin } from './store.js'

/**
 * The news agent: reads the day's headlines and launches a coin for a light,
 * safe story, with a free logo, from its own wallet. Fast and cheap: a small
 * model, no thinking, one story at a time, up to LAB_NEWS_MAX_PER_DAY a day.
 *
 * Hard rules (prompt, a word list, and a second check): no real people, no
 * deaths, disasters, violence, crime or war, no politics or elections, no
 * brands or companies, nothing medical. It skips a round rather than bend them.
 */
const mesa = new Mesa({ privateKey: walletKey('news'), maxHypePerTx: 0.01 })
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
  /\b(kill(s|ed|ing)?|dead|death|dies|died|murder|shoot(ing)?|shot|stab|attack|bomb|war|invasion|missile|terror|hostage|crash|collapse|earthquake|flood|hurricane|wildfire|tornado|tsunami|famine|victim|injur|abuse|assault|rape|suicide|overdose|cancer|disease|outbreak|virus|pandemic|epidemic|hospital|police|arrest|court|trial|jail|prison|lawsuit|sued|fraud|scam|election|vote|ballot|president|prime minister|senator|congress|parliament|minister|government|trump|biden|harris|putin|zelensky|netanyahu|israel|gaza|ukraine|russia|iran|religio|church|mosque|racis|refugee|migrant|layoff|bankrupt)\b/i

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
async function logo(theme: string): Promise<string | null> {
  const prompt = `flat vector coin logo icon of ${theme}, single bold simple symbol centred, solid near-black background #1B1B1B, mint #B6FFEE and soft grey colours, clean geometric shapes, no text, no letters, no border`
  try {
    const r = await fetch(
      `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=512&nologo=true&seed=${Math.floor(Math.random() * 1e6)}`,
      { signal: AbortSignal.timeout(90_000) },
    )
    if (!r.ok) return null
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length < 2_000) return null
    const up = await fetch(config.uploadUrl, { method: 'POST', body: new Uint8Array(buf) })
    const b = (await up.json().catch(() => ({}))) as { url?: string }
    return up.ok && b.url ? b.url : null
  } catch {
    return null
  }
}

async function makeCoin() {
  const seen = new Set(state.newsSeen ?? [])
  const fresh = (await headlines()).filter((h) => !seen.has(key(h.title)) && !BLOCK.test(h.title))
  if (!fresh.length) return log('No new headlines that fit the rules; checking again soon')
  const pick = fresh.sort(() => Math.random() - 0.5).slice(0, 30)
  const recent = coins().slice(0, 40).map((c) => `${c.name} ($${c.symbol})`).join(', ')
  const answer = parseJson<{ skip?: boolean; index?: number; name?: string; symbol?: string; blurb?: string; theme?: string }>(
    await chat({
      bucket: 'news',
      model: config.newsModel,
      maxTokens: 300,
      json: true,
      system: `You turn one of today's headlines into a fun, harmless memecoin idea for Mesa, a launchpad on Elysium. Pick the most delightful, light story: science, space, nature, animals, weather oddities, technology trends, culture, records, discoveries.
Hard rules, no exceptions: never name or hint at a real person (no names, initials or nicknames), a company, brand, product or team; skip anything about death, disasters, violence, crime, war, illness, politics, elections, religion or a group of people. The coin is about the idea or thing in the story, never the people in it. If no headline fits, answer {"skip": true}.`,
      user: `Headlines:\n${pick.map((h, i) => `${i}. ${h.title}`).join('\n')}\n\nCoins already made (don't repeat): ${recent || 'none'}\n\nAnswer with JSON only: {"index": number, "name": "2-3 words, playful, original", "symbol": "3-6 capital letters", "blurb": "one neutral sentence under 110 characters on what inspired it", "theme": "3-6 words describing a simple picture for its logo"} or {"skip": true}`,
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
  const theme = String(answer.theme ?? name).trim().slice(0, 60)
  if (!name || symbol.length < 3 || !blurb) return log('The idea came back incomplete; skipped')
  if (BLOCK.test(`${name} ${blurb} ${theme}`)) return log(`Dropped "${name}": it touched a topic the rules exclude`)
  // A second, independent check before anything goes on chain.
  const check = parseJson<{ ok?: boolean }>(
    await chat({
      bucket: 'news',
      model: config.newsModel,
      maxTokens: 80,
      json: true,
      system: 'You check memecoin names for a launchpad. Reject if the name, ticker or sentence names or hints at any real person, company, brand, product, sports team, political topic, tragedy, illness, crime or a group of people, or could read as offensive or as financial advice.',
      user: `Name: ${name}\nTicker: $${symbol}\nSentence: ${blurb}\nAnswer JSON only: {"ok": true or false}`,
    }),
  )
  if (check.ok !== true) return log(`Dropped "${name}" at the second check`)
  if (!(await symbolFree(symbol))) return log(`$${symbol} is taken on Elysium; skipped`)

  const image = await logo(theme)
  if (config.dryRun) {
    coins().unshift({ name, symbol, blurb, headline: h.title, source: h.source, link: h.link, image, token: null, tx: null, at: now() })
    save()
    return log(`Dry run: would launch $${symbol} (${name}): ${blurb}`)
  }
  const coin: NewsCoin = { name, symbol, blurb, headline: h.title, source: h.source, link: h.link, image, token: null, tx: null, at: now() }
  const res = await mesa.launch({
    name,
    symbol,
    description: `${blurb} Launched by the Mesa Lab news agent.`.slice(0, 300),
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

async function maybeClaim() {
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
    if (!config.newsEnabled) return void (newsPhase = 'off')
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
    await makeCoin()
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
