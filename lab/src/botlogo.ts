import { Resvg } from '@resvg/resvg-js'

/**
 * Free coin logos for the idea agent: a painted scene for the idea (from a free
 * image service) with the Mesa Lab bot drawn on top in code, peeking over the
 * bottom edge. The bot is identical on every coin; the art, accent colour and
 * the bot's look-direction change per coin.
 */

/** Bot accent colours (antenna ball, eye glints, the ledge). */
export const ACCENTS = ['#B6FFEE', '#5AA9FF', '#FFB547', '#FF7A6B', '#A78BFA', '#B8F25C', '#4FE3E3', '#FF8AD8', '#F5D06B']

function bot(accent: string, look: number) {
  // look: -1 left, 0 ahead, 1 right (moves the pupils' glints and tilts the antenna).
  const g = look * 7
  const tilt = look * 8
  return `
  <defs>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0.42" stop-color="#1B1B1B" stop-opacity="0"/>
      <stop offset="0.86" stop-color="#1B1B1B" stop-opacity="0.92"/>
    </linearGradient>
    <radialGradient id="glow"><stop offset="0" stop-color="${accent}" stop-opacity="0.85"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient>
    <linearGradient id="head" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#D9DBD5"/><stop offset="1" stop-color="#B9BBB5"/></linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#fade)"/>
  <g transform="translate(256 512) scale(0.84) translate(-256 -512)">
  <g transform="rotate(${tilt} 256 310)">
    <circle cx="256" cy="232" r="34" fill="url(#glow)"/>
    <rect x="250" y="236" width="12" height="74" rx="6" fill="#C9CBC5"/>
    <circle cx="256" cy="232" r="17" fill="${accent}"/>
    <circle cx="250" cy="226" r="5" fill="#fff" opacity="0.75"/>
  </g>
  <rect x="146" y="300" width="220" height="200" rx="54" fill="url(#head)"/>
  <circle cx="${212 + g * 0.6}" cy="376" r="26" fill="#0B0C0C"/>
  <circle cx="${300 + g * 0.6}" cy="376" r="26" fill="#0B0C0C"/>
  <circle cx="${220 + g}" cy="367" r="7.5" fill="${accent}"/>
  <circle cx="${308 + g}" cy="367" r="7.5" fill="${accent}"/>
  </g>
  <rect x="0" y="459" width="512" height="53" fill="#1B1B1B"/>
  <rect x="0" y="456" width="512" height="5" fill="${accent}" opacity="0.6"/>
  <g transform="translate(256 512) scale(0.84) translate(-256 -512)">
  <rect x="108" y="428" width="80" height="40" rx="20" fill="#C9CBC5"/>
  <rect x="324" y="428" width="80" height="40" rx="20" fill="#C9CBC5"/>
  </g>`
}

/**
 * The logo as a PNG, 320px by default (small files: these launch every minute). `art` is the painted scene (any size, square) or null
 * for a plain backdrop; `crop` drops the free service's corner watermark.
 */
export function botLogo(o: { art: Buffer | null; mime?: string; accent: string; look?: number; crop?: boolean; size?: number }): Buffer {
  const mime = /png|webp/.exec(o.mime ?? '')?.[0] ?? 'jpeg'
  const vb = o.crop ? '31 31 450 450' : '0 0 512 512'
  const art = o.art
    ? `<svg x="0" y="0" width="512" height="512" viewBox="${vb}" preserveAspectRatio="xMidYMid slice"><image href="data:image/${mime};base64,${o.art.toString('base64')}" width="512" height="512"/></svg>`
    : `<radialGradient id="bg" cx="0.5" cy="0.35" r="0.7"><stop offset="0" stop-color="${o.accent}" stop-opacity="0.35"/><stop offset="1" stop-color="${o.accent}" stop-opacity="0"/></radialGradient><rect width="512" height="512" fill="url(#bg)"/>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#1B1B1B"/>${art}${bot(o.accent, o.look ?? 0)}</svg>`
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: o.size ?? 320 } }).render().asPng())
}
