/**
 * Builds the token table (table.ts) on its own thread and database
 * connection, every 5 seconds, and posts it to the API. Its queries never
 * hold up a request, however long a build takes.
 */
import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'

import type { Network } from './config.js'
import { tableBuilder } from './table.js'

const { dbPath, network } = workerData as { dbPath: string; network: Network }
const db = new DatabaseSync(dbPath)
db.exec('PRAGMA busy_timeout = 5000')
const { build } = tableBuilder(db, network)

async function loop() {
  for (;;) {
    const started = Date.now()
    try {
      parentPort!.postMessage({ rows: build() })
    } catch (e) {
      console.error(JSON.stringify({ tableError: e instanceof Error ? e.message : String(e) }))
    }
    const ms = Date.now() - started
    if (ms > 2_000) console.log(JSON.stringify({ tableMs: ms }))
    await new Promise((r) => setTimeout(r, Math.max(1_000, 5_000 - ms)))
  }
}
void loop()
