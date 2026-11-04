/**
 * HYPE bridging between HyperEVM and Elysium through Elysium's official
 * bridge, with no fee on top. Every function returns or sends the same
 * transactions the official bridge expects; Mesa holds nothing in between.
 *
 *  - deposit:       HyperEVM -> Elysium, credited when the next batch lands.
 *  - bridge-and-buy: a deposit that also buys a Mesa token on arrival, through
 *                   MesaBridgeRouter, and refunds the HYPE on Elysium if the
 *                   buy fails (for example because the price moved).
 *  - withdraw:      Elysium -> HyperEVM, claimable after the challenge period.
 */
import {
  ChildToParentMessageReader,
  ChildToParentMessageStatus,
  ChildTransactionReceipt,
  ParentToChildMessageStatus,
  ParentTransactionReceipt,
} from '@arbitrum/sdk'
import { BigNumber, Contract, utils, type providers, type Signer } from 'ethers'

import { networks, registerElysium, type Net } from './networks.js'

export { networks, defaultRpc, elysium, elysiumTestnet, registerElysium, type Net } from './networks.js'

type Provider = providers.Provider

const outboxAbi = [
  'function executeTransaction(bytes32[] proof, uint256 index, address l2Sender, address to, uint256 l2Block, uint256 l1Block, uint256 l2Timestamp, uint256 value, bytes data)',
]
const routerAbi = ['function buy(address token, uint256 minOut, address recipient) payable returns (uint256)']
const bridgeAbi = ['function delayedMessageCount() view returns (uint256)']
const sequencerInboxAbi = [
  'function batchCount() view returns (uint256)',
  'function totalDelayedMessagesRead() view returns (uint256)',
]

/** Gas for a bridge-and-buy on arrival, used when estimation is not possible. */
export const BRIDGE_BUY_GAS = BigNumber.from(1_500_000)

// ---------------------------------------------------------------- deposits

const inboxAbi = [
  'function createRetryableTicket(address to, uint256 l2CallValue, uint256 maxSubmissionCost, address excessFeeRefundAddress, address callValueRefundAddress, uint256 gasLimit, uint256 maxFeePerGas, bytes data) payable returns (uint256)',
  'function calculateRetryableSubmissionFee(uint256 dataLength, uint256 baseFee) view returns (uint256)',
]
const messageDeliveredTopic = utils.id(
  'MessageDelivered(uint256,bytes32,address,uint8,address,bytes32,uint256,uint64)',
)

/** A transaction for the user's wallet to sign. `value` and `gas` are in wei / gas units. */
export interface TxRequest {
  chainId: number
  to: string
  data: string
  value: bigint
}

/**
 * Gas for the deposit's execution on Elysium. A plain deposit needs far
 * less; whatever is not used is refunded to the recipient on Elysium.
 */
export const DEPOSIT_GAS = BigNumber.from(300_000)
/** Lowest price bid for that gas: 10x Elysium's 0.1 gwei floor. Unused, it is refunded. */
export const MIN_CHILD_GAS_PRICE = utils.parseUnits('1', 'gwei')

export interface DepositParams {
  net: Net
  /** HYPE to arrive on Elysium, in wei. */
  amount: BigNumber
  /** The HyperEVM account paying. */
  from: string
  /** The Elysium account credited; defaults to `from`. */
  to?: string
  parentProvider: Provider
  /**
   * Optional. Used only to read Elysium's gas price; without it the
   * minimum bid is used. Deposits never depend on an Elysium RPC.
   */
  childProvider?: Provider
}

/** Everything a retryable needs, built from HyperEVM state only. */
async function retryable(p: {
  net: Net
  target: string
  l2CallValue: BigNumber
  data: string
  refundTo: string
  gasLimit: BigNumber
  parentProvider: Provider
  childProvider?: Provider
}): Promise<TxRequest & { fees: { submission: BigNumber; gas: BigNumber } }> {
  const n = networks[p.net]
  const inbox = new Contract(n.ethBridge.inbox, inboxAbi, p.parentProvider)
  const block = await p.parentProvider.getBlock('latest')
  const parentBaseFee = block.baseFeePerGas ?? (await p.parentProvider.getGasPrice())
  // The submission fee is charged at the base fee of the block that includes
  // the deposit; bid 3x today's. The excess is refunded on Elysium.
  const submission: BigNumber = (
    await inbox.calculateRetryableSubmissionFee(utils.hexDataLength(p.data), parentBaseFee)
  ).mul(3)
  let maxFeePerGas = MIN_CHILD_GAS_PRICE
  if (p.childProvider) {
    try {
      const childPrice = (await p.childProvider.getGasPrice()).mul(3)
      if (childPrice.gt(maxFeePerGas)) maxFeePerGas = childPrice
    } catch {
      // No Elysium RPC: the minimum bid stands.
    }
  }
  const gas = p.gasLimit.mul(maxFeePerGas)
  const data = inbox.interface.encodeFunctionData('createRetryableTicket', [
    p.target,
    p.l2CallValue,
    submission,
    p.refundTo,
    p.refundTo,
    p.gasLimit,
    maxFeePerGas,
    p.data,
  ])
  return {
    chainId: n.parentChainId,
    to: n.ethBridge.inbox,
    data,
    value: p.l2CallValue.add(submission).add(gas).toBigInt(),
    fees: { submission, gas },
  }
}

/**
 * A plain HYPE deposit: `amount` arrives on Elysium 1:1. The wallet pays
 * `amount` plus a small bridge gas deposit, and whatever of that is unused is
 * refunded to the recipient on Elysium. No Mesa contract is involved.
 */
export async function depositRequest(p: DepositParams) {
  return retryable({
    net: p.net,
    target: p.to ?? p.from,
    l2CallValue: p.amount,
    data: '0x',
    refundTo: p.to ?? p.from,
    gasLimit: DEPOSIT_GAS,
    parentProvider: p.parentProvider,
    childProvider: p.childProvider,
  })
}

export interface BridgeAndBuyParams extends DepositParams {
  /** MesaBridgeRouter on Elysium. */
  router: string
  /** The Mesa token to buy. */
  token: string
  /** Minimum tokens out; below it, the HYPE is refunded on Elysium instead. */
  minOut: BigNumber
  /** Gas for the buy on Elysium; defaults to `BRIDGE_BUY_GAS`. Unused gas is refunded. */
  gasLimit?: BigNumber
}

/**
 * Optional: a deposit that buys `token` for the recipient when it arrives.
 * If the buy fails, the router sends the HYPE to the recipient on Elysium.
 * If the message itself fails, it stays redeemable for 7 days and its value
 * goes to the recipient if it expires.
 */
export async function bridgeAndBuyRequest(p: BridgeAndBuyParams) {
  const recipient = p.to ?? p.from
  return retryable({
    net: p.net,
    target: p.router,
    l2CallValue: p.amount,
    data: new utils.Interface(routerAbi).encodeFunctionData('buy', [p.token, p.minOut, recipient]),
    refundTo: recipient,
    gasLimit: p.gasLimit ?? BRIDGE_BUY_GAS,
    parentProvider: p.parentProvider,
    childProvider: p.childProvider,
  })
}

/**
 * Where a deposit is, from HyperEVM alone, with no Elysium RPC.
 *
 * `inBatch` turns true once a batch posted to HyperEVM includes the deposit:
 * from then on it is final. With a live sequencer, Elysium credits a deposit
 * earlier than that, as soon as the sequencer picks it up (minutes on
 * testnet); before Elysium's public sequencer opens, the two happen together
 * when the batch lands. `ahead` is how many deposits are in line before it.
 * For "has it arrived?", prefer `depositStatus` when an Elysium RPC is
 * available, and fall back to this.
 */
export async function depositProgress(p: {
  net: Net
  parentTxHash: string
  parentProvider: Provider
}): Promise<{ messageIndex: number; inBatch: boolean; ahead: number }[]> {
  const n = networks[p.net].ethBridge
  const receipt = await p.parentProvider.getTransactionReceipt(p.parentTxHash)
  if (!receipt) throw new Error('deposit transaction not found on HyperEVM')
  const indexes = receipt.logs
    .filter((l) => l.address.toLowerCase() === n.bridge.toLowerCase() && l.topics[0] === messageDeliveredTopic)
    .map((l) => BigNumber.from(l.topics[1]).toNumber())
  if (indexes.length === 0) throw new Error('not an Elysium deposit')
  const read: BigNumber = await new Contract(n.sequencerInbox, sequencerInboxAbi, p.parentProvider).totalDelayedMessagesRead()
  return indexes.map((i) => ({ messageIndex: i, inBatch: read.gt(i), ahead: Math.max(0, i - read.toNumber()) }))
}

export type DepositState =
  | 'not-yet-created'
  | 'creation-failed'
  | 'redeem-failed'
  | 'credited'
  | 'expired'
  | 'unknown'

const depositStates: Record<number, DepositState> = {
  [ParentToChildMessageStatus.NOT_YET_CREATED]: 'not-yet-created',
  [ParentToChildMessageStatus.CREATION_FAILED]: 'creation-failed',
  [ParentToChildMessageStatus.FUNDS_DEPOSITED_ON_CHILD]: 'redeem-failed',
  [ParentToChildMessageStatus.REDEEMED]: 'credited',
  [ParentToChildMessageStatus.EXPIRED]: 'expired',
}

/**
 * Where a deposit is. `not-yet-created` is normal until the next Elysium
 * batch includes it. `redeem-failed` means the call on arrival ran out of
 * gas; it can be redeemed again on Elysium.
 */
export async function depositStatus(p: {
  parentTxHash: string
  parentProvider: Provider
  childProvider: Provider
}): Promise<{ ticketId: string; state: DepositState; childTxHash?: string }[]> {
  registerElysium()
  const receipt = await p.parentProvider.getTransactionReceipt(p.parentTxHash)
  if (!receipt) throw new Error('deposit transaction not found on HyperEVM')
  const messages = await new ParentTransactionReceipt(receipt).getParentToChildMessages(p.childProvider)
  return Promise.all(
    messages.map(async (m) => {
      const state = depositStates[await m.status()] ?? 'unknown'
      let childTxHash: string | undefined
      if (state === 'credited') {
        const r = await m.getSuccessfulRedeem()
        if ('childTxReceipt' in r && r.childTxReceipt) childTxHash = r.childTxReceipt.transactionHash
      }
      return { ticketId: m.retryableCreationId, state, childTxHash }
    }),
  )
}

// ---------------------------------------------------------------- withdrawals

const arbSysAbi = ['function withdrawEth(address destination) payable returns (uint256)']

/** A withdrawal, signed on Elysium. Claimable on HyperEVM after the challenge period. */
export function withdrawRequest(p: {
  net: Net
  amount: BigNumber
  from: string
  /** The HyperEVM account to pay; defaults to `from`. */
  to?: string
}): TxRequest {
  return {
    chainId: networks[p.net].chainId,
    to: '0x0000000000000000000000000000000000000064',
    data: new utils.Interface(arbSysAbi).encodeFunctionData('withdrawEth', [p.to ?? p.from]),
    value: p.amount.toBigInt(),
  }
}

export type WithdrawalState = 'waiting' | 'claimable' | 'claimed'

/**
 * Where a withdrawal is, and for one still waiting, the HyperEVM block from
 * which it can be claimed (an estimate, for a countdown).
 */
export async function withdrawalStatus(p: {
  childTxHash: string
  parentProvider: Provider
  childProvider: Provider
}): Promise<{ state: WithdrawalState; claimableFromBlock: number | null }[]> {
  registerElysium()
  const receipt = await p.childProvider.getTransactionReceipt(p.childTxHash)
  if (!receipt) throw new Error('withdrawal transaction not found on Elysium')
  const messages = await new ChildTransactionReceipt(receipt).getChildToParentMessages(p.parentProvider)
  return Promise.all(
    messages.map(async (m) => {
      const s = await m.status(p.childProvider)
      const state: WithdrawalState =
        s === ChildToParentMessageStatus.EXECUTED ? 'claimed' : s === ChildToParentMessageStatus.CONFIRMED ? 'claimable' : 'waiting'
      const first = state === 'waiting' ? await m.getFirstExecutableBlock(p.childProvider) : null
      return { state, claimableFromBlock: first ? first.toNumber() : null }
    }),
  )
}

/**
 * The HyperEVM transaction that claims a confirmed withdrawal, for the
 * user's wallet to sign. Anyone may send it; the HYPE goes to the
 * withdrawal's destination.
 */
export async function claimRequest(p: {
  net: Net
  childTxHash: string
  parentProvider: Provider
  childProvider: Provider
}): Promise<TxRequest[]> {
  registerElysium()
  const n = networks[p.net]
  const receipt = await p.childProvider.getTransactionReceipt(p.childTxHash)
  if (!receipt) throw new Error('withdrawal transaction not found on Elysium')
  const events = new ChildTransactionReceipt(receipt).getChildToParentEvents()
  const outbox = new utils.Interface(outboxAbi)
  const out: TxRequest[] = []
  for (const e of events) {
    if (!('position' in e)) continue
    const m = new ChildToParentMessageReader(p.parentProvider, e)
    if ((await m.status(p.childProvider)) !== ChildToParentMessageStatus.CONFIRMED) continue
    const proof = (await m.getOutboxProof(p.childProvider)) as string[]
    out.push({
      chainId: n.parentChainId,
      to: n.ethBridge.outbox,
      data: outbox.encodeFunctionData('executeTransaction', [
        proof,
        e.position,
        e.caller,
        e.destination,
        e.arbBlockNum,
        e.ethBlockNum,
        e.timestamp,
        e.callvalue,
        e.data,
      ]),
      value: 0n,
    })
  }
  return out
}

/** Claim a confirmed withdrawal on HyperEVM. Anyone may send the claim; the HYPE goes to the withdrawal's destination. */
export async function claimWithdrawal(p: {
  childTxHash: string
  parentSigner: Signer
  childProvider: Provider
}): Promise<string[]> {
  registerElysium()
  const receipt = await p.childProvider.getTransactionReceipt(p.childTxHash)
  if (!receipt) throw new Error('withdrawal transaction not found on Elysium')
  const messages = await new ChildTransactionReceipt(receipt).getChildToParentMessages(p.parentSigner)
  const hashes: string[] = []
  for (const m of messages) {
    if ((await m.status(p.childProvider)) !== ChildToParentMessageStatus.CONFIRMED) continue
    const tx = await m.execute(p.childProvider)
    await tx.wait()
    hashes.push(tx.hash)
  }
  return hashes
}

// ---------------------------------------------------------------- the queue

/**
 * How many deposits are waiting for the next batch. Before Elysium's public
 * sequencer opens, deposits only land when a batch is posted.
 */
export async function queueStatus(p: { net: Net; parentProvider: Provider }): Promise<{
  batches: number
  depositsQueued: number
  depositsIncluded: number
}> {
  const n = networks[p.net].ethBridge
  const bridge = new Contract(n.bridge, bridgeAbi, p.parentProvider)
  const inbox = new Contract(n.sequencerInbox, sequencerInboxAbi, p.parentProvider)
  const [delivered, read, batches]: BigNumber[] = await Promise.all([
    bridge.delayedMessageCount(),
    inbox.totalDelayedMessagesRead(),
    inbox.batchCount(),
  ])
  return {
    batches: batches.toNumber(),
    depositsIncluded: read.toNumber(),
    depositsQueued: delivered.sub(read).toNumber(),
  }
}
