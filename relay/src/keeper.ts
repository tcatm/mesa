/**
 * $MESA's buyback keeper: turns the HYPE that Mesa launches send to the
 * BuybackBurner into $MESA bought in its own pool and burned.
 *
 * Every ROUND it pulls the burner's accrued fees from the hook (anyone may),
 * then buys back with at most CHUNK HYPE, at no worse than SLIPPAGE below a
 * quote taken just before, so a large backlog is spread over many small buys
 * instead of one candle, and a sandwich costs more in fees than it can make.
 * The keeper can only call buyback: it can't move the HYPE anywhere else.
 *
 * Env:
 *   KEEPER_KEY     the burner's keeper key (only needs gas on Elysium)
 *   RPC            Elysium RPC that accepts transactions (the relay)   default http://relay:8545
 *   READ_RPC       Elysium RPC for reads                              default RPC
 *   ROUND_MIN      minutes between rounds                             default 10
 *   CHUNK_HYPE     most HYPE spent per buyback                        default 0.25
 *   MIN_HYPE       skip buybacks smaller than this                    default 0.02
 *   SLIPPAGE_BPS   minimum out below the quote                        default 300
 */
import { BigNumber, Contract, Wallet, providers, utils } from 'ethers'

const HOOK = '0xE928F2336051cBD5B9D4531C25EaDd13f9A82aeC'
const BURNER = '0xcCFe02C0a8Fec0c39683aE00b35A5d4560d8E7C1'
const QUOTER = '0x379f556c5a748bd7cc9baf0f7a344094ac1814f5'
const env = process.env
const key = env.KEEPER_KEY
if (!key) throw new Error('KEEPER_KEY is required')
const send = new providers.StaticJsonRpcProvider(env.RPC ?? 'http://relay:8545', 99901)
const read = new providers.StaticJsonRpcProvider(env.READ_RPC ?? env.RPC ?? 'http://relay:8545', 99901)
const wallet = new Wallet(key, send)
const ROUND = Number(env.ROUND_MIN ?? 10) * 60_000
const CHUNK = utils.parseEther(env.CHUNK_HYPE ?? '0.25')
const MIN = utils.parseEther(env.MIN_HYPE ?? '0.02')
const SLIPPAGE = BigNumber.from(env.SLIPPAGE_BPS ?? 300)
// A max fee well above Elysium's base fee, so a relayed transaction still
// clears it a minute later; only the base fee is ever charged.
const FEES = { maxFeePerGas: utils.parseUnits(env.MAX_FEE_GWEI ?? '1', 'gwei'), maxPriorityFeePerGas: 0 }

const hook = new Contract(
  HOOK,
  [
    'function accrued(address) view returns (uint256)',
    'function genesisToken() view returns (address)',
    'function poolKeyOf(address) view returns (tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks))',
  ],
  read,
)
const burner = new Contract(
  BURNER,
  ['function collect() returns (uint256)', 'function buyback(uint256 hypeIn, uint256 minMesaOut) returns (uint256)', 'function keeper() view returns (address)'],
  wallet,
)
const quoter = new Contract(
  QUOTER,
  [
    'function quoteExactInputSingle(tuple(tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)',
  ],
  read,
)
const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }))

async function waitFor(hash: string) {
  // Through the relay, a transaction lands in about a minute.
  const r = await read.waitForTransaction(hash, 1, 15 * 60_000)
  if (r.status !== 1) throw new Error(`reverted ${hash}`)
  return r
}

async function round() {
  const accrued: BigNumber = await hook.accrued(BURNER)
  if (accrued.gt(0)) {
    const tx = await burner.collect({ gasLimit: 200_000, ...FEES })
    await waitFor(tx.hash)
    log({ collected: utils.formatEther(accrued), tx: tx.hash })
  }
  const balance = await read.getBalance(BURNER)
  const hypeIn = balance.lt(CHUNK) ? balance : CHUNK
  if (hypeIn.lt(MIN)) return log({ idle: utils.formatEther(balance) })
  const mesa: string = await hook.genesisToken()
  const key = await hook.poolKeyOf(mesa)
  const [quoted]: [BigNumber] = await quoter.callStatic.quoteExactInputSingle({ poolKey: key, zeroForOne: true, exactAmount: hypeIn, hookData: '0x' })
  const minOut = quoted.mul(BigNumber.from(10_000).sub(SLIPPAGE)).div(10_000)
  const tx = await burner.buyback(hypeIn, minOut, { gasLimit: 600_000, ...FEES })
  await waitFor(tx.hash)
  log({ boughtBack: utils.formatEther(hypeIn), minMesa: utils.formatEther(minOut), backlog: utils.formatEther(balance.sub(hypeIn)), tx: tx.hash })
}

async function main() {
  const k: string = await new Contract(BURNER, ['function keeper() view returns (address)'], read).keeper()
  if (k.toLowerCase() !== wallet.address.toLowerCase()) throw new Error(`this key (${wallet.address}) is not the burner's keeper (${k})`)
  log({ keeper: wallet.address, roundMin: ROUND / 60_000, chunk: utils.formatEther(CHUNK) })
  for (;;) {
    try {
      await round()
    } catch (e) {
      log({ error: e instanceof Error ? e.message.slice(0, 300) : String(e) })
    }
    await new Promise((r) => setTimeout(r, ROUND))
  }
}
void main()
