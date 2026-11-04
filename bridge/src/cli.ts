/**
 * Command line for the bridge, for testing and operations.
 *
 *   npm run cli -- queue      --net testnet
 *   npm run cli -- deposit    --net testnet --amount 0.01 [--to 0x..]
 *   npm run cli -- bridge-buy --net testnet --amount 0.01 --token 0x.. --router 0x.. [--min-out 0] [--to 0x..]
 *   npm run cli -- deposit-progress  --net testnet --tx 0x..   (HyperEVM only)
 *   npm run cli -- deposit-status    --net testnet --tx 0x..   (reads Elysium too)
 *   npm run cli -- withdraw          --net testnet --amount 0.01 [--to 0x..]
 *   npm run cli -- withdrawal-status --net testnet --tx 0x..
 *   npm run cli -- claim             --net testnet --tx 0x..
 *
 * Add --dry true (with --from 0x..) to print a transaction instead of sending it.
 *
 * Env: PRIVATE_KEY (for commands that send), PARENT_RPC and CHILD_RPC to
 * override the public endpoints.
 */
import { BigNumber, Wallet, providers, utils } from 'ethers'

import {
  bridgeAndBuyRequest,
  claimRequest,
  depositProgress,
  defaultRpc,
  depositRequest,
  depositStatus,
  queueStatus,
  withdrawRequest,
  withdrawalStatus,
  type Net,
  type TxRequest,
} from './index.js'

const [cmd, ...rest] = process.argv.slice(2)
const args: Record<string, string> = {}
for (let i = 0; i < rest.length; i += 2) args[rest[i].replace(/^--/, '')] = rest[i + 1]

const net = (args.net ?? 'testnet') as Net
if (net !== 'mainnet' && net !== 'testnet') throw new Error('--net must be mainnet or testnet')
const parent = new providers.StaticJsonRpcProvider(process.env.PARENT_RPC ?? defaultRpc[net].parent)
const child = new providers.StaticJsonRpcProvider(process.env.CHILD_RPC ?? defaultRpc[net].child)

function wallet(p: providers.Provider): Wallet {
  if (!process.env.PRIVATE_KEY) throw new Error('PRIVATE_KEY is not set')
  return new Wallet(process.env.PRIVATE_KEY, p)
}

const hype = (s: string) => utils.parseEther(s)

/** Send `req` from `w`, or with --dry true just print it. */
async function send(w: Wallet | undefined, req: TxRequest, label: string) {
  console.log(label, { to: req.to, value: utils.formatEther(req.value) + ' HYPE', chainId: req.chainId })
  if (args.dry === 'true' || !w) return console.log('dry run, not sent:', JSON.stringify({ to: req.to, data: req.data, value: req.value.toString() }))
  const tx = await w.sendTransaction({ to: req.to, data: req.data, value: BigNumber.from(req.value), chainId: req.chainId })
  console.log('sent:', tx.hash)
  await tx.wait()
  console.log('included')
}

const dry = () => args.dry === 'true'
const fromAddr = (w?: Wallet) => w?.address ?? args.from
const show = (o: unknown) =>
  console.log(JSON.stringify(o, (_, v) => (v?.type === 'BigNumber' ? BigNumber.from(v).toString() : v), 2))

async function main() {
  switch (cmd) {
    case 'queue':
      return show(await queueStatus({ net, parentProvider: parent }))

    case 'deposit': {
      const w = dry() ? undefined : wallet(parent)
      const req = await depositRequest({
        net,
        amount: hype(args.amount),
        from: fromAddr(w),
        to: args.to,
        parentProvider: parent,
        childProvider: process.env.CHILD_RPC ? child : undefined,
      })
      return send(w, req, 'deposit on HyperEVM; credited on Elysium with the next batch')
    }

    case 'bridge-buy': {
      const w = dry() ? undefined : wallet(parent)
      const req = await bridgeAndBuyRequest({
        net,
        amount: hype(args.amount),
        from: fromAddr(w),
        to: args.to,
        router: args.router,
        token: args.token,
        minOut: BigNumber.from(args['min-out'] ?? 0),
        gasLimit: args.gas ? BigNumber.from(args.gas) : undefined,
        parentProvider: parent,
        childProvider: process.env.CHILD_RPC ? child : undefined,
      })
      return send(w, req, 'bridge-and-buy on HyperEVM; runs on Elysium with the next batch')
    }

    case 'deposit-progress':
      return show(await depositProgress({ net, parentTxHash: args.tx, parentProvider: parent }))

    case 'deposit-status':
      return show(await depositStatus({ parentTxHash: args.tx, parentProvider: parent, childProvider: child }))

    case 'withdraw': {
      const w = dry() ? undefined : wallet(child)
      return send(w, withdrawRequest({ net, amount: hype(args.amount), from: fromAddr(w), to: args.to }), 'withdrawal on Elysium')
    }

    case 'withdrawal-status':
      return show(await withdrawalStatus({ childTxHash: args.tx, parentProvider: parent, childProvider: child }))

    case 'claim': {
      const reqs = await claimRequest({ net, childTxHash: args.tx, parentProvider: parent, childProvider: child })
      if (reqs.length === 0) return console.log('nothing claimable yet')
      const w = dry() ? undefined : wallet(parent)
      for (const r of reqs) await send(w, r, 'claim on HyperEVM')
      return
    }

    default:
      throw new Error(`unknown command ${cmd ?? '(none)'}`)
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
