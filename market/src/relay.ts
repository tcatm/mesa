/**
 * Relay (relay.link) for the bridge's "From any chain" tab, with Mesa's API
 * key added here so it never reaches the browser.
 *
 *   GET  /relay/chains
 *   POST /relay/currencies/v2
 *   POST /relay/quote/v2
 *   GET  /relay/intents/status/v3?requestId=…
 *
 * Only these four paths are forwarded, bodies are capped, and Relay's answer
 * (status and JSON) is passed back as is. Without RELAY_API_KEY requests go
 * without a key, which Relay limits.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

const RELAY = 'https://api.relay.link'
const KEY = process.env.RELAY_API_KEY
const ROUTES: Record<string, 'GET' | 'POST'> = {
  '/chains': 'GET',
  '/currencies/v2': 'POST',
  '/quote/v2': 'POST',
  '/intents/status/v3': 'GET',
}
const MAX_BODY = 16_384

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Handles /relay/* if it is one of the forwarded paths; returns false otherwise. */
export function relay(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (!url.pathname.startsWith('/relay/')) return false
  const path = url.pathname.slice('/relay'.length)
  const method = ROUTES[path]
  const reply = (status: number, body: string) => {
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': path === '/chains' ? 'public, max-age=300' : 'no-store' })
    res.end(body)
  }
  if (!method) {
    reply(404, JSON.stringify({ message: 'not found' }))
    return true
  }
  if (req.method !== method) {
    reply(405, JSON.stringify({ message: `${method} only` }))
    return true
  }
  const target = RELAY + path + (method === 'GET' ? url.search : '')
  const headers: Record<string, string> = { accept: 'application/json' }
  if (KEY) headers['x-api-key'] = KEY
  ;(method === 'POST' ? readBody(req) : Promise.resolve(undefined))
    .then(async (body) => {
      if (body !== undefined) {
        JSON.parse(body) // reject anything that isn't JSON
        headers['content-type'] = 'application/json'
      }
      const r = await fetch(target, { method, headers, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(20_000) })
      reply(r.status, await r.text())
    })
    .catch((e: unknown) => reply(e instanceof SyntaxError ? 400 : 502, JSON.stringify({ message: e instanceof Error && e.message === 'too large' ? 'request too large' : 'Relay unavailable, try again' })))
  return true
}
