import { Resvg } from '@resvg/resvg-js'

/**
 * CRT screens, drawn in code: a monitor bezel and curved glass with
 * scanlines and phosphor glow, around one of 25 procedural designs (ASCII
 * fractals, cellular automata, oscilloscopes, hexdumps, boot logs, a wireframe
 * globe and more). Every screen is random, so no two coins look alike. Used by
 * the worker deployer and the CRT deployer.
 */
const FONTS = ['DejaVuSansMono.ttf', 'DejaVuSansMono-Bold.ttf'].map((f) => new URL(`../fonts/${f}`, import.meta.url).pathname)
const render = (svg: string) =>
  Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: 384 }, font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans Mono' } }).render().asPng())

const pick = <T>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)]!
const rnd = (a: number, b: number) => a + Math.random() * (b - a)
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export interface Tint {
  fg: string
  dim: string
  bg: string
}
export const TINTS: Tint[] = [
  { fg: '#5BFF8A', dim: '#1F7A3C', bg: '#020D06' }, // green phosphor
  { fg: '#FFB547', dim: '#7A5218', bg: '#0F0802' }, // amber
  { fg: '#B6FFEE', dim: '#2E7A6A', bg: '#020E0C' }, // mesa mint
  { fg: '#9CC8FF', dim: '#2D4F7A', bg: '#030A16' }, // cold blue
  { fg: '#FF5F45', dim: '#7A2A1E', bg: '#100403' }, // alarm red
  { fg: '#E8ECEF', dim: '#59606A', bg: '#060708' }, // white phosphor
  { fg: '#D59BFF', dim: '#5E3A7A', bg: '#0A0410' }, // violet
]

/** The screen area (inside the bezel) the designs draw into. */
export const SX = 46
export const SY = 46
export const SW = 420
export const SH = 420

/** Monospace text block: one <text> per row, spaces kept. */
function rows(lines: string[], x: number, y: number, size: number, fill: string, lh = size * 1.18, weight = 400) {
  return lines
    .map((l, i) => `<text x="${x}" y="${y + i * lh}" font-size="${size}" font-weight="${weight}" fill="${fill}" xml:space="preserve">${esc(l)}</text>`)
    .join('')
}

const RAMP = ' .:-=+*#%@'

// ---------------------------------------------------------------- the 25 designs
// Each returns SVG drawn inside the screen box, and a short caption.

type Design = (t: Tint, ctx: { serial: string; block: number }) => { svg: string; caption: string }

const mandelbrot: Design = (t) => {
  // The classic whole set most of the time, now and then a zoom on its edge.
  const [cx, cy, z] = pick([
    [-0.6, 0, 1.25],
    [-0.6, 0, 1.25],
    [-0.6, 0, 1.25],
    [-0.75, 0.1, 0.45],
    [-1.25, 0.05, 0.3],
  ] as const)
  const W = 56,
    H = 30
  const out: string[] = []
  for (let j = 0; j < H; j++) {
    let line = ''
    for (let i = 0; i < W; i++) {
      let x = 0,
        y = 0,
        k = 0
      const a = cx + ((i - W / 2) / W) * 3 * z,
        b = cy + ((j - H / 2) / H) * 2 * z
      while (x * x + y * y < 4 && k < 40) {
        ;[x, y] = [x * x - y * y + a, 2 * x * y + b]
        k++
      }
      line += k >= 40 ? '@' : RAMP[Math.min(9, Math.floor(k / 4))]
    }
    out.push(line)
  }
  return { svg: rows(out, SX + 18, SY + 34, 12.2, t.fg), caption: 'Mandelbrot' }
}

const julia: Design = (t) => {
  const [cr, ci] = pick([
    [-0.8, 0.156],
    [0.285, 0.01],
    [-0.4, 0.6],
    [-0.70176, -0.3842],
  ] as const)
  const W = 56,
    H = 30
  const out: string[] = []
  for (let j = 0; j < H; j++) {
    let line = ''
    for (let i = 0; i < W; i++) {
      let x = ((i - W / 2) / W) * 3.2,
        y = ((j - H / 2) / H) * 2,
        k = 0
      while (x * x + y * y < 4 && k < 36) {
        ;[x, y] = [x * x - y * y + cr, 2 * x * y + ci]
        k++
      }
      line += RAMP[Math.min(9, Math.floor(k / 3.6))]
    }
    out.push(line)
  }
  return { svg: rows(out, SX + 18, SY + 34, 12.2, t.fg), caption: 'Julia set' }
}

const automaton = (rule: number, name: string): Design => (t) => {
  const W = 58,
    H = 30
  let cells: number[] = Array.from({ length: W }, (_, i) => (i === Math.floor(W / 2) ? 1 : 0))
  const out: string[] = []
  for (let r = 0; r < H; r++) {
    out.push(cells.map((c) => (c ? '█' : ' ')).join(''))
    cells = cells.map((_, i) => {
      const l = cells[(i - 1 + W) % W]!,
        c = cells[i]!,
        rr = cells[(i + 1) % W]!
      return (rule >> ((l << 2) | (c << 1) | rr)) & 1
    })
  }
  return { svg: rows(out, SX + 14, SY + 30, 12, t.fg, 13.2), caption: name }
}

const life: Design = (t) => {
  const W = 40,
    H = 26
  let g = Array.from({ length: H }, () => Array.from({ length: W }, () => (Math.random() < 0.32 ? 1 : 0)))
  for (let s = 0; s < 6; s++)
    g = g.map((row, y) =>
      row.map((c, x) => {
        let n = 0
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) n += g[(y + dy + H) % H]![(x + dx + W) % W]!
        return n === 3 || (c && n === 2) ? 1 : 0
      }),
    )
  const cell = 9.6
  const sq = g.flatMap((row, y) => row.map((c, x) => (c ? `<rect x="${SX + 18 + x * cell}" y="${SY + 40 + y * cell * 1.3}" width="${cell - 2}" height="${cell * 1.3 - 2}" fill="${t.fg}"/>` : ''))).join('')
  return { svg: sq + rows(['GEN 006 // CONWAY'], SX + 18, SY + 395, 12, t.dim), caption: 'Game of Life' }
}

const rain: Design = (t) => {
  const glyphs = '0123456789ABCDEF$#@%&*+=<>/\\|'
  const cols = 30
  let svg = ''
  for (let c = 0; c < cols; c++) {
    const head = Math.floor(rnd(4, 28)),
      len = Math.floor(rnd(5, 16))
    for (let r = Math.max(0, head - len); r < head; r++) {
      const a = (r - (head - len)) / len
      svg += `<text x="${SX + 16 + c * 13.2}" y="${SY + 26 + r * 14}" font-size="13" fill="${r === head - 1 ? '#ffffff' : t.fg}" fill-opacity="${(0.25 + a * 0.75).toFixed(2)}">${esc(pick([...glyphs]))}</text>`
    }
  }
  return { svg, caption: 'Rain' }
}

const lissajous: Design = (t) => {
  const a = Math.floor(rnd(1, 6)),
    b = Math.floor(rnd(1, 6)),
    d = rnd(0, Math.PI)
  const pts = Array.from({ length: 600 }, (_, i) => {
    const s = (i / 600) * Math.PI * 2
    return `${(256 + 160 * Math.sin(a * s + d)).toFixed(1)},${(250 + 150 * Math.sin(b * s)).toFixed(1)}`
  }).join(' ')
  const grid = Array.from({ length: 9 }, (_, i) => `<path d="M${SX + 10 + i * 50} ${SY + 10} V${SY + SH - 40} M${SX + 10} ${SY + 10 + i * 46} H${SX + SW - 10}" stroke="${t.dim}" stroke-opacity=".5" stroke-width="1"/>`).join('')
  return { svg: `${grid}<polyline points="${pts}" fill="none" stroke="${t.fg}" stroke-width="2.4"/>${rows([`X:Y ${a}:${b}  PHASE ${d.toFixed(2)}`], SX + 18, SY + 395, 12, t.dim)}`, caption: 'Oscilloscope' }
}

const spectrum: Design = (t) => {
  const n = 28
  const bars = Array.from({ length: n }, (_, i) => {
    const h = Math.max(6, 300 * Math.abs(Math.sin(i * 0.5 + rnd(0, 1))) * Math.exp(-i / 22) + rnd(0, 40))
    const x = SX + 22 + i * 13.6
    return Array.from({ length: Math.floor(h / 10) }, (_, k) => `<rect x="${x}" y="${SY + 360 - k * 10}" width="10" height="7" fill="${k > 22 ? '#ffffff' : t.fg}" fill-opacity="${(0.5 + (k / 30) * 0.5).toFixed(2)}"/>`).join('')
  }).join('')
  return { svg: bars + rows(['20Hz          1kHz           20kHz'], SX + 22, SY + 395, 11, t.dim), caption: 'Spectrum' }
}

const hexdump: Design = (t, { serial }) => {
  const seed = [...`mesa.cx ${serial} elysium`].map((c) => c.charCodeAt(0))
  const out: string[] = []
  for (let r = 0; r < 24; r++) {
    const bytes = Array.from({ length: 8 }, (_, k) => (r < 3 && k + r * 8 < seed.length ? seed[k + r * 8]! : Math.floor(Math.random() * 256)))
    out.push(`${(r * 8).toString(16).padStart(6, '0')}  ${bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')}  ${bytes.map((b) => (b > 31 && b < 127 ? String.fromCharCode(b) : '.')).join('')}`)
  }
  return { svg: rows(out, SX + 20, SY + 36, 13, t.fg, 15.2), caption: 'Hexdump' }
}

const boot: Design = (t, { block, serial }) => {
  const lines = [
    'MESA BIOS v0.9.9  (C) MESA.CX',
    '',
    'CPU: ELYSIUM-L2  CHAIN 99901 ... OK',
    'MEM: 640K SHOULD BE ENOUGH ..... OK',
    'RPC  rpc.mesa.cx ............... OK',
    `SYNC BLOCK ${block.toLocaleString('en-US')} ......... OK`,
    'LOAD launchpad.sys .............. OK',
    'LOAD burner.drv ................. OK',
    'LOAD lab/agents ................. OK',
    `UNIT ${serial.slice(0, 12)}`,
    '',
    'READY.',
    '> _',
  ]
  return { svg: rows(lines, SX + 20, SY + 40, 14, t.fg, 22), caption: 'Boot sequence' }
}

const landscape: Design = (t) => {
  // Dithered mesas under a rising sun.
  const W = 60,
    H = 30
  const sun = rnd(18, 42)
  const out: string[] = []
  for (let y = 0; y < H; y++) {
    let l = ''
    for (let x = 0; x < W; x++) {
      const d = Math.hypot((x - sun) / 2, y - 12)
      const ground = y > 18 + Math.round(2 * Math.sin(x / 6)) || (y > 10 && x > 8 && x < 22 && y > 12) || (y > 9 && x > 38 && x < 52)
      if (ground) l += y > 24 ? '▓' : '▒'
      else if (d < 5) l += '█'
      else if (d < 7) l += (x + y) % 2 ? '▓' : ' '
      else if (y < 12 && Math.random() < 0.02) l += '.'
      else l += ' '
    }
    out.push(l)
  }
  return { svg: rows(out, SX + 14, SY + 32, 11.6, t.fg, 13.2), caption: 'Mesas at dawn' }
}

const starfield: Design = (t) => {
  let svg = ''
  for (let i = 0; i < 90; i++) {
    const a = rnd(0, Math.PI * 2),
      r1 = rnd(10, 200),
      r2 = r1 + rnd(8, 40)
    svg += `<path d="M${256 + r1 * Math.cos(a)} ${250 + r1 * Math.sin(a)} L${256 + r2 * Math.cos(a)} ${250 + r2 * Math.sin(a)}" stroke="${t.fg}" stroke-opacity="${(r1 / 200).toFixed(2)}" stroke-width="${(1 + r1 / 120).toFixed(1)}"/>`
  }
  return { svg: svg + rows(['WARP 9.2 // HEADING 099.901'], SX + 18, SY + 395, 12, t.dim), caption: 'Warp' }
}

const globe: Design = (t) => {
  const R = 150
  const lat = Array.from({ length: 7 }, (_, i) => {
    const y = -R + (i + 1) * (2 * R) / 8
    const rx = Math.sqrt(R * R - y * y)
    return `<ellipse cx="256" cy="${246 + y}" rx="${rx}" ry="${rx * 0.12}" fill="none" stroke="${t.fg}" stroke-opacity=".7" stroke-width="1.6"/>`
  }).join('')
  const rot = rnd(0, 30)
  const lon = Array.from({ length: 6 }, (_, i) => `<ellipse cx="256" cy="246" rx="${Math.abs(R * Math.cos(((i * 30 + rot) * Math.PI) / 180))}" ry="${R}" fill="none" stroke="${t.fg}" stroke-opacity=".7" stroke-width="1.6"/>`).join('')
  const ping = `<circle cx="${256 + rnd(-90, 90)}" cy="${246 + rnd(-80, 80)}" r="6" fill="#ffffff"/>`
  return { svg: `<circle cx="256" cy="246" r="${R}" fill="none" stroke="${t.fg}" stroke-width="2.4"/>${lat}${lon}${ping}${rows(['NODE LOCATED'], SX + 18, SY + 395, 12, t.dim)}`, caption: 'Globe' }
}

const helix: Design = (t) => {
  const out: string[] = []
  for (let y = 0; y < 30; y++) {
    const p = y * 0.45
    const a = Math.round(28 + 18 * Math.sin(p)),
      b = Math.round(28 + 18 * Math.sin(p + Math.PI))
    const row = Array(58).fill(' ')
    const [l, r] = a < b ? [a, b] : [b, a]
    if (y % 2 === 0) for (let x = l + 1; x < r; x++) row[x] = '-'
    row[a] = 'O'
    row[b] = 'o'
    out.push(row.join(''))
  }
  return { svg: rows(out, SX + 16, SY + 30, 12, t.fg, 13), caption: 'Helix' }
}

const maze: Design = (t) => {
  const W = 13,
    H = 13
  const seen = Array.from({ length: H }, () => Array(W).fill(false))
  const walls: string[] = []
  const grid = Array.from({ length: H * 2 + 1 }, () => Array(W * 2 + 1).fill('█'))
  const stack: [number, number][] = [[0, 0]]
  seen[0]![0] = true
  grid[1]![1] = ' '
  while (stack.length) {
    const [x, y] = stack.at(-1)!
    const n = (
      [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const
    ).filter(([dx, dy]) => x + dx >= 0 && x + dx < W && y + dy >= 0 && y + dy < H && !seen[y + dy]![x + dx])
    if (!n.length) {
      stack.pop()
      continue
    }
    const [dx, dy] = pick(n)
    seen[y + dy]![x + dx] = true
    grid[y * 2 + 1 + dy]![x * 2 + 1 + dx] = ' '
    grid[(y + dy) * 2 + 1]![(x + dx) * 2 + 1] = ' '
    stack.push([x + dx, y + dy])
  }
  grid[1]![0] = '>'
  grid[H * 2 - 1]![W * 2] = '*'
  void walls
  const lines = grid.map((r) => r.map((c) => c + c).join(''))
  return { svg: rows(lines, SX + 30, SY + 30, 12.8, t.fg, 13.6), caption: 'Labyrinth' }
}

const spiral: Design = (t) => {
  const out: string[][] = Array.from({ length: 30 }, () => Array(58).fill(' '))
  const turns = rnd(4, 7)
  for (let s = 0; s < 2400; s++) {
    const a = (s / 2400) * Math.PI * 2 * turns
    const r = (s / 2400) * 14
    const x = Math.round(29 + r * 2 * Math.cos(a)),
      y = Math.round(15 + r * Math.sin(a))
    if (out[y]?.[x] !== undefined) out[y]![x] = RAMP[Math.min(9, 2 + Math.floor((s / 2400) * 8))]!
  }
  return { svg: rows(out.map((r) => r.join('')), SX + 16, SY + 30, 12, t.fg, 13), caption: 'Spiral' }
}

const tunnel: Design = (t) => {
  const n = 12
  const skew = rnd(-20, 20)
  const sq = Array.from({ length: n }, (_, i) => {
    const s = 190 * Math.pow(0.78, i)
    return `<rect x="${256 - s + skew * (1 - s / 190)}" y="${246 - s * 0.9}" width="${s * 2}" height="${s * 1.8}" fill="none" stroke="${t.fg}" stroke-opacity="${(1 - i / n).toFixed(2)}" stroke-width="2"/>`
  }).join('')
  const lines = [
    [66, 75],
    [446, 75],
    [66, 417],
    [446, 417],
  ]
    .map(([x, y]) => `<path d="M${x} ${y} L${256 + skew} 246" stroke="${t.fg}" stroke-opacity=".35" stroke-width="1.5"/>`)
    .join('')
  return { svg: lines + sq, caption: 'Tunnel' }
}

const plasma: Design = (t) => {
  const k = rnd(0.12, 0.3),
    ph = rnd(0, 6)
  const out: string[] = []
  for (let y = 0; y < 30; y++) {
    let l = ''
    for (let x = 0; x < 58; x++) {
      const v = Math.sin(x * k + ph) + Math.sin(y * k * 1.7) + Math.sin((x + y) * k * 0.7) + Math.sin(Math.hypot(x - 29, y * 2 - 30) * k)
      l += RAMP[Math.max(0, Math.min(9, Math.floor(((v + 4) / 8) * 10)))]
    }
    out.push(l)
  }
  return { svg: rows(out, SX + 16, SY + 30, 12, t.fg, 13), caption: 'Plasma' }
}

const monitor: Design = (t, { block }) => {
  const bar = (label: string, v: number) => `${label.padEnd(8)}[${'|'.repeat(Math.round(v * 24)).padEnd(24, '.')}] ${String(Math.round(v * 100)).padStart(3)}%`
  const lines = [
    'MESA.CX  SYSTEM MONITOR',
    '',
    bar('CPU', rnd(0.2, 0.95)),
    bar('MEM', rnd(0.2, 0.95)),
    bar('RPC', rnd(0.5, 1)),
    bar('BURN', rnd(0.1, 0.9)),
    bar('LAB', rnd(0.3, 1)),
    '',
    `BLOCK   ${block.toLocaleString('en-US')}`,
    `PEERS   ${Math.floor(rnd(8, 64))}`,
    `UPTIME  ${Math.floor(rnd(1, 99))}d ${Math.floor(rnd(0, 23))}h`,
    '',
    'ALL SYSTEMS NOMINAL',
  ]
  return { svg: rows(lines, SX + 20, SY + 40, 13.5, t.fg, 23), caption: 'System monitor' }
}

const morse: Design = (t) => {
  const code: Record<string, string> = { M: '--', E: '.', S: '...', A: '.-', '.': '.-.-.-', C: '-.-.', X: '-..-', B: '-...', U: '..-', I: '..', L: '.-..', D: '-..', Y: '-.--', O: '---', N: '-.' }
  const word = pick(['MESA.CX', 'BUILD', 'ELYSIUM', 'SIGNAL', 'MESA'])
  let x = SX + 26,
    y = 160
  let svg = ''
  for (const ch of word) {
    for (const s of code[ch] ?? '') {
      const w = s === '-' ? 30 : 10
      if (x + w > SX + SW - 26) {
        x = SX + 26
        y += 40
      }
      svg += `<rect x="${x}" y="${y}" width="${w}" height="10" rx="3" fill="${t.fg}"/>`
      x += w + 8
    }
    x += 22
  }
  return { svg: svg + rows(['INCOMING TRANSMISSION', '', 'DECODE TO CONTINUE'], SX + 26, SY + 60, 14, t.fg, 20) + rows([`${word.length} CHARS`], SX + 26, SY + 395, 12, t.dim), caption: 'Morse' }
}

const binary: Design = (t) => {
  const out = Array.from({ length: 26 }, () => Array.from({ length: 40 }, () => (Math.random() < 0.5 ? '0' : '1')).join(''))
  const hi = Math.floor(rnd(4, 20))
  return { svg: rows(out, SX + 30, SY + 32, 14, t.dim, 14.6) + rows([out[hi]!], SX + 30, SY + 32 + hi * 14.6, 14, t.fg, 14.6, 700), caption: 'Binary' }
}

const radar: Design = (t) => {
  const a = rnd(0, Math.PI * 2)
  const rings = [60, 110, 160].map((r) => `<circle cx="256" cy="246" r="${r}" fill="none" stroke="${t.fg}" stroke-opacity=".45" stroke-width="1.6"/>`).join('')
  const sweep = `<path d="M256 246 L${256 + 170 * Math.cos(a)} ${246 + 170 * Math.sin(a)} A170 170 0 0 0 ${256 + 170 * Math.cos(a - 0.7)} ${246 + 170 * Math.sin(a - 0.7)} Z" fill="${t.fg}" fill-opacity=".22"/><path d="M256 246 L${256 + 170 * Math.cos(a)} ${246 + 170 * Math.sin(a)}" stroke="${t.fg}" stroke-width="2.4"/>`
  const blips = Array.from({ length: 6 }, () => `<circle cx="${256 + rnd(-140, 140)}" cy="${246 + rnd(-140, 140)}" r="${rnd(3, 6)}" fill="#ffffff" fill-opacity=".85"/>`).join('')
  return { svg: `${rings}<path d="M86 246 H426 M256 76 V416" stroke="${t.fg}" stroke-opacity=".25"/>${sweep}${blips}`, caption: 'Radar' }
}

const BIG: Record<string, string[]> = {
  M: ['█   █', '██ ██', '█ █ █', '█   █', '█   █'],
  E: ['█████', '█    ', '████ ', '█    ', '█████'],
  S: [' ████', '█    ', ' ███ ', '    █', '████ '],
  A: [' ███ ', '█   █', '█████', '█   █', '█   █'],
}
const banner: Design = (t, { serial }) => {
  const word = 'MESA'
  const lines = Array.from({ length: 5 }, (_, r) => [...word].map((c) => BIG[c]![r]).join('  '))
  return { svg: rows(lines, SX + 34, SY + 150, 22, t.fg, 24, 700) + rows([`> UNIT ${serial}`, '> ONLINE'], SX + 34, SY + 330, 14, t.dim, 22), caption: 'Banner' }
}

const reticle: Design = (t) => {
  const lat = rnd(-60, 60).toFixed(4),
    lon = rnd(-170, 170).toFixed(4)
  const svg = `<circle cx="256" cy="236" r="110" fill="none" stroke="${t.fg}" stroke-width="2"/><circle cx="256" cy="236" r="12" fill="none" stroke="${t.fg}" stroke-width="2"/>
    <path d="M256 96 V196 M256 276 V376 M116 236 H216 M296 236 H396" stroke="${t.fg}" stroke-width="2"/>
    ${[0, 90, 180, 270].map((r) => `<path d="M256 110 l-8 -14 h16 z" fill="${t.fg}" transform="rotate(${r} 256 236)"/>`).join('')}`
  return { svg: svg + rows([`LAT ${lat}`, `LON ${lon}`, 'TARGET ACQUIRED'], SX + 22, SY + 360, 13, t.fg, 18), caption: 'Reticle' }
}

const barcode: Design = (t, { serial }) => {
  let x = SX + 50
  let svg = ''
  while (x < SX + SW - 50) {
    const w = pick([2, 3, 5, 8])
    if (Math.random() < 0.6) svg += `<rect x="${x}" y="${SY + 120}" width="${w}" height="150" fill="${t.fg}"/>`
    x += w + 2
  }
  return { svg: svg + rows(['EXPEDITION LOG'], SX + 50, SY + 80, 16, t.fg, 22, 700) + rows([`ITEM ${serial}`, 'ORIGIN  ELYSIUM', 'CARRIER MESA.CX'], SX + 50, SY + 310, 14, t.fg, 22), caption: 'Manifest' }
}

const sierpinski: Design = (t) => {
  const H = 32
  const out: string[] = []
  for (let y = 0; y < H; y++) {
    let l = ' '.repeat(H - y)
    for (let x = 0; x <= y; x++) l += (x & (y - x)) === 0 ? '▲ ' : '  '
    out.push(l.slice(0, 64))
  }
  return { svg: rows(out, SX + 8, SY + 28, 11, t.fg, 12.2), caption: 'Sierpinski' }
}

const waveform: Design = (t) => {
  const n = rnd(2, 6)
  const lines = Array.from({ length: 5 }, (_, k) => {
    const pts = Array.from({ length: 160 }, (_, i) => `${SX + 20 + i * 2.4},${120 + k * 62 + 22 * Math.sin(i * 0.08 * (k + 1) + n) * Math.sin(i * 0.02)}`).join(' ')
    return `<polyline points="${pts}" fill="none" stroke="${t.fg}" stroke-opacity="${(1 - k * 0.15).toFixed(2)}" stroke-width="2"/>`
  }).join('')
  return { svg: lines + rows(['CH1  CH2  CH3  CH4  CH5'], SX + 20, SY + 395, 12, t.dim), caption: 'Channels' }
}

const terrain: Design = (t) => {
  // Wireframe terrain in perspective.
  const rowsN = 14,
    colsN = 18
  const h = Array.from({ length: rowsN }, (_, r) => Array.from({ length: colsN }, (_, c) => 40 * Math.sin(c * 0.5 + rnd(0, 0.3)) * Math.cos(r * 0.4) + rnd(-8, 8)))
  const P = (r: number, c: number) => {
    const z = 1 + r * 0.22
    return [256 + ((c - colsN / 2) * 34) / z, 150 + 260 / z - h[r]![c]! / z] as const
  }
  let svg = ''
  for (let r = 0; r < rowsN; r++) svg += `<polyline points="${Array.from({ length: colsN }, (_, c) => P(r, c).join(',')).join(' ')}" fill="none" stroke="${t.fg}" stroke-opacity="${(1 - r / rowsN).toFixed(2)}" stroke-width="1.4"/>`
  for (let c = 0; c < colsN; c++) svg += `<polyline points="${Array.from({ length: rowsN }, (_, r) => P(r, c).join(',')).join(' ')}" fill="none" stroke="${t.fg}" stroke-opacity=".45" stroke-width="1.2"/>`
  return { svg, caption: 'Terrain' }
}

export const DESIGNS: Design[] = [
  mandelbrot,
  julia,
  automaton(30, 'Rule 30'),
  automaton(90, 'Rule 90'),
  life,
  rain,
  lissajous,
  spectrum,
  hexdump,
  boot,
  landscape,
  starfield,
  globe,
  helix,
  maze,
  spiral,
  tunnel,
  plasma,
  monitor,
  morse,
  binary,
  radar,
  banner,
  reticle,
  barcode,
  sierpinski,
  waveform,
  terrain,
]

/** A CRT monitor around a design. Optional header/footer text along the screen's edges. */
export function crtScreen(o: { serial: string; block: number; header?: string; footer?: string; design?: number; tint?: Tint }): { png: Buffer; caption: string } {
  const t = o.tint ?? pick(TINTS)
  const d = DESIGNS[o.design ?? Math.floor(Math.random() * DESIGNS.length)]!
  const { svg, caption } = d(t, { serial: o.serial, block: o.block })
  const bezel = pick(['#1A1A1A', '#2A2723', '#D8D2C4', '#3A3F44'])
  const head = o.header ? `<text x="${SX + 18}" y="${SY + 22}" font-size="11" fill="${t.dim}" letter-spacing="2">${esc(o.header).slice(0, 52)}</text>` : ''
  const foot = o.footer ? `<text x="${SX + SW - 18}" y="${SY + SH - 12}" text-anchor="end" font-size="11" fill="${t.dim}" letter-spacing="2">${esc(o.footer).slice(0, 52)}</text>` : ''
  const out = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <defs>
      <clipPath id="scr"><rect x="${SX}" y="${SY}" width="${SW}" height="${SH}" rx="38"/></clipPath>
      <radialGradient id="vig" cx="0.5" cy="0.5" r="0.72"><stop offset="0.6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".72"/></radialGradient>
      <linearGradient id="glare" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".09"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/></linearGradient>
      <filter id="glow" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="1.3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      <pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="1.5" fill="#000" opacity=".24"/></pattern>
    </defs>
    <rect width="512" height="512" fill="${bezel}"/>
    <rect x="${SX - 14}" y="${SY - 14}" width="${SW + 28}" height="${SH + 28}" rx="48" fill="#000" opacity=".55"/>
    <g clip-path="url(#scr)">
      <rect x="${SX}" y="${SY}" width="${SW}" height="${SH}" fill="${t.bg}"/>
      <g filter="url(#glow)" font-family="DejaVu Sans Mono">${svg}${head}${foot}</g>
      <rect x="${SX}" y="${SY}" width="${SW}" height="${SH}" fill="url(#scan)"/>
      <rect x="${SX}" y="${SY}" width="${SW}" height="${SH}" fill="url(#vig)"/>
      <rect x="${SX}" y="${SY}" width="${SW}" height="${SH}" fill="url(#glare)"/>
    </g>
    <circle cx="470" cy="490" r="4" fill="${t.fg}" opacity=".9"/>
  </svg>`
  return { png: render(out), caption }
}
