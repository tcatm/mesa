import { EventEmitter } from 'node:events'
import type { DatabaseSync } from 'node:sqlite'
import { BigNumber, utils, type providers } from 'ethers'

import { ZERO, type Network } from './config.js'
import { getMeta, setMeta } from './db.js'

const pmAbi = new utils.Interface([
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
])
const mesaAbi = new utils.Interface([
  'event Launched(address indexed token, bytes32 indexed poolId, address indexed creator, address quote, address feeRecipient, string name, string symbol, string metadataURI, uint16 buyFeeBps, uint16 sellFeeBps, uint16 sniperFeeBps, uint32 snipeSeconds, uint16 maxBuyBps, uint256 devBuyQuote, uint256 devBuyTokens)',
  'event FeesTaken(bytes32 indexed poolId, bool buy, uint256 baseFee, uint256 sniperFee)',
  'event Bought(uint256 hypeIn, uint256 mesaBurned)',
])
const erc20 = new utils.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 amount)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
])
const T = {
  init: pmAbi.getEventTopic('Initialize'),
  swap: pmAbi.getEventTopic('Swap'),
  launched: mesaAbi.getEventTopic('Launched'),
  fees: mesaAbi.getEventTopic('FeesTaken'),
  bought: mesaAbi.getEventTopic('Bought'),
  transfer: erc20.getEventTopic('Transfer'),
}

const lc = (a: string) => a.toLowerCase()
const units = (v: BigNumber, d: number) => parseFloat(utils.formatUnits(v, d))

interface RawLog {
  address: string
  topics: string[]
  data: string
  blockNumber: number
  logIndex: number
  transactionHash: string
}
interface Pool {
  id: string
  token: string
  quote: string
  quote_is0: number
  venue: string
  hook: string
}

/** New trades and pools, for the live feed. */
export const live = new EventEmitter()

export class Indexer {
  private pools = new Map<string, Pool>()
  private decimals = new Map<string, number>()
  /** Currencies seen in any pool so far: a launch's quote is the side that existed before. */
  private seen = new Set<string>()
  /** quote token -> HYPE per quote, from its own HYPE pool's last trade. */
  private hypeRate = new Map<string, number>()
  private hype: Set<string>
  private blockTimes = new Map<number, number>()

  constructor(
    private db: DatabaseSync,
    private rpc: providers.JsonRpcProvider,
    private n: Network,
  ) {
    this.hype = new Set(n.hype.map(lc))
    for (const p of db.prepare('SELECT id, token, quote, quote_is0, venue, hook FROM pools').all() as unknown as Pool[]) {
      this.pools.set(p.id, p)
      this.seen.add(p.token)
      this.seen.add(p.quote)
    }
    for (const t of db.prepare('SELECT address, decimals FROM tokens').all() as { address: string; decimals: number }[]) {
      this.decimals.set(t.address, t.decimals)
    }
    // Latest HYPE rate of every quote, from the most recent trade of a token that is itself a quote.
    for (const r of db
      .prepare(
        `SELECT token, price_hype FROM (SELECT token, price_hype, ROW_NUMBER() OVER (PARTITION BY token ORDER BY block DESC, log_index DESC) rn FROM trades WHERE price_hype IS NOT NULL) WHERE rn = 1`,
      )
      .all() as { token: string; price_hype: number }[]) {
      this.hypeRate.set(r.token, r.price_hype)
    }
  }

  get cursor(): number {
    return Number(getMeta(this.db, 'cursor') ?? this.n.startBlock)
  }

  async run(signal?: AbortSignal) {
    while (!signal?.aborted) {
      try {
        const head = await this.rpc.getBlockNumber()
        const from = this.cursor
        if (from > head) {
          await sleep(1_000)
          continue
        }
        const to = Math.min(head, from + this.n.range - 1)
        await this.step(from, to)
        setMeta(this.db, 'cursor', String(to + 1))
        setMeta(this.db, 'head', String(head))
        if (to === head) await sleep(1_000)
      } catch (e) {
        console.error(JSON.stringify({ indexerError: e instanceof Error ? e.message.slice(0, 300) : String(e) }))
        await sleep(5_000)
      }
    }
  }

  // ---------------------------------------------------------------- rpc helpers

  private async logs(fromBlock: number, toBlock: number, address: string | string[], topics?: (string | string[])[]) {
    const raw = (await this.rpc.send('eth_getLogs', [
      { fromBlock: utils.hexValue(fromBlock), toBlock: utils.hexValue(toBlock), address, topics },
    ])) as (Omit<RawLog, 'blockNumber' | 'logIndex'> & { blockNumber: string; logIndex: string })[]
    return raw.map((l) => ({ ...l, blockNumber: parseInt(l.blockNumber, 16), logIndex: parseInt(l.logIndex, 16) })) as RawLog[]
  }

  /** JSON-RPC batch, in chunks. */
  private async batch(calls: { method: string; params: unknown[] }[], size = 50): Promise<unknown[]> {
    const out: unknown[] = []
    for (let i = 0; i < calls.length; i += size) {
      const chunk = calls.slice(i, i + size)
      const body = chunk.map((c, j) => ({ jsonrpc: '2.0', id: j, method: c.method, params: c.params }))
      const res = await fetch(this.rpc.connection.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = (await res.json()) as { id: number; result?: unknown; error?: unknown }[]
      const byId = new Map(json.map((r) => [r.id, r.result]))
      for (let j = 0; j < chunk.length; j++) out.push(byId.get(j) ?? null)
    }
    return out
  }

  private async times(blocks: number[]) {
    const missing = [...new Set(blocks)].filter((b) => !this.blockTimes.has(b))
    const res = (await this.batch(missing.map((b) => ({ method: 'eth_getBlockByNumber', params: [utils.hexValue(b), false] })))) as
      | ({ timestamp: string } | null)[]
    missing.forEach((b, i) => res[i] && this.blockTimes.set(b, parseInt(res[i]!.timestamp, 16)))
    if (this.blockTimes.size > 100_000) this.blockTimes.clear()
  }

  private async senders(txs: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(txs)]
    const res = (await this.batch(unique.map((h) => ({ method: 'eth_getTransactionByHash', params: [h] })))) as ({ from: string } | null)[]
    return new Map(unique.map((h, i) => [h, res[i] ? lc(res[i]!.from) : '']))
  }

  /** Name, symbol, decimals and supply of tokens not seen before. */
  private async describe(tokens: string[]) {
    const fresh = [...new Set(tokens)].filter((t) => t !== ZERO && !this.decimals.has(t))
    if (!fresh.length) return [] as Record<string, unknown>[]
    const fns = ['name', 'symbol', 'decimals', 'totalSupply'] as const
    const res = (await this.batch(
      fresh.flatMap((t) => fns.map((f) => ({ method: 'eth_call', params: [{ to: t, data: erc20.encodeFunctionData(f) }, 'latest'] }))),
    )) as (string | null)[]
    return fresh.map((t, i) => {
      const dec = (f: (typeof fns)[number]) => {
        const r = res[i * 4 + fns.indexOf(f)]
        try {
          return r && r !== '0x' ? erc20.decodeFunctionResult(f, r)[0] : null
        } catch {
          return null
        }
      }
      const decimals = Number(dec('decimals') ?? 18)
      const supply = dec('totalSupply') as BigNumber | null
      this.decimals.set(t, decimals)
      return {
        address: t,
        name: (dec('name') as string | null)?.slice(0, 100) ?? null,
        symbol: (dec('symbol') as string | null)?.slice(0, 40) ?? null,
        decimals,
        supply: supply ? units(supply, decimals) : null,
      }
    })
  }

  private dec(t: string) {
    return t === ZERO ? 18 : (this.decimals.get(t) ?? 18)
  }

  /** Quote per token from a pool's sqrt price, adjusted for decimals. */
  private price(p: Pool & { currency0?: string }, sqrtPriceX96: BigNumber): number {
    const s = Number(sqrtPriceX96.toString()) / 2 ** 96
    const c0 = p.quote_is0 ? p.quote : p.token
    const c1 = p.quote_is0 ? p.token : p.quote
    const oneIn0 = s * s * 10 ** (this.dec(c0) - this.dec(c1)) // currency1 per currency0, whole units
    return p.quote_is0 ? 1 / oneIn0 : oneIn0
  }

  /** HYPE per one unit of `quote`, if known. */
  private hypeOf(quote: string): number | null {
    if (this.hype.has(quote)) return 1
    return this.hypeRate.get(quote) ?? null
  }

  // ---------------------------------------------------------------- a range

  async step(fromBlock: number, toBlock: number) {
    const pms = this.n.poolManagers.map((p) => p.address)
    const pmLogs = await this.logs(fromBlock, toBlock, pms, [[T.init, T.swap]])
    const mesaLogs = this.n.mesa ? await this.logs(fromBlock, toBlock, [this.n.mesa.hook, this.n.mesa.burner]) : []

    // 1. New pools, in order, deciding which side is the token.
    const newPools: Record<string, unknown>[] = []
    const inits = pmLogs.filter((l) => l.topics[0] === T.init)
    const initSenders = await this.senders(inits.map((l) => lc(l.transactionHash)))
    const stablesAndHype = new Set([...this.hype, ...(this.n.usd ? [lc(this.n.usd.address)] : [])])
    for (const l of inits) {
      const e = pmAbi.parseLog(l).args
      const c0 = lc(e.currency0)
      const c1 = lc(e.currency1)
      const hook = lc(e.hooks)
      let quoteIs0: boolean
      if (stablesAndHype.has(c0) !== stablesAndHype.has(c1)) quoteIs0 = stablesAndHype.has(c0)
      else if (this.seen.has(c0) !== this.seen.has(c1)) quoteIs0 = this.seen.has(c0)
      else quoteIs0 = true
      const pool = {
        id: lc(e.id),
        pool_manager: lc(l.address),
        hook,
        venue: this.n.venues[hook] ?? (hook === ZERO ? 'Uniswap v4' : `Other ${hook.slice(0, 6)}…${hook.slice(-4)}`),
        currency0: c0,
        currency1: c1,
        token: quoteIs0 ? c1 : c0,
        quote: quoteIs0 ? c0 : c1,
        quote_is0: quoteIs0 ? 1 : 0,
        fee: Number(e.fee),
        tick_spacing: Number(e.tickSpacing),
        block: l.blockNumber,
        timestamp: 0,
        tx: lc(l.transactionHash),
        creator: initSenders.get(lc(l.transactionHash)) ?? '',
        initial_price: 0,
      }
      this.seen.add(c0)
      this.seen.add(c1)
      this.pools.set(pool.id, pool)
      newPools.push(pool)
    }
    const newTokens = await this.describe(newPools.flatMap((p) => [p.currency0 as string, p.currency1 as string]))
    for (const p of newPools) {
      const l = inits.find((x) => lc(x.transactionHash) === p.tx && lc(pmAbi.parseLog(x).args.id) === p.id)!
      p.initial_price = this.price(p as unknown as Pool, pmAbi.parseLog(l).args.sqrtPriceX96)
    }

    // 2. Swaps on known pools.
    const swaps = pmLogs.filter((l) => l.topics[0] === T.swap && this.pools.has(lc(l.topics[1])))
    await this.times([...swaps.map((l) => l.blockNumber), ...inits.map((l) => l.blockNumber), ...mesaLogs.map((l) => l.blockNumber)])
    for (const p of newPools) p.timestamp = this.blockTimes.get(p.block as number) ?? 0
    const swapSenders = await this.senders(swaps.map((l) => lc(l.transactionHash)))

    // Mesa's exact fees, paired with its swaps by (tx, pool) in log order.
    const fees = new Map<string, { base: number; sniper: number }[]>()
    for (const l of mesaLogs.filter((l) => l.topics[0] === T.fees)) {
      const e = mesaAbi.parseLog(l).args
      const k = `${lc(l.transactionHash)}:${lc(e.poolId)}`
      const list = fees.get(k) ?? []
      list.push({ base: units(e.baseFee, 18), sniper: units(e.sniperFee, 18) })
      fees.set(k, list)
    }
    const mesaHook = this.n.mesa ? lc(this.n.mesa.hook) : null
    const mesaBurner = this.n.mesa ? lc(this.n.mesa.burner) : null

    const trades: Record<string, unknown>[] = []
    for (const l of swaps) {
      const e = pmAbi.parseLog(l).args
      const p = this.pools.get(lc(e.id))!
      const q: BigNumber = p.quote_is0 ? e.amount0 : e.amount1
      const t: BigNumber = p.quote_is0 ? e.amount1 : e.amount0
      if (q.isZero() && t.isZero()) continue
      const side = q.isNegative() ? 'buy' : 'sell'
      const tx = lc(l.transactionHash)
      const swapper = lc(e.sender)
      const isMesa = p.hook === mesaHook
      const kind = isMesa && swapper === mesaBurner ? 'buyback' : isMesa && swapper === mesaHook ? 'dev' : 'trade'
      const fee = isMesa && kind !== 'buyback' ? (fees.get(`${tx}:${p.id}`)?.shift() ?? { base: 0, sniper: 0 }) : { base: 0, sniper: 0 }
      const pooled = units(q.abs(), this.dec(p.quote))
      const quoteAmount = side === 'buy' ? pooled + fee.base + fee.sniper : pooled - fee.base - fee.sniper
      const price = this.price(p, e.sqrtPriceX96)
      const rate = this.hypeOf(p.quote)
      const priceHype = rate === null ? null : price * rate
      // A token that is itself a quote elsewhere: its HYPE rate is this trade's.
      if (priceHype !== null && this.hype.has(p.quote)) this.hypeRate.set(p.token, priceHype)
      trades.push({
        tx,
        log_index: l.logIndex,
        pool: p.id,
        token: p.token,
        block: l.blockNumber,
        timestamp: this.blockTimes.get(l.blockNumber) ?? 0,
        trader: kind === 'buyback' ? mesaBurner : swapSenders.get(tx) || null,
        side,
        kind,
        quote_amount: quoteAmount,
        token_amount: units(t.abs(), this.dec(p.token)),
        fee: fee.base,
        sniper_fee: fee.sniper,
        price,
        price_hype: priceHype,
        value_hype: rate === null ? null : quoteAmount * rate,
      })
    }

    // 3. Transfers of every launched token, for holders.
    const tokens = [...new Set([...this.pools.values()].map((p) => p.token))].filter((t) => t !== ZERO)
    const transferLogs: RawLog[] = []
    for (let i = 0; i < tokens.length; i += 300) {
      transferLogs.push(...(await this.logs(fromBlock, toBlock, tokens.slice(i, i + 300), [T.transfer])))
    }
    const transfers = transferLogs
      .filter((l) => l.topics.length === 3)
      .map((l) => {
        const e = erc20.parseLog(l).args
        const token = lc(l.address)
        return {
          tx: lc(l.transactionHash),
          log_index: l.logIndex,
          token,
          block: l.blockNumber,
          src: lc(e.from),
          dst: lc(e.to),
          amount: units(e.amount, this.dec(token)),
        }
      })

    // 4. Mesa launches and burns.
    const launches = mesaLogs
      .filter((l) => l.topics[0] === T.launched)
      .map((l) => {
        const e = mesaAbi.parseLog(l).args
        return {
          token: lc(e.token),
          pool_id: lc(e.poolId),
          creator: lc(e.creator),
          fee_recipient: lc(e.feeRecipient),
          metadata_uri: e.metadataURI,
          buy_fee_bps: e.buyFeeBps,
          sell_fee_bps: e.sellFeeBps,
          sniper_fee_bps: e.sniperFeeBps,
          snipe_seconds: e.snipeSeconds,
          max_buy_bps: e.maxBuyBps,
          dev_buy_quote: units(e.devBuyQuote, 18),
          dev_buy_tokens: units(e.devBuyTokens, 18),
          genesis: 0,
        }
      })
    if (launches.length && !(this.db.prepare('SELECT 1 FROM mesa_launches LIMIT 1').get() as unknown)) launches[0].genesis = 1
    const burns = mesaLogs
      .filter((l) => l.topics[0] === T.bought)
      .map((l) => {
        const e = mesaAbi.parseLog(l).args
        return {
          tx: lc(l.transactionHash),
          log_index: l.logIndex,
          block: l.blockNumber,
          timestamp: this.blockTimes.get(l.blockNumber) ?? 0,
          hype_in: units(e.hypeIn, 18),
          mesa_burned: units(e.mesaBurned, 18),
        }
      })

    // 5. One transaction for the range.
    const firstBlock = new Map<string, number>()
    for (const p of newPools) for (const c of [p.currency0, p.currency1] as string[]) if (!firstBlock.has(c)) firstBlock.set(c, p.block as number)
    this.db.exec('BEGIN')
    try {
      insert(this.db, 'pools', newPools)
      insert(this.db, 'tokens', newTokens.map((t) => ({ ...t, first_block: firstBlock.get(t.address as string) ?? fromBlock })))
      insert(this.db, 'mesa_launches', launches)
      insert(this.db, 'trades', trades)
      insert(this.db, 'burns', burns)
      const ins = this.db.prepare(
        'INSERT OR IGNORE INTO transfers (tx, log_index, token, block, src, dst, amount) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      const bal = this.db.prepare(
        'INSERT INTO balances (token, holder, balance) VALUES (?, ?, ?) ON CONFLICT(token, holder) DO UPDATE SET balance = balance + excluded.balance',
      )
      for (const t of transfers) {
        // Balances move only for transfers not seen before, so re-indexing a range is harmless.
        if (ins.run(t.tx, t.log_index, t.token, t.block, t.src, t.dst, t.amount).changes === 0) continue
        if (t.src !== ZERO) bal.run(t.token, t.src, -t.amount)
        if (t.dst !== ZERO) bal.run(t.token, t.dst, t.amount)
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    for (const p of newPools) live.emit('pool', p)
    for (const t of trades) live.emit('trade', t)
    if (newPools.length || trades.length) {
      console.log(JSON.stringify({ indexed: [fromBlock, toBlock], pools: newPools.length, trades: trades.length, transfers: transfers.length }))
    }
  }
}

function insert(db: DatabaseSync, table: string, rows: Record<string, unknown>[]) {
  if (rows.length === 0) return
  const cols = Object.keys(rows[0])
  const stmt = db.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
  for (const r of rows) stmt.run(...(cols.map((c) => (typeof r[c] === 'boolean' ? Number(r[c]) : r[c])) as (string | number | null)[]))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
