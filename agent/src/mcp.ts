#!/usr/bin/env node
/**
 * Mesa's MCP server: Elysium's markets and Mesa's launchpad as tools any
 * MCP client (Claude, Cursor, an agent framework) can call. Runs over stdio.
 *
 *   npx -y --package=https://mesa.cx/agent/mesa-agent.tgz mesa-mcp
 *
 * Read tools work with no setup. Trading, launching and claiming need
 * MESA_PRIVATE_KEY (a wallet made for the agent), and are capped by
 * MESA_MAX_HYPE per transaction (default 1).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Mesa } from "./mesa.js";

const mesa = Mesa.fromEnv();
const server = new McpServer(
  { name: "mesa", version: "0.1.0" },
  {
    instructions:
      "Mesa is the launchpad for builders on Elysium, the Hyperliquid L2 (chain 99901, gas in HYPE). " +
      "Use the read tools to look at tokens and markets on every Elysium launchpad. " +
      "Write tools (buy, sell, launch, claim) spend real HYPE from the configured agent wallet; " +
      "quote before trading, confirm amounts with the user, and never exceed what they asked for. " +
      "Transactions take about a minute to land until Elysium's public sequencer opens.",
  },
);

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
const run = async (f: () => Promise<unknown>) => {
  try {
    return ok(await f());
  } catch (e) {
    return fail(e);
  }
};
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("A 0x address");
const token = z.string().min(1).describe('A token address, or its ticker like "$MESA" (resolves to the most-held token with that ticker)');

// ------------------------------------------------------------ read

server.registerTool(
  "list_tokens",
  {
    title: "List tokens",
    description: "Tokens on every Elysium launchpad (Mesa, Ascend, BOXA, Kleos, Volta, ElysPump and plain Uniswap v4), sorted. Prices and volumes are in HYPE.",
    inputSchema: {
      sort: z.enum(["trending", "volume", "gainers", "losers", "mcap", "new", "trades"]).optional(),
      window: z.enum(["1h", "6h", "24h", "7d"]).optional(),
      launchpad: z.string().optional().describe('Only one launchpad, e.g. "Mesa"'),
      search: z.string().optional().describe("Name, ticker or address"),
      limit: z.number().int().min(1).max(100).optional(),
    },
  },
  (a) => run(() => mesa.tokens({ sort: a.sort, window: a.window, venue: a.launchpad, query: a.search, limit: a.limit ?? 20 })),
);
server.registerTool(
  "get_token",
  { title: "Token details", description: "One token: price, market cap, volume, holders, launch settings and forensics (dev holdings, bundles, top holders).", inputSchema: { token: token } },
  (a) => run(() => mesa.token(a.token)),
);
server.registerTool(
  "get_trades",
  { title: "Recent trades", description: "A token's latest trades, newest first.", inputSchema: { token: token, limit: z.number().int().min(1).max(200).optional() } },
  (a) => run(() => mesa.trades(a.token, a.limit ?? 30)),
);
server.registerTool(
  "get_holders",
  { title: "Top holders", description: "A token's largest holders, with their share of supply.", inputSchema: { token: token, limit: z.number().int().min(1).max(200).optional() } },
  (a) => run(() => mesa.holders(a.token, a.limit ?? 20)),
);
server.registerTool(
  "get_candles",
  { title: "Price candles", description: "OHLC candles in HYPE. interval is in seconds (60, 300, 900, 3600, 14400, 86400).", inputSchema: { token: token, interval: z.number().int().optional(), limit: z.number().int().max(1000).optional() } },
  (a) => run(() => mesa.candles(a.token, a.interval ?? 300, a.limit ?? 100)),
);
server.registerTool(
  "get_portfolio",
  { title: "Portfolio", description: "A wallet's Elysium token holdings and profit and loss. Defaults to this agent's wallet.", inputSchema: { wallet: address.optional() } },
  (a) => run(() => mesa.portfolio(a.wallet)),
);
server.registerTool(
  "get_balance",
  { title: "Balance", description: "HYPE balance, and optionally one token's balance, for this agent's wallet or any address.", inputSchema: { token: token.optional(), wallet: address.optional() } },
  (a) => run(() => mesa.balance(a.token, a.wallet)),
);
server.registerTool(
  "market_stats",
  { title: "Elysium market stats", description: "Chain-wide numbers and every launchpad's activity.", inputSchema: {} },
  () => run(async () => ({ stats: await mesa.stats(), launchpads: await mesa.launchpads() })),
);
server.registerTool(
  "mesa_burns",
  { title: "$MESA burns", description: "The $MESA flywheel: 30% of every Mesa launch's fees buys $MESA and burns it. Totals and latest burns.", inputSchema: {} },
  () => run(() => mesa.burns()),
);
server.registerTool(
  "explain_transaction",
  { title: "Explain a transaction", description: "Trades, launches and burns in an Elysium transaction, from Mesa's indexer. Full view at mesa.cx/tx/<hash>.", inputSchema: { hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) } },
  (a) => run(async () => ({ ...(await mesa.transaction(a.hash)), explorer: `https://mesa.cx/tx/${a.hash}` })),
);
server.registerTool(
  "quote",
  { title: "Quote a trade", description: "What a buy (amount in HYPE) or sell (amount in tokens) would return, before trading.", inputSchema: { token: token, side: z.enum(["buy", "sell"]), amount: z.string().describe('e.g. "0.1"') } },
  (a) => run(() => mesa.quote(a.token, a.side, a.amount)),
);
server.registerTool(
  "claimable_fees",
  { title: "Claimable fees", description: "HYPE fees waiting in MesaHook for a creator, payout or builder wallet. Defaults to this agent's wallet.", inputSchema: { wallet: address.optional() } },
  (a) => run(() => mesa.claimable(a.wallet)),
);

// ------------------------------------------------------------ write

const writes = mesa.address !== null;
const guard = `Spends real HYPE from the agent wallet${writes ? ` ${mesa.address}` : ""}; capped at ${mesa.maxHype} HYPE per transaction.`;

server.registerTool(
  "buy",
  { title: "Buy a token", description: `Buy a token with HYPE. ${guard}`, inputSchema: { token: token, hype: z.string().describe('HYPE to spend, e.g. "0.1"'), slippageBps: z.number().int().min(10).max(5000).optional() } },
  (a) => run(() => mesa.buy(a.token, a.hype, a.slippageBps)),
);
server.registerTool(
  "sell",
  { title: "Sell a token", description: `Sell a token for HYPE: an amount, "all", or a percentage like "50%". ${guard}`, inputSchema: { token: token, amount: z.string(), slippageBps: z.number().int().min(10).max(5000).optional() } },
  (a) => run(() => mesa.sell(a.token, a.amount, a.slippageBps)),
);
server.registerTool(
  "launch_token",
  {
    title: "Launch a token on Mesa",
    description: `Launch a token in one transaction: 1B supply, all in a Uniswap v4 pool, liquidity locked forever. The creator earns 70% of a 1-10% fee on every trade, in HYPE; 30% burns $MESA. Name and ticker can never change. ${guard}`,
    inputSchema: {
      name: z.string().max(64),
      symbol: z.string().max(16),
      description: z.string().optional(),
      image: z.string().url().optional().describe("https link to a square image"),
      website: z.string().url().optional(),
      twitter: z.string().url().optional(),
      telegram: z.string().url().optional(),
      feePct: z.number().min(1).max(10).optional().describe("Trading fee, 1 to 10. Default 1."),
      feeRecipient: address.optional().describe("Who receives the creator fees. Default: the agent wallet."),
      devBuy: z.string().optional().describe("HYPE to buy at launch, at the starting price. Optional."),
      sniperPct: z.number().min(0).max(30).optional(),
      snipeSeconds: z.number().int().min(0).max(900).optional(),
    },
  },
  (a) => run(() => mesa.launch(a)),
);
server.registerTool(
  "claim_fees",
  { title: "Claim fees", description: "Claim this agent wallet's HYPE fees from MesaHook.", inputSchema: {} },
  () => run(() => mesa.claim()),
);

await server.connect(new StdioServerTransport());
