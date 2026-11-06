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
}): Promise<string> {
  if (spentToday() >= config.budgetUsdPerDay) throw new BudgetError(`today's model budget of $${config.budgetUsdPerDay} is used up`)
  if (config.mock) return mock(o.user)
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
    }),
    signal: AbortSignal.timeout(300_000),
  })
  const body = (await r.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[]
    usage?: { cost?: number }
    error?: { message?: string }
  } | null
  if (!r.ok || !body) throw new Error(`OpenRouter ${r.status}: ${body?.error?.message ?? 'no answer'}`)
  const cost = Number(body.usage?.cost ?? 0)
  state.spend[today()] = spentToday() + (Number.isFinite(cost) ? cost : 0)
  // Keep a month of spend.
  for (const d of Object.keys(state.spend).sort().slice(0, -31)) delete state.spend[d]
  save()
  const text = body.choices?.[0]?.message?.content ?? ''
  if (!text.trim()) throw new Error('the model answered with nothing')
  return text
}

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
  if (user.includes('IDEA'))
    return JSON.stringify({
      name: 'Pomodoro Garden',
      symbol: 'POMG',
      slug: 'pomodoro-garden',
      tagline: 'A focus timer that grows a tiny pixel garden while you work.',
      about: 'Set a 25 minute focus session and a plant grows one stage per session. Breaks are timed too. Everything runs in your browser.',
    })
  if (user.includes('ICON'))
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#1B1B1B"/><circle cx="256" cy="280" r="120" fill="#B6FFEE"/><rect x="246" y="120" width="20" height="80" fill="#B6FFEE"/></svg>'
  if (user.includes('REVIEW')) return JSON.stringify({ ok: true, reason: 'A harmless focus timer.' })
  return '```html\n<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pomodoro Garden</title><style>body{background:#1B1B1B;color:#eee;font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0}button{background:#B6FFEE;border:0;padding:12px 20px;border-radius:999px}</style></head><body><main><h1>Pomodoro Garden</h1><p id="t">25:00</p><button id="b">Start</button><footer><a href="https://mesa.cx/lab" target="_blank" rel="noopener">Built by the Mesa Lab agent</a></footer></main><script>let s=1500,i;b.onclick=()=>{clearInterval(i);i=setInterval(()=>{s--;t.textContent=String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0")},1000)}</script></body></html>\n```'
}
