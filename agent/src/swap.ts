/**
 * Swaps on Elysium's Uniswap v4 pools, through the Universal Router that
 * matches each pool's PoolManager. Elysium has two PoolManagers (the official
 * one, used by Flaunch, BOXA and plain v4 pools, and ElysPump's own), each with
 * its own Universal Router.
 *
 *   Buy:  native HYPE in, one transaction, nothing to approve.
 *   Sell: an exact-amount approval of the token to Permit2 (only if needed),
 *         then one transaction that carries a signed, single-use Permit2
 *         permission for that amount and the swap. No unlimited approvals.
 *
 * Quotes come from Uniswap's V4Quoter. The deployed one serves the official
 * PoolManager; for ElysPump's, the same bytecode with its PoolManager address
 * swapped in is run as a simulation (an eth_call with a code override), so
 * nothing extra is deployed.
 */
import {
  type Address,
  type Hex,
  type PublicClient,
  concatHex,
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  parseAbi,
  parseAbiParameters,
  zeroAddress,
} from "viem";

export const ELYSIUM_RPC = "https://rpc.mesa.cx";
export const ELYSIUM_CHAIN_ID = 99901;

export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;
const QUOTER = "0x379f556c5a748bd7cc9baf0f7a344094ac1814f5" as const;
/** Where the patched quoter "lives" for the simulation; nothing is deployed there. */
const SIM_QUOTER = "0x00000000000000000000000000000000000c0de5" as const;

export const POOL_MANAGERS = {
  official: "0xe2e105d3f7209a9da11f83ccf3e7398a753823f1",
  elyspump: "0x5fb015a49f5b35073f9ce01c2adb287a75f89600",
} as const;

/** The Universal Router bound to each PoolManager. */
const ROUTERS: Record<string, Address> = {
  [POOL_MANAGERS.official]: "0x1b341fdd55d56f8e08409a2c25ddfad93eb03c1a",
  [POOL_MANAGERS.elyspump]: "0x751cefb96ac88db5327d39e0fbdd5d882d80b430",
};

export const routerFor = (poolManager: string): Address | null =>
  ROUTERS[poolManager.toLowerCase()] ?? null;

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/** A pool as the terminal API describes it. */
export interface ApiPool {
  id: string;
  venue: string;
  hook: string;
  pool_manager: string;
  currency0: string;
  currency1: string;
  quote: string;
  fee: number;
  tick_spacing: number;
}

export interface Market {
  key: PoolKey;
  poolManager: string;
  router: Address;
  token: Address;
  /** HYPE is currency0 (native HYPE sorts first), so buying is 0 -> 1. */
  tokenIs1: boolean;
}

/**
 * The pool to trade a token in: the first native-HYPE pool on a PoolManager
 * with a known router. Pools quoted in other currencies are not traded yet.
 */
export function marketOf(token: string, pools: ApiPool[]): Market | null {
  for (const p of pools) {
    const router = routerFor(p.pool_manager);
    if (!router || p.quote.toLowerCase() !== zeroAddress) continue;
    const key: PoolKey = {
      currency0: p.currency0 as Address,
      currency1: p.currency1 as Address,
      fee: Number(p.fee),
      tickSpacing: Number(p.tick_spacing),
      hooks: p.hook as Address,
    };
    return {
      key,
      poolManager: p.pool_manager.toLowerCase(),
      router,
      token: token as Address,
      tokenIs1: key.currency1.toLowerCase() === token.toLowerCase(),
    };
  }
  return null;
}

let client: PublicClient | null = null;
export function elysiumClient(): PublicClient {
  client ??= createPublicClient({ transport: http(ELYSIUM_RPC) }) as PublicClient;
  return client;
}

// ---------------------------------------------------------------- quotes

const quoterAbi = parseAbi([
  "function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

let patchedQuoter: Promise<Hex> | null = null;
/** The V4Quoter's runtime code with ElysPump's PoolManager in place of the official one. */
function elysPumpQuoterCode(): Promise<Hex> {
  patchedQuoter ??= elysiumClient()
    .getCode({ address: QUOTER })
    .then((code) => {
      if (!code) throw new Error("quoter not found");
      const from = POOL_MANAGERS.official.slice(2);
      const to = POOL_MANAGERS.elyspump.slice(2);
      const out = code.toLowerCase().split(from).join(to) as Hex;
      if (out === code.toLowerCase()) throw new Error("quoter has no PoolManager to patch");
      return out;
    });
  return patchedQuoter;
}

/** Tokens (buy) or HYPE (sell) out for `amountIn`, both in wei. */
export async function quote(m: Market, side: "buy" | "sell", amountIn: bigint): Promise<bigint> {
  const zeroForOne = side === "buy" ? m.tokenIs1 : !m.tokenIs1;
  const data = encodeFunctionData({
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ poolKey: m.key, zeroForOne, exactAmount: amountIn, hookData: "0x" }],
  });
  const official = m.poolManager === POOL_MANAGERS.official;
  const to = official ? QUOTER : SIM_QUOTER;
  const result = (await elysiumClient().request({
    method: "eth_call",
    params: official
      ? [{ to, data }, "latest"]
      : ([{ to, data }, "latest", { [SIM_QUOTER]: { code: await elysPumpQuoterCode() } }] as never),
  })) as Hex;
  return BigInt(`0x${result.slice(2, 66)}`);
}

// ---------------------------------------------------------------- swaps

const routerAbi = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
]);
const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
const permit2Abi = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);

// Universal Router commands and V4Router actions (Uniswap v4-periphery).
const V4_SWAP = "0x10";
const PERMIT2_PERMIT = "0x0a";
const SWAP_EXACT_IN_SINGLE = 0x06;
const SETTLE_ALL = 0x0c;
const TAKE_ALL = 0x0f;

export interface TxRequest {
  chainId: number;
  to: Address;
  data: Hex;
  value: bigint;
}

/**
 * Before a swap lands, Elysium may still be waiting on the HyperEVM inbox
 * (before its public sequencer opens), so allow a generous deadline.
 */
const DEADLINE_SECONDS = 20 * 60;

function v4SwapInput(m: Market, side: "buy" | "sell", amountIn: bigint, minOut: bigint): Hex {
  const zeroForOne = side === "buy" ? m.tokenIs1 : !m.tokenIs1;
  const currencyIn = zeroForOne ? m.key.currency0 : m.key.currency1;
  const currencyOut = zeroForOne ? m.key.currency1 : m.key.currency0;
  const actions = concatHex(
    [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL].map(
      (a) => `0x${a.toString(16).padStart(2, "0")}` as Hex,
    ),
  );
  const params = [
    encodeAbiParameters(
      parseAbiParameters(
        "((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)",
      ),
      [{ poolKey: m.key, zeroForOne, amountIn, amountOutMinimum: minOut, hookData: "0x" }],
    ),
    encodeAbiParameters(parseAbiParameters("address, uint256"), [currencyIn, amountIn]),
    encodeAbiParameters(parseAbiParameters("address, uint256"), [currencyOut, minOut]),
  ];
  return encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), [actions, params]);
}

const deadline = () => BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);

/** A buy: `hypeIn` wei of native HYPE for at least `minOut` tokens. */
export function buyRequest(m: Market, hypeIn: bigint, minOut: bigint): TxRequest {
  return {
    chainId: ELYSIUM_CHAIN_ID,
    to: m.router,
    data: encodeFunctionData({
      abi: routerAbi,
      functionName: "execute",
      args: [V4_SWAP, [v4SwapInput(m, "buy", hypeIn, minOut)], deadline()],
    }),
    value: hypeIn,
  };
}

/** The approval a sell needs first, if the token's Permit2 allowance is short: exactly the amount. */
export async function sellApproval(
  m: Market,
  owner: Address,
  amount: bigint,
): Promise<TxRequest | null> {
  const current = await elysiumClient().readContract({
    address: m.token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, PERMIT2],
  });
  if (current >= amount) return null;
  return {
    chainId: ELYSIUM_CHAIN_ID,
    to: m.token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PERMIT2, amount] }),
    value: 0n,
  };
}

/** The Permit2 permission a sell signs: this amount, this router, for 30 minutes. */
export async function sellPermit(m: Market, owner: Address, amount: bigint) {
  const [, , nonce] = await elysiumClient().readContract({
    address: PERMIT2,
    abi: permit2Abi,
    functionName: "allowance",
    args: [owner, m.token, m.router],
  });
  const now = Math.floor(Date.now() / 1000);
  const message = {
    details: { token: m.token, amount, expiration: now + 30 * 60, nonce },
    spender: m.router,
    sigDeadline: BigInt(now + 30 * 60),
  };
  return {
    message,
    typedData: {
      domain: { name: "Permit2", chainId: ELYSIUM_CHAIN_ID, verifyingContract: PERMIT2 },
      types: {
        PermitDetails: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint160" },
          { name: "expiration", type: "uint48" },
          { name: "nonce", type: "uint48" },
        ],
        PermitSingle: [
          { name: "details", type: "PermitDetails" },
          { name: "spender", type: "address" },
          { name: "sigDeadline", type: "uint256" },
        ],
      },
      primaryType: "PermitSingle" as const,
      message,
    },
  };
}

/** A sell: `tokensIn` for at least `minOut` wei of HYPE, carrying the signed permit. */
export function sellRequest(
  m: Market,
  tokensIn: bigint,
  minOut: bigint,
  permit: Awaited<ReturnType<typeof sellPermit>>["message"],
  signature: Hex,
): TxRequest {
  const permitInput = encodeAbiParameters(
    parseAbiParameters(
      "((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline), bytes",
    ),
    [permit, signature],
  );
  return {
    chainId: ELYSIUM_CHAIN_ID,
    to: m.router,
    data: encodeFunctionData({
      abi: routerAbi,
      functionName: "execute",
      args: [
        concatHex([PERMIT2_PERMIT, V4_SWAP]),
        [permitInput, v4SwapInput(m, "sell", tokensIn, minOut)],
        deadline(),
      ],
    }),
    value: 0n,
  };
}

export const tokenBalance = (token: Address, owner: Address) =>
  elysiumClient().readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });

export const tokenDecimals = (token: Address) =>
  elysiumClient().readContract({ address: token, abi: erc20Abi, functionName: "decimals" });

/** `amount` less `bps` basis points. */
export const withSlippage = (amount: bigint, bps: number) =>
  (amount * BigInt(10_000 - bps)) / 10_000n;
