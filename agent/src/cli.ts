#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The mesa command line: the same things as the MCP server, for scripts and
 * for agents that drive a shell.
 */
import { Mesa } from "./mesa.js";
import { describe, telegram, watch, webhook, type MesaEvent, type WatchKind } from "./watch.js";

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
  mesa updates <token>          the token's build log

Live alerts (runs until stopped):
  mesa watch [--token $MESA,0x..] [--launchpad Mesa] [--only trades,launches,updates]
             [--min 1] [--side buy|sell] [--webhook https://...] [--telegram]
    --telegram needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID; --webhook signs
    with MESA_WEBHOOK_SECRET when set (header x-mesa-signature: sha256=<hmac>).
  mesa telegram-chats    your bot's chats, to find TELEGRAM_CHAT_ID

Your agent wallet (MESA_PRIVATE_KEY):
  mesa balance [token]
  mesa portfolio [address]
  mesa buy <token> <hype>
  mesa sell <token> <amount|all|50%>
  mesa launch --name "Keystone" --symbol KEY [--fee 1] [--dev-buy 0.1] [--description ...] [--image https://...]
  mesa update <token> "shipped v0.2" [--link https://...]   post to the build log
  mesa fees           claimable HYPE fees
  mesa claim          claim them

Settings: MESA_PRIVATE_KEY, MESA_MAX_HYPE (per-transaction cap, default 1),
MESA_SLIPPAGE_BPS (default 300), MESA_BUILDER + MESA_BUILDER_FEE (builder fee on launches).
Output is readable in a terminal and JSON in pipes or with --json. Docs: https://mesa.cx/docs#agents`;

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
    case "updates":
      return mesa.updates(need(0, "token"), num("limit") ?? 20);
    case "update":
      return mesa.postUpdate(need(0, "token"), need(1, "update text"), f["link"]);
    case "fees":
      return mesa.claimable(pos[0]);
    case "claim":
      return mesa.claim();
    case "telegram-chats": {
      const bot = process.env["TELEGRAM_BOT_TOKEN"];
      if (!bot) throw new Error("Set TELEGRAM_BOT_TOKEN (from @BotFather) first.");
      const r = (await (await fetch(`https://api.telegram.org/bot${bot}/getUpdates`)).json()) as {
        ok: boolean;
        description?: string;
        result?: { message?: { chat: { id: number; title?: string; username?: string; type: string } }; my_chat_member?: { chat: { id: number; title?: string; type: string } }; channel_post?: { chat: { id: number; title?: string; type: string } } }[];
      };
      if (!r.ok) throw new Error(`Telegram: ${r.description ?? "request failed"}`);
      const chats = new Map<number, string>();
      for (const u of r.result ?? []) {
        const c = u.message?.chat ?? u.my_chat_member?.chat ?? u.channel_post?.chat;
        if (c) chats.set(c.id, `${c.type}${"title" in c && c.title ? ` "${c.title}"` : ""}`);
      }
      if (!chats.size) return { hint: "No chats yet. Send your bot a message, or add it to a group or channel, then run this again." };
      return Object.fromEntries([...chats].map(([id, what]) => [String(id), what]));
    }
    case "watch":
      await runWatch(mesa, f);
      return undefined;
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

async function runWatch(mesa: Mesa, f: Record<string, string>) {
  const tokens = f["token"] ? await Promise.all(f["token"].split(",").map((t) => mesa.resolve(t))) : [];
  const kindOf: Record<string, WatchKind> = { trade: "trade", trades: "trade", launch: "launch", launches: "launch", update: "update", updates: "update" };
  const kinds = f["only"] ? f["only"].split(",").map((k) => {
    const v = kindOf[k.trim()];
    if (!v) throw new Error(`--only: trades, launches or updates, not "${k}"`);
    return v;
  }) : undefined;
  const sinks: { name: string; send: (e: MesaEvent) => Promise<void> }[] = [];
  if (f["webhook"]) {
    if (!/^https?:\/\//.test(f["webhook"])) throw new Error("--webhook needs an http(s) URL");
    sinks.push({ name: "webhook", send: webhook(f["webhook"], process.env["MESA_WEBHOOK_SECRET"]) });
  }
  if (f["telegram"]) {
    const bot = process.env["TELEGRAM_BOT_TOKEN"];
    const chat = process.env["TELEGRAM_CHAT_ID"];
    if (!bot || !chat) throw new Error("--telegram needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID");
    sinks.push({ name: "telegram", send: telegram(bot, chat) });
  }
  const json = process.argv.includes("--json") || !process.stdout.isTTY;
  const what = [
    tokens.length ? `${tokens.length} token${tokens.length > 1 ? "s" : ""}` : "every token",
    f["launchpad"] ? `on ${f["launchpad"]}` : "",
    f["min"] ? `trades ≥ ${f["min"]} HYPE` : "",
    sinks.length ? `→ ${sinks.map((s) => s.name).join(", ")}` : "",
  ].filter(Boolean).join(" · ");
  console.error(`mesa: watching ${what}. Ctrl+C to stop.`);
  const stop = new AbortController();
  process.on("SIGINT", () => stop.abort());
  process.on("SIGTERM", () => stop.abort());
  for await (const e of watch(
    {
      tokens,
      ...(f["launchpad"] ? { launchpad: f["launchpad"] } : {}),
      ...(kinds ? { kinds } : {}),
      ...(f["min"] ? { minHype: Number(f["min"]) } : {}),
      ...(f["side"] === "buy" || f["side"] === "sell" ? { side: f["side"] } : {}),
    },
    { signal: stop.signal, onStatus: (s) => s !== "connected" && console.error(`mesa: ${s}`) },
  )) {
    console.log(json ? JSON.stringify(e) : describe(e));
    for (const s of sinks)
      s.send(e).catch((err: unknown) => console.error(`mesa: ${s.name} failed: ${err instanceof Error ? err.message : String(err)}`));
  }
}

/** Short, readable output for a person at a terminal; JSON for pipes, scripts and --json. */
const compact = (v: number) =>
  v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(2)}K` : v.toLocaleString("en-US", { maximumFractionDigits: 4 });
const whole = (s: string) => Number(s).toLocaleString("en-US", { maximumFractionDigits: Number(s) >= 1000 ? 0 : 4 });
function pretty(cmd: string | undefined, out: any): string | null {
  const shortTx = (h: string) => `mesa.cx/tx/${h.slice(0, 6)}…`;
  switch (cmd) {
    case "balance":
      return Object.entries(out)
        .filter(([k]) => k !== "address")
        .map(([k, v]) => `${k.padEnd(10)} ${whole(String(v)).padStart(12)}   ready`)
        .join("\n");
    case "tokens":
      return (out.tokens as any[])
        .map((t) => {
          const chg = Number(t.change24h ?? 0);
          const mc = Number(t.marketCapHype ?? 0);
          return `$${String(t.symbol).padEnd(10)} ${(mc >= 1000 ? compact(mc) : mc.toFixed(0)).padStart(6)} HYPE  ${(chg >= 0 ? "+" : "") + (Math.abs(chg) >= 1000 ? compact(chg) : chg.toFixed(1))}%`;
        })
        .join("\n");
    case "quote":
      return `you get  ≥ ${whole(out.minimumOut)} ${String(out.unit).replace("$", "")}\nexpected   ${whole(out.amountOut)}`;
    case "buy":
      return out.status === "success"
        ? `✓ ${whole(out.expected)} ${out.symbol} · ${shortTx(out.hash)}`
        : `${out.status} · ${out.explorer}`;
    case "sell":
      return out.status === "success" ? `✓ sold ${whole(out.sold)} ${out.symbol} for ~${whole(out.expectedHype)} HYPE · ${shortTx(out.hash)}` : `${out.status} · ${out.explorer}`;
    case "launch":
      return out.token
        ? `✓ launched · ${out.chart}\n70% of every fee to this agent, in HYPE`
        : `${out.status} · ${out.explorer}`;
    case "fees":
      return `${whole(out.claimableHype)} HYPE claimable`;
    case "update":
      return `✓ posted to the build log · ${out.page.replace("https://", "")}`;
    case "claim":
      return out.status === "success" ? `✓ claimed ${whole(out.claimedHype)} HYPE · ${shortTx(out.hash)}` : `${out.status} · ${out.explorer}`;
    default:
      return null;
  }
}

main().then(
  (out) => {
    if (out === undefined) return;
    const wantJson = process.argv.includes("--json") || !process.stdout.isTTY;
    const text = wantJson ? null : pretty(process.argv[2], out);
    console.log(text ?? JSON.stringify(out, null, 2));
  },
  (e: unknown) => {
    console.error(`mesa: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
