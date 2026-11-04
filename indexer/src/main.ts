/**
 * Mesa indexer and terminal API.
 *
 * Env:
 *   NETWORK   testnet | mainnet (must be in config.ts)   default testnet
 *   RPC       Elysium RPC; defaults to the network's public one
 *   DB        SQLite file                                  default ./mesa-<network>.db
 *   PORT      API port                                     default 8080
 *   RANGE     blocks per getLogs request                   default 2000
 */
import { providers } from 'ethers'

import { serve } from './api.js'
import { deployments } from './config.js'
import { open } from './db.js'
import { Indexer } from './indexer.js'

const net = process.env.NETWORK ?? 'testnet'
const d = deployments[net]
if (!d) throw new Error(`no Mesa deployment configured for ${net}`)

const db = open(process.env.DB ?? `./mesa-${net}.db`)
const rpc = new providers.StaticJsonRpcProvider(process.env.RPC ?? d.rpc, d.chainId)
const port = Number(process.env.PORT ?? 8080)

serve(db, d, port)
console.log(JSON.stringify({ api: port, network: net }))
void new Indexer(db, rpc, d, Number(process.env.RANGE ?? 2_000)).run()
