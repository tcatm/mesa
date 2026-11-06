import { createServer } from 'node:http'
import { config } from './config.js'
import { readApp, spentToday, state } from './store.js'
import { watch } from './live.js'
import { newsAddress, newsStatus } from './news.js'
import { ideasStatus } from './ideas.js'
import { vampStatus } from './vamps.js'

/**
 * Served at api.mesa.cx/lab/:
 *   GET /lab/api/status     the agent's wallet, what it's doing, today's spend
 *   GET /lab/api/projects   everything it has shipped
 *   GET /lab/api/live       server-sent events: its steps, thoughts and code as it writes
 *   GET /lab/api/news       the news agent: its wallet, what it's doing, every coin and the headline behind it
 *   GET /lab/api/ideas      the idea agent: open, forkable project ideas, each with a coin
 *   GET /lab/api/vamps      the attention token deployer: Elysium versions of tokens trending on other chains
 *   GET /lab/<slug>/        an app, in a strict sandbox
 *
 * Apps are written by a model with no human review, so each is served with a
 * CSP sandbox: its own opaque origin (no cookies or storage of api.mesa.cx),
 * network only to Mesa's public read-only RPC and API, no forms, popups only
 * for links out.
 */
const SANDBOX = [
  'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  // Read-only public data: Elysium's RPC and Mesa's indexer.
  'connect-src https://rpc.mesa.cx https://api.mesa.cx',
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
          newsAddress,
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
    if (path === '/api/live') return watch(res)
    if (path === '/api/news') return void newsStatus().then((s) => json(s))
    if (path === '/api/ideas') return void ideasStatus().then((s) => json(s))
    if (path === '/api/vamps') return void vampStatus().then((s) => json(s))

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
