/**
 * Command line for the bridge, for testing and operations.
 *
 *   npm run cli -- queue      --net testnet
 *   npm run cli -- deposit    --net testnet --amount 0.01 [--to 0x..]
 *   npm run cli -- bridge-buy --net testnet --amount 0.01 --token 0x.. --router 0x.. [--min-out 0] [--to 0x..]
 *   npm run cli -- deposit-status    --net testnet --tx 0x..
 *   npm run cli -- withdraw          --net testnet --amount 0.01 [--to 0x..]
 *   npm run cli -- withdrawal-status --net testnet --tx 0x..
 *   npm run cli -- claim             --net testnet --tx 0x..
 *
 * Env: PRIVATE_KEY (for commands that send), PARENT_RPC and CHILD_RPC to
 * override the public endpoints.
 */
import { BigNumber, Wallet, providers, utils } from 'ethers'

import {
  BRIDGE_BUY_GAS,
  bridgeAndBuyRequest,
  claimWithdrawal,
  defaultRpc,
  depositRequest,
  depositStatus,
  queueStatus,
  withdrawRequest,
  withdrawalStatus,
  type Net,
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
const show = (o: unknown) =>
  console.log(JSON.stringify(o, (_, v) => (v?.type === 'BigNumber' ? BigNumber.from(v).toString() : v), 2))

async function main() {
  switch (cmd) {
    case 'queue':
      return show(await queueStatus({ net, parentProvider: parent }))

    case 'deposit': {
      const w = wallet(parent)
      const req = await depositRequest({
        net,
        amount: hype(args.amount),
        from: w.address,
        to: args.to,
        parentProvider: parent,
        childProvider: child,
      })
      const tx = await w.sendTransaction(req.txRequest)
      console.log('deposit sent on HyperEVM:', tx.hash, 'value', utils.formatEther(req.txRequest.value), 'HYPE')
      await tx.wait()
      return console.log('included on HyperEVM; credited on Elysium with the next batch')
    }

    case 'bridge-buy': {
      const w = wallet(parent)
      const req = await bridgeAndBuyRequest({
        net,
        amount: hype(args.amount),
        from: w.address,
        to: args.to,
        router: args.router,
        token: args.token,
        minOut: BigNumber.from(args['min-out'] ?? 0),
        gasLimit: args.gas ? BigNumber.from(args.gas) : BRIDGE_BUY_GAS,
        parentProvider: parent,
        childProvider: child,
      })
      const tx = await w.sendTransaction(req.txRequest)
      console.log('bridge-and-buy sent on HyperEVM:', tx.hash, 'value', utils.formatEther(req.txRequest.value), 'HYPE')
      await tx.wait()
      return console.log('included on HyperEVM; runs on Elysium with the next batch')
    }

    case 'deposit-status':
      return show(await depositStatus({ parentTxHash: args.tx, parentProvider: parent, childProvider: child }))

    case 'withdraw': {
      const w = wallet(child)
      const req = await withdrawRequest({ net, amount: hype(args.amount), from: w.address, to: args.to })
      const tx = await w.sendTransaction(req.txRequest)
      console.log('withdrawal sent on Elysium:', tx.hash)
      await tx.wait()
      return console.log('included; claim on HyperEVM after the challenge period')
    }

    case 'withdrawal-status':
      return show(await withdrawalStatus({ childTxHash: args.tx, parentProvider: parent, childProvider: child }))

    case 'claim':
      return show(await claimWithdrawal({ childTxHash: args.tx, parentSigner: wallet(parent), childProvider: child }))

    default:
      throw new Error(`unknown command ${cmd ?? '(none)'}`)
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
