/**
 * Token images through Mesa: GET /img?u=<https url>.
 *
 * The site only loads images from api.mesa.cx, so its Content-Security-Policy
 * can refuse every other image host (an image request is one way a script
 * could smuggle data out). This fetches the original once, checks it really
 * is an image, and serves it with a long cache.
 *
 * Safe to point at any URL:
 * - https only, default port, no credentials in the URL;
 * - every address the host resolves to is checked at connect time, so the
 *   service can't be used to reach the server's own network (no private,
 *   loopback, link-local or reserved ranges, and DNS rebinding doesn't help);
 * - redirects are followed by hand, at most 3, each checked the same way;
 * - at most 3 MB, 8 seconds, and the bytes must start like a PNG, JPEG, GIF,
 *   WebP, AVIF, ICO or SVG;
 * - SVGs are served with a policy that stops scripts and sandboxes them.
 */
import { lookup as dnsLookup } from 'node:dns'
import { request } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'

const MAX_BYTES = 3 * 1024 * 1024
const TIMEOUT_MS = 8_000
const MAX_REDIRECTS = 3
const CACHE_BYTES = 64 * 1024 * 1024
const CACHE_MS = 24 * 3600_000

export class ImageError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

// ---------------------------------------------------------------- addresses

function v4Private(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number]
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 || // this-net, private, loopback, multicast, reserved
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) // benchmarking
  )
}

/** True for any address the proxy must not connect to. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return v4Private(ip)
  if (isIP(ip) !== 6) return true
  const x = ip.toLowerCase()
  const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return v4Private(mapped[1]!)
  return (
    x === '::' || x === '::1' ||
    x.startsWith('fc') || x.startsWith('fd') || // unique local
    /^fe[89ab]/.test(x) || // link-local
    x.startsWith('ff') || // multicast
    x.startsWith('64:ff9b') || x.startsWith('2001:db8') || x.startsWith('::ffff')
  )
}

/** dns.lookup that refuses private answers: the check happens at connect time. */
const safeLookup: LookupFunction = (host, options, cb) => {
  dnsLookup(host, { ...options, all: true }, (err, addresses) => {
    if (err) return (cb as (e: Error) => void)(err)
    const list = addresses as unknown as { address: string; family: number }[]
    const bad = list.find((a) => isPrivateAddress(a.address))
    if (!list.length || bad) return (cb as (e: Error) => void)(new ImageError(400, 'address not allowed'))
    if ((options as { all?: boolean }).all) return (cb as (e: null, a: typeof list) => void)(null, list)
    ;(cb as (e: null, a: string, f: number) => void)(null, list[0]!.address, list[0]!.family)
  })
}

export function checkUrl(raw: string): URL {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new ImageError(400, 'bad url')
  }
  if (u.protocol !== 'https:') throw new ImageError(400, 'https only')
  if (u.port && u.port !== '443') throw new ImageError(400, 'default port only')
  if (u.username || u.password) throw new ImageError(400, 'no credentials')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) && isPrivateAddress(host)) throw new ImageError(400, 'address not allowed')
  if (raw.length > 2048) throw new ImageError(400, 'url too long')
  return u
}

// ---------------------------------------------------------------- type sniffing

export function sniff(b: Buffer): string | null {
  const s = (i: number, str: string) => b.subarray(i, i + str.length).toString('latin1') === str
  if (b[0] === 0x89 && s(1, 'PNG')) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (s(0, 'GIF8')) return 'image/gif'
  if (s(0, 'RIFF') && s(8, 'WEBP')) return 'image/webp'
  if (s(4, 'ftypavif') || s(4, 'ftypavis')) return 'image/avif'
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'image/x-icon'
  const head = b.subarray(0, 1024).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase()
  if ((head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!--')) && head.includes('<svg')) return 'image/svg+xml'
  return null
}

// ---------------------------------------------------------------- fetching

function get(u: URL): Promise<{ status: number; location?: string; body?: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(
      u,
      {
        method: 'GET',
        lookup: safeLookup,
        timeout: TIMEOUT_MS,
        headers: { 'user-agent': 'MesaImageProxy/1.0', accept: 'image/*' },
      },
      (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400) {
          res.resume()
          return resolve({ status, location: res.headers.location })
        }
        if (status !== 200) {
          res.resume()
          return reject(new ImageError(502, `upstream ${status}`))
        }
        const declared = Number(res.headers['content-length'] ?? 0)
        if (declared > MAX_BYTES) {
          res.destroy()
          return reject(new ImageError(413, 'too large'))
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > MAX_BYTES) {
            res.destroy()
            reject(new ImageError(413, 'too large'))
          } else chunks.push(c)
        })
        res.on('end', () => resolve({ status, body: Buffer.concat(chunks) }))
        res.on('error', reject)
      },
    )
    req.on('timeout', () => req.destroy(new ImageError(504, 'timed out')))
    req.on('error', (e) => reject(e instanceof ImageError ? e : new ImageError(502, 'fetch failed')))
    req.end()
  })
}

export async function fetchImage(raw: string): Promise<{ type: string; body: Buffer }> {
  let u = checkUrl(raw)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const r = await get(u)
    if (r.location !== undefined) {
      u = checkUrl(new URL(r.location, u).toString())
      continue
    }
    const type = sniff(r.body!)
    if (!type) throw new ImageError(415, 'not an image')
    return { type, body: r.body! }
  }
  throw new ImageError(508, 'too many redirects')
}

// ---------------------------------------------------------------- cache

const cache = new Map<string, { at: number; value: Promise<{ type: string; body: Buffer }> }>()
let cachedBytes = 0
const sizes = new Map<string, number>()

export function image(raw: string): Promise<{ type: string; body: Buffer }> {
  const hit = cache.get(raw)
  if (hit && Date.now() - hit.at < CACHE_MS) {
    // Refresh its place: Map order is the eviction order.
    cache.delete(raw)
    cache.set(raw, hit)
    return hit.value
  }
  const value = fetchImage(raw)
  cache.set(raw, { at: Date.now(), value })
  value.then(
    (v) => {
      sizes.set(raw, v.body.length)
      cachedBytes += v.body.length
      for (const [k] of cache) {
        if (cachedBytes <= CACHE_BYTES) break
        cache.delete(k)
        cachedBytes -= sizes.get(k) ?? 0
        sizes.delete(k)
      }
    },
    // Failures are remembered for a minute, so a broken URL isn't refetched per visitor.
    () => setTimeout(() => cache.get(raw)?.value === value && cache.delete(raw), 60_000),
  )
  return value
}

/** Headers for a proxied image. SVGs can carry script, so they get no powers at all. */
export function imageHeaders(type: string, length: number): Record<string, string | number> {
  return {
    'content-type': type,
    'content-length': length,
    'cache-control': 'public, max-age=86400, immutable',
    'access-control-allow-origin': '*',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'cross-origin-resource-policy': 'cross-origin',
  }
}
