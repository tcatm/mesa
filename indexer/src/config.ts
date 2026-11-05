/**
 * What the indexer follows on each network.
 *
 * Every Uniswap v4 pool on the listed PoolManagers is indexed, whatever its
 * hook; `venues` names the launchpad behind each known hook. Mesa's own hook,
 * when deployed, adds its launch settings and exact fees.
 */
export interface Network {
  chainId: number
  rpc: string
  poolManagers: { address: string; name: string }[]
  /** hook address (lowercase) -> launchpad name. A pool with no hook is "Uniswap v4". */
  venues: Record<string, string>
  /** Tokens worth exactly 1 HYPE: native HYPE (address zero) and fully backed wrappers. */
  hype: string[]
  /** A dollar stablecoin, for HYPE's price in USD. */
  usd?: { address: string; decimals: number }
  /** Mesa's deployment, if any. */
  mesa?: { hook: string; burner: string }
  /** Block to start indexing from. */
  startBlock: number
  /** Blocks per log request. */
  range: number
}

const ZERO = '0x0000000000000000000000000000000000000000'

export const networks: Record<string, Network> = {
  mainnet: {
    chainId: 99901,
    rpc: 'https://rpc.agoradex.app',
    poolManagers: [
      { address: '0xe2e105d3f7209a9da11f83ccf3e7398a753823f1', name: 'Uniswap v4' },
      { address: '0x5fb015a49f5b35073f9ce01c2adb287a75f89600', name: 'ElysPump PoolManager' },
    ],
    venues: {
      '0x00c002cdae688f39a90cf2ad74c59421c9502acc': 'BOXA',
      '0x3ab88ddc3cf2a012af88b60828edb4553697e5dc': 'Flaunch',
      '0xe928f2336051cbd5b9d4531c25eadd13f9a82aec': 'Mesa',
      '0xe11cafa5901b0aab51eb78251488400f9e4320cc': 'ElysPump',
      '0xbacf71bf02b8cfe171853c5ec4a060ba2ac1e0cc': 'ElysPump',
    },
    hype: [ZERO, '0xba876237b0f021a6c6d852d6c26e107997cc5e81', '0x0269031ace34a7821e9d9980d087c35ce7c19eef'],
    usd: { address: '0xb47c4c8f73f009cc0c0d3f92b388d13e293f0b65', decimals: 6 },
    mesa: { hook: '0xe928f2336051cbd5b9d4531c25eadd13f9a82aec', burner: '0xccfe02c0a8fec0c39683ae00b35a5d4560d8e7c1' },
    startBlock: 0,
    range: Number(process.env.RANGE ?? 10_000),
  },
  testnet: {
    chainId: 99801,
    rpc: 'https://testnet-rpc.elysium.kinetiq.xyz',
    poolManagers: [{ address: '0xde6d3e1938a0546074c67c04edf8aaf6acb2419f', name: 'Mesa rehearsal' }],
    venues: { '0xdc9de61da0abd148dd36dcc380803b86dbe72aec': 'Mesa' },
    hype: [ZERO, '0xcd57f65c2b0e5881cfc2e609f7cd53b746e1f234'],
    mesa: { hook: '0xe135287a21207cf0e457a10f686932936d4caaec', burner: '0xfd4d2a133ffbc045c7f80c7a196d8b2be3e64012' },
    startBlock: 23_212_142,
    range: 2_000,
  },
}

export const DEAD = '0x000000000000000000000000000000000000dead'
export { ZERO }

/** A buy in the launch block by anyone but the creator counts toward "bundle %". */
export const BUNDLE_BLOCKS = 1
