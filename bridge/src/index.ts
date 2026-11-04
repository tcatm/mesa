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
  ChildToParentMessageStatus,
  ChildTransactionReceipt,
  EthBridger,
  ParentToChildMessageStatus,
  ParentTransactionReceipt,
  type ParentToChildTransactionRequest,
  type ChildToParentTransactionRequest,
} from '@arbitrum/sdk'
import { ParentToChildMessageCreator } from '@arbitrum/sdk/dist/lib/message/ParentToChildMessageCreator.js'
import { BigNumber, Contract, utils, type providers, type Signer } from 'ethers'

import { networks, registerElysium, type Net } from './networks.js'

export { networks, defaultRpc, elysium, elysiumTestnet, registerElysium, type Net } from './networks.js'

type Provider = providers.Provider

const routerAbi = ['function buy(address token, uint256 minOut, address recipient) payable returns (uint256)']
const bridgeAbi = ['function delayedMessageCount() view returns (uint256)']
const sequencerInboxAbi = [
  'function batchCount() view returns (uint256)',
  'function totalDelayedMessagesRead() view returns (uint256)',
]

/** Gas for a bridge-and-buy on arrival, used when estimation is not possible. */
export const BRIDGE_BUY_GAS = BigNumber.from(1_500_000)

function bridger(net: Net): EthBridger {
  registerElysium()
  return new EthBridger(networks[net])
}

// ---------------------------------------------------------------- deposits

export interface DepositParams {
  net: Net
  /** HYPE to arrive on Elysium, in wei. */
  amount: BigNumber
  /** The HyperEVM account paying. */
  from: string
  /** The Elysium account credited; defaults to `from`. */
  to?: string
  parentProvider: Provider
  childProvider: Provider
}

/**
 * A plain HYPE deposit. The request's `txRequest` is what the wallet signs on
 * HyperEVM; its value is `amount` plus the small retryable gas, and anything
 * unused is refunded to `to` on Elysium.
 */
export async function depositRequest(p: DepositParams): Promise<ParentToChildTransactionRequest> {
  return bridger(p.net).getDepositToRequest({
    amount: p.amount,
    from: p.from,
    destinationAddress: p.to ?? p.from,
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
  /**
   * Gas for the buy on Elysium. Estimated when omitted, which needs the
   * child RPC to see the token's pool; before the public sequencer opens a
   * brand-new launch may not be visible yet, so pass `BRIDGE_BUY_GAS`.
   */
  gasLimit?: BigNumber
}

/**
 * A deposit that buys `token` for `to` when it arrives. If the buy fails, the
 * router sends the HYPE to `to` on Elysium. If the bridge message itself
 * fails (too little gas), it stays redeemable by anyone for 7 days and its
 * value goes to `to` if it expires.
 */
export async function bridgeAndBuyRequest(p: BridgeAndBuyParams): Promise<ParentToChildTransactionRequest> {
  registerElysium()
  const recipient = p.to ?? p.from
  const data = new utils.Interface(routerAbi).encodeFunctionData('buy', [p.token, p.minOut, recipient])
  return ParentToChildMessageCreator.getTicketCreationRequest(
    {
      from: p.from,
      to: p.router,
      l2CallValue: p.amount,
      data,
      excessFeeRefundAddress: recipient,
      callValueRefundAddress: recipient,
    },
    p.parentProvider,
    p.childProvider,
    p.gasLimit ? { gasLimit: { base: p.gasLimit } } : undefined,
  )
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

/** A withdrawal, signed on Elysium. Claimable on HyperEVM after the challenge period. */
export async function withdrawRequest(p: {
  net: Net
  amount: BigNumber
  from: string
  /** The HyperEVM account to pay; defaults to `from`. */
  to?: string
}): Promise<ChildToParentTransactionRequest> {
  return bridger(p.net).getWithdrawalRequest({ amount: p.amount, from: p.from, destinationAddress: p.to ?? p.from })
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
