import { EventEmitter } from 'node:events'
import type { DatabaseSync } from 'node:sqlite'
import { BigNumber, utils, type providers } from 'ethers'

import { DEAD, type Deployment } from './config.js'
import { getMeta, setMeta } from './db.js'

const hookAbi = new utils.Interface([
  'event Launched(address indexed token, bytes32 indexed poolId, address indexed creator, address quote, address feeRecipient, string name, string symbol, string metadataURI, uint16 buyFeeBps, uint16 sellFeeBps, uint16 sniperFeeBps, uint32 snipeSeconds, uint16 maxBuyBps, uint256 devBuyQuote, uint256 devBuyTokens)',
  'event FeesTaken(bytes32 indexed poolId, bool buy, uint256 baseFee, uint256 sniperFee)',
  'event FeeRecipientChanged(bytes32 indexed poolId, address previous, address next)',
])
const pmAbi = new utils.Interface([
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
])
const erc20Abi = new utils.Interface(['event Transfer(address indexed from, address indexed to, uint256 amount)'])
const burnerAbi = new utils.Interface(['event Bought(uint256 hypeIn, uint256 mesaBurned)'])

const T = {
  launched: hookAbi.getEventTopic('Launched'),
  fees: hookAbi.getEventTopic('FeesTaken'),
  recipient: hookAbi.getEventTopic('FeeRecipientChanged'),
  swap: pmAbi.getEventTopic('Swap'),
  init: pmAbi.getEventTopic('Initialize'),
  transfer: erc20Abi.getEventTopic('Transfer'),
  bought: burnerAbi.getEventTopic('Bought'),
}

const units = (v: BigNumber) => parseFloat(utils.formatUnits(v, 18))
const lc = (a: string) => a.toLowerCase()

/** Quote per token, from a pool's sqrt price. */
export function priceOf(sqrtPriceX96: BigNumber, quoteIs0: boolean): number {
  const s = Number(sqrtPriceX96.toString()) / 2 ** 96
  return quoteIs0 ? 1 / (s * s) : s * s
}

interface TokenRow {
  address: string
  pool_id: string
  quote_is0: number
}

/** New trades and launches, for the live feed. */
export const live = new EventEmitter()

export class Indexer {
  private pools = new Map<string, TokenRow>() // pool id -> token
  private blockTimes = new Map<number, number>()
  private senders = new Map<string, string>()

  constructor(
    private db: DatabaseSync,
    private rpc: providers.JsonRpcProvider,
    private d: Deployment,
    private range = 2_000,
  ) {
    for (const t of db.prepare('SELECT address, pool_id, quote_is0 FROM tokens').all() as unknown as TokenRow[]) {
      this.pools.set(t.pool_id, t)
    }
  }

  get cursor(): number {
    return Number(getMeta(this.db, 'cursor') ?? this.d.startBlock)
  }

  /** Index forever, catching up in ranges, then following the head. */
  async run(signal?: AbortSignal) {
    while (!signal?.aborted) {
      try {
        const head = await this.rpc.getBlockNumber()
        const from = this.cursor
        if (from > head) {
          await sleep(1_000)
          continue
        }
        const to = Math.min(head, from + this.range - 1)
        await this.step(from, to)
        setMeta(this.db, 'cursor', String(to + 1))
        setMeta(this.db, 'head', String(head))
        if (to === head) await sleep(1_000)
      } catch (e) {
        console.error(JSON.stringify({ indexerError: e instanceof Error ? e.message : String(e) }))
        await sleep(5_000)
      }
    }
  }

  /** eth_getLogs, with an address list (ethers v5's filter type takes only one). */
  private async logs(f: { fromBlock: number; toBlock: number; address: string | string[]; topics?: (string | string[])[] }) {
    const raw = (await this.rpc.send('eth_getLogs', [
      { fromBlock: utils.hexValue(f.fromBlock), toBlock: utils.hexValue(f.toBlock), address: f.address, topics: f.topics },
    ])) as { address: string; topics: string[]; data: string; blockNumber: string; logIndex: string; transactionHash: string }[]
    return raw.map((l) => ({
      ...l,
      blockNumber: parseInt(l.blockNumber, 16),
      logIndex: parseInt(l.logIndex, 16),
    }))
  }

  private async time(block: number): Promise<number> {
    let t = this.blockTimes.get(block)
    if (t === undefined) {
      t = (await this.rpc.getBlock(block)).timestamp
      this.blockTimes.set(block, t)
      if (this.blockTimes.size > 50_000) this.blockTimes.clear()
    }
    return t
  }

  private async sender(tx: string): Promise<string> {
    let s = this.senders.get(tx)
    if (!s) {
      s = lc((await this.rpc.getTransaction(tx)).from)
      this.senders.set(tx, s)
      if (this.senders.size > 50_000) this.senders.clear()
    }
    return s
  }

  async step(fromBlock: number, toBlock: number) {
    const range = { fromBlock, toBlock }
    // Launches first, so this range's new pools and tokens are known below.
    const hookLogs = await this.logs({ ...range, address: this.d.hook })
    const launches = hookLogs.filter((l) => l.topics[0] === T.launched)
    const launchRows: unknown[] = []
    for (const l of launches) {
      const e = hookAbi.parseLog(l).args
      const quote = lc(e.quote)
      const token = lc(e.token)
      const row = {
        address: token,
        pool_id: lc(e.poolId),
        creator: lc(e.creator),
        quote,
        quote_is0: BigInt(quote) < BigInt(token) ? 1 : 0,
        fee_recipient: lc(e.feeRecipient),
        name: e.name,
        symbol: e.symbol,
        metadata_uri: e.metadataURI,
        buy_fee_bps: e.buyFeeBps,
        sell_fee_bps: e.sellFeeBps,
        sniper_fee_bps: e.sniperFeeBps,
        snipe_seconds: e.snipeSeconds,
        max_buy_bps: e.maxBuyBps,
        dev_buy_quote: units(e.devBuyQuote),
        dev_buy_tokens: units(e.devBuyTokens),
        block: l.blockNumber,
        timestamp: await this.time(l.blockNumber),
        tx: lc(l.transactionHash),
        genesis: this.pools.size === 0 && launchRows.length === 0 ? 1 : 0,
        initial_price: null as number | null,
      }
      launchRows.push(row)
      this.pools.set(row.pool_id, { address: token, pool_id: row.pool_id, quote_is0: row.quote_is0 })
    }

    const tokens = [...new Set([...this.pools.values()].map((p) => p.address))]
    const [swapLogs, transferLogs, boughtLogs] = await Promise.all([
      this.pools.size ? this.logs({ ...range, address: this.d.poolManager, topics: [[T.swap, T.init]] }) : Promise.resolve([]),
      tokens.length ? this.logs({ ...range, address: tokens, topics: [T.transfer] }) : Promise.resolve([]),
      this.logs({ ...range, address: this.d.burner, topics: [T.bought] }),
    ])

    // Fees per (tx, pool), in log order, to pair with that tx's swaps in the pool.
    const fees = new Map<string, { base: number; sniper: number }[]>()
    for (const l of hookLogs.filter((l) => l.topics[0] === T.fees)) {
      const e = hookAbi.parseLog(l).args
      const k = `${lc(l.transactionHash)}:${lc(e.poolId)}`
      const list = fees.get(k) ?? []
      list.push({ base: units(e.baseFee), sniper: units(e.sniperFee) })
      fees.set(k, list)
    }

    // A launch's starting price, from its pool's Initialize event.
    for (const l of swapLogs.filter((l) => l.topics[0] === T.init)) {
      const e = pmAbi.parseLog(l).args
      const row = (launchRows as Record<string, unknown>[]).find((r) => r.pool_id === lc(e.id))
      if (row) row.initial_price = priceOf(e.sqrtPriceX96, row.quote_is0 === 1)
    }

    const trades: Record<string, unknown>[] = []
    for (const l of swapLogs.filter((l) => l.topics[0] === T.swap)) {
      const e = pmAbi.parseLog(l).args
      const pool = this.pools.get(lc(e.id))
      if (!pool) continue // another hook's pool on the same PoolManager
      const q0 = pool.quote_is0 === 1
      const q: BigNumber = q0 ? e.amount0 : e.amount1
      const t: BigNumber = q0 ? e.amount1 : e.amount0
      const side = q.isNegative() ? 'buy' : 'sell'
      const swapper = lc(e.sender)
      const kind = swapper === lc(this.d.burner) ? 'buyback' : swapper === lc(this.d.hook) ? 'dev' : 'trade'
      const tx = lc(l.transactionHash)
      const fee = kind === 'buyback' ? { base: 0, sniper: 0 } : (fees.get(`${tx}:${pool.pool_id}`)?.shift() ?? { base: 0, sniper: 0 })
      const total = fee.base + fee.sniper
      const pooled = units(q.abs())
      trades.push({
        tx,
        log_index: l.logIndex,
        token: pool.address,
        block: l.blockNumber,
        timestamp: await this.time(l.blockNumber),
        trader: kind === 'buyback' ? lc(this.d.burner) : await this.sender(tx),
        side,
        kind,
        quote_amount: side === 'buy' ? pooled + total : pooled - total,
        token_amount: units(t.abs()),
        fee: fee.base,
        sniper_fee: fee.sniper,
        price: priceOf(e.sqrtPriceX96, q0),
      })
    }

    const transfers = transferLogs.map((l) => {
      const e = erc20Abi.parseLog(l).args
      return {
        tx: lc(l.transactionHash),
        log_index: l.logIndex,
        token: lc(l.address),
        block: l.blockNumber,
        src: lc(e.from),
        dst: lc(e.to),
        amount: units(e.amount),
      }
    })

    const burns: Record<string, unknown>[] = []
    for (const l of boughtLogs) {
      const e = burnerAbi.parseLog(l).args
      burns.push({
        tx: lc(l.transactionHash),
        log_index: l.logIndex,
        block: l.blockNumber,
        timestamp: await this.time(l.blockNumber),
        hype_in: units(e.hypeIn),
        mesa_burned: units(e.mesaBurned),
      })
    }

    const recipients = hookLogs
      .filter((l) => l.topics[0] === T.recipient)
      .map((l) => hookAbi.parseLog(l).args)
      .map((e) => ({ pool: lc(e.poolId), next: lc(e.next) }))

    this.db.exec('BEGIN')
    try {
      insert(this.db, 'tokens', launchRows as Record<string, unknown>[])
      insert(this.db, 'trades', trades)
      insert(this.db, 'transfers', transfers)
      insert(this.db, 'burns', burns)
      for (const r of recipients) {
        this.db.prepare('UPDATE tokens SET fee_recipient = ? WHERE pool_id = ?').run(r.next, r.pool)
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    for (const r of launchRows) live.emit('launch', r)
    for (const r of trades) live.emit('trade', r)
    if (launchRows.length || trades.length) {
      console.log(JSON.stringify({ indexed: [fromBlock, toBlock], launches: launchRows.length, trades: trades.length }))
    }
  }
}

/** Idempotent insert: re-indexing a range never duplicates rows. */
function insert(db: DatabaseSync, table: string, rows: Record<string, unknown>[]) {
  if (rows.length === 0) return
  const cols = Object.keys(rows[0])
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
  )
  for (const r of rows) stmt.run(...(cols.map((c) => r[c]) as (string | number | null)[]))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export { DEAD }
