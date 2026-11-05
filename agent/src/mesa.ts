/**
 * The Mesa SDK: read Elysium's markets through Mesa's indexer, and trade,
 * launch and claim through Mesa's contracts, from one object.
 *
 * Reads need nothing. Writes need a private key, ideally of a wallet made for
 * the agent and funded with only what it may spend. Every write is checked
 * against a per-transaction HYPE limit (MESA_MAX_HYPE, 1 HYPE by default).
 */
import {
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type WalletClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  formatEther,
  formatUnits,
  http,
  parseEther,
  parseUnits,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  ELYSIUM_CHAIN_ID,
  ELYSIUM_RPC,
  type ApiPool,
  buyRequest,
  elysiumClient,
  marketOf,
  quote as quoteSwap,
  sellApproval,
  sellPermit,
  sellRequest,
  tokenBalance,
  tokenDecimals,
  withSlippage,
} from "./swap.js";
import { LIMITS, MESA_HOOK, hookAbi, launchCall, launchedToken, validate, type LaunchForm } from "./launch.js";

export const API = "https://api.mesa.cx/elysium";
export const MESA_TOKEN: Address = "0xD1Fe265a3A30177a0c5E74F535a2350b5f370197";

export const elysium: Chain = defineChain({
  id: ELYSIUM_CHAIN_ID,
  name: "Elysium",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: [ELYSIUM_RPC] } },
  blockExplorers: { default: { name: "Mesa Explorer", url: "https://mesa.cx" } },
});

export type Sort = "trending" | "volume" | "gainers" | "losers" | "mcap" | "new" | "trades";

export interface MesaOptions {
  /** A 0x-prefixed private key. Without one, the SDK can only read. */
  privateKey?: Hex | undefined;
  /** The most HYPE a single buy, launch or dev buy may spend. Default 1. */
  maxHypePerTx?: number | undefined;
  /** Default slippage for swaps, in basis points. Default 300 (3%). */
  slippageBps?: number | undefined;
  /** Builder fee attached to launches: your app's address and up to 1%. */
  builder?: { address: Address; pct: number } | undefined;
}

export interface TxResult {
  hash: Hash;
  status: "success" | "reverted" | "pending";
  explorer: string;
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error(`Mesa API ${path}: ${r.status}`);
  return (await r.json()) as T;
}

const addr = (a: string): Address => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`Not an address: ${a}`);
  return a as Address;
};

export class Mesa {
  readonly account: PrivateKeyAccount | null;
  private wallet: WalletClient | null;
  readonly maxHype: number;
  readonly slippageBps: number;
  readonly builder: MesaOptions["builder"];

  constructor(opts: MesaOptions = {}) {
    this.account = opts.privateKey ? privateKeyToAccount(opts.privateKey) : null;
    this.wallet = this.account
      ? createWalletClient({ account: this.account, chain: elysium, transport: http(ELYSIUM_RPC) })
      : null;
    this.maxHype = opts.maxHypePerTx ?? 1;
    this.slippageBps = opts.slippageBps ?? 300;
    this.builder = opts.builder;
    if (this.builder && (this.builder.pct <= 0 || this.builder.pct > LIMITS.builderMax))
      throw new Error("Builder fee: between 0 and 1 percent.");
  }

  /** Configure from the environment: MESA_PRIVATE_KEY, MESA_MAX_HYPE, MESA_SLIPPAGE_BPS, MESA_BUILDER, MESA_BUILDER_FEE. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): Mesa {
    const key = env["MESA_PRIVATE_KEY"]?.trim();
    const builder = env["MESA_BUILDER"]?.trim();
    return new Mesa({
      privateKey: key ? ((key.startsWith("0x") ? key : `0x${key}`) as Hex) : undefined,
      maxHypePerTx: env["MESA_MAX_HYPE"] ? Number(env["MESA_MAX_HYPE"]) : undefined,
      slippageBps: env["MESA_SLIPPAGE_BPS"] ? Number(env["MESA_SLIPPAGE_BPS"]) : undefined,
      builder: builder ? { address: addr(builder), pct: Number(env["MESA_BUILDER_FEE"] ?? 0.5) } : undefined,
    });
  }

  get address(): Address | null {
    return this.account?.address ?? null;
  }

  // ------------------------------------------------------------ reading

  /**
   * A token by address, or by ticker ("$MESA" or "MESA"). Tickers aren't
   * unique on Elysium, so a ticker resolves to the token with that exact
   * symbol held by the most wallets, the one the terminal marks OG.
   */
  async resolve(token: string): Promise<Address> {
    const t = token.trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(t)) return t as Address;
    const sym = t.replace(/^\$/, "").toLowerCase();
    if (!sym) throw new Error("Give a token address or ticker.");
    const { tokens } = await this.tokens({ query: sym, limit: 100 });
    const exact = tokens
      .filter((x) => String(x["symbol"] ?? "").toLowerCase() === sym)
      .sort((a, b) => Number(b["holders"] ?? 0) - Number(a["holders"] ?? 0));
    const hit = exact[0];
    if (!hit) throw new Error(`No token with the ticker $${sym.toUpperCase()}. Use its address.`);
    return hit["address"] as Address;
  }

  /** Tokens on every Elysium launchpad, sorted. */
  tokens(o: { sort?: Sort; window?: "1h" | "6h" | "24h" | "7d"; venue?: string; query?: string; limit?: number } = {}) {
    const q = new URLSearchParams({ sort: o.sort ?? "trending", window: o.window ?? "24h", limit: String(Math.min(o.limit ?? 20, 200)) });
    if (o.venue) q.set("venue", o.venue);
    if (o.query) q.set("q", o.query);
    return get<{ total: number; tokens: Record<string, unknown>[] }>(`/tokens?${q}`);
  }
  /** One token: price, market cap, volume, holders, launch settings and forensics. */
  async token(address: string) {
    address = await this.resolve(address);
    return get<Record<string, unknown> & { pools: ApiPool[]; symbol: string | null }>(`/tokens/${addr(address).toLowerCase()}`);
  }
  async trades(address: string, limit = 50) {
    address = await this.resolve(address);
    return get<Record<string, unknown>[]>(`/tokens/${addr(address).toLowerCase()}/trades?limit=${Math.min(limit, 500)}`);
  }
  async holders(address: string, limit = 25) {
    address = await this.resolve(address);
    return get<{ address: string; balance: number; pct: number | null }[]>(`/tokens/${addr(address).toLowerCase()}/holders?limit=${Math.min(limit, 1000)}`);
  }
  /** OHLC candles in HYPE; interval in seconds. */
  async candles(address: string, interval = 300, limit = 200) {
    address = await this.resolve(address);
    return get<Record<string, unknown>>(`/tokens/${addr(address).toLowerCase()}/candles?interval=${interval}&limit=${limit}`);
  }
  /** A wallet's token holdings and profit and loss. */
  portfolio(address?: string) {
    const a = address ?? this.address;
    if (!a) throw new Error("Give an address, or configure a private key.");
    return get<Record<string, unknown>>(`/wallets/${addr(a).toLowerCase()}`);
  }
  /** Chain-wide numbers: tokens, launchpads, volume, block height. */
  stats() {
    return get<Record<string, unknown>>(`/stats`);
  }
  launchpads() {
    return get<Record<string, unknown>[]>(`/venues`);
  }
  /** The $MESA buyback and burn: totals and the latest burns. */
  burns() {
    return get<Record<string, unknown>>(`/mesa`);
  }
  /** What Mesa's indexer knows about a transaction: trades, launches, burns. */
  transaction(hash: string) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error(`Not a transaction hash: ${hash}`);
    return get<Record<string, unknown>>(`/tx/${hash.toLowerCase()}`);
  }

  /** HYPE and, optionally, one token's balance for this agent's wallet (or another). */
  async balance(token?: string, owner?: string) {
    const who = (owner ? addr(owner) : this.address) as Address | null;
    if (!who) throw new Error("Give an address, or configure a private key.");
    const hype = await elysiumClient().getBalance({ address: who });
    const out: Record<string, string> = { address: who, HYPE: formatEther(hype) };
    if (token) {
      const t = await this.resolve(token);
      const [bal, dec, info] = await Promise.all([tokenBalance(t, who), tokenDecimals(t), this.token(t).catch(() => null)]);
      out[info?.symbol ? `$${info.symbol}` : t] = formatUnits(bal, dec);
    }
    return out;
  }

  /** A price for a buy (HYPE in) or a sell (tokens in), before trading. */
  async quote(token: string, side: "buy" | "sell", amount: string) {
    const t = await this.resolve(token);
    const info = await this.token(t);
    const m = marketOf(t, info.pools);
    if (!m) throw new Error("No HYPE pool Mesa can route for this token.");
    const dec = side === "sell" ? await tokenDecimals(t) : 18;
    const inWei = side === "buy" ? parseEther(amount) : parseUnits(amount, dec);
    const out = await quoteSwap(m, side, inWei);
    const outDec = side === "buy" ? await tokenDecimals(t) : 18;
    return {
      token: t,
      symbol: info.symbol,
      side,
      amountIn: amount,
      amountOut: formatUnits(out, outDec),
      minimumOut: formatUnits(withSlippage(out, this.slippageBps), outDec),
      slippageBps: this.slippageBps,
      unit: side === "buy" ? `$${info.symbol}` : "HYPE",
    };
  }

  // ------------------------------------------------------------ writing

  private need(): { wallet: WalletClient; account: PrivateKeyAccount } {
    if (!this.wallet || !this.account)
      throw new Error("This needs a wallet: set MESA_PRIVATE_KEY to a key for a wallet made for this agent.");
    return { wallet: this.wallet, account: this.account };
  }
  private cap(hype: number) {
    if (!(hype > 0)) throw new Error("Amount must be above 0.");
    if (hype > this.maxHype)
      throw new Error(`${hype} HYPE is over this agent's limit of ${this.maxHype} HYPE per transaction (MESA_MAX_HYPE).`);
  }
  private async send(req: { to: Address; data: Hex; value: bigint }): Promise<TxResult> {
    const { wallet, account } = this.need();
    const hash = await wallet.sendTransaction({ account, chain: elysium, to: req.to, data: req.data, value: req.value });
    // Until Elysium's public sequencer opens, Mesa's RPC relays each transaction
    // through the official inbox on HyperEVM: it lands about a minute later.
    const r = await elysiumClient()
      .waitForTransactionReceipt({ hash, timeout: 240_000, pollingInterval: 4_000 })
      .catch(() => null);
    return { hash, status: r ? r.status : "pending", explorer: `https://mesa.cx/tx/${hash}` };
  }

  /** Buy a token with `hype` HYPE. */
  async buy(token: string, hype: string, slippageBps = this.slippageBps) {
    this.cap(Number(hype));
    const t = await this.resolve(token);
    const info = await this.token(t);
    const m = marketOf(t, info.pools);
    if (!m) throw new Error("No HYPE pool Mesa can route for this token.");
    const inWei = parseEther(hype);
    const out = await quoteSwap(m, "buy", inWei);
    const res = await this.send(buyRequest(m, inWei, withSlippage(out, slippageBps)));
    return { ...res, expected: formatUnits(out, await tokenDecimals(t)), symbol: info.symbol };
  }

  /** Sell `amount` of a token, or "all", or a percentage like "50%". */
  async sell(token: string, amount: string, slippageBps = this.slippageBps) {
    const { wallet, account } = this.need();
    const t = await this.resolve(token);
    const info = await this.token(t);
    const m = marketOf(t, info.pools);
    if (!m) throw new Error("No HYPE pool Mesa can route for this token.");
    const [bal, dec] = await Promise.all([tokenBalance(t, account.address), tokenDecimals(t)]);
    const tokensIn =
      amount === "all"
        ? bal
        : amount.endsWith("%")
          ? (bal * BigInt(Math.round(Number(amount.slice(0, -1)) * 100))) / 10_000n
          : parseUnits(amount, dec);
    if (tokensIn <= 0n || tokensIn > bal) throw new Error(`Balance is ${formatUnits(bal, dec)}; can't sell ${formatUnits(tokensIn, dec)}.`);
    const approval = await sellApproval(m, account.address, tokensIn);
    if (approval) await this.send(approval);
    const out = await quoteSwap(m, "sell", tokensIn);
    const permit = await sellPermit(m, account.address, tokensIn);
    const signature = await wallet.signTypedData({ account, ...permit.typedData });
    const res = await this.send(sellRequest(m, tokensIn, withSlippage(out, slippageBps), permit.message, signature));
    return { ...res, sold: formatUnits(tokensIn, dec), expectedHype: formatEther(out), symbol: info.symbol };
  }

  /**
   * Launch a token on Mesa. Fees default to 1%, all of the creator's 70% to
   * this wallet. A dev buy (HYPE) is optional and counts against the limit.
   */
  async launch(o: {
    name: string;
    symbol: string;
    description?: string;
    image?: string;
    website?: string;
    twitter?: string;
    telegram?: string;
    feePct?: number;
    feeRecipient?: string;
    devBuy?: string;
    sniperPct?: number;
    snipeSeconds?: number;
  }) {
    const { account } = this.need();
    if (!MESA_HOOK) throw new Error("Mesa isn't deployed on this network.");
    if (o.devBuy && Number(o.devBuy) > 0) this.cap(Number(o.devBuy));
    const form: LaunchForm = {
      name: o.name,
      symbol: o.symbol,
      description: o.description ?? "",
      image: o.image ?? "",
      website: o.website ?? "",
      twitter: o.twitter ?? "",
      telegram: o.telegram ?? "",
      feePct: o.feePct ?? 1,
      payout: "wallet",
      feeRecipient: o.feeRecipient ?? account.address,
      recipients: [],
      holdersPct: 0,
      buybackPct: 0,
      antiSnipe: (o.sniperPct ?? 0) > 0,
      sniperPct: o.sniperPct ?? 0,
      snipeSeconds: o.snipeSeconds ?? 0,
      maxBuyPct: 100,
      devBuy: o.devBuy ?? "0",
      builder: this.builder,
    };
    const problems = validate(form);
    if (problems.length) throw new Error(problems.join(" "));
    const res = await this.send(launchCall(form, MESA_HOOK));
    let token: Address | null = null;
    if (res.status === "success") {
      const receipt = await elysiumClient().getTransactionReceipt({ hash: res.hash });
      token = launchedToken(receipt, MESA_HOOK);
    }
    return { ...res, token, chart: token ? `https://mesa.cx/markets/elysium/${token}` : null };
  }

  /** HYPE fees waiting for this wallet (as creator, payout wallet or builder). */
  async claimable(owner?: string) {
    const who = (owner ? addr(owner) : this.address) as Address | null;
    if (!who || !MESA_HOOK) throw new Error("Give an address, or configure a private key.");
    const wei = await elysiumClient().readContract({ address: MESA_HOOK, abi: hookAbi, functionName: "accrued", args: [who] });
    return { address: who, claimableHype: formatEther(wei) };
  }

  /** Claim this wallet's fees from MesaHook, in HYPE. */
  async claim() {
    const { account } = this.need();
    if (!MESA_HOOK) throw new Error("Mesa isn't deployed on this network.");
    const { claimableHype } = await this.claimable(account.address);
    if (Number(claimableHype) <= 0) throw new Error("Nothing to claim yet.");
    const res = await this.send({ to: MESA_HOOK, data: encodeFunctionData({ abi: hookAbi, functionName: "claim" }), value: 0n });
    return { ...res, claimedHype: claimableHype };
  }

  /** Hand a token's fee wallet to someone else; they must accept it. */
  async handOverFees(token: string, next: string) {
    if (!MESA_HOOK) throw new Error("Mesa isn't deployed on this network.");
    return this.send({
      to: MESA_HOOK,
      data: encodeFunctionData({ abi: hookAbi, functionName: "setFeeRecipient", args: [await this.resolve(token), addr(next)] }),
      value: 0n,
    });
  }
}

export { MESA_HOOK, LIMITS };
