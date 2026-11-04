import { registerCustomArbitrumNetwork, type ArbitrumNetwork } from '@arbitrum/sdk'

/**
 * Elysium's rollup and bridge contracts on HyperEVM.
 *
 * Testnet: Kinetiq's contract-addresses page, checked on chain.
 * Mainnet: read on chain from the inbox (Inbox.bridge(), Bridge.rollup(), and
 * so on), since Kinetiq publishes mainnet addresses at launch. See
 * docs/elysium.md.
 */
export const elysium: ArbitrumNetwork = {
  name: 'Elysium',
  chainId: 99901,
  parentChainId: 999,
  confirmPeriodBlocks: 483_840,
  isTestnet: false,
  isCustom: true,
  isBold: true,
  ethBridge: {
    bridge: '0x503D572157113fAaaD4DbeD2647Bb10b949216B6',
    inbox: '0xce59f8b65ad41c9dae4c07a0571a39824bd92cff',
    outbox: '0xeC6B106DfA14428FE5Eec2a4065a7be599f02728',
    rollup: '0x508C173dFe5F737B3493195Bf785d71fA76fD217',
    sequencerInbox: '0x7f3Ff53aecB87261206ad3bDc27A88b6D8420fa6',
  },
}

export const elysiumTestnet: ArbitrumNetwork = {
  name: 'Elysium testnet',
  chainId: 99801,
  parentChainId: 998,
  confirmPeriodBlocks: 10,
  isTestnet: true,
  isCustom: true,
  isBold: true,
  ethBridge: {
    bridge: '0x36dAbc3CEE2E1084B7d04c8015Ef68Cac78f4f37',
    inbox: '0x11178Df40CBf87a4343f4B3F8B09B366ceFA8Ec0',
    outbox: '0x87391D602aaffB3Fe8051EcCDb75d6EEe8C31060',
    rollup: '0xEbf08e34941fd93a0Fc1cD89dbBF7447267039Df',
    sequencerInbox: '0xb5B1a0AebfFeF819Ec3F8c39a17b5C4E70A001E3',
  },
}

export type Net = 'mainnet' | 'testnet'

export const networks: Record<Net, ArbitrumNetwork> = { mainnet: elysium, testnet: elysiumTestnet }

/** Public endpoints; pass your own for production traffic. */
export const defaultRpc: Record<Net, { parent: string; child: string }> = {
  mainnet: { parent: 'https://rpc.hyperliquid.xyz/evm', child: 'https://rpc.boxa.club' },
  testnet: { parent: 'https://rpc.hyperliquid-testnet.xyz/evm', child: 'https://testnet-rpc.elysium.kinetiq.xyz' },
}

let registered = false

/** Make the Arbitrum SDK aware of both Elysium networks. Safe to call twice. */
export function registerElysium(): void {
  if (registered) return
  registerCustomArbitrumNetwork(elysium)
  registerCustomArbitrumNetwork(elysiumTestnet)
  registered = true
}
