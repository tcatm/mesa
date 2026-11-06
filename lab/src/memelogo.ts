import { readFileSync } from 'node:fs'
import { Resvg } from '@resvg/resvg-js'
import { createAvatar } from '@dicebear/core'
import { bigSmile, bottts, funEmoji, thumbs } from '@dicebear/collection'

/**
 * Meme-coin logos from free sources, in several looks so a list of them
 * doesn't all look alike:
 *   - Microsoft Fluent Emoji in 3D, colour and flat (MIT)
 *   - Twemoji (CC BY 4.0)
 *   - DiceBear characters: Thumbs (CC0), Fun Emoji and Big Smile (CC BY 4.0),
 *     Bottts (free for commercial use)
 * on one of several backdrops. Each logo comes with a credit line.
 */
export interface Emoji {
  n: string
  p: string
  c: string | null
  f: string | null
  u: string
  k: string[]
  g: string
}
const UA = 'MesaLab/1.0 (https://mesa.cx/lab)'
export const EMOJI: Emoji[] = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../emoji.json', import.meta.url), 'utf8')) as Emoji[]
  } catch {
    return []
  }
})()
const FAVOURED = new Set(['Animals & Nature', 'Food & Drink', 'Objects', 'Smileys & Emotion', 'Activities', 'Travel & Places'])
const pick = <T>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)]!

export function matchEmoji(terms: string[]): Emoji | null {
  let best: { e: Emoji; s: number } | null = null
  terms.forEach((raw, rank) => {
    const t = raw.toLowerCase().trim()
    if (t.length < 2) return
    const weight = 3 - Math.min(rank, 2)
    for (const e of EMOJI) {
      const words = e.n.split(/\s+/)
      let s = 0
      if (e.n === t) s = 10
      else if (words.at(-1) === t) s = 9 // the subject: "full moon" for moon, not "moon cake"
      else if (words[0] === t) s = 8
      else if (words.includes(t)) s = 7
      else if (e.k.includes(t)) s = 6
      else if (e.n.includes(t)) s = 4
      else if (e.k.some((k) => k.includes(t))) s = 2
      if (!s) continue
      s = s * weight + (FAVOURED.has(e.g) ? 1 : 0)
      if (!best || s > best.s) best = { e, s }
    }
  })
  return best ? (best as { e: Emoji }).e : null
}

const PALETTES = [
  ['#FFE66D', '#FF9F1C'],
  ['#9BF6FF', '#4D96FF'],
  ['#CAFFBF', '#3BB273'],
  ['#FFC6FF', '#C77DFF'],
  ['#FFADAD', '#FF5D8F'],
  ['#B6FFEE', '#2EC4B6'],
  ['#FDFFB6', '#F9C80E'],
  ['#E0C3FC', '#8EC5FC'],
  ['#FFD6A5', '#FF7B54'],
  ['#1B1B1B', '#3A3A3A'],
] as const

/** A backdrop behind the art; the art sits in the middle 380px. */
function backdrop(): string {
  const [a, b] = pick(PALETTES)
  switch (Math.floor(Math.random() * 5)) {
    case 0: // soft radial gradient
      return `<defs><radialGradient id="g" cx="0.5" cy="0.38" r="0.75"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></radialGradient></defs><rect width="512" height="512" fill="url(#g)"/>`
    case 1: // sunburst
      return `<rect width="512" height="512" fill="${b}"/>${Array.from({ length: 16 }, (_, i) => {
        const t = (i * Math.PI) / 8
        return `<path d="M256 256 L${256 + 520 * Math.cos(t)} ${256 + 520 * Math.sin(t)} L${256 + 520 * Math.cos(t + 0.2)} ${256 + 520 * Math.sin(t + 0.2)}Z" fill="${a}" opacity=".55"/>`
      }).join('')}`
    case 2: // polka dots
      return `<rect width="512" height="512" fill="${a}"/>${Array.from({ length: 64 }, (_, i) => `<circle cx="${32 + (i % 8) * 64 + (Math.floor(i / 8) % 2) * 32}" cy="${32 + Math.floor(i / 8) * 64}" r="9" fill="${b}" opacity=".45"/>`).join('')}`
    case 3: // diagonal stripes
      return `<rect width="512" height="512" fill="${a}"/>${Array.from({ length: 14 }, (_, i) => `<path d="M${i * 80 - 512} 512 L${i * 80} 0 L${i * 80 + 36} 0 L${i * 80 - 476} 512Z" fill="${b}" opacity=".35"/>`).join('')}`
    default: // flat colour with a ring
      return `<rect width="512" height="512" fill="${b}"/><circle cx="256" cy="256" r="200" fill="${a}"/>`
  }
}

async function fetchText(url: string) {
  const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20_000) })
  if (!r.ok) throw new Error(`${r.status} ${url}`)
  return r
}
const raw = (p: string) => `https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/${p.split('/').map(encodeURIComponent).join('/')}`
const dataUri = (mime: string, b: Buffer) => `data:${mime};base64,${b.toString('base64')}`

/** The art as a data URI, from one of the emoji sets; null if that set has no copy. */
async function emojiArt(e: Emoji): Promise<{ uri: string; credit: string } | null> {
  const styles: (() => Promise<{ uri: string; credit: string } | null>)[] = [
    async () => ({ uri: dataUri('image/png', Buffer.from(await (await fetchText(raw(e.p))).arrayBuffer())), credit: `${e.n} from Fluent Emoji 3D by Microsoft (MIT)` }),
    async () => (e.c ? { uri: dataUri('image/svg+xml', Buffer.from(await (await fetchText(raw(e.c))).text())), credit: `${e.n} from Fluent Emoji by Microsoft (MIT)` } : null),
    async () => (e.f ? { uri: dataUri('image/svg+xml', Buffer.from(await (await fetchText(raw(e.f))).text())), credit: `${e.n} from Fluent Emoji Flat by Microsoft (MIT)` } : null),
    async () => {
      if (!e.u) return null
      const code = e.u.toLowerCase().split('-').filter((c) => c !== 'fe0f').join('-')
      const svg = await (await fetchText(`https://raw.githubusercontent.com/jdecked/twemoji/main/assets/svg/${code}.svg`)).text()
      return { uri: dataUri('image/svg+xml', Buffer.from(svg)), credit: `${e.n} from Twemoji (CC BY 4.0)` }
    },
  ]
  // 3D most often: it looks the most like a memecoin.
  const order = [0, 0, 1, 2, 3].sort(() => Math.random() - 0.5)
  for (const i of [...new Set(order), 0]) {
    try {
      const a = await styles[i]!()
      if (a) return a
    } catch {
      // try the next set
    }
  }
  return null
}

/** A cartoon character, drawn locally from the coin's ticker. */
function character(seed: string): { uri: string; credit: string } {
  const sets = [
    { style: thumbs, credit: 'Thumbs by DiceBear (CC0)' },
    { style: funEmoji, credit: 'Fun Emoji by Davis Uche, via DiceBear (CC BY 4.0)' },
    { style: bigSmile, credit: 'Big Smile by Ashley Seo, via DiceBear (CC BY 4.0)' },
    { style: bottts, credit: 'Bottts by Pablo Stanley, via DiceBear' },
  ] as const
  const s = pick(sets)
  const svg = createAvatar(s.style as Parameters<typeof createAvatar>[0], { seed, backgroundColor: ['transparent'] }).toString()
  return { uri: dataUri('image/svg+xml', Buffer.from(svg)), credit: s.credit }
}

/** A finished 384px PNG logo and its credit. Characters when nothing fits (or now and then for variety). */
export async function memeLogo(terms: string[], seed: string): Promise<{ png: Buffer; credit: string } | null> {
  const e = matchEmoji(terms)
  const art = e && Math.random() > 0.15 ? await emojiArt(e) : character(seed)
  if (!art) return null
  const tilt = Math.round((Math.random() - 0.5) * 18)
  const shadow = `<defs><radialGradient id="s" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#000" stop-opacity=".28"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient></defs><ellipse cx="256" cy="434" rx="150" ry="24" fill="url(#s)"/>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${backdrop()}${shadow}<g transform="rotate(${tilt} 256 256)"><image href="${art.uri}" x="70" y="60" width="372" height="372"/></g></svg>`
  const png = Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: 384 } }).render().asPng())
  return { png, credit: art.credit }
}
