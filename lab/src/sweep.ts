// One-off: claim every agent's creator fees and send all of its HYPE, less a
// little gas, to the owner. LAB_SWEEP_TO="<address>:<id>", done once per id.
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { config } from './config.js'
import { save, state, walletKey } from './store.js'

const chain = defineChain({ id: 99901, name: 'Elysium', nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.mesa.cx'] } } })
const HOOK = '0xE928F2336051cBD5B9D4531C25EaDd13f9A82aeC' as Address
const hookAbi = parseAbi(['function accrued(address) view returns (uint256)', 'function claim() returns (uint256)'])
const AGENTS = ['wallet', 'news', 'vamp', 'worker', 'signal'] as const
const RESERVE = 50_000n * 1_000_000_000n // 50k gas at 1 gwei: far above a transfer at the 0.1 gwei floor

export async function sweep(note: (s: string) => void) {
  const [to, id] = (process.env.LAB_SWEEP_TO ?? '').split(':')
  if (!to || !id || !/^0x[0-9a-fA-F]{40}$/.test(to) || (state.swept ?? []).includes(id) || config.dryRun) return
  state.swept = [...(state.swept ?? []), id]
  save() // marked first, so a restart can never send twice
  const pub = createPublicClient({ chain, transport: http() })
  for (const name of AGENTS) {
    try {
      const account = privateKeyToAccount(walletKey(name))
      const wallet = createWalletClient({ account, chain, transport: http() })
      const fees = await pub.readContract({ address: HOOK, abi: hookAbi, functionName: 'accrued', args: [account.address] })
      if (fees > 0n) {
        const h = await wallet.writeContract({ account, chain, address: HOOK, abi: hookAbi, functionName: 'claim' })
        await pub.waitForTransactionReceipt({ hash: h, timeout: 180_000 })
      }
      const bal = await pub.getBalance({ address: account.address })
      if (bal <= RESERVE) { note(`Sweep: ${name} wallet had nothing to send`); continue }
      const value = bal - RESERVE
      const hash = await wallet.sendTransaction({ account, chain, to: to as Address, value, gas: 21_000n })
      note(`Sweep: sent ${(Number(value) / 1e18).toFixed(4)} HYPE from the ${name} wallet to the owner (${hash.slice(0, 10)}…)`)
      console.log(JSON.stringify({ sweep: name, from: account.address, value: value.toString(), hash }))
    } catch (e) {
      note(`Sweep: ${name} wallet failed: ${String(e).slice(0, 120)}`)
      console.error('sweep', name, e)
    }
  }
}
