import { Resvg } from '@resvg/resvg-js'
import { Mesa } from 'mesa-agent'
import { config } from './config.js'
import { chat, parseJson } from './llm.js'
import { BLOCK, trending } from './news.js'
import { memeLogo } from './memelogo.js'
import { save, spentToday, state, walletKey, type NewsCoin } from './store.js'

/**
 * The attention token deployer: an Elysium version of a token trending on another chain
 * (DexScreener's boosts and newest profiles): the same name and ticker, a
 * picture that fits it from Wikimedia Commons (public domain or CC0 only, so
 * free to reuse), and a description that says it's an attention token, not affiliated
 * with the original. Its own wallet; at most LAB_VAMPS_MAX_PER_DAY a day,
 * spread evenly.
 */
const mesa = new Mesa({ privateKey: walletKey('vamp'), maxHypePerTx: 0.01 })
export const vampAddress = mesa.address!
const now = () => Math.floor(Date.now() / 1000)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export let vampPhase: 'off' | 'needs-key' | 'needs-funds' | 'budget' | 'waiting' | 'working' | 'full' = 'off'
const vamps = () => (state.vamps ??= [])
const UA = 'MesaLab/1.0 (https://mesa.cx/lab)'

function log(text: string) {
  state.vampLog = [{ at: now(), text }, ...(state.vampLog ?? [])].slice(0, 100)
  save()
  console.log(JSON.stringify({ vamps: text }))
}

async function symbolFree(sym: string) {
  if (vamps().some((c) => c.symbol === sym) || (state.news ?? []).some((c) => c.symbol === sym) || state.projects.some((p) => p.symbol === sym)) return false
  try {
    await mesa.resolve(sym)
    return false
  } catch {
    return true
  }
}

/** Pictures that make a bad coin logo: religion, death, war, people, documents, maps. */
const AVOID =
  /christ|jesus|madonna|saint|crucif|pieta|angel|church|cathedral|dead|death|corpse|funeral|grave|tomb|war|battle|soldier|army|nazi|weapon|gun|portrait|president|king|queen|pope|minister|senator|court|map|diagram|chart|document|letter|manuscript|book|page|stamp|coin of|banknote|logo|flag of|coat of arms|x-ray|surgery|blood|injur|museum|catalog|specimen|herbarium|skull|skeleton/

interface Pic {
  url: string
  credit: string
}

/** Public-domain or CC0 pictures on Wikimedia Commons for a search. */
async function commons(q: string): Promise<Pic[]> {
  const u = new URL('https://commons.wikimedia.org/w/api.php')
  for (const [k, v] of Object.entries({
    action: 'query',
    format: 'json',
    generator: 'search',
    gsrsearch: `${q} filetype:bitmap`,
    gsrnamespace: '6',
    gsrlimit: '40',
    prop: 'imageinfo',
    iiprop: 'url|extmetadata|size|mime',
    iiurlwidth: '640',
    iiextmetadatafilter: 'License|LicenseShortName',
  }))
    u.searchParams.set(k, v)
  const r = await fetch(u, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20_000) })
  if (!r.ok) throw new Error(`commons ${r.status}`)
  const b = (await r.json()) as {
    query?: {
      pages?: Record<
        string,
        {
          title: string
          imageinfo?: { thumburl?: string; width: number; height: number; mime: string; extmetadata?: Record<string, { value?: string }> }[]
        }
      >
    }
  }
  const out: Pic[] = []
  for (const p of Object.values(b.query?.pages ?? {})) {
    const i = p.imageinfo?.[0]
    if (!i?.thumburl || !/jpeg|png/.test(i.mime) || i.width < 300 || i.height < 300) continue
    const lic = `${i.extmetadata?.License?.value ?? ''} ${i.extmetadata?.LicenseShortName?.value ?? ''}`.toLowerCase()
    // Only free to reuse with no conditions: public domain or CC0.
    if (!/\b(pd|cc0|cc-zero|public domain)\b/.test(lic) || /\bby\b|sa\b|nc\b/.test(lic.replace(/public domain|cc0|cc-zero/g, ''))) continue
    const title = p.title.toLowerCase()
    if (AVOID.test(title)) continue
    // The search must actually be in the file's name, so the picture is of that thing.
    if (!q.toLowerCase().split(/\s+/).every((w) => title.includes(w.replace(/s$/, '')))) continue
    out.push({ url: i.thumburl, credit: `${p.title.replace(/^File:/, '')} (${i.extmetadata?.LicenseShortName?.value ?? 'public domain'}, Wikimedia Commons)` })
  }
  return out
}

/** Fetch a picture, crop it square and centred, and upload it to Mesa's media store. */
async function squareUpload(url: string): Promise<string | null> {
  const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30_000) })
  if (!r.ok) return null
  const img = Buffer.from(await r.arrayBuffer())
  if (img.length < 2_000) return null
  const mime = /png/.test(r.headers.get('content-type') ?? '') ? 'png' : 'jpeg'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><image href="data:image/${mime};base64,${img.toString('base64')}" x="0" y="0" width="512" height="512" preserveAspectRatio="xMidYMid slice"/></svg>`
  const png = Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: 384 } }).render().asPng())
  const up = await fetch(config.uploadUrl, { method: 'POST', headers: { 'content-type': 'image/png' }, body: new Uint8Array(png) })
  const b = (await up.json().catch(() => ({}))) as { url?: string }
  return up.ok && b.url ? b.url : null
}

async function picture(searches: string[]): Promise<{ url: string; credit: string } | null> {
  const used = new Set(vamps().slice(0, 300).map((v) => v.imageCredit))
  for (const q of searches) {
    try {
      const pics = (await commons(q)).filter((p) => !used.has(p.credit))
      for (const p of pics.slice(0, 4)) {
        const url = await squareUpload(p.url).catch(() => null)
        if (url) return { url, credit: p.credit }
      }
    } catch (e) {
      console.error(JSON.stringify({ vampPicture: String(e).slice(0, 160), q }))
    }
    await sleep(1_000)
  }
  return null
}

/** Upload a finished PNG to Mesa's media store. */
async function upload(png: Buffer): Promise<string | null> {
  const up = await fetch(config.uploadUrl, { method: 'POST', headers: { 'content-type': 'image/png' }, body: new Uint8Array(png) })
  const body = (await up.json().catch(() => ({}))) as { url?: string }
  return up.ok && body.url ? body.url : null
}

async function makeVamp() {
  const done = new Set(vamps().map((c) => c.symbol))
  const items = (await trending()).filter((t) => !done.has(t.symbol) && !BLOCK.test(`${t.name} ${t.symbol}`))
  if (!items.length) return log('Nothing new trending right now')
  for (const t of items.sort(() => Math.random() - 0.5).slice(0, 6)) {
    if (!(await symbolFree(t.symbol))) {
      done.add(t.symbol)
      continue
    }
    const check = parseJson<{ ok?: boolean; style?: string; emoji?: string[]; searches?: string[] }>(
      await chat({
        bucket: 'news',
        model: config.newsModel,
        maxTokens: 200,
        json: true,
        system:
          'You check memecoin names for a launchpad and pick a logo. Reject (ok false) if the name or ticker is a slur, hateful, sexual, about a death or tragedy, or names a private individual or a minor. Otherwise ok true, plus: "style": "meme" if it sounds like a meme, joke, animal or vibe coin, or "serious" if it sounds like a real product, protocol, AI or infrastructure project; "emoji": 3 single words for an emoji that fits (most fitting first), e.g. ["frog", "lizard", "money"]; "searches": 3 plain photo searches (1-2 words, most specific first) for a serious-looking picture, e.g. ["circuit board", "server", "network"]. Never a person, religion, brand or logo.',
        user: `Name: ${t.name}\nTicker: $${t.symbol}\nAnswer JSON only: {"ok": true or false, "style": "meme" or "serious", "emoji": ["...", "...", "..."], "searches": ["...", "...", "..."]}`,
      }),
    )
    if (check.ok !== true) continue
    const words = (x: unknown) => (Array.isArray(x) ? x : []).map((v) => String(v).trim().slice(0, 40)).filter(Boolean)
    const searches = words(check.searches)
    const meme = async () => {
      const l = await memeLogo([...words(check.emoji), ...t.name.toLowerCase().split(/[^a-z]+/)], t.symbol).catch(() => null)
      const url = l ? await upload(l.png).catch(() => null) : null
      return l && url ? { url, credit: l.credit } : null
    }
    const pic =
      check.style === 'serious'
        ? ((await picture(searches)) ?? (await meme()))
        : ((await meme()) ?? (await picture([...searches, 'cute animal'])))
    if (!pic) {
      log(`Skipped $${t.symbol}: no icon found`)
      continue
    }
    const blurb = `Attention token: $${t.symbol} is trending on ${t.chain}.`
    const coin: NewsCoin = {
      kind: 'vamp',
      name: t.name,
      symbol: t.symbol,
      blurb,
      headline: `$${t.symbol} trending on ${t.chain}`,
      source: 'dexscreener.com',
      link: t.url,
      image: pic?.url ?? null,
      imageCredit: pic?.credit,
      token: null,
      tx: null,
      at: now(),
    }
    if (config.dryRun) {
      vamps().unshift(coin)
      save()
      return log(`Dry run: would launch $${t.symbol} (${t.name}) from ${t.chain}`)
    }
    const res = await mesa.launch({
      name: t.name,
      symbol: t.symbol,
      description: `${blurb} Launched on Elysium by Mesa Lab's attention token deployer; not affiliated with the original.${pic ? ` Picture: ${pic.credit}.` : ''}`.slice(0, 300),
      image: pic?.url ?? undefined,
      website: 'https://mesa.cx/lab',
      feePct: config.newsFeePct,
      sniperPct: 10,
      snipeSeconds: 60,
    })
    coin.token = res.token
    coin.tx = res.hash
    vamps().unshift(coin)
    state.vamps = vamps().slice(0, 2000)
    save()
    return log(res.status === 'success' && res.token ? `Launched $${t.symbol} (${t.name}), trending on ${t.chain}` : `Launch of $${t.symbol} ${res.status}`)
  }
  log('Everything trending right now is taken or skipped')
}

async function maybeClaim() {
  if (config.dryRun || now() - (state.vampLastClaimAt ?? 0) < 86_400) return
  const { claimableHype } = await mesa.claimable()
  if (Number(claimableHype) < config.claimAt) return
  const r = await mesa.claim()
  state.vampLastClaimAt = now()
  if (r.status === 'success') {
    state.vampClaimedHype = (state.vampClaimedHype ?? 0) + Number(r.claimedHype)
    log(`Claimed ${Number(r.claimedHype).toFixed(4)} HYPE in trading fees`)
  }
  save()
}

let running = false
async function tick() {
  if (running) return
  running = true
  try {
    if (!config.vampsEnabled) return void (vampPhase = 'off')
    if (!config.openrouterKey && !config.mock) return void (vampPhase = 'needs-key')
    await maybeClaim().catch((e) => console.error('vamp claim', e))
    if (spentToday('news') >= config.newsBudgetUsdPerDay) return void (vampPhase = 'budget')
    const today = vamps().filter((c) => c.at > now() - 86_400 && c.token).length
    if (today >= config.vampsMaxPerDay) return void (vampPhase = 'full')
    const gap = Math.floor(86_400 / config.vampsMaxPerDay)
    if (now() - (vamps()[0]?.at ?? 0) < gap) return void (vampPhase = 'waiting')
    if (!config.dryRun && Number((await mesa.balance()).HYPE) < config.minHype) return void (vampPhase = 'needs-funds')
    vampPhase = 'working'
    await makeVamp()
    vampPhase = 'waiting'
  } catch (e) {
    log(`Something went wrong: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`)
    vampPhase = 'waiting'
  } finally {
    running = false
  }
}

export function startVamps() {
  void tick()
  setInterval(() => void tick(), 10_000)
}

export async function vampStatus() {
  const balance = await mesa
    .balance()
    .then((b) => Number(b.HYPE))
    .catch(() => null)
  return {
    address: vampAddress,
    balanceHype: balance,
    phase: vampPhase,
    enabled: config.vampsEnabled,
    maxPerDay: config.vampsMaxPerDay,
    launchedToday: vamps().filter((c) => c.at > now() - 86_400 && c.token).length,
    launched: vamps().filter((c) => c.token).length,
    claimedHype: state.vampClaimedHype ?? 0,
    coins: vamps().slice(0, 200),
    log: (state.vampLog ?? []).slice(0, 30),
  }
}
