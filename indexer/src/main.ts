/**
 * Mesa terminal indexer and API: every launchpad on Elysium's v4 PoolManagers.
 *
 * Env:
 *   NETWORK   mainnet | testnet                 default mainnet
 *   RPC       Elysium RPC; defaults to the network's in config.ts
 *   DB        SQLite file                       default ./terminal-<network>.db
 *   PORT      API port                          default 8080
 */
import { providers } from 'ethers'

import { serve } from './api.js'
import { networks } from './config.js'
import { open } from './db.js'
import { Indexer } from './indexer.js'
import { MetadataWorker } from './metadata.js'

const net = process.env.NETWORK ?? 'mainnet'
const n = networks[net]
if (!n) throw new Error(`unknown network ${net}`)
if (process.env.RPC) n.rpc = process.env.RPC

const db = open(process.env.DB ?? `./terminal-${net}.db`)
const rpc = new providers.StaticJsonRpcProvider(n.rpc, n.chainId)
serve(db, n, Number(process.env.PORT ?? 8080))
console.log(JSON.stringify({ api: Number(process.env.PORT ?? 8080), network: net, rpc: n.rpc.replace(/\/[^/]{20,}$/, '/…') }))
void new Indexer(db, rpc, n).run()
void new MetadataWorker(db, n.rpc).run()
