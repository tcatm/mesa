import { Resvg } from '@resvg/resvg-js'
import { shitify } from './shit.js'
import { Mesa, API } from 'mesa-agent'
import { config } from './config.js'
import { save, state, walletKey } from './store.js'
import { botLogo } from './botlogo.js'
import { crtScreen } from './crt.js'

/**
 * The worker deployer: launches "mesa.cx worker 949395" / "mesa.cx crawler
 * 9373895" tokens, each with a mission for mapping Elysium and a real reading
 * for it taken from Mesa's indexer at launch (blocks indexed, launchpads,
 * tokens, bridge flow, $MESA burned). Logos are drawn in code: drones,
 * crawlers and satellites in industrial colours, each stamped with its serial.
 * Its own wallet; at most LAB_WORKERS_MAX_PER_DAY a day, spread evenly. No
 * model calls, so it costs only gas.
 */
const mesa = new Mesa({ privateKey: walletKey('worker'), maxHypePerTx: 0.01 })
export const workerAddress = mesa.address!
const now = () => Math.floor(Date.now() / 1000)
export let workerPhase: 'off' | 'needs-funds' | 'waiting' | 'working' | 'full' = 'off'

export interface Worker {
  name: string
  symbol: string
  kind: string
  mission: string
  report: string
  image: string | null
  token: string | null
  tx: string | null
  at: number
}
const workers = () => (state.workers ??= [])

function log(text: string) {
  state.workerLog = [{ at: now(), text }, ...(state.workerLog ?? [])].slice(0, 100)
  save()
  console.log(JSON.stringify({ workers: text }))
}

const pick = <T>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)]!
const fmt = (n: number) => Math.round(n).toLocaleString('en-US')

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(15_000) })
  if (!r.ok) throw new Error(`${path} ${r.status}`)
  return (await r.json()) as T
}

/** A mission, and the real reading that goes with it. */
async function mission(): Promise<{ mission: string; report: string }> {
  const s = await get<{ tokens: number; launchpads: number; pools: number; trades24h: number; volume24hHype: number; head: number; mesaBurned: number }>('/stats')
  const missions: (() => Promise<{ mission: string; report: string }>)[] = [
    async () => {
      const from = Math.max(0, s.head - 10_000)
      return { mission: `Index Elysium blocks ${fmt(from)} to ${fmt(s.head)}`, report: `Head block ${fmt(s.head)}; ${fmt(s.trades24h)} trades in the last 24h.` }
    },
    async () => {
      const v = await get<{ venue: string; tokens: number }[]>('/venues')
      const top = [...v].filter((x) => x.venue !== 'Other').sort((a, b) => b.tokens - a.tokens).slice(0, 3)
      return { mission: "Map Elysium's launchpads", report: `${s.launchpads} launchpads found; most launches on ${top.map((x) => `${x.venue} (${fmt(x.tokens)})`).join(', ')}.` }
    },
    async () => ({ mission: 'Count every token launched on Elysium', report: `${fmt(s.tokens)} tokens across ${fmt(s.pools)} pools at block ${fmt(s.head)}.` }),
    async () => {
      const b = await get<{ deposits: { n: number; hype: number }; wallets: number; last24h: { deposits: { n: number; hype: number } } }>('/bridge')
      return { mission: 'Watch HYPE bridged into Elysium', report: `${fmt(b.deposits.hype)} HYPE bridged in through Mesa by ${fmt(b.wallets)} wallets; ${fmt(b.last24h.deposits.hype)} in the last 24h.` }
    },
    async () => ({ mission: 'Track $MESA buybacks and burns', report: `${fmt(s.mesaBurned)} $MESA burned so far (${((s.mesaBurned / 1e9) * 100).toFixed(2)}% of supply).` }),
    async () => ({ mission: "Measure Elysium's daily volume", report: `${fmt(s.volume24hHype)} HYPE traded in the last 24h over ${fmt(s.trades24h)} trades.` }),
  ]
  return pick(missions)()
}

// ---------------------------------------------------------------- logos: serious, technical line art

/** A bundled monospace font (DejaVu Sans Mono, free licence): the server image has no fonts. */
const FONTS = ['DejaVuSansMono.ttf', 'DejaVuSansMono-Bold.ttf'].map((f) => new URL(`../fonts/${f}`, import.meta.url).pathname)
const render = (svg: string) =>
  Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: 384 }, font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans Mono' } }).render().asPng())

const PALETTES = [
  { bg: '#0B0D10', ink: '#E8ECEF', accent: '#F5A524', dim: '#1C2128' }, // amber on carbon
  { bg: '#07111A', ink: '#CFE6FF', accent: '#4FA3FF', dim: '#12263A' }, // cobalt
  { bg: '#0E0B0B', ink: '#F2E6E3', accent: '#FF5F45', dim: '#2A1D1B' }, // signal red
  { bg: '#08100A', ink: '#DDF5DA', accent: '#5BE37D', dim: '#15281A' }, // phosphor
  { bg: '#0F0C16', ink: '#E7E0FA', accent: '#A98BFF', dim: '#231C35' }, // ultraviolet
  { bg: '#ECE8DF', ink: '#1A1C20', accent: '#C2410C', dim: '#D6D0C3' }, // blueprint on paper
  { bg: '#0A0A0A', ink: '#F5F5F5', accent: '#F5F5F5', dim: '#1E1E1E' }, // monochrome
  { bg: '#071413', ink: '#D9FFF6', accent: '#B6FFEE', dim: '#12302C' }, // mesa mint
] as const
type P = (typeof PALETTES)[number]
const rnd = (a: number, b: number) => a + Math.random() * (b - a)
const C = 256

/** Faint framing: a grid, crosshair ticks or a dotted field. */
function field(c: P) {
  switch (Math.floor(Math.random() * 3)) {
    case 0:
      return Array.from({ length: 9 }, (_, i) => `<path d="M${i * 64} 0 V512 M0 ${i * 64} H512" stroke="${c.dim}" stroke-width="1.5"/>`).join('')
    case 1:
      return Array.from({ length: 64 }, (_, i) => `<circle cx="${32 + (i % 8) * 64}" cy="${32 + Math.floor(i / 8) * 64}" r="2" fill="${c.dim}"/>`).join('')
    default:
      return `<path d="M24 24 h40 M24 24 v40 M488 24 h-40 M488 24 v40 M24 488 h40 M24 488 v-40 M488 488 h-40 M488 488 v-40" stroke="${c.dim}" stroke-width="3" fill="none"/>`
  }
}

const ICONS: Record<string, (c: P) => string> = {
  // A radar sweep with contacts.
  radar: (c) =>
    `${[70, 120, 170].map((r) => `<circle cx="${C}" cy="${C}" r="${r}" fill="none" stroke="${c.ink}" stroke-opacity=".35" stroke-width="2"/>`).join('')}
     <path d="M${C} ${C - 180} V${C + 180} M${C - 180} ${C} H${C + 180}" stroke="${c.ink}" stroke-opacity=".2" stroke-width="2"/>
     <path d="M${C} ${C} L${C + 170 * Math.cos(-0.9)} ${C + 170 * Math.sin(-0.9)} A170 170 0 0 1 ${C + 170} ${C} Z" fill="${c.accent}" opacity=".28"/>
     ${Array.from({ length: 5 }, () => `<circle cx="${C + rnd(-150, 150)}" cy="${C + rnd(-150, 150)}" r="6" fill="${c.accent}"/>`).join('')}`,
  // Orbits around a core.
  orbit: (c) =>
    `${[0, 60, 120].map((r) => `<ellipse cx="${C}" cy="${C}" rx="180" ry="62" fill="none" stroke="${c.ink}" stroke-opacity=".55" stroke-width="2.5" transform="rotate(${r} ${C} ${C})"/>`).join('')}
     <circle cx="${C}" cy="${C}" r="34" fill="${c.accent}"/>
     ${[0, 60, 120].map((r, i) => `<circle cx="${C + 180 * Math.cos((r * Math.PI) / 180 + i)}" cy="${C + 62 * Math.sin(i * 2)}" r="9" fill="${c.ink}" transform="rotate(${r} ${C} ${C})"/>`).join('')}`,
  // Topographic contour lines.
  contour: (c) =>
    `${Array.from({ length: 9 }, (_, i) => {
      const r = 30 + i * 22
      const pts = Array.from({ length: 24 }, (_, k) => {
        const t = (k / 24) * Math.PI * 2
        const w = r * (1 + 0.12 * Math.sin(t * 3 + i) + 0.06 * Math.cos(t * 5))
        return `${C + w * Math.cos(t)},${C + w * 0.8 * Math.sin(t)}`
      }).join(' ')
      return `<polygon points="${pts}" fill="none" stroke="${i === 4 ? c.accent : c.ink}" stroke-opacity="${i === 4 ? 1 : 0.45}" stroke-width="${i === 4 ? 3.5 : 2}"/>`
    }).join('')}`,
  // A crystal lattice.
  lattice: (c) => {
    const pts: [number, number][] = []
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) pts.push([C - 160 + x * 80 + (y % 2) * 40, C - 160 + y * 80])
    const lines = pts.flatMap(([x, y], i) => pts.slice(i + 1).filter(([a, b]) => Math.hypot(a - x, b - y) < 92).map(([a, b]) => `<path d="M${x} ${y} L${a} ${b}" stroke="${c.ink}" stroke-opacity=".4" stroke-width="2"/>`))
    return `${lines.join('')}${pts.map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="${i === 12 ? 16 : 6}" fill="${i === 12 ? c.accent : c.ink}"/>`).join('')}`
  },
  // A sigil: concentric geometry with a bound glyph.
  sigil: (c) => {
    const n = Math.floor(rnd(5, 9))
    const star = Array.from({ length: n }, (_, i) => `${C + 150 * Math.cos((i * 2 * Math.PI * 2) / n - Math.PI / 2)},${C + 150 * Math.sin((i * 2 * Math.PI * 2) / n - Math.PI / 2)}`).join(' ')
    return `<circle cx="${C}" cy="${C}" r="180" fill="none" stroke="${c.ink}" stroke-opacity=".5" stroke-width="2"/><circle cx="${C}" cy="${C}" r="160" fill="none" stroke="${c.ink}" stroke-opacity=".25" stroke-width="1.5"/>
      <polygon points="${star}" fill="none" stroke="${c.accent}" stroke-width="3"/>
      ${Array.from({ length: n }, (_, i) => `<circle cx="${C + 180 * Math.cos((i * 2 * Math.PI) / n)}" cy="${C + 180 * Math.sin((i * 2 * Math.PI) / n)}" r="7" fill="${c.ink}"/>`).join('')}
      <circle cx="${C}" cy="${C}" r="14" fill="${c.accent}"/>`
  },
  // A prism splitting a beam.
  prism: (c) =>
    `<path d="M40 300 L210 270" stroke="${c.ink}" stroke-width="5"/><polygon points="${C},120 ${C + 120},350 ${C - 120},350" fill="none" stroke="${c.ink}" stroke-width="4"/>
     ${[0, 1, 2, 3].map((i) => `<path d="M300 280 L480 ${200 + i * 50}" stroke="${c.accent}" stroke-opacity="${1 - i * 0.2}" stroke-width="5"/>`).join('')}`,
  // A crawler, reduced to line art.
  crawler: (c) =>
    `${[-1, 1].flatMap((sd) => [-50, 0, 50].map((dy, i) => `<path d="M${C + sd * 50} ${C + dy} L${C + sd * 130} ${C + dy + (i - 1) * 30 - 20} L${C + sd * 180} ${C + dy + (i - 1) * 60 + 30}" fill="none" stroke="${c.ink}" stroke-width="5" stroke-linejoin="round"/>`)).join('')}
     <ellipse cx="${C}" cy="${C}" rx="64" ry="96" fill="${c.bg}" stroke="${c.ink}" stroke-width="5"/><circle cx="${C}" cy="${C - 50}" r="16" fill="${c.accent}"/>
     <path d="M${C - 34} ${C + 6} H${C + 34} M${C - 34} ${C + 30} H${C + 34}" stroke="${c.ink}" stroke-opacity=".6" stroke-width="4"/>`,
  // A waveform over a baseline.
  signal: (c) =>
    `<path d="M40 ${C} H472" stroke="${c.ink}" stroke-opacity=".3" stroke-width="2"/>
     <polyline points="${Array.from({ length: 60 }, (_, i) => `${40 + i * 7.3},${C - Math.sin(i * 0.45) * (30 + 110 * Math.exp(-((i - 30) ** 2) / 120))}`).join(' ')}" fill="none" stroke="${c.accent}" stroke-width="4"/>
     ${[100, 412].map((x) => `<path d="M${x} ${C - 150} V${C + 150}" stroke="${c.ink}" stroke-opacity=".25" stroke-width="2" stroke-dasharray="6 8"/>`).join('')}`,
  // A monolith with a seam of light.
  monolith: (c) =>
    `<path d="M80 420 H432" stroke="${c.ink}" stroke-opacity=".4" stroke-width="2"/><rect x="${C - 60}" y="90" width="120" height="330" fill="${c.bg}" stroke="${c.ink}" stroke-width="4"/>
     <path d="M${C} 110 V400" stroke="${c.accent}" stroke-width="4"/><circle cx="${C}" cy="150" r="10" fill="${c.accent}"/>`,
  // A node graph: a block, and what it touches.
  graph: (c) => {
    const nodes = Array.from({ length: 9 }, () => [C + rnd(-170, 170), C + rnd(-170, 170)] as const)
    return `${nodes.map(([x, y]) => `<path d="M${C} ${C} L${x} ${y}" stroke="${c.ink}" stroke-opacity=".35" stroke-width="2"/>`).join('')}
      ${nodes.map(([x, y], i) => (i % 3 === 0 ? `<rect x="${x - 10}" y="${y - 10}" width="20" height="20" fill="${c.ink}"/>` : `<circle cx="${x}" cy="${y}" r="8" fill="${c.ink}"/>`)).join('')}
      <rect x="${C - 30}" y="${C - 30}" width="60" height="60" fill="${c.accent}"/>`
  },
  // A compass rose / survey mark.
  survey: (c) =>
    `<circle cx="${C}" cy="${C}" r="170" fill="none" stroke="${c.ink}" stroke-opacity=".45" stroke-width="2"/>
     ${Array.from({ length: 36 }, (_, i) => `<path d="M${C + 160 * Math.cos((i * Math.PI) / 18)} ${C + 160 * Math.sin((i * Math.PI) / 18)} L${C + (i % 9 === 0 ? 135 : 150) * Math.cos((i * Math.PI) / 18)} ${C + (i % 9 === 0 ? 135 : 150) * Math.sin((i * Math.PI) / 18)}" stroke="${c.ink}" stroke-width="2"/>`).join('')}
     <polygon points="${C},${C - 130} ${C + 22},${C} ${C},${C + 130} ${C - 22},${C}" fill="${c.accent}"/><polygon points="${C - 130},${C} ${C},${C - 16} ${C + 130},${C} ${C},${C + 16}" fill="${c.ink}" opacity=".7"/>`,
  // A layered stack (blocks).
  strata: (c) =>
    `${Array.from({ length: 6 }, (_, i) => {
      const y = 340 - i * 44
      return `<path d="M${C} ${y - 40} L${C + 150} ${y} L${C} ${y + 40} L${C - 150} ${y} Z" fill="${i === 5 ? c.accent : c.bg}" stroke="${c.ink}" stroke-opacity="${i === 5 ? 1 : 0.6}" stroke-width="3"/>`
    }).join('')}`,
}
const ICON_NAMES = Object.keys(ICONS)

/** A CRT terminal readout: phosphor glow, scanlines, a header, our pixel M and a few log lines. */
export function crt(name: string, serial: string, lines: string[]): Buffer {
  const tint = pick([
    { fg: '#5BFF8A', bg: '#021208', glow: '#1EFF5A' },
    { fg: '#FFB547', bg: '#140B02', glow: '#FF9A1E' },
    { fg: '#B6FFEE', bg: '#02120F', glow: '#5EF2D2' },
    { fg: '#9CC8FF', bg: '#030A16', glow: '#4F9BFF' },
  ])
  const role = name.replace(/^mesa\.cx\s*/i, '').toUpperCase()
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const m = 'M240 0 L422 0 L533 259 L382 259 L253 560 L0 560 Z M644 0 L826 0 L937 259 L786 259 L657 560 L404 560 Z M937 259 L1066 560 L808 560 Z'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <defs>
      <radialGradient id="v" cx="0.5" cy="0.5" r="0.72"><stop offset="0.6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".75"/></radialGradient>
      <filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="1.8" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      <pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="1.5" fill="#000" opacity=".26"/></pattern>
    </defs>
    <rect width="512" height="512" fill="${tint.bg}"/>
    <g filter="url(#glow)" fill="${tint.fg}" font-family="DejaVu Sans Mono" >
      <text x="256" y="70" text-anchor="middle" font-size="40" font-weight="700" letter-spacing="4">MESA.CX</text>
      <rect x="176" y="92" width="160" height="40" fill="none" stroke="${tint.fg}" stroke-width="3"/>
      <text x="256" y="121" text-anchor="middle" font-size="24" font-weight="700" letter-spacing="3">${esc(serial).slice(0, 10)}</text>
      <g transform="translate(148 156) scale(0.2026)"><path d="${m}"/></g>
      <text x="256" y="314" text-anchor="middle" font-size="22" font-weight="700" letter-spacing="2">${esc(role).slice(0, 26)}</text>
      ${lines.map((l, i) => `<text x="40" y="${360 + i * 30}" font-size="17" opacity=".85">${esc(l).slice(0, 40)}</text>`).join('')}
      <rect x="${40 + Math.min(40, (lines.at(-1) ?? '').length) * 10.3}" y="${360 + (lines.length - 1) * 30 - 15}" width="11" height="19"/>
    </g>
    <rect width="512" height="512" fill="url(#scan)"/>
    <rect width="512" height="512" fill="url(#v)"/>
  </svg>`
  return render(svg)
}

const hex = (t: string) => [...t].map((ch) => ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))

/** A cryptic CRT screen: a hex grid with a hidden word lit, a cipher line, or a riddle about the chain. */
export function puzzle(name: string, serial: string, block: number): Buffer {
  const tint = pick([
    { fg: '#5BFF8A', dim: '#1D6B35', bg: '#020D06' },
    { fg: '#FFB547', dim: '#6B4A1A', bg: '#0F0802' },
    { fg: '#B6FFEE', dim: '#2E6B5F', bg: '#020E0C' },
    { fg: '#FF5F45', dim: '#6B241A', bg: '#100403' },
    { fg: '#E8ECEF', dim: '#4A5058', bg: '#060708' },
  ])
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const role = name.replace(/^mesa\.cx\s*/i, '').toUpperCase().slice(0, 26)
  const words = ['MESA', 'BUILD', 'SHIP', 'ELYSIUM', 'SIGNAL', 'GENESIS', 'BLOCK', 'LATTICE', 'ORIGIN', 'SUMMIT']
  const word = pick(words)
  let body = ''
  switch (Math.floor(Math.random() * 3)) {
    case 0: {
      // 8x8 hex grid; the hidden word's bytes run down the diagonal, lit.
      const bytes = hex(word)
      const cells: string[] = []
      for (let r = 0; r < 8; r++)
        for (let c = 0; c < 8; c++) {
          const lit = r === c && r < bytes.length
          const v = lit ? bytes[r]! : Math.floor(Math.random() * 256).toString(16).toUpperCase().padStart(2, '0')
          cells.push(`<text x="${92 + c * 47}" y="${150 + r * 34}" font-size="20" font-weight="${lit ? 700 : 400}" fill="${lit ? tint.fg : tint.dim}">${v}</text>`)
        }
      body = `${cells.join('')}<text x="256" y="440" text-anchor="middle" font-size="16" fill="${tint.fg}" letter-spacing="4">READ THE DIAGONAL</text>`
      break
    }
    case 1: {
      // A shift cipher of a phrase, with the key hidden in the serial.
      const shift = (Number(serial.replace(/\D/g, '').slice(-1)) || 7) % 26 || 7
      const phrase = pick(['BUILD ON ELYSIUM', 'THE SUMMIT IS EARNED', 'EVERY LAUNCH BURNS', 'SHIP OR BE FORGOTTEN', 'WATCH THE BLOCKS'])
      const enc = phrase.replace(/[A-Z]/g, (ch) => String.fromCharCode(((ch.charCodeAt(0) - 65 + shift) % 26) + 65))
      body = `<text x="256" y="200" text-anchor="middle" font-size="30" font-weight="700" fill="${tint.fg}" letter-spacing="3">${esc(enc)}</text>
        <path d="M80 236 H432" stroke="${tint.dim}" stroke-width="2"/>
        <text x="256" y="280" text-anchor="middle" font-size="18" fill="${tint.dim}" letter-spacing="3">KEY: THE LAST DIGIT</text>
        <text x="256" y="318" text-anchor="middle" font-size="18" fill="${tint.dim}" letter-spacing="3">${esc(hex('MESA.CX').join(' '))}</text>
        <text x="256" y="440" text-anchor="middle" font-size="16" fill="${tint.fg}" letter-spacing="4">ROT-?</text>`
      break
    }
    default: {
      // A riddle whose answer is on chain.
      const riddles = [
        ['THE FIRST BURN', 'LEFT A MARK.', 'FIND ITS BLOCK.'],
        ['COUNT THE PADS', 'THAT FEED THE SUMMIT.', 'ONE IS HOME.'],
        [`BLOCK ${block.toLocaleString('en-US')}`, 'WAS NOT EMPTY.', 'WHO WAS THERE?'],
        ['NINE DIGITS OF EIGHT', 'WAIT FOR THE PATIENT.', 'NOV 18.'],
        ['A BRIDGE, A TOLL,', 'ZERO PAID.', 'WHERE DOES IT LEAD?'],
      ]
      const r = pick(riddles)
      body = `<text x="60" y="170" font-size="15" fill="${tint.dim}" letter-spacing="2">┌${'─'.repeat(30)}┐</text>
        ${r.map((l, i) => `<text x="256" y="${220 + i * 46}" text-anchor="middle" font-size="26" font-weight="700" fill="${tint.fg}" letter-spacing="2">${esc(l)}</text>`).join('')}
        <text x="60" y="380" font-size="15" fill="${tint.dim}" letter-spacing="2">└${'─'.repeat(30)}┘</text>
        <text x="256" y="440" text-anchor="middle" font-size="16" fill="${tint.fg}" letter-spacing="4">ANSWER ON CHAIN</text>`
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <defs>
      <radialGradient id="v" cx="0.5" cy="0.5" r="0.75"><stop offset="0.62" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".7"/></radialGradient>
      <filter id="glow" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="1.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      <pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="1.5" fill="#000" opacity=".22"/></pattern>
    </defs>
    <rect width="512" height="512" fill="${tint.bg}"/>
    <g filter="url(#glow)" font-family="DejaVu Sans Mono">
      <text x="40" y="62" font-size="18" font-weight="700" fill="${tint.fg}" letter-spacing="3">MESA.CX</text>
      <text x="472" y="62" text-anchor="end" font-size="18" fill="${tint.fg}" letter-spacing="2">${esc(serial).slice(0, 12)}</text>
      <path d="M40 80 H472" stroke="${tint.dim}" stroke-width="2"/>
      <text x="40" y="104" font-size="13" fill="${tint.dim}" letter-spacing="3">${esc(role)}</text>
      ${body}
      <path d="M40 462 H472" stroke="${tint.dim}" stroke-width="2"/>
      <text x="40" y="486" font-size="13" fill="${tint.dim}" letter-spacing="3">BLK ${block.toLocaleString('en-US')}</text>
    </g>
    <rect width="512" height="512" fill="url(#scan)"/><rect width="512" height="512" fill="url(#v)"/>
  </svg>`
  return render(svg)
}

export function logo(serial: string): Buffer {
  const c = pick(PALETTES)
  const icon = ICONS[pick(ICON_NAMES)]!
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <rect width="512" height="512" fill="${c.bg}"/>${field(c)}
    <g transform="translate(256 236) scale(0.86) translate(-256 -256)">${icon(c)}</g>
    <text x="256" y="474" text-anchor="middle" font-family="DejaVu Sans Mono" font-size="22" fill="${c.ink}" fill-opacity=".75" letter-spacing="6">${serial}</text>
  </svg>`
  return render(svg)
}

// ---------------------------------------------------------------- names

const ROLES = ['worker', 'crawler', 'scout', 'relay', 'surveyor', 'cartographer', 'indexer', 'sentinel', 'archivist', 'sounder'] as const
const ADJ = ['obsidian', 'hollow', 'silent', 'umbral', 'null', 'vesper', 'ashen', 'liminal', 'latent', 'argent', 'sable', 'cinder', 'distant', 'quiet', 'tidal', 'lunar', 'feral', 'glass', 'iron', 'pale']
const NOUN = ['cartographer', 'warden', 'lantern', 'oracle', 'cipher', 'archivist', 'augur', 'scribe', 'lamplighter', 'ferryman', 'monolith', 'glyph', 'sounder', 'surveyor', 'witness', 'heron', 'meridian', 'lattice', 'vigil', 'ember']
const GREEK = ['alpha', 'beta', 'gamma', 'delta', 'theta', 'lambda', 'sigma', 'omega', 'kappa', 'zeta']

/** A name and ticker: half plain ("mesa.cx crawler 9373895"), half cryptic. */
export function naming(): { name: string; ticker: string; serial: string } {
  const serial = String(Math.floor(1_000_000 + Math.random() * 9_000_000))
  const short = serial.slice(-4)
  switch (Math.floor(Math.random() * 6)) {
    case 0:
    case 1:
    case 2: {
      const role = pick(ROLES)
      return { name: `mesa.cx ${role} ${serial}`, ticker: `${role.slice(0, 4).toUpperCase()}${short}`, serial }
    }
    case 3: {
      const a = pick(ADJ)
      const n = pick(NOUN)
      return { name: `mesa.cx ${a} ${n} ${short}`, ticker: `${a.slice(0, 2)}${n.slice(0, 2)}${short}`.toUpperCase(), serial: short }
    }
    case 4: {
      const g = pick(GREEK)
      const n = pick(NOUN)
      const k = Math.floor(rnd(2, 99))
      return { name: `mesa.cx ${g}-${k} ${n}`, ticker: `${g.slice(0, 3)}${k}`.toUpperCase(), serial: `${g.toUpperCase()}-${k}` }
    }
    default: {
      const hex = Math.floor(Math.random() * 0xfffff).toString(16).toUpperCase().padStart(5, '0')
      const n = pick(NOUN)
      return { name: `mesa.cx ${n} 0x${hex}`, ticker: `X${hex}`, serial: `0x${hex}` }
    }
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

async function makeWorker() {
  let { name, ticker, serial } = naming()
  let symbol = ticker.replace(/[^A-Z0-9]/g, '').slice(0, 10)
  try {
    await mesa.resolve(symbol)
    const n = naming() // taken: try another
    name = n.name
    serial = n.serial
    symbol = n.ticker.replace(/[^A-Z0-9]/g, '').slice(0, 10)
  } catch {
    // free
  }
  const kind = ROLES.find((r) => name.includes(` ${r} `)) ?? 'worker'
  const m = await mission()
  const head = await get<{ head: number }>('/stats').then((x) => x.head).catch(() => 0)
  const lines = [`> ${m.mission}`.toUpperCase(), `BLOCK ${fmt(head)} // ELYSIUM`, '> REPORTING']
  // Mostly technical line art and CRT screens (some cryptic), now and then the Mesa bot itself.
  const roll = Math.random()
  const png =
    roll < 0.2
      ? crt(name, serial, lines)
      : roll < 0.35
        ? puzzle(name, serial, head)
        : roll < 0.6
          ? crtScreen({ serial, block: head, header: 'MESA.CX', footer: `BLK ${fmt(head)}` }).png
          : roll < 0.68
            ? botLogo({ prop: pick(['radar', 'server', 'compass', 'telescope', 'map', 'magnifier', 'dish', 'database', 'terminal']) })
            : logo(serial)
  const image = (await upload(png)) ?? (await upload(png)) // one retry
  if (!image) return log(`Skipped ${name}: its icon didn't upload`)
  const w: Worker = { name, symbol, kind, mission: m.mission, report: m.report, image, token: null, tx: null, at: now() }
  if (config.dryRun) {
    workers().unshift(w)
    save()
    return log(`Dry run: would launch ${name} ($${symbol})`)
  }
  const res = await mesa.launch(await shitify({
    name,
    symbol,
    description: `Mission: ${m.mission}. Report: ${m.report} A Mesa Lab worker token, mapping Elysium from mesa.cx.`.slice(0, 300),
    image: image ?? undefined,
    website: 'https://mesa.cx/lab',
    feePct: config.newsFeePct,
    sniperPct: 10,
    snipeSeconds: 60,
  }))
  w.token = res.token
  w.tx = res.hash
  workers().unshift(w)
  state.workers = workers().slice(0, 2000)
  save()
  log(res.status === 'success' && res.token ? `Launched ${name} ($${symbol}): ${m.mission}` : `Launch of ${name} ${res.status}`)
}

async function maybeClaim() {
  if (config.dryRun || now() - (state.workerLastClaimAt ?? 0) < 86_400) return
  const { claimableHype } = await mesa.claimable()
  if (Number(claimableHype) < config.claimAt) return
  const r = await mesa.claim()
  state.workerLastClaimAt = now()
  if (r.status === 'success') {
    state.workerClaimedHype = (state.workerClaimedHype ?? 0) + Number(r.claimedHype)
    log(`Claimed ${Number(r.claimedHype).toFixed(4)} HYPE in trading fees`)
  }
  save()
}

let running = false
async function tick() {
  if (running) return
  running = true
  try {
    if (!config.workersEnabled) return void (workerPhase = 'off')
    await maybeClaim().catch((e) => console.error('worker claim', e))
    const today = workers().filter((c) => c.at > now() - 86_400 && c.token).length
    if (today >= config.workersMaxPerDay) return void (workerPhase = 'full')
    const gap = Math.floor(86_400 / config.workersMaxPerDay)
    if (now() - (workers()[0]?.at ?? 0) < gap) return void (workerPhase = 'waiting')
    if (!config.dryRun && Number((await mesa.balance()).HYPE) < config.minHype) return void (workerPhase = 'needs-funds')
    workerPhase = 'working'
    await makeWorker()
    workerPhase = 'waiting'
  } catch (e) {
    log(`Something went wrong: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`)
    workerPhase = 'waiting'
  } finally {
    running = false
  }
}

export function startWorkers() {
  void tick()
  setInterval(() => void tick(), 10_000)
}

export async function workerStatus() {
  const balance = await mesa
    .balance()
    .then((b) => Number(b.HYPE))
    .catch(() => null)
  return {
    address: workerAddress,
    balanceHype: balance,
    phase: workerPhase,
    enabled: config.workersEnabled,
    maxPerDay: config.workersMaxPerDay,
    launchedToday: workers().filter((c) => c.at > now() - 86_400 && c.token).length,
    launched: workers().filter((c) => c.token).length,
    claimedHype: state.workerClaimedHype ?? 0,
    workers: workers().slice(0, 200),
    log: (state.workerLog ?? []).slice(0, 30),
  }
}
