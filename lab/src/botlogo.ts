import { Resvg } from '@resvg/resvg-js'

/**
 * Free coin logos for the idea agent, drawn entirely in code: the Mesa Lab bot
 * in one of several poses with one of ~50 props, an accent colour and a
 * backdrop. The agent picks the prop that fits each idea; pose, colour, backdrop
 * and direction vary per coin, so thousands of combinations look distinct.
 */

/** Accent colours (antenna ball, eye glints, the prop's highlights). */
export const ACCENTS = ['#B6FFEE', '#5AA9FF', '#FFB547', '#FF7A6B', '#A78BFA', '#B8F25C', '#4FE3E3', '#FF8AD8', '#F5D06B', '#FF9F1C', '#70D6FF', '#E9FF70', '#00F5D4', '#F15BB5', '#9B5DE5', '#C1FF72', '#FFD6A5', '#FF4D6D']

const L = '#E8EDED' // light
const M = '#9AA19E' // mid grey
const D = '#2E3434' // dark
const BOT = '#C9CBC5'
const BOT_HI = '#DADCD6'
const EYE = '#0B0C0C'

/** Props, each drawn in a box about 140 wide, centred on 0,0. `a` is the accent colour. */
const PROPS: Record<string, (a: string) => string> = {
  wrench: (a) => `<g transform="rotate(-40)"><rect x="-10" y="-30" width="20" height="90" rx="10" fill="${M}"/><path d="M-30 -50 a32 32 0 1 0 60 0 l-14 0 l0 18 l-32 0 l0 -18 z" fill="${L}"/><circle cx="0" cy="48" r="5" fill="${a}"/></g>`,
  gear: (a) => `<g>${Array.from({ length: 8 }, (_, i) => `<rect x="-11" y="-62" width="22" height="26" rx="5" fill="${M}" transform="rotate(${i * 45})"/>`).join('')}<circle r="44" fill="${M}"/><circle r="18" fill="${a}"/></g>`,
  rocket: (a) => `<g transform="rotate(30)"><path d="M0 -66 C28 -40 28 10 20 34 L-20 34 C-28 10 -28 -40 0 -66Z" fill="${L}"/><circle cy="-14" r="13" fill="${a}"/><circle cy="-14" r="7" fill="${D}"/><path d="M-20 10 L-40 40 L-20 34Z M20 10 L40 40 L20 34Z" fill="${M}"/><path d="M-12 36 L0 66 L12 36Z" fill="${a}"/></g>`,
  laptop: (a) => `<g><rect x="-60" y="-50" width="120" height="78" rx="8" fill="${M}"/><rect x="-52" y="-42" width="104" height="62" rx="4" fill="${D}"/><path d="M-40 -26 l14 0 M-40 -12 l40 0 M-40 2 l26 0" stroke="${a}" stroke-width="6" stroke-linecap="round"/><path d="M-72 30 L72 30 L62 44 L-62 44Z" fill="${L}"/></g>`,
  key: (a) => `<g transform="rotate(-30)"><circle cx="-34" r="28" fill="${a}"/><circle cx="-34" r="11" fill="${D}"/><rect x="-8" y="-8" width="78" height="16" rx="6" fill="${L}"/><rect x="44" y="6" width="10" height="20" rx="3" fill="${L}"/><rect x="60" y="6" width="10" height="14" rx="3" fill="${L}"/></g>`,
  lock: (a) => `<g><path d="M-30 -10 v-24 a30 30 0 0 1 60 0 v24" fill="none" stroke="${M}" stroke-width="14"/><rect x="-48" y="-14" width="96" height="76" rx="14" fill="${a}"/><circle cy="18" r="10" fill="${D}"/><rect x="-4" y="22" width="8" height="20" rx="3" fill="${D}"/></g>`,
  shield: (a) => `<g><path d="M0 -64 L54 -44 C54 10 34 46 0 64 C-34 46 -54 10 -54 -44Z" fill="${M}"/><path d="M0 -48 L40 -34 C40 6 26 34 0 48Z" fill="${a}"/><path d="M-20 0 L-4 16 L24 -16" fill="none" stroke="${L}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/></g>`,
  coin: (a) => `<g><circle r="56" fill="${a}"/><circle r="44" fill="none" stroke="${D}" stroke-opacity="0.35" stroke-width="6"/><path d="M0 -26 L26 0 L0 26 L-26 0Z" fill="${D}" opacity="0.45"/></g>`,
  coins: (a) => `<g>${[0, 1, 2, 3].map((i) => `<ellipse cy="${40 - i * 22}" rx="52" ry="16" fill="${i % 2 ? L : a}"/><rect x="-52" y="${40 - i * 22}" width="104" height="10" fill="${i % 2 ? M : a}" opacity="0.8"/>`).join('')}</g>`,
  magnifier: (a) => `<g transform="rotate(-40)"><rect x="-9" y="30" width="18" height="50" rx="9" fill="${M}"/><circle cy="-10" r="44" fill="${D}" stroke="${L}" stroke-width="12"/><path d="M-22 -26 a26 26 0 0 1 22 -14" stroke="${a}" stroke-width="8" fill="none" stroke-linecap="round"/></g>`,
  lightbulb: (a) => `<g><circle cy="-16" r="46" fill="${a}"/><path d="M-22 22 L22 22 L18 44 L-18 44Z" fill="${L}"/><rect x="-16" y="44" width="32" height="14" rx="5" fill="${M}"/><path d="M-12 -10 L0 6 L12 -10" stroke="${D}" stroke-width="6" fill="none" stroke-opacity="0.5"/></g>`,
  map: (a) => `<g><path d="M-66 -44 L-22 -56 L22 -44 L66 -56 L66 44 L22 56 L-22 44 L-66 56Z" fill="${L}"/><path d="M-22 -56 L-22 44 M22 -44 L22 56" stroke="${M}" stroke-width="4"/><path d="M-48 20 Q-20 -30 10 4 T48 -24" fill="none" stroke="${a}" stroke-width="6" stroke-dasharray="10 8" stroke-linecap="round"/><circle cx="48" cy="-24" r="9" fill="${a}"/></g>`,
  compass: (a) => `<g><circle r="58" fill="${M}"/><circle r="46" fill="${L}"/><path d="M0 -38 L12 0 L0 38 L-12 0Z" fill="${D}"/><path d="M0 -38 L12 0 L-12 0Z" fill="${a}"/><circle r="6" fill="${M}"/></g>`,
  book: (a) => `<g><path d="M0 -40 C-20 -52 -50 -52 -66 -44 L-66 50 C-50 42 -20 42 0 54Z" fill="${L}"/><path d="M0 -40 C20 -52 50 -52 66 -44 L66 50 C50 42 20 42 0 54Z" fill="${a}"/><path d="M-52 -24 h36 M-52 -8 h36 M-52 8 h28" stroke="${M}" stroke-width="5" stroke-linecap="round"/></g>`,
  scroll: (a) => `<g><rect x="-50" y="-52" width="100" height="104" fill="${L}"/><rect x="-62" y="-62" width="124" height="20" rx="10" fill="${M}"/><rect x="-62" y="44" width="124" height="20" rx="10" fill="${M}"/><path d="M-32 -22 h64 M-32 -4 h64 M-32 14 h40" stroke="${a}" stroke-width="6" stroke-linecap="round"/></g>`,
  clock: (a) => `<g><circle r="58" fill="${L}" stroke="${M}" stroke-width="10"/><path d="M0 0 V-36 M0 0 L26 14" stroke="${D}" stroke-width="8" stroke-linecap="round"/><circle r="7" fill="${a}"/>${[0, 90, 180, 270].map((r) => `<rect x="-3" y="-48" width="6" height="10" fill="${a}" transform="rotate(${r})"/>`).join('')}</g>`,
  hourglass: (a) => `<g><rect x="-46" y="-66" width="92" height="14" rx="5" fill="${M}"/><rect x="-46" y="52" width="92" height="14" rx="5" fill="${M}"/><path d="M-36 -52 L36 -52 L4 0 L36 52 L-36 52 L-4 0Z" fill="${L}"/><path d="M-20 -36 L20 -36 L2 -6Z M-24 48 L24 48 L0 24Z" fill="${a}"/></g>`,
  battery: (a) => `<g><rect x="-64" y="-34" width="118" height="68" rx="12" fill="${M}"/><rect x="54" y="-14" width="14" height="28" rx="4" fill="${M}"/><rect x="-54" y="-24" width="70" height="48" rx="6" fill="${a}"/><path d="M-14 -16 L-28 4 L-16 4 L-24 18 L-4 -4 L-16 -4Z" fill="${D}"/></g>`,
  plug: (a) => `<g><rect x="-34" y="-30" width="68" height="60" rx="14" fill="${L}"/><rect x="-22" y="-60" width="12" height="32" rx="4" fill="${M}"/><rect x="10" y="-60" width="12" height="32" rx="4" fill="${M}"/><path d="M0 30 C0 60 40 50 50 70" fill="none" stroke="${a}" stroke-width="10" stroke-linecap="round"/></g>`,
  dish: (a) => `<g><path d="M-56 -30 A64 64 0 0 0 30 56 Z" fill="${L}"/><path d="M-12 12 L30 -30" stroke="${M}" stroke-width="6"/><circle cx="34" cy="-34" r="9" fill="${a}"/><path d="M48 -48 a20 20 0 0 1 0 28 M58 -60 a36 36 0 0 1 0 52" fill="none" stroke="${a}" stroke-width="5" stroke-linecap="round"/><rect x="-16" y="40" width="32" height="24" rx="4" fill="${M}"/></g>`,
  server: (a) => `<g>${[0, 1, 2].map((i) => `<rect x="-56" y="${-60 + i * 42}" width="112" height="36" rx="8" fill="${M}"/><circle cx="-36" cy="${-42 + i * 42}" r="6" fill="${a}"/><rect x="-16" y="${-45 + i * 42}" width="56" height="6" rx="3" fill="${D}"/>`).join('')}</g>`,
  cube: (a) => `<g><path d="M0 -60 L54 -30 L0 0 L-54 -30Z" fill="${L}"/><path d="M-54 -30 L0 0 L0 62 L-54 32Z" fill="${M}"/><path d="M54 -30 L0 0 L0 62 L54 32Z" fill="${a}"/></g>`,
  chain: (a) => `<g transform="rotate(-30)"><rect x="-70" y="-20" width="70" height="40" rx="20" fill="none" stroke="${M}" stroke-width="12"/><rect x="0" y="-20" width="70" height="40" rx="20" fill="none" stroke="${a}" stroke-width="12"/></g>`,
  bridge: (a) => `<g><path d="M-70 20 Q0 -50 70 20" fill="none" stroke="${a}" stroke-width="8"/><rect x="-74" y="18" width="148" height="12" rx="4" fill="${L}"/>${[-44, -16, 16, 44].map((x) => `<rect x="${x - 2}" y="${-10 + Math.abs(x) * 0.4}" width="4" height="${30 - Math.abs(x) * 0.4}" fill="${M}"/>`).join('')}<rect x="-66" y="30" width="12" height="30" fill="${M}"/><rect x="54" y="30" width="12" height="30" fill="${M}"/></g>`,
  envelope: (a) => `<g><rect x="-62" y="-40" width="124" height="84" rx="8" fill="${L}"/><path d="M-62 -36 L0 10 L62 -36" fill="none" stroke="${M}" stroke-width="6"/><circle cx="40" cy="-36" r="16" fill="${a}"/></g>`,
  box: (a) => `<g><path d="M-54 -20 L54 -20 L54 52 L-54 52Z" fill="${M}"/><path d="M-60 -40 L60 -40 L60 -16 L-60 -16Z" fill="${L}"/><rect x="-10" y="-40" width="20" height="92" fill="${a}"/></g>`,
  flag: (a) => `<g><rect x="-44" y="-66" width="8" height="132" rx="4" fill="${M}"/><path d="M-36 -62 C0 -76 20 -44 56 -58 L56 2 C20 16 0 -16 -36 -2Z" fill="${a}"/></g>`,
  trophy: (a) => `<g><path d="M-40 -56 L40 -56 L36 -6 C30 18 -30 18 -36 -6Z" fill="${a}"/><path d="M-40 -46 C-70 -46 -64 -6 -34 -10 M40 -46 C70 -46 64 -6 34 -10" fill="none" stroke="${a}" stroke-width="8"/><rect x="-8" y="14" width="16" height="26" fill="${M}"/><rect x="-34" y="40" width="68" height="18" rx="5" fill="${L}"/></g>`,
  gamepad: (a) => `<g><path d="M-50 -30 L50 -30 C78 -30 84 40 62 44 C46 46 36 20 20 20 L-20 20 C-36 20 -46 46 -62 44 C-84 40 -78 -30 -50 -30Z" fill="${M}"/><path d="M-44 -6 h24 M-32 -18 v24" stroke="${L}" stroke-width="8" stroke-linecap="round"/><circle cx="30" cy="-14" r="7" fill="${a}"/><circle cx="44" cy="0" r="7" fill="${L}"/></g>`,
  dice: (a) => `<g transform="rotate(-12)"><rect x="-50" y="-50" width="100" height="100" rx="18" fill="${L}"/>${[[-24, -24], [24, -24], [0, 0], [-24, 24], [24, 24]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="9" fill="${a}"/>`).join('')}</g>`,
  palette: (a) => `<g><path d="M0 -56 C44 -56 66 -24 60 6 C56 26 30 18 24 34 C18 52 0 58 -16 56 C-50 52 -66 22 -62 -8 C-58 -36 -32 -56 0 -56Z" fill="${L}"/><circle cx="-30" cy="-16" r="10" fill="${a}"/><circle cx="-4" cy="-34" r="10" fill="#FF7A6B"/><circle cx="28" cy="-24" r="10" fill="#5AA9FF"/><circle cx="-30" cy="18" r="10" fill="#F5D06B"/></g>`,
  pencil: (a) => `<g transform="rotate(-45)"><rect x="-12" y="-60" width="24" height="96" fill="${a}"/><rect x="-12" y="-72" width="24" height="16" rx="4" fill="#FF8AD8"/><path d="M-12 36 L12 36 L0 64Z" fill="${L}"/><path d="M-4 54 L4 54 L0 64Z" fill="${D}"/></g>`,
  hammer: (a) => `<g transform="rotate(-30)"><rect x="-8" y="-20" width="16" height="90" rx="6" fill="${M}"/><rect x="-46" y="-50" width="92" height="34" rx="8" fill="${L}"/><rect x="-46" y="-50" width="20" height="34" rx="6" fill="${a}"/></g>`,
  flask: (a) => `<g><path d="M-14 -62 L14 -62 L14 -20 L50 46 C54 56 46 62 38 62 L-38 62 C-46 62 -54 56 -50 46 L-14 -20Z" fill="${L}"/><path d="M-32 20 L32 20 L46 48 C48 54 44 56 40 56 L-40 56 C-44 56 -48 54 -46 48Z" fill="${a}"/><circle cx="-6" cy="36" r="5" fill="${L}"/><circle cx="12" cy="44" r="3" fill="${L}"/><rect x="-20" y="-70" width="40" height="10" rx="4" fill="${M}"/></g>`,
  telescope: (a) => `<g><g transform="rotate(-25)"><rect x="-60" y="-14" width="90" height="28" rx="8" fill="${L}"/><rect x="26" y="-20" width="34" height="40" rx="8" fill="${a}"/></g><path d="M-6 6 L-34 64 M-6 6 L22 64" stroke="${M}" stroke-width="8" stroke-linecap="round"/></g>`,
  globe: (a) => `<g><circle r="56" fill="${a}"/><ellipse rx="22" ry="56" fill="none" stroke="${D}" stroke-opacity="0.4" stroke-width="5"/><path d="M-56 0 H56 M-48 -28 H48 M-48 28 H48" stroke="${D}" stroke-opacity="0.4" stroke-width="5"/></g>`,
  chart: (a) => `<g><rect x="-62" y="-56" width="124" height="112" rx="10" fill="${D}" stroke="${M}" stroke-width="5"/><rect x="-44" y="10" width="18" height="30" fill="${M}"/><rect x="-18" y="-10" width="18" height="50" fill="${L}"/><rect x="8" y="-34" width="18" height="74" fill="${a}"/><path d="M-44 -18 L-10 -36 L30 -40" stroke="${a}" stroke-width="4" fill="none"/></g>`,
  bolt: (a) => `<g><path d="M14 -66 L-40 10 L-4 10 L-18 66 L40 -14 L4 -14Z" fill="${a}"/></g>`,
  heart: (a) => `<g><path d="M0 50 C-60 10 -66 -30 -40 -46 C-22 -56 -6 -46 0 -32 C6 -46 22 -56 40 -46 C66 -30 60 10 0 50Z" fill="${a}"/></g>`,
  star: (a) => `<g><path d="M0 -62 L17 -20 L62 -18 L27 10 L39 54 L0 30 L-39 54 L-27 10 L-62 -18 L-17 -20Z" fill="${a}"/></g>`,
  megaphone: (a) => `<g transform="rotate(-15)"><path d="M-40 -14 L30 -50 L30 50 L-40 14Z" fill="${L}"/><rect x="-60" y="-18" width="24" height="36" rx="6" fill="${M}"/><rect x="28" y="-52" width="12" height="104" rx="5" fill="${a}"/><rect x="-46" y="14" width="14" height="30" rx="5" fill="${M}"/></g>`,
  ticket: (a) => `<g transform="rotate(-12)"><path d="M-66 -34 H66 V-10 a10 10 0 0 0 0 20 V34 H-66 V10 a10 10 0 0 0 0 -20Z" fill="${a}"/><path d="M26 -34 V34" stroke="${D}" stroke-width="4" stroke-dasharray="6 6" stroke-opacity="0.5"/><path d="M-44 -8 h50 M-44 8 h34" stroke="${D}" stroke-width="6" stroke-linecap="round" stroke-opacity="0.5"/></g>`,
  wallet: (a) => `<g><rect x="-60" y="-40" width="120" height="84" rx="14" fill="${M}"/><rect x="-60" y="-52" width="100" height="24" rx="8" fill="${L}"/><rect x="20" y="-14" width="48" height="32" rx="10" fill="${a}"/><circle cx="36" cy="2" r="6" fill="${D}"/></g>`,
  terminal: (a) => `<g><rect x="-66" y="-50" width="132" height="100" rx="12" fill="${D}" stroke="${M}" stroke-width="5"/><rect x="-66" y="-50" width="132" height="20" rx="10" fill="${M}"/><path d="M-44 -6 L-24 8 L-44 22" fill="none" stroke="${a}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/><rect x="-14" y="18" width="36" height="8" rx="4" fill="${L}"/></g>`,
  database: (a) => `<g><path d="M-50 -44 V44 A50 16 0 0 0 50 44 V-44" fill="${M}"/><ellipse cy="-44" rx="50" ry="16" fill="${L}"/><path d="M-50 -10 A50 16 0 0 0 50 -10 M-50 22 A50 16 0 0 0 50 22" fill="none" stroke="${a}" stroke-width="6"/></g>`,
  cloud: (a) => `<g><path d="M-50 40 C-80 40 -80 0 -52 -4 C-54 -40 -10 -50 4 -24 C14 -46 56 -40 52 -6 C80 -2 76 40 50 40Z" fill="${L}"/><path d="M-20 10 L0 -10 L20 10 M0 -10 V30" stroke="${a}" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g>`,
  seedling: (a) => `<g><path d="M-40 26 L40 26 L32 64 L-32 64Z" fill="${M}"/><path d="M0 26 V-14" stroke="${a}" stroke-width="7"/><path d="M0 -10 C-10 -46 -50 -50 -56 -36 C-50 -10 -20 -4 0 -10Z" fill="${a}"/><path d="M0 -20 C10 -56 50 -60 56 -46 C50 -20 20 -14 0 -20Z" fill="${a}" opacity="0.8"/></g>`,
  paperplane: (a) => `<g transform="rotate(-15)"><path d="M-66 0 L66 -46 L20 50 L6 12Z" fill="${L}"/><path d="M6 12 L66 -46 L-4 30Z" fill="${M}"/><path d="M-70 30 h20 M-80 46 h30" stroke="${a}" stroke-width="5" stroke-linecap="round"/></g>`,
  puzzle: (a) => `<g><path d="M-50 -50 H-12 a14 14 0 1 1 24 0 H50 V-12 a14 14 0 1 1 0 24 V50 H12 a14 14 0 1 0 -24 0 H-50 V12 a14 14 0 1 0 0 -24Z" fill="${a}"/></g>`,
  anchor: (a) => `<g><circle cy="-48" r="12" fill="none" stroke="${M}" stroke-width="8"/><path d="M0 -36 V56 M-26 -16 H26" stroke="${M}" stroke-width="10" stroke-linecap="round"/><path d="M-52 16 C-48 50 -20 58 0 58 C20 58 48 50 52 16" fill="none" stroke="${a}" stroke-width="10" stroke-linecap="round"/></g>`,
  bell: (a) => `<g><path d="M0 -60 C-34 -60 -40 -30 -40 0 C-40 24 -54 34 -56 42 H56 C54 34 40 24 40 0 C40 -30 34 -60 0 -60Z" fill="${a}"/><circle cy="54" r="12" fill="${M}"/><rect x="-6" y="-70" width="12" height="14" rx="4" fill="${M}"/></g>`,
  kettle: (a) => `<g><path d="M-44 52 C-60 52 -60 -6 -30 -20 L30 -20 C60 -6 60 52 44 52Z" fill="${a}"/><path d="M-20 -20 C-20 -56 20 -56 20 -20" fill="none" stroke="${M}" stroke-width="8"/><path d="M44 0 L74 -20 L66 -6 L52 18" fill="${a}"/><rect x="-10" y="-30" width="20" height="10" rx="4" fill="${M}"/></g>`,
  lantern: (a) => `<g><path d="M-14 -66 C-14 -80 14 -80 14 -66" fill="none" stroke="${M}" stroke-width="6"/><rect x="-36" y="-60" width="72" height="14" rx="5" fill="${M}"/><rect x="-30" y="-46" width="60" height="84" rx="10" fill="${D}" stroke="${M}" stroke-width="5"/><ellipse cy="-4" rx="14" ry="22" fill="${a}"/><rect x="-40" y="38" width="80" height="14" rx="5" fill="${M}"/></g>`,
  robotarm: (a) => `<g><rect x="-44" y="44" width="70" height="18" rx="6" fill="${M}"/><path d="M-10 44 L-24 -4 L28 -36" fill="none" stroke="${L}" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/><circle cx="-24" cy="-4" r="10" fill="${a}"/><path d="M28 -36 l22 -10 M28 -36 l14 18" stroke="${M}" stroke-width="8" stroke-linecap="round"/></g>`,
  qr: (a) => `<g><rect x="-56" y="-56" width="112" height="112" rx="10" fill="${L}"/>${[[-40, -40], [16, -40], [-40, 16]].map(([x, y]) => `<rect x="${x}" y="${y}" width="24" height="24" fill="${D}"/><rect x="${x! + 7}" y="${y! + 7}" width="10" height="10" fill="${a}"/>`).join('')}${[[0, 0], [12, 12], [24, 0], [28, 28], [0, 24], [12, 36]].map(([x, y]) => `<rect x="${x}" y="${y}" width="10" height="10" fill="${D}"/>`).join('')}</g>`,
  radar: (a) => `<g><circle r="58" fill="${D}" stroke="${M}" stroke-width="5"/><circle r="38" fill="none" stroke="${a}" stroke-opacity="0.4" stroke-width="3"/><circle r="18" fill="none" stroke="${a}" stroke-opacity="0.4" stroke-width="3"/><path d="M0 0 L40 -40 A57 57 0 0 1 57 0Z" fill="${a}" opacity="0.6"/><circle cx="20" cy="-30" r="5" fill="${a}"/></g>`,
  handshake: (a) => `<g><path d="M-70 -10 L-30 -30 L10 -10 L-10 10 Z" fill="${L}"/><path d="M70 -10 L30 -30 L-10 -10 L10 10 L30 30 L50 10Z" fill="${a}"/><path d="M-30 -30 L-10 -10" stroke="${M}" stroke-width="4"/></g>`,
  crown: (a) => `<g><path d="M-60 30 L-60 -30 L-30 0 L0 -44 L30 0 L60 -30 L60 30Z" fill="${a}"/><rect x="-60" y="30" width="120" height="16" rx="4" fill="${L}"/><circle cy="-48" r="8" fill="${L}"/></g>`,
  headphones: (a) => `<g><path d="M-50 20 V0 a50 50 0 0 1 100 0 V20" fill="none" stroke="${M}" stroke-width="10"/><rect x="-62" y="6" width="28" height="48" rx="12" fill="${a}"/><rect x="34" y="6" width="28" height="48" rx="12" fill="${a}"/></g>`,
  camera: (a) => `<g><rect x="-62" y="-34" width="124" height="80" rx="14" fill="${M}"/><rect x="-26" y="-48" width="44" height="18" rx="5" fill="${M}"/><circle cy="6" r="28" fill="${D}" stroke="${L}" stroke-width="6"/><circle cy="6" r="12" fill="${a}"/><circle cx="44" cy="-20" r="5" fill="${a}"/></g>`,
  stopwatch: (a) => `<g><circle cy="8" r="54" fill="${L}" stroke="${M}" stroke-width="8"/><rect x="-10" y="-62" width="20" height="16" rx="4" fill="${M}"/><path d="M0 8 V-26" stroke="${a}" stroke-width="8" stroke-linecap="round"/><circle cy="8" r="7" fill="${D}"/></g>`,
  cart: (a) => `<g><path d="M-70 -40 H-50 L-30 30 H44 L60 -20 H-40" fill="none" stroke="${M}" stroke-width="9" stroke-linejoin="round" stroke-linecap="round"/><path d="M-36 -16 H54 L44 18 H-26Z" fill="${a}"/><circle cx="-22" cy="50" r="10" fill="${L}"/><circle cx="36" cy="50" r="10" fill="${L}"/></g>`,
  ballot: (a) => `<g><rect x="-56" y="-10" width="112" height="70" rx="8" fill="${M}"/><rect x="-30" y="-6" width="60" height="8" rx="3" fill="${D}"/><g transform="translate(0 -24) rotate(-8)"><rect x="-30" y="-40" width="60" height="44" rx="4" fill="${L}"/><path d="M-12 -18 L-2 -8 L14 -28" fill="none" stroke="${a}" stroke-width="6" stroke-linecap="round"/></g></g>`,
  mailbox: (a) => `<g><path d="M-50 -10 a30 30 0 0 1 60 0 V40 H-50Z" fill="${L}"/><path d="M10 -40 H50 a20 20 0 0 1 20 20 V40 H10Z" fill="${M}"/><rect x="34" y="-60" width="6" height="40" fill="${M}"/><rect x="40" y="-60" width="24" height="16" fill="${a}"/><rect x="-6" y="40" width="12" height="26" fill="${M}"/></g>`,
}
export const PROP_NAMES = Object.keys(PROPS)

/** The bot's head, centred at 0,0 (about 200 wide). look: -1..1 moves the eyes. */
function head(a: string, look: number) {
  const g = look * 8
  return `<rect x="-6" y="-120" width="12" height="40" rx="6" fill="${BOT}"/>
  <circle cy="-124" r="26" fill="${a}" opacity="0.25"/>
  <circle cy="-124" r="15" fill="${a}"/><circle cx="-5" cy="-129" r="4.5" fill="#fff" opacity="0.75"/>
  <rect x="-100" y="-86" width="200" height="164" rx="48" fill="${BOT}"/>
  <rect x="-100" y="-86" width="200" height="60" rx="30" fill="${BOT_HI}" opacity="0.5"/>
  <circle cx="${-40 + g * 0.6}" cy="-6" r="24" fill="${EYE}"/><circle cx="${40 + g * 0.6}" cy="-6" r="24" fill="${EYE}"/>
  <circle cx="${-32 + g}" cy="-14" r="7" fill="${a}"/><circle cx="${48 + g}" cy="-14" r="7" fill="${a}"/>`
}
const paw = (x: number, y: number, r = 0) => `<rect x="${x - 26}" y="${y - 16}" width="52" height="32" rx="16" fill="${BOT}" transform="rotate(${r} ${x} ${y})"/>`
const prop = (name: string, a: string, x: number, y: number, s: number, r = 0) =>
  `<g transform="translate(${x} ${y}) rotate(${r}) scale(${s})">${(PROPS[name] ?? PROPS.star!)(a)}</g>`

/** Poses: how the bot and the prop are arranged on the 512 canvas. */
const arm = (x1: number, y1: number, x2: number, y2: number) =>
  `<path d="M${x1} ${y1} L${x2} ${y2}" stroke="${BOT}" stroke-width="24" stroke-linecap="round"/>`
const POSES: Record<string, (p: string, a: string, look: number) => string> = {
  // Holding the prop up in front, both paws on it.
  hold: (p, a, look) => `<g transform="translate(256 300) scale(0.9)">${head(a, look)}</g>${prop(p, a, 256, 388, 1.12)}${paw(176, 404)}${paw(336, 404)}`,
  // Peeking over the bottom ledge, the prop sitting on the ledge beside it.
  peek: (p, a, look) =>
    `${prop(p, a, 360, 300, 1.0, 6)}<g transform="translate(200 396) scale(0.95)">${head(a, look || 0.8)}</g><rect x="0" y="452" width="512" height="60" fill="#1B1B1B"/><rect x="0" y="449" width="512" height="5" fill="${a}" opacity="0.6"/>${paw(130, 452)}${paw(270, 452)}`,
  // The prop large behind, the bot popping up in front of it.
  behind: (p, a, look) => `${prop(p, a, 256, 200, 1.5)}<g transform="translate(256 392) scale(0.8)">${head(a, look)}</g>${paw(180, 448)}${paw(332, 448)}`,
  // The prop floating above, glowing, the bot gazing up at it.
  float: (p, a, look) =>
    `<circle cx="256" cy="150" r="96" fill="${a}" opacity="0.12"/>${prop(p, a, 256, 150, 0.95)}<path d="M196 262 q8 -10 16 0 M300 262 q8 -10 16 0" stroke="${a}" stroke-width="5" fill="none" stroke-linecap="round" opacity="0.7"/><g transform="translate(256 392) scale(0.82)">${head(a, look * 0.5)}</g>${paw(180, 448)}${paw(332, 448)}`,
  // Tilted the other way, the prop held up close to its face.
  tilt: (p, a, look) => `<g transform="translate(210 300) rotate(-8) scale(0.84)">${head(a, look || 0.8)}</g>${prop(p, a, 368, 340, 1.05, 10)}${paw(322, 380, -12)}${paw(414, 380, -12)}`,
  // Two small props either side of it.
  duo: (p, a, look) => `${prop(p, a, 110, 300, 0.7, -10)}${prop(p, a, 402, 300, 0.7, 10)}<g transform="translate(256 360) scale(0.82)">${head(a, look)}</g>${paw(186, 424)}${paw(326, 424)}`,
  // Tiny bot on top of a giant prop.
  ontop: (p, a, look) => `${prop(p, a, 256, 330, 1.6)}<g transform="translate(256 168) scale(0.52)">${head(a, look)}</g>${paw(214, 214)}${paw(298, 214)}`,
  // Head tilted, showing off the prop beside it with one paw.
  side: (p, a, look) =>
    `<g transform="translate(196 300) rotate(-8) scale(0.88)">${head(a, look || 1)}</g>${arm(270, 340, 314, 352)}${prop(p, a, 370, 300, 0.95, -6)}${paw(316, 352, -20)}`,
}
export const POSE_NAMES = Object.keys(POSES)

/** Backdrops behind the bot. */
const BACKDROPS: ((a: string) => string)[] = [
  (a) => `<radialGradient id="g" cx="0.5" cy="0.4" r="0.65"><stop offset="0" stop-color="${a}" stop-opacity="0.32"/><stop offset="1" stop-color="${a}" stop-opacity="0"/></radialGradient><rect width="512" height="512" fill="url(#g)"/>`,
  (a) => `${[70, 130, 190, 250].map((r) => `<circle cx="256" cy="230" r="${r}" fill="none" stroke="${a}" stroke-opacity="${0.22 - r / 2000}" stroke-width="3"/>`).join('')}`,
  (a) => `${Array.from({ length: 64 }, (_, i) => `<circle cx="${32 + (i % 8) * 64}" cy="${32 + Math.floor(i / 8) * 64}" r="3" fill="${a}" opacity="0.22"/>`).join('')}`,
  (a) => `${Array.from({ length: 12 }, (_, i) => `<path d="M256 230 L${256 + 400 * Math.cos((i * Math.PI) / 6)} ${230 + 400 * Math.sin((i * Math.PI) / 6)} L${256 + 400 * Math.cos((i * Math.PI) / 6 + 0.18)} ${230 + 400 * Math.sin((i * Math.PI) / 6 + 0.18)}Z" fill="${a}" opacity="0.07"/>`).join('')}`,
  (a) => `${Array.from({ length: 9 }, (_, i) => `<path d="M${i * 64} 0 V512 M0 ${i * 64} H512" stroke="${a}" stroke-opacity="0.09" stroke-width="2"/>`).join('')}`,
  (a) => `${[[60, 80], [440, 60], [120, 300], [470, 260], [300, 40], [40, 200], [400, 400], [90, 440]].map(([x, y], i) => `<path d="M${x} ${y! - 10} L${x! + 3} ${y! - 3} L${x! + 10} ${y} L${x! + 3} ${y! + 3} L${x} ${y! + 10} L${x! - 3} ${y! + 3} L${x! - 10} ${y} L${x! - 3} ${y! - 3}Z" fill="${a}" opacity="${0.25 + (i % 3) * 0.1}"/>`).join('')}`,
  (a) => `<circle cx="256" cy="236" r="190" fill="${a}" opacity="0.1"/><circle cx="256" cy="236" r="130" fill="${a}" opacity="0.08"/>`,
  (a) => `${Array.from({ length: 8 }, (_, i) => `<path d="M0 ${60 + i * 60} Q128 ${30 + i * 60} 256 ${60 + i * 60} T512 ${60 + i * 60}" fill="none" stroke="${a}" stroke-opacity="0.12" stroke-width="3"/>`).join('')}`,
  (a) => `<path d="M0 512 L512 0 L512 512 Z" fill="${a}" opacity="0.07"/>`,
  (a) => `${Array.from({ length: 30 }, () => `<circle cx="${Math.random() * 512}" cy="${Math.random() * 400}" r="${1 + Math.random() * 2.5}" fill="#fff" opacity="${0.2 + Math.random() * 0.5}"/>`).join('')}<circle cx="410" cy="100" r="34" fill="${a}" opacity="0.22"/>`,
  (a) => `${Array.from({ length: 6 }, (_, i) => `<rect x="${40 + i * 76}" y="${300 - (i % 3) * 60}" width="44" height="${212 + (i % 3) * 60}" fill="${a}" opacity="0.07"/>`).join('')}`,
  (a) => `${Array.from({ length: 12 }, (_, i) => `<path d="M${i * 48 - 60} 0 L${i * 48 + 60} 512" stroke="${a}" stroke-opacity="0.08" stroke-width="18"/>`).join('')}`,
  (a) => `<rect x="40" y="40" width="432" height="432" rx="60" fill="none" stroke="${a}" stroke-opacity="0.18" stroke-width="4" stroke-dasharray="14 12"/>`,
  (a) => `${Array.from({ length: 9 }, (_, i) => `<path d="M256 236 L${256 + 400 * Math.cos(i * 0.7)} ${236 + 400 * Math.sin(i * 0.7)}" stroke="${a}" stroke-opacity="0.1" stroke-width="2"/>`).join('')}<circle cx="256" cy="236" r="60" fill="${a}" opacity="0.08"/>`,
]

const pick = <T>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)]!

/**
 * A logo as a PNG (320px by default: these launch every minute, so files stay
 * small). Anything not given is picked at random.
 */
export function botLogo(o: { prop?: string; pose?: string; accent?: string; backdrop?: number; look?: number; flip?: boolean; size?: number } = {}): Buffer {
  const a = o.accent ?? pick(ACCENTS)
  const p = o.prop && PROPS[o.prop] ? o.prop : pick(PROP_NAMES)
  const pose = POSES[o.pose ?? ''] ?? POSES[pick(POSE_NAMES)]!
  const bd = BACKDROPS[o.backdrop ?? Math.floor(Math.random() * BACKDROPS.length)] ?? BACKDROPS[0]!
  const look = o.look ?? pick([-1, -0.5, 0, 0.5, 1])
  const flip = o.flip ?? Math.random() < 0.5
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#1B1B1B"/>${bd(a)}<g ${flip ? 'transform="translate(512 0) scale(-1 1)"' : ''}>${pose(p, a, look)}</g></svg>`
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: o.size ?? 320 } }).render().asPng())
}
