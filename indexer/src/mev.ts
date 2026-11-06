import type { DatabaseSync } from 'node:sqlite'

/**
 * Sandwich bots, found from the trades themselves.
 *
 * A sandwich: wallet W trades one way (the front-run), another wallet trades
 * the same way right after (the victim), then W trades back the same number of
 * tokens (the back-run), all within a few seconds. W is marked as an MEV bot,
 * on every token; the victim's trade is marked as sandwiched.
 *
 * Scans the last 3 days at start, then only new blocks every 30 seconds.
 */
// Front-run to back-run, at most. In seconds, not blocks: Elysium makes a block
// for nearly every transaction, so a few seconds can be dozens of blocks.
const WINDOW_SECONDS = 20
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
}

export function startMev(db: DatabaseSync) {
  /** Bot wallet -> sandwiches seen. */
  const bots = new Map<string, number>()
  const victims = new Set<string>() // tx
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
        `SELECT tx, token, block, log_index, timestamp, trader, side, token_amount FROM trades
         WHERE timestamp >= ? AND kind = 'trade' ORDER BY token, block, log_index`,
      )
      .all((since ?? Math.floor(Date.now() / 1000)) - WINDOW_SECONDS) as unknown as T[]
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i]!
      if (!a.trader || seen.has(a.tx)) continue
      let victimsHere: string[] = []
      for (let j = i + 1; j < rows.length; j++) {
        const b = rows[j]!
        if (b.token !== a.token || b.timestamp > a.timestamp + WINDOW_SECONDS) break
        if (b.trader === a.trader) {
          if (
            b.side !== a.side &&
            Math.abs(b.token_amount - a.token_amount) <= a.token_amount * SAME_AMOUNT &&
            victimsHere.length
          ) {
            seen.add(a.tx)
            bots.set(a.trader, (bots.get(a.trader) ?? 0) + 1)
            for (const v of victimsHere) victims.add(v)
          }
          break // W's next trade on this token ends the window either way
        }
        if (b.side === a.side) victimsHere = [...victimsHere, b.tx]
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
    isBot: (a: string | null | undefined) => !!a && bots.has(a.toLowerCase()),
    isVictim: (tx: string) => victims.has(tx),
    bots,
  }
}
