/**
 * Launching on Mesa: the launch contract's address, the call, and the maths
 * the form shows. Every number here mirrors a rule the contracts enforce
 * (contracts/src/MesaHook.sol, MesaPayout.sol in the mesa repo).
 */
import {
  type Address,
  type Hex,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  parseEventLogs,
  type TransactionReceipt,
} from "viem";

/** MesaHook on Elysium mainnet; null until Mesa is deployed there. */
export const MESA_HOOK: Address | null = "0xE928F2336051cBD5B9D4531C25EaDd13f9A82aeC";

export const SUPPLY = 1_000_000_000;
/** Starting market cap of every HYPE launch, as the virtual HYPE reserve. */
export const START_HYPE = 30;
export const CREATOR_SHARE = 0.7;

export const LIMITS = {
  fee: { min: 1, max: 10 }, // percent
  sniper: { min: 0, max: 30 }, // percent
  snipeSeconds: { min: 0, max: 900 },
  maxBuy: { min: 0.1, max: 100 }, // percent of supply
  devBuyMaxPct: 10, // percent of supply
  builderMax: 1, // percent
  recipients: 5,
  metadataBytes: 512,
  name: 64,
  symbol: 16,
} as const;

export const hookAbi = parseAbi([
  "function launch((string name, string symbol, string metadataURI, address feeRecipient, uint16 feeBps, uint16 sniperFeeBps, uint32 snipeSeconds, uint16 maxBuyBps, address builder, uint16 builderFeeBps, bytes payout) p) payable returns (address, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks))",
  "event Launched(address indexed token, bytes32 indexed poolId, address indexed creator, address quote, address feeRecipient, string name, string symbol, string metadataURI, uint16 feeBps, address builder, uint16 builderFeeBps, uint16 sniperFeeBps, uint32 snipeSeconds, uint16 maxBuyBps, uint256 devBuyQuote, uint256 devBuyTokens)",
  "function genesisToken() view returns (address)",
  "function genesisLauncher() view returns (address)",
  "function accrued(address) view returns (uint256)",
  "function claim() returns (uint256)",
  "function setFeeRecipient(address token, address next)",
  "function acceptFeeRecipient(address token)",
  "function pendingFeeRecipient(bytes32) view returns (address)",
  "function poolOf(address) view returns (bytes32)",
  "function pools(bytes32) view returns (address token, address feeRecipient, address quote, bool quoteIs0, uint16 feeBps, uint16 builderFeeBps, uint16 sniperFeeBps, uint16 maxBuyBps, uint32 snipeSeconds, uint64 launchedAt, address builder)",
]);

export interface Recipient {
  address: string;
  pct: number;
}

export interface LaunchForm {
  name: string;
  symbol: string;
  description: string;
  image: string;
  website: string;
  twitter: string;
  telegram: string;
  feePct: number;
  /** "wallet": all creator fees to one wallet; "split": wallets, holders and buyback. */
  payout: "wallet" | "split";
  feeRecipient: string;
  recipients: Recipient[];
  holdersPct: number;
  buybackPct: number;
  antiSnipe: boolean;
  sniperPct: number;
  snipeSeconds: number;
  maxBuyPct: number;
  devBuy: string;
  builder?: { address: Address; pct: number } | undefined;
}

/** Off-chain details, stored on chain as compact JSON in the launch event. */
export function metadataOf(f: LaunchForm): string {
  const m: Record<string, string> = {};
  if (f.description.trim()) m["description"] = f.description.trim();
  if (f.image.trim()) m["image"] = f.image.trim();
  if (f.website.trim()) m["website"] = f.website.trim();
  if (f.twitter.trim()) m["twitter"] = f.twitter.trim();
  if (f.telegram.trim()) m["telegram"] = f.telegram.trim();
  return Object.keys(m).length ? JSON.stringify(m) : "";
}

export const byteLength = (s: string) => new TextEncoder().encode(s).length;

const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a.trim());
const isHttps = (u: string) => !u.trim() || /^https:\/\/\S+$/.test(u.trim());

/** Tokens a dev buy of `hype` gets at the starting price, after the fee. */
export function devBuyTokens(hype: number, feePct: number): number {
  const net = hype * (1 - feePct / 100);
  return net > 0 ? (SUPPLY * net) / (START_HYPE + net) : 0;
}

/** The largest dev buy (in HYPE) the 10% cap allows, at a given fee. */
export function maxDevBuy(feePct: number): number {
  const net = (START_HYPE * 0.1) / 0.9;
  return net / (1 - feePct / 100);
}

/** Problems with the form, or none. */
export function validate(f: LaunchForm): string[] {
  const out: string[] = [];
  if (!f.name.trim() || byteLength(f.name.trim()) > LIMITS.name)
    out.push("Name: 1 to 64 characters.");
  if (!f.symbol.trim() || byteLength(f.symbol.trim()) > LIMITS.symbol)
    out.push("Ticker: 1 to 16 characters.");
  for (const [k, v] of [
    ["Image", f.image],
    ["Website", f.website],
    ["X", f.twitter],
    ["Telegram", f.telegram],
  ] as const) {
    if (!isHttps(v)) out.push(`${k}: use a full https:// link.`);
  }
  if (byteLength(metadataOf(f)) > LIMITS.metadataBytes)
    out.push("Description and links are too long together: keep them under 512 bytes.");
  if (f.payout === "wallet") {
    if (!isAddr(f.feeRecipient)) out.push("Fee wallet: enter a valid address.");
  } else {
    const total = f.recipients.reduce((a, r) => a + r.pct, 0) + f.holdersPct + f.buybackPct;
    if (Math.round(total * 100) !== 10_000)
      out.push(`Split: the shares add up to ${total}%, not 100%.`);
    if (f.recipients.length > LIMITS.recipients) out.push("Split: at most 5 wallets.");
    const seen = new Set<string>();
    for (const r of f.recipients) {
      if (!isAddr(r.address)) out.push("Split: every wallet needs a valid address.");
      else if (seen.has(r.address.toLowerCase()))
        out.push("Split: the same wallet is listed twice.");
      seen.add(r.address.toLowerCase());
      if (r.pct <= 0) out.push("Split: every wallet needs a share above 0%.");
    }
  }
  const dev = Number(f.devBuy || 0);
  if (!(dev >= 0)) out.push("Dev buy: enter an amount of HYPE.");
  else if (dev > maxDevBuy(f.feePct))
    out.push(`Dev buy: at most about ${maxDevBuy(f.feePct).toFixed(2)} HYPE (10% of supply).`);
  return out;
}

const bps = (pct: number) => Math.round(pct * 100);

/** The launch transaction: calldata and value (the dev buy). */
export function launchCall(
  f: LaunchForm,
  hook: Address,
): { to: Address; data: Hex; value: bigint } {
  const payout: Hex =
    f.payout === "wallet"
      ? "0x"
      : encodeAbiParameters(
          [{ type: "address[]" }, { type: "uint16[]" }, { type: "uint16" }, { type: "uint16" }],
          [
            f.recipients.map((r) => r.address.trim() as Address),
            f.recipients.map((r) => bps(r.pct)),
            bps(f.holdersPct),
            bps(f.buybackPct),
          ],
        );
  const recipient =
    f.payout === "wallet"
      ? (f.feeRecipient.trim() as Address)
      : // Ignored for splits (the payout contract receives the fees), but must not be zero.
        ((f.recipients[0]?.address.trim() as Address | undefined) ?? hook);
  const data = encodeFunctionData({
    abi: hookAbi,
    functionName: "launch",
    args: [
      {
        name: f.name.trim(),
        symbol: f.symbol.trim(),
        metadataURI: metadataOf(f),
        feeRecipient: recipient,
        feeBps: bps(f.feePct),
        sniperFeeBps: f.antiSnipe ? bps(f.sniperPct) : 0,
        snipeSeconds: f.antiSnipe ? Math.round(f.snipeSeconds) : 0,
        maxBuyBps: f.antiSnipe ? bps(f.maxBuyPct) : 10_000,
        builder: f.builder?.address ?? "0x0000000000000000000000000000000000000000",
        builderFeeBps: f.builder ? bps(f.builder.pct) : 0,
        payout,
      },
    ],
  });
  const value = BigInt(Math.round(Number(f.devBuy || 0) * 1e6)) * 10n ** 12n;
  return { to: hook, data, value };
}

/** The launched token's address, from the receipt. */
export function launchedToken(receipt: TransactionReceipt, hook: Address): Address | null {
  const logs = parseEventLogs({ abi: hookAbi, eventName: "Launched", logs: receipt.logs });
  const l = logs.find((x) => x.address.toLowerCase() === hook.toLowerCase());
  return l ? l.args.token : null;
}

/** $MESA's settings, for the genesis launch. */
export function mesaPreset(wallet: string): Partial<LaunchForm> {
  return {
    name: "Mesa",
    symbol: "MESA",
    feePct: 1,
    payout: "wallet",
    feeRecipient: wallet,
    antiSnipe: true,
    sniperPct: 10,
    snipeSeconds: 5,
    maxBuyPct: 100,
  };
}
