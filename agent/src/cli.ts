#!/usr/bin/env node
/**
 * The mesa command line: the same things as the MCP server, for scripts and
 * for agents that drive a shell.
 */
import { Mesa } from "./mesa.js";

const HELP = `mesa: Elysium markets and Mesa's launchpad from a terminal

Reading (no setup):
  mesa tokens [--sort trending|volume|gainers|mcap|new] [--launchpad Mesa] [--limit 20]
  mesa token <address|$TICKER>
  mesa trades <address> [--limit 20]
  mesa holders <address>
  mesa stats
  mesa burns
  mesa quote buy <token> <hype>
  mesa quote sell <token> <amount>
  mesa tx <hash>

Your agent wallet (MESA_PRIVATE_KEY):
  mesa balance [token]
  mesa portfolio [address]
  mesa buy <token> <hype>
  mesa sell <token> <amount|all|50%>
  mesa launch --name "Keystone" --symbol KEY [--fee 1] [--dev-buy 0.1] [--description ...] [--image https://...]
  mesa fees           claimable HYPE fees
  mesa claim          claim them

Settings: MESA_PRIVATE_KEY, MESA_MAX_HYPE (per-transaction cap, default 1),
MESA_SLIPPAGE_BPS (default 300), MESA_BUILDER + MESA_BUILDER_FEE (builder fee on launches).
Output is JSON. Docs: https://mesa.cx/docs#agents`;

function flags(args: string[]) {
  const pos: string[] = [];
  const f: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = args[i + 1];
      if (v !== undefined && !v.startsWith("--")) {
        f[k] = v;
        i++;
      } else f[k] = "true";
    } else pos.push(a);
  }
  return { pos, f };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, f } = flags(rest);
  const mesa = Mesa.fromEnv();
  const num = (k: string) => (f[k] !== undefined ? Number(f[k]) : undefined);
  const need = (i: number, what: string) => {
    const v = pos[i];
    if (!v) throw new Error(`Missing ${what}. Run "mesa help".`);
    return v;
  };
  switch (cmd) {
    case "tokens":
      return mesa.tokens({ sort: f["sort"] as never, venue: f["launchpad"], query: f["search"], limit: num("limit") ?? 20 });
    case "token":
      return mesa.token(need(0, "token address"));
    case "trades":
      return mesa.trades(need(0, "token address"), num("limit") ?? 20);
    case "holders":
      return mesa.holders(need(0, "token address"), num("limit") ?? 20);
    case "stats":
      return { stats: await mesa.stats(), launchpads: await mesa.launchpads() };
    case "burns":
      return mesa.burns();
    case "tx":
      return mesa.transaction(need(0, "transaction hash"));
    case "quote":
      return mesa.quote(need(1, "token address"), need(0, "buy or sell") as "buy" | "sell", need(2, "amount"));
    case "balance":
      return mesa.balance(pos[0]);
    case "portfolio":
      return mesa.portfolio(pos[0]);
    case "buy":
      return mesa.buy(need(0, "token address"), need(1, "HYPE amount"));
    case "sell":
      return mesa.sell(need(0, "token address"), need(1, "amount, all or a percentage"));
    case "launch":
      if (!f["name"] || !f["symbol"]) throw new Error('mesa launch --name "Name" --symbol TICKER');
      return mesa.launch({
        name: f["name"],
        symbol: f["symbol"],
        description: f["description"],
        image: f["image"],
        website: f["website"],
        twitter: f["twitter"],
        telegram: f["telegram"],
        feePct: num("fee"),
        devBuy: f["dev-buy"],
        sniperPct: num("sniper"),
        snipeSeconds: num("snipe-seconds"),
      });
    case "fees":
      return mesa.claimable(pos[0]);
    case "claim":
      return mesa.claim();
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return undefined;
    default:
      throw new Error(`Unknown command "${cmd}". Run "mesa help".`);
  }
}

main().then(
  (out) => {
    if (out !== undefined) console.log(JSON.stringify(out, null, 2));
  },
  (e: unknown) => {
    console.error(`mesa: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
