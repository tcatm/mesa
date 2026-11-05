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
  /**
   * Every v4 PoolManager to index. `venue` names pools on it whose hook isn't
   * in `venues`. `backfill` marks a manager added after the database began:
   * its history is indexed beside the live chain until it catches up.
   */
  poolManagers: { address: string; name: string; venue?: string; backfill?: true }[]
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

/**
 * Token images Mesa shows instead of the one published at launch. The launch
 * record on chain can't change; this is only what Mesa's site and API show.
 * Used for Mesa's own token; keep it to tokens whose team asked for it.
 */
export const IMAGE_OVERRIDES: Record<string, string> = {
  // $MESA: mint mark on a slate circle (Nov 2026).
  '0xd1fe265a3a30177a0c5e74f535a2350b5f370197':
    'https://api.mesa.cx/media/9f22d028643d7754d7b7fc21c6a97d52427f0848000db7442b7ddb0370366d6a.png',
}

export const networks: Record<string, Network> = {
  mainnet: {
    chainId: 99901,
    rpc: 'https://rpc.agoradex.app',
    poolManagers: [
      { address: '0xe2e105d3f7209a9da11f83ccf3e7398a753823f1', name: 'Uniswap v4' },
      { address: '0x5fb015a49f5b35073f9ce01c2adb287a75f89600', name: 'ElysPump PoolManager', venue: 'ElysPump' },
      // Other launchpads' own PoolManagers, found by their Initialize events.
      { address: '0xb308b5df891c300a5f5a5b8fdbc30108ba842490', name: 'Kleos PoolManager', venue: 'Kleos', backfill: true },
      // BOXA's own PoolManager: the BOXA token itself launched here.
      { address: '0x06c63714fbf1f5753017123e2fcfdede4540b2c4', name: 'BOXA PoolManager', venue: 'BOXA', backfill: true },
      ...[
        '0x5c54a7293d96b11a29a0256ee8dfdbc3059637da',
        '0x3564d7defdb26abe3f0953ee57d93953ec94fa25',
        '0xeef19ba12957efaa08a2769a47660c9665b972df',
        '0x7654db7229130530a3033675abd4e35e59c57ead',
        '0x9fc48776883a89b9611979069ce25be1e82a536d',
        '0xe5bdc9a87b54ac1624cb51095dc86636378c4fb6',
        '0x5246d97812ec0786065c88413555a3ada6a47da8',
        '0x349aa7dd9d3cf3cff2eeb0993ea84ae1740d38e3',
        '0x794ad5fe8227524619c7bbf6b4572c9d08d9ff1f',
        '0xe4ee99e8d5b1c8bf0b09fa8c48347329e2269491',
        '0x31ca735981faff9144d479f967beee411516c54c',
        '0x21bf73ea677311ca25ad2935ca912b2a8d43dcd4',
        '0x3067db655bfb661d021f47b72748954bc6211583',
        '0xa8c3806d3c56b13e7799200f359fd9ed46c51714',
        '0xf1c4b572bb6712956eb65d407f3b821b538774ae',
      ].map((address) => ({ address, name: 'PoolManager', backfill: true as const })),
    ],
    venues: {
      '0x00c002cdae688f39a90cf2ad74c59421c9502acc': 'BOXA',
      '0x3ab88ddc3cf2a012af88b60828edb4553697e5dc': 'Volta',
      '0xe0def4221b9840a610d4e7d55812a79a6431a8ec': 'Ascend',
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
