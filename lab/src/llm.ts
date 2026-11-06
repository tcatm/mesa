import { config } from './config.js'
import { save, spentToday, state, today } from './store.js'

/**
 * The model, through OpenRouter. Every call's cost is added to today's spend,
 * and no call starts once today's budget (LAB_BUDGET_USD) is used up.
 */
export class BudgetError extends Error {}

export async function chat(o: {
  model?: string
  system: string
  user: string
  maxTokens: number
  json?: boolean
  /** Called with each piece of the answer as it streams in. */
  onToken?: (t: string) => void
  /** Called with the model's reasoning as it streams in (shown live). */
  onReasoning?: (t: string) => void
  /** How hard the model thinks before answering; it shares max_tokens with the answer. */
  effort?: 'none' | 'minimal' | 'low' | 'medium'
  /** Whose budget pays: the builder agent's (default) or the news agent's. */
  bucket?: 'lab' | 'news'
}): Promise<string> {
  const bucket = o.bucket ?? 'lab'
  if (spentToday(bucket) >= budgetOf(bucket)) throw new BudgetError(`today's ${bucket === 'news' ? 'news ' : ''}model budget of $${budgetOf(bucket)} is used up`)
  if (config.mock) {
    const text = mock(o.user)
    if (o.onToken) for (let i = 0; i < text.length; i += 60) (o.onToken(text.slice(i, i + 60)), await new Promise((r) => setTimeout(r, 15)))
    return text
  }
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.openrouterKey}`,
      'content-type': 'application/json',
      'http-referer': 'https://mesa.cx/lab',
      'x-title': 'Mesa Lab',
    },
    body: JSON.stringify({
      model: o.model ?? config.model,
      max_tokens: o.maxTokens,
      messages: [
        { role: 'system', content: o.system },
        { role: 'user', content: o.user },
      ],
      ...(o.json ? { response_format: { type: 'json_object' } } : {}),
      usage: { include: true },
      reasoning: { effort: o.effort ?? 'none' },
      ...(o.onToken ? { stream: true } : {}),
    }),
    signal: AbortSignal.timeout(300_000),
  })
  if (o.onToken && r.ok && r.body) return readStream(r.body, o.onToken, o.onReasoning, bucket)
  const body = (await r.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[]
    usage?: { cost?: number }
    error?: { message?: string }
  } | null
  // Some models no longer allow reasoning to be switched off: ask again with a little of it.
  if (r.status === 400 && /reasoning is mandatory/i.test(body?.error?.message ?? '') && (o.effort ?? 'none') === 'none')
    return chat({ ...o, effort: 'low', maxTokens: o.maxTokens + 2_000 })
  if (!r.ok || !body) throw new Error(`OpenRouter ${r.status}: ${body?.error?.message ?? 'no answer'}`)
  addSpend(Number(body.usage?.cost ?? 0), bucket)
  const text = body.choices?.[0]?.message?.content ?? ''
  if (!text.trim()) throw new Error('the model answered with nothing')
  return text
}

/** Reads a streamed answer (server-sent events), passing each piece on and counting its cost. */
async function readStream(
  body: ReadableStream<Uint8Array>,
  onToken: (t: string) => void,
  onReasoning?: (t: string) => void,
  bucket: 'lab' | 'news' = 'lab',
): Promise<string> {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let text = ''
  let cost = 0
  let reasoned = 0
  let finish = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      try {
        const j = JSON.parse(data) as {
          choices?: { delta?: { content?: string; reasoning?: string }; finish_reason?: string | null }[]
          usage?: { cost?: number }
          error?: { message?: string }
        }
        if (j.error) throw new Error(`OpenRouter: ${j.error.message ?? 'stream error'}`)
        const c = j.choices?.[0]
        if (c?.finish_reason) finish = c.finish_reason
        const rz = c?.delta?.reasoning
        if (rz) {
          reasoned += rz.length
          onReasoning?.(rz)
        }
        const t = c?.delta?.content
        if (t) {
          text += t
          onToken(t)
        }
        if (j.usage?.cost !== undefined) cost = Number(j.usage.cost)
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('OpenRouter')) throw e
      }
    }
  }
  addSpend(cost, bucket)
  if (!text.trim())
    throw new Error(`the model answered with nothing (stopped: ${finish || 'unknown'}, ${Math.round(reasoned / 1000)}K characters of reasoning)`)
  if (finish === 'length') throw new Error(`the model ran out of room after ${Math.round(text.length / 1000)} KB`)
  return text
}

/** Adds a call's cost to today's spend (for calls outside chat(), like images). */
export function addSpend(usd: number, bucket: 'lab' | 'news' = 'lab') {
  const book = bucket === 'news' ? (state.newsSpend ??= {}) : state.spend
  book[today()] = (book[today()] ?? 0) + (Number.isFinite(usd) ? usd : 0)
  // Keep a month.
  for (const d of Object.keys(book).sort().slice(0, -31)) delete book[d]
  save()
}
const budgetOf = (b: 'lab' | 'news') => (b === 'news' ? config.newsBudgetUsdPerDay : config.budgetUsdPerDay)

/** JSON from a model answer, even when it's wrapped in a code fence. */
export function parseJson<T>(text: string): T {
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const raw = (m ? m[1]! : text).trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  return JSON.parse(raw.slice(start, end + 1)) as T
}

// Canned answers for testing without a key (LAB_MOCK=1).
function mock(user: string): string {
  if (user.includes('Headlines:'))
    return JSON.stringify({ index: 0, name: 'Comet Wink', symbol: 'WINKZ', blurb: 'A newly spotted comet will swing past Jupiter next spring.', theme: 'a small comet with a mint tail' })
  if (user.includes('Ticker:')) return JSON.stringify({ ok: true })
  if (user.includes('IDEA'))
    return JSON.stringify({
      name: 'Gas Lantern',
      symbol: 'GLAMP',
      slug: 'gas-lantern',
      tagline: "Live Elysium gas price and block pace, with a cost calculator for any gas limit.",
      about: "Shows Elysium's current gas price and recent blocks from Mesa's public RPC, and turns any gas limit into a cost in HYPE.",
      thought: "Builders deploying on Elysium keep asking what a transaction will cost. A live gas readout with a calculator answers that in one glance.",
    })
  if (user.includes('ICON'))
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#1B1B1B"/><circle cx="256" cy="280" r="120" fill="#B6FFEE"/><rect x="246" y="120" width="20" height="80" fill="#B6FFEE"/></svg>'
  if (user.includes('REVIEW')) return JSON.stringify({ ok: true, reason: 'A harmless focus timer.' })
  return '```html\n<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pomodoro Garden</title><style>body{background:#1B1B1B;color:#eee;font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0}button{background:#B6FFEE;border:0;padding:12px 20px;border-radius:999px}</style></head><body><main><h1>Pomodoro Garden</h1><p id="t">25:00</p><button id="b">Start</button><footer><a href="https://mesa.cx/lab" target="_blank" rel="noopener">Built by the Mesa Lab agent</a></footer></main><script>let s=1500,i;b.onclick=()=>{clearInterval(i);i=setInterval(()=>{s--;t.textContent=String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0")},1000)}</script></body></html>\n```'
}
