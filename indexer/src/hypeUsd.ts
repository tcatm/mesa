/**
 * HYPE's dollar price, from Hyperliquid's own market (HYPE/USDC spot, @107;
 * the HYPE perp's mid if spot is missing), refreshed every 30 seconds.
 *
 * Elysium's own HYPE/USDC pools are thin and lag the market by several
 * percent, which made dollar figures here disagree with every other site.
 * They remain the fallback when Hyperliquid can't be reached for 5 minutes.
 */
const INFO = 'https://api.hyperliquid.xyz/info'
let price: number | null = null
let at = 0
let started = false

async function refresh() {
  try {
    const r = await fetch(INFO, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'allMids' }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) return
    const mids = (await r.json()) as Record<string, string>
    const p = Number(mids['@107'] ?? mids['HYPE'])
    if (Number.isFinite(p) && p > 0) {
      price = p
      at = Date.now()
    }
  } catch {
    // keep the last price; it expires below
  }
}

/** Starts polling (once per thread). */
export function startHypeUsd() {
  if (started) return
  started = true
  void refresh()
  setInterval(() => void refresh(), 30_000).unref()
}

/** The market price if fresh (under 5 minutes old), else null. */
export function marketHypeUsd(): number | null {
  return price !== null && Date.now() - at < 300_000 ? price : null
}
