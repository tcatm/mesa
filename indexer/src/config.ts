/** Where Mesa lives on each network. Mainnet is filled in at deployment. */
export interface Deployment {
  chainId: number
  rpc: string
  hook: string
  poolManager: string
  burner: string
  /** Block the hook was deployed in: indexing starts here. */
  startBlock: number
}

export const deployments: Record<string, Deployment> = {
  testnet: {
    chainId: 99801,
    rpc: 'https://testnet-rpc.elysium.kinetiq.xyz',
    hook: '0xdc9dE61dA0ABD148DD36dCC380803B86dBE72AEc',
    poolManager: '0xDe6D3E1938A0546074C67C04edF8aAF6Acb2419f',
    burner: '0x60d13A743d7256586a46E22E7Dd2B937357630bd',
    startBlock: 23_212_142,
  },
}

export const SUPPLY = 1_000_000_000
export const DEAD = '0x000000000000000000000000000000000000dead'

/** A buy in the launch block by anyone but the creator counts toward "bundle %". */
export const BUNDLE_BLOCKS = 1
