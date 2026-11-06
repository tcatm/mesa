import type { DatabaseSync } from 'node:sqlite'

/**
 * Sandwich bots, found from the trades themselves.
 *
 * A sandwich, back to back on one token with nothing else between: wallet W
 * trades one way (the front-run), other wallets trade the same way (the
 * victims), then W trades back the same number of tokens (the back-run) for a
 * profit, within seconds. A wallet that does this at least twice is marked as an
 * MEV bot on every token, and its victims' trades as sandwiched. (Once could be
 * a person flipping fast; bots do it all day.)
 *
 * Scans the last 3 days at start, then only new blocks every 30 seconds.
 */
// Front-run to back-run, at most. In seconds, not blocks: Elysium makes a block
// for nearly every transaction, so a few seconds can be dozens of blocks.
const WINDOW_SECONDS = 15
const MIN_SANDWICHES = 2
const SAME_AMOUNT = 0.01 // back-run size within 1% of the front-run's tokens
const START_SECONDS = 3 * 86_400

interface T {
  tx: string
  token: string
  block: number
  log_index: number
  timestamp: number
  trader: string | null
  side: string
  token_amount: number
  quote_amount: number
}

export function startMev(db: DatabaseSync) {
  /** Bot wallet -> sandwiches seen. */
  const bots = new Map<string, number>()
  const victims = new Map<string, string>() // victim tx -> bot
  const seen = new Set<string>() // front-run tx, so overlapping scans don't count twice
  let from = 0

  function scan() {
    const head = (db.prepare('SELECT MAX(block) b FROM trades').get() as { b: number | null }).b
    if (head === null) return
    if (!from) {
      const s = db
        .prepare('SELECT MIN(block) b FROM trades WHERE timestamp > ?')
        .get(Math.floor(Date.now() / 1000) - START_SECONDS) as { b: number | null }
      from = s.b ?? head
    }
    // Re-read a little back so a sandwich split across two scans is still whole.
    const since = (db.prepare('SELECT MIN(timestamp) t FROM trades WHERE block >= ?').get(from) as { t: number | null }).t
    const rows = db
      .prepare(
        `SELECT tx, token, block, log_index, timestamp, trader, side, token_amount, quote_amount FROM trades
         WHERE timestamp >= ? AND kind = 'trade' ORDER BY token, block, log_index`,
      )
      .all((since ?? Math.floor(Date.now() / 1000)) - WINDOW_SECONDS) as unknown as T[]
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i]!
      if (!a.trader || seen.has(a.tx)) continue
      const victimsHere: string[] = []
      for (let j = i + 1; j < rows.length; j++) {
        const b = rows[j]!
        if (b.token !== a.token || b.timestamp > a.timestamp + WINDOW_SECONDS) break
        if (b.trader !== a.trader) {
          // Only same-way trades by others may sit between the two legs.
          if (b.side !== a.side) break
          victimsHere.push(b.tx)
          continue
        }
        const sameSize = Math.abs(b.token_amount - a.token_amount) <= a.token_amount * SAME_AMOUNT
        // Bought for less HYPE than it sold for (or sold for more than it bought back).
        const profit = a.side === 'buy' ? b.quote_amount > a.quote_amount : a.quote_amount > b.quote_amount
        if (b.side !== a.side && sameSize && profit && victimsHere.length) {
          seen.add(a.tx)
          bots.set(a.trader, (bots.get(a.trader) ?? 0) + 1)
          for (const v of victimsHere) victims.set(v, a.trader)
        }
        break
      }
    }
    from = head + 1
  }

  const run = () => {
    try {
      scan()
    } catch (e) {
      console.error('mev scan', e)
    }
  }
  run()
  setInterval(run, 30_000).unref()

  return {
    isBot: (a: string | null | undefined) => !!a && (bots.get(a.toLowerCase()) ?? 0) >= MIN_SANDWICHES,
    isVictim: (tx: string) => (bots.get(victims.get(tx) ?? '') ?? 0) >= MIN_SANDWICHES,
    bots,
  }
}
