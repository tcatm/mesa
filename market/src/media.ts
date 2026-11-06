/**
 * Token images uploaded on Mesa's launch page:
 *   POST /upload        the image's bytes as the body; returns { url }
 *   GET  /media/<file>  the stored image
 *
 * A file is stored under the SHA-256 of its bytes, so its address can never
 * show a different picture, and the same image uploaded twice is one file.
 * Only PNG, JPEG, GIF and WebP are accepted (no SVG: it can carry script),
 * checked by their first bytes, not by what the uploader says they are.
 * Uploads are limited per IP and in total, so the store can't be filled.
 *
 * The address saved with a launch is https://api.mesa.cx/media/<file>: if the
 * files ever move (to object storage or IPFS), that address keeps working by
 * serving or redirecting from here.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, statSync } from 'node:fs'
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'

import { sniff } from './images.js'

export const MEDIA_DIR = process.env.MEDIA_DIR ?? './media'
export const MEDIA_URL = process.env.MEDIA_URL ?? 'https://api.mesa.cx/media'
const MAX_BYTES = 3 * 1024 * 1024
const MAX_TOTAL = Number(process.env.MEDIA_MAX_BYTES ?? 5 * 1024 ** 3)
const PER_IP_PER_HOUR = Number(process.env.UPLOADS_PER_IP_PER_HOUR ?? 20)
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
const TYPE = Object.fromEntries(Object.entries(EXT).map(([t, e]) => [e, t]))
const FILE = /^([0-9a-f]{64})\.(png|jpg|gif|webp)$/

export class MediaError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

mkdirSync(MEDIA_DIR, { recursive: true })
let total = readdirSync(MEDIA_DIR).reduce((s, f) => s + (FILE.test(f) ? statSync(join(MEDIA_DIR, f)).size : 0), 0)

const uploads = new Map<string, number[]>()
function underLimit(ip: string): boolean {
  if (ip === '') return true // internal
  const now = Date.now()
  const recent = (uploads.get(ip) ?? []).filter((t) => now - t < 3_600_000)
  if (recent.length >= PER_IP_PER_HOUR) return false
  recent.push(now)
  uploads.set(ip, recent)
  if (uploads.size > 50_000) uploads.clear()
  return true
}

function body(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0)
    if (declared > MAX_BYTES) return reject(new MediaError(413, 'images can be at most 3 MB'))
    const parts: Buffer[] = []
    let n = 0
    req.on('data', (c: Buffer) => {
      n += c.length
      if (n > MAX_BYTES) {
        req.destroy()
        reject(new MediaError(413, 'images can be at most 3 MB'))
      } else parts.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(parts)))
    req.on('error', reject)
  })
}

/** Store an uploaded image; returns its permanent address. */
export async function upload(req: IncomingMessage, ip: string): Promise<{ url: string; type: string; bytes: number }> {
  if (!underLimit(ip)) throw new MediaError(429, 'too many uploads, try again later')
  const b = await body(req)
  if (b.length === 0) throw new MediaError(400, 'empty upload')
  const type = sniff(b)
  const ext = type ? EXT[type] : undefined
  if (!type || !ext) throw new MediaError(415, 'use a PNG, JPEG, GIF or WebP image')
  const name = `${createHash('sha256').update(b).digest('hex')}.${ext}`
  const path = join(MEDIA_DIR, name)
  const exists = await stat(path).then(
    () => true,
    () => false,
  )
  if (!exists) {
    if (total + b.length > MAX_TOTAL) throw new MediaError(507, 'uploads are paused, try again later')
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, b, { flag: 'wx' })
    await rename(tmp, path)
    total += b.length
    console.log(JSON.stringify({ upload: name, bytes: b.length }))
  }
  return { url: `${MEDIA_URL}/${name}`, type, bytes: b.length }
}

/** A stored image by its file name, or null. */
export async function media(file: string): Promise<{ type: string; body: Buffer } | null> {
  const m = FILE.exec(file)
  if (!m) return null
  const body = await readFile(join(MEDIA_DIR, file)).catch(() => null)
  return body ? { type: TYPE[m[2]!]!, body } : null
}
