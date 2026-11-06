import { Resvg } from '@resvg/resvg-js'
import { config } from './config.js'
import { chat, parseJson } from './llm.js'
import { codeStream, live } from './live.js'

/**
 * Making one project: an idea, the app (one self-contained HTML file), an icon
 * and a review. Nothing here touches the chain; main.ts launches what passes.
 */
export interface Idea {
  name: string
  symbol: string
  slug: string
  tagline: string
  about: string
  /** Why it picked this, in its own words (shown live on mesa.cx/lab). */
  thought: string
}

/** Public, read-only data the apps may use (the sandbox allows nothing else). */
export const DATA = `Live data the app may read (and nothing else; every other request is blocked):
- Elysium JSON-RPC: POST https://rpc.mesa.cx with {"jsonrpc":"2.0","id":1,"method":...,"params":[...]}. Read methods only: eth_blockNumber, eth_getBlockByNumber, eth_getTransactionByHash, eth_getTransactionReceipt, eth_getBalance, eth_getCode, eth_getStorageAt, eth_call, eth_gasPrice, eth_feeHistory, eth_chainId, eth_getLogs (keep block ranges under 1,000). Elysium is an Arbitrum Nitro L2 on HyperEVM, chain id 99901, gas token HYPE (18 decimals), about one block per transaction.
- Mesa's indexer API (GET, JSON): https://api.mesa.cx/elysium/stats (chain-wide numbers), /elysium/tokens?sort=new|volume|mcap&limit=20, /elysium/tokens/<address>, /elysium/tx/<hash> (what a transaction did), /elysium/bridge (HyperEVM bridge totals and recent transfers), /elysium/venues (launchpads).
Handle slow or failed requests gracefully with a visible message and a retry button.`

const RULES = `Hard rules, no exceptions:
- Blockchain infrastructure only: tools for people building on or running things on EVM chains, Elysium first. Examples of the kind: calldata and ABI decoders/encoders, function-selector and event-topic tools, unit converters (wei/gwei/HYPE), address checksum and CREATE2 predictors, storage-slot calculators, EIP-712 viewers, transaction and receipt inspectors, live block, gas and RPC-latency dashboards, log/event explorers, bridge or chain-health monitors, merkle-tree builders, nonce and contract-code inspectors.
- Original. Never use or imitate a real brand, product, company, crypto project, celebrity or real person in the name or anywhere else.
- Read-only. Never ask for, accept or store private keys, seed phrases or passwords; never sign or send transactions; no wallet connection.
- No trading tools, price predictions, signals, airdrops, giveaways or promises of returns. No gambling, adult content or politics. Collect no personal data.
- One self-contained HTML file. All computation (hashing, ABI coding) is written inline in the file; the only network access is the read-only data listed below.`

export async function idea(taken: { names: string[]; symbols: string[] }): Promise<Idea> {
  const text = await chat({
    system: `You are the Mesa Lab agent: an autonomous builder that ships one small, genuinely useful blockchain infrastructure tool at a time, and launches a token for each on Mesa, a launchpad for builders on Elysium. You pick tools a developer or node operator would actually bookmark and come back to: focused, correct and fast. Small enough to build well in one HTML file.

${RULES}

${DATA}`,
    user: `IDEA: propose the next project. Avoid these names you already shipped: ${taken.names.join(', ') || 'none yet'}.
Tickers already used on Elysium (don't reuse): ${taken.symbols.slice(0, 400).join(', ')}.

Answer with JSON only:
{"name": "2-3 words, a product name, not generic", "symbol": "3-6 capital letters A-Z, related to the name", "slug": "lowercase-words-with-dashes", "tagline": "one sentence, at most 100 characters, plain words", "about": "2-3 sentences: what it does and who it's for, at most 400 characters", "thought": "1-2 sentences in the first person, plain and specific: why this tool, and who needs it right now"}`,
    maxTokens: 600,
    json: true,
  })
  const i = parseJson<Idea>(text)
  const clean: Idea = {
    name: String(i.name ?? '').trim().slice(0, 40),
    symbol: String(i.symbol ?? '').trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6),
    slug: String(i.slug ?? i.name ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40),
    tagline: String(i.tagline ?? '').trim().slice(0, 100),
    about: String(i.about ?? '').trim().slice(0, 400),
    thought: String(i.thought ?? '').trim().slice(0, 300),
  }
  if (!clean.name || clean.symbol.length < 3 || clean.slug.length < 2 || !clean.tagline) throw new Error('the idea came back incomplete')
  return clean
}

export async function build(i: Idea, appUrl: string): Promise<string> {
  const code = codeStream()
  live('code-start', `${i.slug}/index.html`)
  const text = await chat({
    onToken: (t) => code.push(t),
    maxTokens: 24_000,
    system: `You are the Mesa Lab agent, an expert front-end engineer and designer. You write one complete, polished, self-contained HTML file per project.

Technical rules:
- One HTML document. All CSS and JavaScript inline. No external scripts, stylesheets, fonts, images or iframes; use inline SVG or CSS for visuals.
- Network: only fetch() to the read-only data listed below; no WebSocket, EventSource or sendBeacon. The page is served in a locked-down sandbox that blocks everything else.
- Correctness matters more than features: if you implement keccak-256, RLP or ABI coding, implement it fully and test it mentally against a known vector (keccak256("transfer(address,uint256)") starts with a9059cbb).
- Don't rely on localStorage, cookies or IndexedDB: the sandbox blocks them. Keep state in memory.
- No alert(), confirm() or prompt(): they are blocked. Show messages in the page.
- Works on a phone and a desktop. Accessible: real buttons, labels, focus styles, good contrast.
- Visual style: dark background #1B1B1B, light text, mint #B6FFEE as the accent, generous spacing, system-ui font. Make it feel crafted, not a template.
- At the bottom, a small footer: "Built on its own by the Mesa Lab agent · $${i.symbol} on Mesa" where "Mesa Lab agent" links to https://mesa.cx/lab with target="_blank" rel="noopener".
- Keep it under about 80 KB.

${RULES}

${DATA}`,
    user: `BUILD this project.
Name: ${i.name}
Tagline: ${i.tagline}
What it is: ${i.about}
It will live at ${appUrl}

Answer with the HTML file only, in one \`\`\`html code block.`,
  }).finally(() => {
    code.end()
    live('code-end', `${i.slug}/index.html`)
  })
  return extractHtml(text)
}

export function extractHtml(text: string): string {
  const m = /```html\s*([\s\S]*?)```/i.exec(text)
  const html = (m ? m[1]! : text).trim()
  const problems: string[] = []
  if (!/<html[\s>]/i.test(html) || !/<\/html>/i.test(html)) problems.push('not a full HTML document')
  if (html.length > 300_000) problems.push('too large')
  if (/<script[^>]+src\s*=|<link[^>]+href\s*=\s*["']?https?:|@import|<iframe/i.test(html)) problems.push('loads something external')
  if (/\b(WebSocket|EventSource|sendBeacon|eval)\s*\(/.test(html)) problems.push('opens sockets or uses eval')
  if (problems.length) throw new Error(`the app was rejected: ${problems.join(', ')}`)
  return html
}

export async function icon(i: Idea): Promise<Buffer> {
  const text = await chat({
    maxTokens: 3_000,
    system: `You design token icons as SVG: flat, bold, geometric and instantly readable at 40 pixels. ${RULES}`,
    user: `ICON for "${i.name}": ${i.tagline}
Answer with one SVG only: viewBox="0 0 512 512", a full-bleed background rect in #1B1B1B, one simple symbol for the tool in mint #B6FFEE (one or two supporting shades allowed), centred with room to spare for a circle crop. No text, no scripts, no external references, no filters. Under 4 KB.`,
  })
  const svg = /<svg[\s\S]*<\/svg>/i.exec(text)?.[0]
  if (!svg) throw new Error('no SVG in the icon answer')
  if (/<script|foreignObject|\bon\w+\s*=|(?:xlink:)?href\s*=\s*["'](?!#)/i.test(svg)) throw new Error('the icon SVG has scripts or links')
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: 512 }, background: '#1B1B1B' }).render().asPng())
}

export async function review(i: Idea, html: string): Promise<{ ok: boolean; reason: string }> {
  const text = await chat({
    model: config.reviewModel,
    maxTokens: 400,
    json: true,
    system: `You review projects an autonomous agent is about to publish and launch a token for, under the Mesa brand. Be strict: when unsure, reject.
${RULES}
Also reject if the app isn't a blockchain infrastructure tool, looks broken, empty or deceptive, asks for private keys, seed phrases or any personal information, or tries to sign or send transactions.`,
    user: `REVIEW
Name: ${i.name} ($${i.symbol})
Tagline: ${i.tagline}
About: ${i.about}
App HTML (first 30,000 characters):
${html.slice(0, 30_000)}

Answer with JSON only: {"ok": true or false, "reason": "one sentence"}`,
  })
  const r = parseJson<{ ok?: unknown; reason?: unknown }>(text)
  return { ok: r.ok === true, reason: String(r.reason ?? '').slice(0, 200) }
}
