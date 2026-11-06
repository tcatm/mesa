import { createServer } from 'node:http'
import { config } from './config.js'
import { readApp, spentToday, state } from './store.js'

/**
 * Served at api.mesa.cx/lab/:
 *   GET /lab/api/status     the agent's wallet, what it's doing, today's spend
 *   GET /lab/api/projects   everything it has shipped
 *   GET /lab/<slug>/        an app, in a strict sandbox
 *
 * Apps are written by a model with no human review, so each is served with a
 * CSP sandbox: its own opaque origin (no cookies or storage of api.mesa.cx),
 * no network at all, no forms, popups only for links out.
 */
const SANDBOX = [
  'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'self' https://mesa.cx",
  "base-uri 'none'",
].join('; ')

export function serve(o: { address: string; balance: () => Promise<number | null> }) {
  // Imported late: main.ts owns the agent's phase.
  const main = import('./main.js')
  createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://lab')
    const path = url.pathname.replace(/^\/lab/, '') || '/'
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json({ error: 'GET only' }, 405)

    if (path === '/api/status') {
      void Promise.all([o.balance(), main]).then(([balance, m]) =>
        json({
          address: o.address,
          balanceHype: balance,
          phase: m.phase,
          nextAt: m.nextAt || null,
          enabled: config.enabled,
          dryRun: config.dryRun,
          projects: state.projects.length,
          launched: state.projects.filter((p) => p.token).length,
          claimedHype: state.claimedHype,
          spentTodayUsd: Math.round(spentToday() * 100) / 100,
          budgetUsdPerDay: config.budgetUsdPerDay,
          maxPerDay: config.maxPerDay,
          model: config.model,
          log: state.log.slice(0, 30),
        }),
      )
      return
    }
    if (path === '/api/projects') return json(state.projects)

    const m = /^\/([a-z0-9-]{2,40})\/?$/.exec(path)
    if (m) {
      if (!path.endsWith('/')) {
        res.writeHead(301, { location: `${config.publicUrl}/${m[1]}/` })
        return res.end()
      }
      const html = readApp(m[1]!)
      if (!html) return json({ error: 'not found' }, 404)
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': SANDBOX,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cross-origin-opener-policy': 'same-origin',
        'cache-control': 'public, max-age=300',
      })
      return res.end(req.method === 'HEAD' ? undefined : html)
    }
    if (path === '/' || path === '') {
      res.writeHead(302, { location: 'https://mesa.cx/lab' })
      return res.end()
    }
    json({ error: 'not found' }, 404)
  }).listen(config.port)
}
