/**
 * Mesa relay: an Elysium JSON-RPC endpoint for wallets.
 *
 * Until Elysium's public sequencer opens, transactions cannot be sent to
 * Elysium directly. They can be posted to its official inbox on HyperEVM,
 * and the next batch executes them. This server does that for wallets:
 *
 *  - eth_sendRawTransaction: checks the signed Elysium transaction, then
 *    posts it unchanged to the inbox with `sendL2Message`, paying the
 *    HyperEVM gas. Elysium executes it as the user's own signed
 *    transaction; the relay cannot alter it, and the user pays Elysium gas.
 *  - eth_getTransactionCount ("pending"): counts relayed transactions that
 *    have not been executed yet, so wallets do not reuse a nonce.
 *  - eth_getTransactionByHash: shows a relayed transaction as pending until
 *    it is executed.
 *  - everything else is forwarded to UPSTREAM_RPC.
 *
 * With MODE=direct (once the public sequencer is open), transactions are
 * forwarded upstream like any RPC and the relay is just a proxy.
 *
 * Env:
 *   NETWORK        mainnet | testnet                  (default mainnet)
 *   RELAYER_KEY    HyperEVM key that pays inbox gas    (required in inbox mode)
 *   UPSTREAM_RPC   Elysium RPC for reads; ideally one that includes pending inbox messages
 *   PARENT_RPC     HyperEVM RPC
 *   MODE           inbox | direct                     (default inbox)
 *   ALLOW_TO       comma-separated contract addresses a relayed transaction may call
 *   MESA_HOOK      also allow the hook and any token it launched (checked on chain)
 *   ALLOW_ANY      "true" to relay to any address (not recommended; default false)
 *   MAX_HYPE_PER_HOUR   relayer gas budget per rolling hour, in HYPE     (default 0.05)
 *   MAX_RELAYS_PER_HOUR                                                   (default 300)
 *   READ_PER_IP_PER_MIN, MAX_BATCH, MAX_LOG_RANGE                         (defaults 600, 50, 10000)
 *   MAX_GAS        largest gas limit relayed           (default 5000000)
 *   PER_SENDER_PER_MIN, PER_IP_PER_MIN                 (defaults 10, 60)
 *   PORT           (default 8545)
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { BigNumber, Contract, Wallet, providers, utils } from 'ethers'

type Net = 'mainnet' | 'testnet'

const NETWORKS: Record<Net, { chainId: number; inbox: string; upstream: string; parent: string }> = {
  mainnet: {
    chainId: 99901,
    inbox: '0xce59f8b65ad41c9dae4c07a0571a39824bd92cff',
    upstream: 'https://rpc.agoradex.app',
    parent: 'https://rpc.hyperliquid.xyz/evm',
  },
  testnet: {
    chainId: 99801,
    inbox: '0x11178Df40CBf87a4343f4B3F8B09B366ceFA8Ec0',
    upstream: 'https://testnet-rpc.elysium.kinetiq.xyz',
    parent: 'https://rpc.hyperliquid-testnet.xyz/evm',
  },
}

const env = process.env
const net = (env.NETWORK ?? 'mainnet') as Net
if (!NETWORKS[net]) throw new Error('NETWORK must be mainnet or testnet')
const cfg = NETWORKS[net]
const mode = env.MODE === 'direct' ? 'direct' : 'inbox'
const upstreamUrl = env.UPSTREAM_RPC ?? cfg.upstream
const allowTo = new Set(
  (env.ALLOW_TO ?? '')
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean),
)
const allowAny = env.ALLOW_ANY === 'true'
const mesaHook = env.MESA_HOOK?.toLowerCase()
const maxHypePerHour = utils.parseEther(env.MAX_HYPE_PER_HOUR ?? '0.05')
const maxRelaysPerHour = Number(env.MAX_RELAYS_PER_HOUR ?? 300)
const readPerIp = Number(env.READ_PER_IP_PER_MIN ?? 600)
const maxBatch = Number(env.MAX_BATCH ?? 50)
const maxLogRange = Number(env.MAX_LOG_RANGE ?? 10_000)
const maxGas = BigNumber.from(env.MAX_GAS ?? 5_000_000)
const maxPendingPerSender = Number(env.MAX_PENDING_PER_SENDER ?? 8)
const perSender = Number(env.PER_SENDER_PER_MIN ?? 10)
const perIp = Number(env.PER_IP_PER_MIN ?? 60)

const parent = new providers.StaticJsonRpcProvider(env.PARENT_RPC ?? cfg.parent)
const upstream = new providers.StaticJsonRpcProvider(upstreamUrl, cfg.chainId)
const relayer = mode === 'inbox' ? new Wallet(requireEnv('RELAYER_KEY'), parent) : undefined
const inbox = new Contract(cfg.inbox, ['function sendL2Message(bytes messageData) returns (uint256)'], relayer ?? parent)

/** Arbitrum L2 message type for a signed transaction. */
const SIGNED_TX = '0x04'

function requireEnv(k: string): string {
  const v = env[k]
  if (!v) throw new Error(`${k} is required`)
  return v
}

// ---------------------------------------------------------------- state

interface Relayed {
  hash: string
  from: string
  nonce: number
  raw: string
  parentTx: string
  at: number
  tx: ReturnType<typeof utils.parseTransaction>
}

/** Relayed transactions not yet seen executed upstream, by hash. */
const pending = new Map<string, Relayed>()
/** Highest relayed nonce + 1, per sender. */
const nextNonce = new Map<string, number>()

const windows = new Map<string, number[]>()
function limited(key: string, perMin: number): boolean {
  const now = Date.now()
  const w = (windows.get(key) ?? []).filter((t) => now - t < 60_000)
  if (w.length >= perMin) return true
  w.push(now)
  windows.set(key, w)
  return false
}

// ---------------------------------------------------------------- budget, policy, stats

/** Relayer HyperEVM spend in the last hour: an upper bound at send, the real cost once mined. */
const spends: { at: number; cost: BigNumber }[] = []
function spentLastHour(): BigNumber {
  const cutoff = Date.now() - 3600_000
  while (spends.length && spends[0].at < cutoff) spends.shift()
  return spends.reduce((a, s) => a.add(s.cost), BigNumber.from(0))
}

export const stats = {
  startedAt: new Date().toISOString(),
  relayed: 0,
  rejected: {} as Record<string, number>,
  reads: 0,
  lastRelayAt: null as string | null,
}
function reject(reason: string, code: number, message: string): never {
  stats.rejected[reason] = (stats.rejected[reason] ?? 0) + 1
  throw new RpcError(code, message)
}

/**
 * eth_call that throws on revert. ethers v5's provider.call returns a
 * reverted call's revert data as if it were a result, so it is not used here.
 */
async function rawCall(t: { from?: string; to?: string; data?: string; value?: BigNumber; gasLimit?: BigNumber }): Promise<string> {
  const q: Record<string, string> = {}
  if (t.from) q.from = t.from
  if (t.to) q.to = t.to
  if (t.data) q.data = t.data
  if (t.value && !t.value.isZero()) q.value = utils.hexValue(t.value)
  if (t.gasLimit) q.gas = utils.hexValue(t.gasLimit)
  return (await upstream.send('eth_call', [q, 'latest'])) as string
}

const mesaTokenCache = new Map<string, boolean>()
const hookIface = new utils.Interface(['function poolOf(address) view returns (bytes32)'])
/** Whether a relayed transaction may call `to`. */
async function allowed(to: string | undefined): Promise<boolean> {
  if (allowAny) return true
  if (!to) return false // contract creation
  const a = to.toLowerCase()
  if (allowTo.has(a) || a === mesaHook) return true
  if (!mesaHook) return false
  const cached = mesaTokenCache.get(a)
  if (cached !== undefined) return cached
  try {
    const id = await rawCall({ to: mesaHook, data: hookIface.encodeFunctionData('poolOf', [a]) })
    const ok = BigNumber.from(id).gt(0)
    mesaTokenCache.set(a, ok)
    return ok
  } catch {
    return false
  }
}

/** Relayer sends are serialized so its HyperEVM nonces never collide. */
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(f: () => Promise<T>): Promise<T> {
  const run = queue.then(f, f)
  queue = run.catch(() => undefined)
  return run
}

async function prune() {
  for (const [hash, r] of pending) {
    try {
      const receipt = await upstream.getTransactionReceipt(hash)
      const count = await upstream.getTransactionCount(r.from, 'latest')
      if (receipt || count > r.nonce || Date.now() - r.at > 6 * 3600_000) pending.delete(hash)
    } catch {
      // Upstream unavailable: keep it for now.
    }
  }
}
setInterval(() => void prune(), 15_000).unref()

// ---------------------------------------------------------------- rpc

class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message)
  }
}

interface RpcReq {
  jsonrpc: '2.0'
  id: unknown
  method: string
  params?: unknown[]
}

async function forward(req: RpcReq): Promise<unknown> {
  const res = await fetch(upstreamUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: req.method, params: req.params ?? [] }),
  })
  const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string } }
  if (body.error) throw new RpcError(body.error.code, body.error.message)
  return body.result
}

async function sendRaw(raw: string, ip: string): Promise<string> {
  if (mode === 'direct') return (await forward({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] })) as string

  let tx: ReturnType<typeof utils.parseTransaction>
  try {
    tx = utils.parseTransaction(raw)
  } catch {
    throw new RpcError(-32602, 'not a signed transaction')
  }
  if (!tx.from || !tx.hash) throw new RpcError(-32602, 'unsigned transaction')
  if (tx.chainId !== cfg.chainId) throw new RpcError(-32602, `wrong chain: expected ${cfg.chainId}`)
  if (tx.gasLimit.gt(maxGas)) throw new RpcError(-32602, `gas limit above ${maxGas}`)
  if (!(await allowed(tx.to))) reject('not-allowed', -32003, 'this relay only sends transactions to Mesa contracts')
  const from = tx.from.toLowerCase()
  if (pending.has(tx.hash)) return tx.hash
  if (limited(`ip:${ip}`, perIp) || limited(`from:${from}`, perSender)) reject('rate-limited', -32005, 'rate limited')
  if (spentLastHour().gte(maxHypePerHour) || spends.length >= maxRelaysPerHour) {
    reject('budget', -32005, 'the relay is at its hourly limit; try again shortly')
  }

  // Reject what Elysium would reject, so no inbox gas is spent on it.
  const [chainNonce, balance] = await Promise.all([
    upstream.getTransactionCount(tx.from, 'pending'),
    upstream.getBalance(tx.from, 'pending'),
  ])
  const expected = Math.max(chainNonce, nextNonce.get(from) ?? 0)
  if (tx.nonce !== expected) reject('nonce', -32000, `nonce ${tx.nonce} is not the next one (${expected})`)
  const price = tx.maxFeePerGas ?? tx.gasPrice ?? BigNumber.from(0)
  if (balance.lt(tx.gasLimit.mul(price).add(tx.value))) reject('funds', -32000, 'insufficient funds for gas * price + value')

  // A transaction that would revert is not worth inbox gas. One exception:
  // it may depend on the sender's previous relayed transaction, still
  // waiting for the batch (an approval, then a swap), so with exactly one
  // waiting it goes through. More than that and it must simulate cleanly.
  const waiting = [...pending.values()].filter((r) => r.from === from).length
  if (waiting >= maxPendingPerSender) reject('too-many-pending', -32005, `${waiting} transactions already waiting for the next batch`)
  try {
    await rawCall({ from: tx.from, to: tx.to ?? undefined, data: tx.data, value: tx.value, gasLimit: tx.gasLimit })
  } catch (e) {
    if (waiting !== 1) {
      const why = (e as { body?: string; message?: string })?.body?.match(/"message":"([^"]+)"/)?.[1] ?? 'execution reverted'
      reject('would-revert', 3, `would revert on Elysium: ${why}`)
    }
  }

  const sent = await serial(async () => (await inbox.sendL2Message(utils.hexConcat([SIGNED_TX, raw]))) as providers.TransactionResponse)
  const spend = { at: Date.now(), cost: sent.gasLimit.mul(sent.maxFeePerGas ?? sent.gasPrice ?? 0) }
  spends.push(spend)
  void sent
    .wait()
    .then((r) => (spend.cost = r.gasUsed.mul(r.effectiveGasPrice)))
    .catch(() => undefined)
  stats.relayed += 1
  stats.lastRelayAt = new Date().toISOString()
  pending.set(tx.hash, { hash: tx.hash, from, nonce: tx.nonce, raw, parentTx: sent.hash, at: Date.now(), tx })
  nextNonce.set(from, tx.nonce + 1)
  console.log(JSON.stringify({ relayed: tx.hash, from, nonce: tx.nonce, to: tx.to, parentTx: sent.hash }))
  return tx.hash
}

function pendingTxObject(r: Relayed) {
  const t = r.tx
  const hex = (v?: BigNumber | null) => (v ? utils.hexValue(v) : undefined)
  return {
    hash: r.hash,
    from: t.from,
    to: t.to ?? null,
    nonce: utils.hexValue(t.nonce),
    value: hex(t.value),
    gas: hex(t.gasLimit),
    gasPrice: hex(t.maxFeePerGas ?? t.gasPrice),
    maxFeePerGas: hex(t.maxFeePerGas),
    maxPriorityFeePerGas: hex(t.maxPriorityFeePerGas),
    input: t.data,
    type: utils.hexValue(t.type ?? 0),
    chainId: utils.hexValue(cfg.chainId),
    v: utils.hexValue(t.v ?? 0),
    r: t.r,
    s: t.s,
    blockHash: null,
    blockNumber: null,
    transactionIndex: null,
  }
}

const BLOCKED = /^(debug_|trace_|admin_|personal_|txpool_|miner_|engine_|eth_sign|eth_sendTransaction$|eth_accounts$)/

async function handle(req: RpcReq, ip: string): Promise<unknown> {
  const p = req.params ?? []
  if (BLOCKED.test(req.method)) reject('method', -32601, `method ${req.method} is not available`)
  if (req.method !== 'eth_sendRawTransaction') {
    if (limited(`read:${ip}`, readPerIp)) reject('read-rate', -32005, 'rate limited')
    stats.reads += 1
  }
  if (req.method === 'eth_getLogs') {
    const f = (p[0] ?? {}) as { fromBlock?: string; toBlock?: string; blockHash?: string }
    if (!f.blockHash) {
      const head = await upstream.getBlockNumber()
      const n = (t?: string) => (!t || t === 'latest' || t === 'pending' || t === 'safe' || t === 'finalized' ? head : t === 'earliest' ? 0 : parseInt(t, 16))
      if (n(f.toBlock) - n(f.fromBlock) > maxLogRange) reject('log-range', -32005, `eth_getLogs is limited to ${maxLogRange} blocks`)
    }
  }
  switch (req.method) {
    case 'eth_chainId':
      return utils.hexValue(cfg.chainId)
    case 'net_version':
      return String(cfg.chainId)
    case 'eth_sendRawTransaction':
      return sendRaw(String(p[0]), ip)
    case 'eth_getTransactionCount': {
      const count = BigNumber.from(await forward(req)).toNumber()
      if (p[1] !== 'pending') return utils.hexValue(count)
      return utils.hexValue(Math.max(count, nextNonce.get(String(p[0]).toLowerCase()) ?? 0))
    }
    case 'eth_getTransactionByHash': {
      const result = await forward(req)
      const r = pending.get(String(p[0]).toLowerCase()) ?? pending.get(String(p[0]))
      return result ?? (r ? pendingTxObject(r) : null)
    }
    case 'mesa_relayStatus': {
      const r = pending.get(String(p[0]))
      return r ? { hash: r.hash, parentTx: r.parentTx, relayedAt: new Date(r.at).toISOString() } : null
    }
    default:
      return forward(req)
  }
}

// ---------------------------------------------------------------- http

function cors(res: ServerResponse) {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'POST, GET, OPTIONS')
  res.setHeader('access-control-allow-headers', 'content-type')
}

async function body(req: IncomingMessage): Promise<string> {
  let s = ''
  for await (const chunk of req) {
    s += chunk
    if (s.length > 1_000_000) throw new Error('request too large')
  }
  return s
}

async function one(r: RpcReq, ip: string) {
  try {
    return { jsonrpc: '2.0', id: r.id ?? null, result: await handle(r, ip) }
  } catch (e) {
    const code = e instanceof RpcError ? e.code : -32603
    const message = e instanceof Error ? e.message : String(e)
    return { jsonrpc: '2.0', id: r.id ?? null, error: { code, message } }
  }
}

const server = createServer(async (req, res) => {
  cors(res)
  if (req.method === 'OPTIONS') return res.writeHead(204).end()
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    const [head, relayerBalance] = await Promise.all([
      upstream.getBlockNumber().catch(() => null),
      relayer ? relayer.getBalance().catch(() => null) : null,
    ])
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(
      JSON.stringify({
        network: net,
        chainId: cfg.chainId,
        mode,
        upstreamHead: head,
        relayer: relayer?.address ?? null,
        relayerBalance: relayerBalance ? utils.formatEther(relayerBalance) : null,
        pending: pending.size,
        relayedTotal: stats.relayed,
        rejected: stats.rejected,
        reads: stats.reads,
        startedAt: stats.startedAt,
        lastRelayAt: stats.lastRelayAt,
        spentLastHour: utils.formatEther(spentLastHour()),
        budgetPerHour: utils.formatEther(maxHypePerHour),
        policy: allowAny ? 'any' : { allowTo: [...allowTo], mesaHook: mesaHook ?? null },
      }),
    )
  }
  if (req.method !== 'POST') return res.writeHead(405).end()
  const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim()
  let parsed: RpcReq | RpcReq[]
  try {
    parsed = JSON.parse(await body(req))
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }))
  }
  if (Array.isArray(parsed) && parsed.length > maxBatch) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32005, message: `batches are limited to ${maxBatch} requests` } }))
  }
  const out = Array.isArray(parsed) ? await Promise.all(parsed.map((r) => one(r, ip))) : await one(parsed, ip)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(out))
})

const port = Number(env.PORT ?? 8545)
server.listen(port, () =>
  console.log(JSON.stringify({ listening: port, network: net, mode, upstream: upstreamUrl, relayer: relayer?.address })),
)
