/**
 * Scores the Mesa Builder Drop (airdrop.ts) on its own thread and database
 * connection whenever the API asks (with the current MEV bot list), and posts
 * the result back. Its queries never hold up a request.
 */
import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'

import type { Network } from './config.js'
import { computeAirdrop } from './airdrop.js'

const { dbPath, network } = workerData as { dbPath: string; network: Network }
const db = new DatabaseSync(dbPath)
db.exec('PRAGMA busy_timeout = 5000')

parentPort!.on('message', (m: { bots: string[] }) => {
  const started = Date.now()
  try {
    const bots = new Set(m.bots)
    const r = computeAirdrop(db, network, (a) => bots.has(a))
    parentPort!.postMessage({ ...r, scores: [...r.scores] })
    console.log(JSON.stringify({ airdropMs: Date.now() - started, wallets: r.wallets }))
  } catch (e) {
    console.error(JSON.stringify({ airdropError: e instanceof Error ? e.stack : String(e) }))
    parentPort!.postMessage(null)
  }
})
