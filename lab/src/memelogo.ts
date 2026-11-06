import { readFileSync } from 'node:fs'
import { Resvg } from '@resvg/resvg-js'

/**
 * Meme-coin logos from free sources, in several looks so a list of them
 * doesn't all look alike:
 *   - Microsoft Fluent Emoji in 3D, colour and flat (MIT)
 *   - Twemoji (CC BY 4.0)
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
  ['#F1FAEE', '#A8DADC'],
  ['#FFF1E6', '#F4A261'],
  ['#E9FF70', '#70D6FF'],
  ['#FF70A6', '#FFD670'],
  ['#00F5D4', '#9B5DE5'],
  ['#FEE440', '#F15BB5'],
  ['#D8F3DC', '#52B788'],
  ['#CDB4DB', '#FFAFCC'],
  ['#0B132B', '#3A506B'],
] as const

/** A backdrop behind the art; the art sits in the middle 380px. */
function backdrop(): string {
  const [a, b] = pick(PALETTES)
  switch (Math.floor(Math.random() * 10)) {
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
    case 4: // flat colour with a ring
      return `<rect width="512" height="512" fill="${b}"/><circle cx="256" cy="256" r="200" fill="${a}"/>`
    case 5: // checkerboard
      return `<rect width="512" height="512" fill="${a}"/>${Array.from({ length: 64 }, (_, i) => ((i + Math.floor(i / 8)) % 2 ? `<rect x="${(i % 8) * 64}" y="${Math.floor(i / 8) * 64}" width="64" height="64" fill="${b}" opacity=".35"/>` : '')).join('')}`
    case 6: // confetti
      return `<rect width="512" height="512" fill="${a}"/>${Array.from({ length: 40 }, () => `<rect x="${Math.random() * 500}" y="${Math.random() * 500}" width="14" height="6" rx="3" fill="${pick([b, '#ffffff', '#1B1B1B'])}" opacity=".6" transform="rotate(${Math.random() * 180} ${Math.random() * 512} ${Math.random() * 512})"/>`).join('')}`
    case 7: // halftone fade
      return `<rect width="512" height="512" fill="${a}"/>${Array.from({ length: 256 }, (_, i) => `<circle cx="${16 + (i % 16) * 32}" cy="${16 + Math.floor(i / 16) * 32}" r="${1 + (Math.floor(i / 16) / 16) * 11}" fill="${b}" opacity=".5"/>`).join('')}`
    case 8: // two-tone split
      return `<rect width="512" height="512" fill="${a}"/><path d="M0 512 L512 0 L512 512 Z" fill="${b}"/>`
    default: // concentric rings
      return `<rect width="512" height="512" fill="${b}"/>${[230, 180, 130, 80].map((r, i) => `<circle cx="256" cy="256" r="${r}" fill="${i % 2 ? b : a}"/>`).join('')}`
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

/** A finished 384px PNG logo and its credit; null when no emoji fits (the caller then uses a photo). */
export async function memeLogo(terms: string[], seed: string): Promise<{ png: Buffer; credit: string } | null> {
  const e = matchEmoji(terms)
  void seed
  const art = e ? await emojiArt(e) : null
  if (!art) return null
  const tilt = Math.round((Math.random() - 0.5) * 18)
  const shadow = `<defs><radialGradient id="s" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#000" stop-opacity=".28"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient></defs><ellipse cx="256" cy="434" rx="150" ry="24" fill="url(#s)"/>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${backdrop()}${shadow}<g transform="rotate(${tilt} 256 256)"><image href="${art.uri}" x="70" y="60" width="372" height="372"/></g></svg>`
  const png = Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: 384 } }).render().asPng())
  return { png, credit: art.credit }
}
