import type { ServerResponse } from 'node:http'

/**
 * The agent, live: what it's doing, why, and the code as it's written,
 * streamed to everyone watching mesa.cx/lab (GET /lab/api/live, server-sent
 * events). New viewers get the recent history first. Public: never put
 * secrets in here.
 */
export type LiveKind = 'phase' | 'step' | 'thought' | 'code' | 'code-start' | 'code-end'

export interface LiveEvent {
  id: number
  at: number
  kind: LiveKind
  text: string
}

const history: LiveEvent[] = []
const viewers = new Set<ServerResponse>()
let id = 0

export function live(kind: LiveKind, text: string) {
  const e: LiveEvent = { id: ++id, at: Math.floor(Date.now() / 1000), kind, text }
  history.push(e)
  // Keep the last project's code and the recent steps; trim old code first.
  if (history.length > 600) {
    const i = history.findIndex((h) => h.kind === 'code')
    history.splice(i >= 0 && i < history.length - 200 ? i : 0, 1)
  }
  const line = `id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`
  for (const v of viewers) v.write(line)
}

/** Batches a stream of model tokens into a few code events a second. */
export function codeStream() {
  let buf = ''
  let timer: NodeJS.Timeout | null = null
  const flush = () => {
    timer = null
    if (buf) live('code', buf)
    buf = ''
  }
  return {
    push(t: string) {
      buf += t
      if (!timer) timer = setTimeout(flush, 250)
    },
    end() {
      if (timer) clearTimeout(timer)
      flush()
    },
  }
}

export function watch(res: ServerResponse) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
  })
  res.write(': connected\n\n')
  for (const e of history) res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`)
  viewers.add(res)
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000)
  res.on('close', () => {
    clearInterval(ping)
    viewers.delete(res)
  })
}
