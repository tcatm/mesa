import { Resvg } from '@resvg/resvg-js'

/**
 * Detailed crawler bots, drawn in code: plated bodies, jointed legs,
 * sensor arrays and the Mesa mark, in several builds (spider, tank, quad,
 * centipede, drone, walker) and colourways. Every one is randomised.
 */
const FONTS = ['DejaVuSansMono.ttf', 'DejaVuSansMono-Bold.ttf'].map((f) => new URL(`../fonts/${f}`, import.meta.url).pathname)
const render = (svg: string) =>
  Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: 384 }, font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans Mono' } }).render().asPng())
const pick = <T>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)]!
const rnd = (a: number, b: number) => a + Math.random() * (b - a)

const MPATH = 'M240 0 L422 0 L533 259 L382 259 L253 560 L0 560 Z M644 0 L826 0 L937 259 L786 259 L657 560 L404 560 Z M937 259 L1066 560 L808 560 Z'
const mark = (x: number, y: number, w: number, fill: string) => `<g transform="translate(${x} ${y}) scale(${w / 1066})" fill="${fill}"><path d="${MPATH}"/></g>`

interface Kit {
  bg: string
  plate: string
  shade: string
  joint: string
  eye: string
  line: string
}
const KITS: Kit[] = [
  { bg: '#0B0D10', plate: '#C9CED3', shade: '#8A9097', joint: '#3A4048', eye: '#B6FFEE', line: '#1C2128' },
  { bg: '#0E0B08', plate: '#2B2B2B', shade: '#1A1A1A', joint: '#F5A524', eye: '#F5A524', line: '#2A2015' },
  { bg: '#071019', plate: '#DDE6EE', shade: '#9FB0C0', joint: '#2C3E50', eye: '#4FA3FF', line: '#12263A' },
  { bg: '#100605', plate: '#3A3A3D', shade: '#232326', joint: '#FF5F45', eye: '#FF5F45', line: '#2A1714' },
  { bg: '#0B140F', plate: '#B9C9BD', shade: '#7E9184', joint: '#24352A', eye: '#5BE37D', line: '#15281A' },
  { bg: '#ECE8DF', plate: '#1F2226', shade: '#3A3F45', joint: '#C2410C', eye: '#C2410C', line: '#D6D0C3' },
  { bg: '#0F0C16', plate: '#D9D1F0', shade: '#9C90C0', joint: '#2E2640', eye: '#B6FFEE', line: '#231C35' },
]

function backdrop(k: Kit) {
  return pick([
    () => Array.from({ length: 9 }, (_, i) => `<path d="M${i * 64} 0 V512 M0 ${i * 64} H512" stroke="${k.line}" stroke-width="1.5"/>`).join(''),
    () => Array.from({ length: 8 }, (_, i) => `<circle cx="256" cy="256" r="${40 + i * 34}" fill="none" stroke="${k.line}" stroke-width="1.5"/>`).join(''),
    () => `<path d="M0 400 H512" stroke="${k.line}" stroke-width="2"/>${Array.from({ length: 16 }, (_, i) => `<path d="M256 400 L${i * 34 - 16} 512" stroke="${k.line}" stroke-width="1.2"/>`).join('')}`,
  ])()
}

/** A jointed leg from (x,y), out in direction `side`, with a knee and a foot. */
function leg(k: Kit, x: number, y: number, side: number, reach: number, drop: number, w = 9) {
  const kx = x + side * reach * 0.55,
    ky = y - drop * 0.5
  const fx = x + side * reach,
    fy = y + drop
  return `<path d="M${x} ${y} L${kx} ${ky} L${fx} ${fy}" fill="none" stroke="${k.shade}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${kx}" cy="${ky}" r="${w * 0.75}" fill="${k.joint}"/><circle cx="${x}" cy="${y}" r="${w * 0.6}" fill="${k.joint}"/>
    <path d="M${fx - side * 4} ${fy} l${side * 10} 6" stroke="${k.plate}" stroke-width="${w * 0.6}" stroke-linecap="round"/>`
}

const eyes = (k: Kit, x: number, y: number, n: number, gap: number) =>
  Array.from({ length: n }, (_, i) => `<circle cx="${x + (i - (n - 1) / 2) * gap}" cy="${y}" r="7" fill="${k.eye}"/><circle cx="${x + (i - (n - 1) / 2) * gap}" cy="${y}" r="12" fill="${k.eye}" opacity=".18"/>`).join('')

const BUILDS: Record<string, (k: Kit) => string> = {
  spider: (k) => {
    const legs = [-1, 1].flatMap((sd) => [-48, -16, 16, 48].map((dy, i) => leg(k, 256 + sd * 60, 270 + dy, sd, rnd(130, 170), 40 + i * 18)))
    return `${legs.join('')}
      <ellipse cx="256" cy="300" rx="78" ry="96" fill="${k.shade}"/><ellipse cx="256" cy="292" rx="70" ry="86" fill="${k.plate}"/>
      ${[0, 1, 2].map((i) => `<path d="M${200 + i * 4} ${300 + i * 26} Q256 ${312 + i * 26} ${312 - i * 4} ${300 + i * 26}" fill="none" stroke="${k.shade}" stroke-width="4"/>`).join('')}
      <rect x="206" y="176" width="100" height="70" rx="22" fill="${k.plate}" stroke="${k.shade}" stroke-width="4"/>${eyes(k, 256, 208, 3, 26)}
      <path d="M232 176 l-18 -40 M280 176 l18 -40" stroke="${k.shade}" stroke-width="4"/><circle cx="214" cy="134" r="5" fill="${k.eye}"/><circle cx="298" cy="134" r="5" fill="${k.eye}"/>
      ${mark(226, 280, 60, k.joint)}`
  },
  tank: (k) => `
      <rect x="96" y="300" width="320" height="76" rx="38" fill="${k.joint}"/>${Array.from({ length: 8 }, (_, i) => `<circle cx="${134 + i * 35}" cy="338" r="14" fill="${k.shade}" stroke="${k.plate}" stroke-width="3"/>`).join('')}
      <path d="M116 300 H396" stroke="${k.plate}" stroke-width="4" stroke-dasharray="10 8"/>
      <rect x="140" y="214" width="232" height="92" rx="18" fill="${k.plate}"/><rect x="140" y="270" width="232" height="36" rx="10" fill="${k.shade}"/>
      ${mark(216, 226, 80, k.joint)}
      <rect x="226" y="150" width="96" height="70" rx="16" fill="${k.plate}" stroke="${k.shade}" stroke-width="4"/>${eyes(k, 274, 184, 2, 34)}
      <path d="M322 178 H420" stroke="${k.shade}" stroke-width="12" stroke-linecap="round"/><circle cx="424" cy="178" r="9" fill="${k.eye}"/>
      <path d="M248 150 V104" stroke="${k.shade}" stroke-width="4"/><path d="M228 104 a20 20 0 0 1 40 0" fill="none" stroke="${k.eye}" stroke-width="4"/>`,
  quad: (k) => {
    const legs = [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]
      .map(([sx, sy]) => leg(k, 256 + sx! * 70, 270 + sy! * 30, sx!, 140, 70 + sy! * 20, 14))
      .join('')
    return `${legs}<rect x="160" y="210" width="192" height="120" rx="30" fill="${k.plate}"/><rect x="160" y="290" width="192" height="40" rx="14" fill="${k.shade}"/>
      ${mark(216, 236, 80, k.joint)}<rect x="210" y="140" width="92" height="72" rx="20" fill="${k.plate}" stroke="${k.shade}" stroke-width="4"/>${eyes(k, 256, 176, 2, 30)}
      <path d="M256 140 V106" stroke="${k.shade}" stroke-width="4"/><circle cx="256" cy="100" r="8" fill="${k.eye}"/>`
  },
  centipede: (k) => {
    const n = 7
    let svg = ''
    for (let i = n - 1; i >= 0; i--) {
      const x = 100 + i * 50,
        y = 280 + 26 * Math.sin(i * 0.9)
      svg += leg(k, x, y + 10, -1, 34, 50, 5) + leg(k, x, y + 10, 1, 34, 50, 5)
      svg += `<ellipse cx="${x}" cy="${y}" rx="32" ry="38" fill="${k.shade}"/><ellipse cx="${x}" cy="${y - 4}" rx="28" ry="32" fill="${k.plate}"/><path d="M${x - 18} ${y - 4} H${x + 18}" stroke="${k.shade}" stroke-width="3"/>`
    }
    const hx = 100 + (n - 1) * 50 + 40,
      hy = 280 + 26 * Math.sin((n - 1) * 0.9) - 14
    return `${svg}<circle cx="${hx}" cy="${hy}" r="40" fill="${k.plate}" stroke="${k.shade}" stroke-width="4"/>${eyes(k, hx + 6, hy - 6, 2, 22)}
      <path d="M${hx + 14} ${hy - 38} l20 -36 M${hx - 8} ${hy - 38} l-6 -40" stroke="${k.shade}" stroke-width="4"/>${mark(hx - 18, hy + 10, 34, k.joint)}`
  },
  drone: (k) => {
    const arms = [
      [140, 140],
      [372, 140],
      [140, 372],
      [372, 372],
    ]
      .map(
        ([x, y]) => `<path d="M256 256 L${x} ${y}" stroke="${k.shade}" stroke-width="16"/><circle cx="${x}" cy="${y}" r="58" fill="none" stroke="${k.plate}" stroke-opacity=".5" stroke-width="3"/>
      <circle cx="${x}" cy="${y}" r="16" fill="${k.joint}"/><path d="M${x! - 50} ${y! - 6} L${x! + 50} ${y! + 6}" stroke="${k.plate}" stroke-width="6" stroke-linecap="round"/>`,
      )
      .join('')
    return `${arms}<circle cx="256" cy="256" r="76" fill="${k.plate}"/><circle cx="256" cy="256" r="76" fill="none" stroke="${k.shade}" stroke-width="6"/>
      <circle cx="256" cy="256" r="34" fill="${k.bg}"/><circle cx="256" cy="256" r="14" fill="${k.eye}"/><circle cx="256" cy="256" r="26" fill="${k.eye}" opacity=".2"/>${mark(228, 300, 56, k.joint)}`
  },
  walker: (k) => `
      ${leg(k, 210, 320, -1, 60, 110, 18)}${leg(k, 302, 320, 1, 60, 110, 18)}
      <rect x="168" y="160" width="176" height="170" rx="26" fill="${k.plate}"/><rect x="168" y="290" width="176" height="40" rx="14" fill="${k.shade}"/>
      <rect x="190" y="182" width="132" height="54" rx="14" fill="${k.bg}"/>${eyes(k, 256, 209, 4, 26)}
      ${mark(216, 248, 80, k.joint)}
      <rect x="120" y="190" width="40" height="110" rx="14" fill="${k.shade}"/><rect x="352" y="190" width="40" height="110" rx="14" fill="${k.shade}"/>
      ${[0, 1, 2].map((i) => `<rect x="128" y="${206 + i * 28}" width="24" height="14" rx="4" fill="${k.joint}"/><rect x="360" y="${206 + i * 28}" width="24" height="14" rx="4" fill="${k.joint}"/>`).join('')}
      <path d="M220 160 V120 M292 160 V128" stroke="${k.shade}" stroke-width="5"/><circle cx="220" cy="114" r="7" fill="${k.eye}"/><rect x="282" y="116" width="20" height="12" fill="${k.eye}"/>`,
}
export const BUILD_NAMES = Object.keys(BUILDS)

export function crawlerBot(serial: string): Buffer {
  const k = pick(KITS)
  const build = BUILDS[pick(BUILD_NAMES)]!
  const tilt = rnd(-8, 8)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <rect width="512" height="512" fill="${k.bg}"/>${backdrop(k)}
    <g transform="rotate(${tilt} 256 270) translate(256 250) scale(0.9) translate(-256 -256)">${build(k)}</g>
    <text x="256" y="486" text-anchor="middle" font-size="18" fill="${k.plate}" fill-opacity=".7" letter-spacing="5" font-family="DejaVu Sans Mono">${serial}</text>
  </svg>`
  return render(svg)
}
