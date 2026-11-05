import type { DatabaseSync } from 'node:sqlite'

import { getMeta, setMeta } from './db.js'

/**
 * Everything bridged through Mesa's bridge contracts, for the bridge page's
 * tracker: deposits through MesaBridge on HyperEVM, withdrawals through
 * MesaWithdraw on Elysium, and claims of those withdrawals on HyperEVM.
 *
 *  - A deposit is a retryable ticket MesaBridge sends to Elysium's bridge:
 *    MessageDelivered with MesaBridge's aliased address as sender, and the
 *    Inbox's InboxMessageDelivered in the same transaction carrying the
 *    recipient and amount.
 *  - A withdrawal is ArbSys's L2ToL1Tx with MesaWithdraw as caller.
 *  - A claim is the Outbox's OutBoxTransactionExecuted with MesaWithdraw as
 *    the L2 sender; its amount is the withdrawal's at the same position.
 */
export interface BridgeConfig {
  parentRpc: string
  childRpc: string
  bridge: string // Elysium's Bridge on HyperEVM (emits MessageDelivered)
  inbox: string
  outbox: string
  mesaBridgeAliased: string
  mesaWithdraw: string
  parentStart: number
  childStart: number
}

export const MAINNET_BRIDGE: BridgeConfig = {
  parentRpc: process.env.PARENT_RPC ?? 'https://rpc.hyperliquid.xyz/evm',
  childRpc: '',
  bridge: '0x503d572157113faaad4dbed2647bb10b949216b6',
  inbox: '0xce59f8b65ad41c9dae4c07a0571a39824bd92cff',
  outbox: '0xec6b106dfa14428fe5eec2a4065a7be599f02728',
  mesaBridgeAliased: '0xb512a02bb588077cfd84e93ffe3ae76a9dc79c39',
  mesaWithdraw: '0xe1d51502d5bc0d67f48df64a589e89663d0ce59b',
  parentStart: 50_379_778,
  childStart: 460_000,
}

const TOPIC = {
  messageDelivered: '0x5e3c1311ea442664e8b1611bfabef659120ea7a0a2cfc0667700bebc69cbffe1',
  inboxMessageDelivered: '0xff64905f73a67fb594e0f940a8075a860db489ad991e032f48c81123eb52d60b',
  outboxExecuted: '0x20af7f3bbfe38132b8900ae295cd9c8d1914be7052d061a511f3f728dab18964',
  l2ToL1Tx: '0x3e7aafa77dbf186b7fd488006beff893744caa3c4f6f299e8a709fa2087374fc',
}
const ARB_SYS = '0x0000000000000000000000000000000000000064'

interface Log {
  address: string
  topics: string[]
  data: string
  blockNumber: string
  transactionHash: string
  logIndex: string
}

const word = (data: string, i: number) => data.slice(2 + i * 64, 2 + (i + 1) * 64)
const addrOf = (w: string) => `0x${w.slice(24)}`.toLowerCase()
const wei = (w: string) => Number(BigInt(`0x${w}`)) / 1e18
const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`

export function migrate(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bridge_transfers (
      kind TEXT NOT NULL,          -- deposit | withdrawal | claim
      tx TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      block INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      address TEXT NOT NULL,       -- recipient (deposit), sender (withdrawal), destination (claim)
      amount REAL,                 -- HYPE
      position INTEGER,            -- withdrawal / claim outbox position
      PRIMARY KEY (kind, tx, log_index)
    );
    CREATE INDEX IF NOT EXISTS bridge_time ON bridge_transfers(timestamp);
  `)
}

export class BridgeTracker {
  constructor(
    private db: DatabaseSync,
    private cfg: BridgeConfig,
  ) {
    migrate(db)
  }

  private async rpc(url: string, calls: { method: string; params: unknown[] }[]): Promise<unknown[]> {
    if (!calls.length) return []
    const out: unknown[] = []
    for (let i = 0; i < calls.length; i += 40) {
      const chunk = calls.slice(i, i + 40)
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(chunk.map((c, id) => ({ jsonrpc: '2.0', id, ...c }))),
        signal: AbortSignal.timeout(30_000),
      })
      const body = (await res.json()) as { id: number; result?: unknown; error?: { message: string } }[]
      if (!Array.isArray(body)) throw new Error(`rpc: ${JSON.stringify(body).slice(0, 200)}`)
      for (let j = 0; j < chunk.length; j++) {
        const r = body.find((x) => x.id === j)
        if (r?.error) throw new Error(r.error.message)
        out.push(r?.result)
      }
    }
    return out
  }

  private async head(url: string) {
    return parseInt((await this.rpc(url, [{ method: 'eth_blockNumber', params: [] }]))[0] as string, 16)
  }

  private async logs(url: string, from: number, to: number, address: string, topics: (string | null)[]) {
    return (await this.rpc(url, [
      { method: 'eth_getLogs', params: [{ fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, address, topics }] },
    ]))[0] as Log[]
  }

  private async times(url: string, blocks: number[]) {
    const uniq = [...new Set(blocks)]
    const res = (await this.rpc(
      url,
      uniq.map((b) => ({ method: 'eth_getBlockByNumber', params: [`0x${b.toString(16)}`, false] })),
    )) as { timestamp: string }[]
    return new Map(uniq.map((b, i) => [b, parseInt(res[i]?.timestamp ?? '0x0', 16)]))
  }

  private insert(rows: Record<string, unknown>[]) {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO bridge_transfers (kind, tx, log_index, block, timestamp, address, amount, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const r of rows) {
      stmt.run(
        r.kind as string,
        r.tx as string,
        r.log_index as number,
        r.block as number,
        r.timestamp as number,
        r.address as string,
        (r.amount as number | null) ?? null,
        (r.position as number | null) ?? null,
      )
    }
  }

  /** Deposits recorded before message indexes were kept: read them from their receipts. */
  private async backfillMessages() {
    const rows = this.db
      .prepare(`SELECT tx, log_index FROM bridge_transfers WHERE kind = 'deposit' AND position IS NULL LIMIT 40`)
      .all() as { tx: string; log_index: number }[]
    if (!rows.length) return
    const receipts = (await this.rpc(
      this.cfg.parentRpc,
      rows.map((r) => ({ method: 'eth_getTransactionReceipt', params: [r.tx] })),
    )) as ({ logs: Log[] } | null)[]
    const set = this.db.prepare(`UPDATE bridge_transfers SET position = ? WHERE kind = 'deposit' AND tx = ? AND log_index = ?`)
    rows.forEach((r, i) => {
      const l = receipts[i]?.logs.find((x) => parseInt(x.logIndex, 16) === r.log_index && x.topics[0] === TOPIC.messageDelivered)
      if (l?.topics[1]) set.run(Number(BigInt(l.topics[1])), r.tx, r.log_index)
    })
  }

  /** HyperEVM: MesaBridge deposits and claims of MesaWithdraw withdrawals. */
  private async parentStep(range: number): Promise<boolean> {
    await this.backfillMessages().catch(() => {})
    const url = this.cfg.parentRpc
    const head = await this.head(url)
    const from = Number(getMeta(this.db, 'bridge_parent_cursor') ?? this.cfg.parentStart)
    if (from > head) return false
    const to = Math.min(head, from + range - 1)
    const [delivered, claims] = await Promise.all([
      this.logs(url, from, to, this.cfg.bridge, [TOPIC.messageDelivered]),
      this.logs(url, from, to, this.cfg.outbox, [TOPIC.outboxExecuted, null, pad(this.cfg.mesaWithdraw)]),
    ])
    // MessageDelivered data: inbox, kind, sender, dataHash, baseFee, timestamp.
    const ours = delivered.filter((l) => addrOf(word(l.data, 2)) === this.cfg.mesaBridgeAliased)
    const rows: Record<string, unknown>[] = []
    if (ours.length || claims.length) {
      const blocks = [...ours, ...claims].map((l) => parseInt(l.blockNumber, 16))
      const [t, receipts] = await Promise.all([
        this.times(url, blocks),
        this.rpc(url, ours.map((l) => ({ method: 'eth_getTransactionReceipt', params: [l.transactionHash] }))) as Promise<
          { logs: Log[] }[]
        >,
      ])
      ours.forEach((l, i) => {
        const msg = receipts[i]?.logs.find(
          (x) => x.address.toLowerCase() === this.cfg.inbox && x.topics[0] === TOPIC.inboxMessageDelivered && x.topics[1] === l.topics[1],
        )
        if (!msg) return
        // InboxMessageDelivered(bytes data): offset, length, then the retryable's fields.
        const body = `0x${msg.data.slice(2 + 128)}`
        rows.push({
          kind: 'deposit',
          tx: l.transactionHash.toLowerCase(),
          log_index: parseInt(l.logIndex, 16),
          block: parseInt(l.blockNumber, 16),
          timestamp: t.get(parseInt(l.blockNumber, 16)) ?? 0,
          address: addrOf(word(body, 0)),
          amount: wei(word(body, 1)),
          // For deposits, position holds the delayed-message index: the
          // requestId of the Elysium transactions that carry it out.
          position: Number(BigInt(l.topics[1] ?? '0x0')),
        })
      })
      for (const l of claims) {
        const position = Number(BigInt(`0x${word(l.data, 0)}`))
        const w = this.db
          .prepare(`SELECT amount FROM bridge_transfers WHERE kind = 'withdrawal' AND position = ?`)
          .get(position) as { amount: number } | undefined
        rows.push({
          kind: 'claim',
          tx: l.transactionHash.toLowerCase(),
          log_index: parseInt(l.logIndex, 16),
          block: parseInt(l.blockNumber, 16),
          timestamp: t.get(parseInt(l.blockNumber, 16)) ?? 0,
          address: addrOf(l.topics[1] ?? '0x'),
          amount: w?.amount ?? null,
          position,
        })
      }
    }
    this.db.exec('BEGIN')
    try {
      this.insert(rows)
      setMeta(this.db, 'bridge_parent_cursor', String(to + 1))
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return to < head
  }

  /** Elysium: withdrawals through MesaWithdraw. */
  private async childStep(range: number): Promise<boolean> {
    const url = this.cfg.childRpc
    const head = await this.head(url)
    const from = Number(getMeta(this.db, 'bridge_child_cursor') ?? this.cfg.childStart)
    if (from > head) return false
    const to = Math.min(head, from + range - 1)
    const logs = (await this.logs(url, from, to, ARB_SYS, [TOPIC.l2ToL1Tx])).filter(
      (l) => addrOf(word(l.data, 0)) === this.cfg.mesaWithdraw,
    )
    const rows: Record<string, unknown>[] = []
    if (logs.length) {
      const [t, txs] = await Promise.all([
        this.times(url, logs.map((l) => parseInt(l.blockNumber, 16))),
        this.rpc(url, logs.map((l) => ({ method: 'eth_getTransactionByHash', params: [l.transactionHash] }))) as Promise<
          { from: string }[]
        >,
      ])
      logs.forEach((l, i) => {
        // L2ToL1Tx data: caller, arbBlockNum, ethBlockNum, timestamp, callvalue, data.
        rows.push({
          kind: 'withdrawal',
          tx: l.transactionHash.toLowerCase(),
          log_index: parseInt(l.logIndex, 16),
          block: parseInt(l.blockNumber, 16),
          timestamp: t.get(parseInt(l.blockNumber, 16)) ?? 0,
          address: (txs[i]?.from ?? addrOf(l.topics[1] ?? '0x')).toLowerCase(),
          amount: wei(word(l.data, 4)),
          position: Number(BigInt(l.topics[3] ?? '0x0')),
        })
      })
    }
    this.db.exec('BEGIN')
    try {
      this.insert(rows)
      setMeta(this.db, 'bridge_child_cursor', String(to + 1))
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return to < head
  }

  async run() {
    for (;;) {
      let busy = false
      try {
        busy = (await this.parentStep(1_000)) || busy
      } catch (e) {
        console.error(JSON.stringify({ bridgeParentError: e instanceof Error ? e.message.slice(0, 200) : String(e) }))
      }
      try {
        busy = (await this.childStep(5_000)) || busy
      } catch (e) {
        console.error(JSON.stringify({ bridgeChildError: e instanceof Error ? e.message.slice(0, 200) : String(e) }))
      }
      await new Promise((r) => setTimeout(r, busy ? 300 : 10_000))
    }
  }
}

/** Totals and the latest transfers, for the bridge page. */
export function bridgeStats(db: DatabaseSync) {
  migrate(db)
  const now = Math.floor(Date.now() / 1000)
  const total = (kind: string, since = 0) =>
    db
      .prepare(`SELECT COUNT(*) n, COALESCE(SUM(amount), 0) hype FROM bridge_transfers WHERE kind = ? AND timestamp >= ?`)
      .get(kind, since) as { n: number; hype: number }
  const wallets = db.prepare(`SELECT COUNT(DISTINCT address) n FROM bridge_transfers WHERE kind IN ('deposit', 'withdrawal')`).get() as {
    n: number
  }
  return {
    deposits: total('deposit'),
    withdrawals: total('withdrawal'),
    claims: total('claim'),
    last24h: { deposits: total('deposit', now - 86_400), withdrawals: total('withdrawal', now - 86_400) },
    wallets: wallets.n,
    recent: db
      .prepare(
        `SELECT kind, tx, timestamp, address, amount FROM bridge_transfers WHERE kind IN ('deposit', 'withdrawal')
         ORDER BY timestamp DESC, log_index DESC LIMIT 25`,
      )
      .all(),
  }
}

/** A deposit by its delayed-message index, or a withdrawal and its claim by Elysium tx. */
export function bridgeLookup(db: DatabaseSync, q: { message?: number; tx?: string }) {
  migrate(db)
  if (q.message !== undefined) {
    return (
      (db
        .prepare(`SELECT kind, tx, timestamp, address, amount FROM bridge_transfers WHERE kind = 'deposit' AND position = ?`)
        .get(q.message) as Record<string, unknown> | undefined) ?? null
    )
  }
  if (q.tx) {
    const w = db
      .prepare(`SELECT kind, tx, timestamp, address, amount, position FROM bridge_transfers WHERE kind = 'withdrawal' AND tx = ?`)
      .get(q.tx) as Record<string, unknown> | undefined
    if (!w) return null
    const claim = db
      .prepare(`SELECT tx, timestamp FROM bridge_transfers WHERE kind = 'claim' AND position = ?`)
      .get(w.position as number) as Record<string, unknown> | undefined
    return { ...w, claim: claim ?? null }
  }
  return null
}
