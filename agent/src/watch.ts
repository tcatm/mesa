/**
 * Live events from Mesa's indexer, filtered and described: trades, new
 * launches and build-log updates on Elysium, as they land.
 *
 * Reads the indexer's server-sent event stream, reconnects on its own, and
 * adds each token's ticker, name and launchpad. Forwarders turn events into a
 * webhook POST or a Telegram message, so an alert bot is one command:
 *
 *   TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… mesa watch --token '$MESA' --telegram
 */
import { createHmac } from "node:crypto";
import { API } from "./mesa.js";

export type WatchKind = "trade" | "launch" | "update";

export interface TokenInfo {
  address: string;
  symbol: string | null;
  name: string | null;
  venue: string;
}

export interface TradeEvent {
  type: "trade";
  token: TokenInfo;
  side: "buy" | "sell";
  hype: number;
  tokens: number;
  priceHype: number;
  trader: string | null;
  tx: string;
  block: number;
  time: number;
  explorer: string;
  chart: string;
}
export interface LaunchEvent {
  type: "launch";
  token: TokenInfo;
  pool: string;
  time: number;
  chart: string;
}
export interface UpdateEvent {
  type: "update";
  token: TokenInfo;
  text: string;
  link: string | null;
  author: string;
  time: number;
  chart: string;
}
export type MesaEvent = TradeEvent | LaunchEvent | UpdateEvent;

export interface WatchFilter {
  /** Only these token addresses (lowercase or not). Empty: every token. */
  tokens?: string[];
  /** Only one launchpad, e.g. "Mesa" (case-insensitive). */
  launchpad?: string;
  /** Which events. Default: all three. */
  kinds?: WatchKind[];
  /** Trades only: at least this much HYPE. */
  minHype?: number;
  /** Trades only: buys or sells. */
  side?: "buy" | "sell";
}

const chartOf = (a: string) => `https://mesa.cx/markets/elysium/${a.toLowerCase()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Token names and launchpads, looked up once and kept for ten minutes. */
class TokenCache {
  private m = new Map<string, { at: number; info: TokenInfo }>();
  async get(address: string, fresh = false): Promise<TokenInfo> {
    const a = address.toLowerCase();
    const hit = this.m.get(a);
    if (hit && !fresh && Date.now() - hit.at < 600_000) return hit.info;
    try {
      const r = await fetch(`${API}/tokens/${a}`);
      if (r.ok) {
        const t = (await r.json()) as Partial<TokenInfo>;
        const info = { address: a, symbol: t.symbol ?? null, name: t.name ?? null, venue: t.venue ?? "?" };
        this.m.set(a, { at: Date.now(), info });
        return info;
      }
    } catch {
      // fall through
    }
    return hit?.info ?? { address: a, symbol: null, name: null, venue: "?" };
  }
}

/** Raw rows from GET /stream. */
type Raw = { event: string; data: Record<string, unknown> };

async function* sse(url: string, signal?: AbortSignal): AsyncGenerator<Raw> {
  const r = await fetch(url, { headers: { accept: "text/event-stream" }, ...(signal ? { signal } : {}) });
  if (!r.ok || !r.body) throw new Error(`stream ${r.status}`);
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) {
        if (block.startsWith(":")) yield { event: "ping", data: {} };
        continue;
      }
      try {
        yield { event, data: JSON.parse(data) as Record<string, unknown> };
      } catch {
        // skip a malformed event
      }
    }
  }
}

/**
 * Every matching event, forever (until `signal` aborts). Reconnects with
 * backoff when the connection drops; events during a gap are not replayed.
 */
export async function* watch(filter: WatchFilter = {}, opts: { signal?: AbortSignal; onStatus?: (s: string) => void } = {}): AsyncGenerator<MesaEvent> {
  const tokens = new Set((filter.tokens ?? []).map((t) => t.toLowerCase()));
  const kinds = new Set<WatchKind>(filter.kinds?.length ? filter.kinds : ["trade", "launch", "update"]);
  const pad = filter.launchpad?.toLowerCase();
  const cache = new TokenCache();
  let backoff = 1000;

  // New tokens get their name a few seconds after the pool appears, so
  // launches are resolved off to the side and delivered when ready. Pools
  // that never get a name or ticker (test and spam pools) are skipped unless
  // you asked for that token.
  const ready: MesaEvent[] = [];
  const resolveLaunch = async (token: string, data: Record<string, unknown>) => {
    let info = await cache.get(token, true);
    for (let i = 0; i < 3 && !info.symbol; i++) {
      await sleep(5000);
      info = await cache.get(token, true);
    }
    if (info.venue === "?") info = { ...info, venue: String(data["venue"] ?? "?") };
    if (!info.symbol && !tokens.has(token)) return;
    if (!wanted(info)) return;
    ready.push({ type: "launch", token: info, pool: String(data["id"]), time: Math.floor(Date.now() / 1000), chart: chartOf(token) });
  };

  const wanted = (info: TokenInfo) =>
    (tokens.size === 0 || tokens.has(info.address)) && (!pad || info.venue.toLowerCase() === pad);

  while (!opts.signal?.aborted) {
    try {
      opts.onStatus?.("connected");
      for await (const { event, data } of sse(`${API}/stream`, opts.signal)) {
        backoff = 1000;
        while (ready.length) yield ready.shift()!;
        const token = String(data["token"] ?? "").toLowerCase();
        if (!token || (tokens.size && !tokens.has(token))) continue;

        if (event === "trade" && kinds.has("trade")) {
          if (data["kind"] !== "trade") continue;
          const hype = Number(data["value_hype"] ?? 0);
          const side = data["side"] === "sell" ? "sell" : "buy";
          if (filter.minHype && hype < filter.minHype) continue;
          if (filter.side && side !== filter.side) continue;
          const info = await cache.get(token);
          if (!wanted(info)) continue;
          const tx = String(data["tx"]);
          yield {
            type: "trade",
            token: info,
            side,
            hype,
            tokens: Number(data["token_amount"] ?? 0),
            priceHype: Number(data["price_hype"] ?? 0),
            trader: (data["trader"] as string | null) ?? null,
            tx,
            block: Number(data["block"]),
            time: Number(data["timestamp"]),
            explorer: `https://mesa.cx/tx/${tx}`,
            chart: chartOf(token),
          };
        } else if (event === "pool" && kinds.has("launch")) {
          if (pad && String(data["venue"] ?? "").toLowerCase() !== pad) continue;
          void resolveLaunch(token, data);
        } else if (event === "update" && kinds.has("update")) {
          const info = await cache.get(token);
          if (!wanted(info)) continue;
          yield {
            type: "update",
            token: info,
            text: String(data["text"] ?? ""),
            link: (data["link"] as string | null) ?? null,
            author: String(data["author"] ?? ""),
            time: Number(data["time"] ?? Math.floor(Date.now() / 1000)),
            chart: chartOf(token),
          };
        }
      }
      opts.onStatus?.("stream ended, reconnecting");
    } catch (e) {
      if (opts.signal?.aborted) return;
      opts.onStatus?.(`disconnected (${e instanceof Error ? e.message : String(e)}), retrying in ${backoff / 1000}s`);
    }
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 60_000);
  }
}

// ------------------------------------------------------------ describing

const num = (v: number) =>
  v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v.toLocaleString("en-US", { maximumFractionDigits: 4 });
const tick = (t: TokenInfo) => (t.symbol ? `$${t.symbol}` : `${t.address.slice(0, 6)}…${t.address.slice(-4)}`);

/** One line for a terminal or a log. */
export function describe(e: MesaEvent): string {
  switch (e.type) {
    case "trade":
      return `${e.side === "buy" ? "🟢 BUY " : "🔴 SELL"} ${tick(e.token)}  ${num(e.hype)} HYPE  (${num(e.tokens)} ${e.token.symbol ?? "tokens"})  ${e.token.venue}  ${e.explorer}`;
    case "launch":
      return `🚀 NEW  ${tick(e.token)}${e.token.name ? ` · ${e.token.name}` : ""}  on ${e.token.venue}  ${e.chart}`;
    case "update":
      return `🔨 BUILD ${tick(e.token)}: ${e.text}${e.link ? `  ${e.link}` : ""}`;
  }
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

/** A Telegram message (HTML parse mode). */
export function telegramText(e: MesaEvent): string {
  const t = `<b>${esc(tick(e.token))}</b>`;
  switch (e.type) {
    case "trade":
      return `${e.side === "buy" ? "🟢 Buy" : "🔴 Sell"} ${t} · <b>${esc(num(e.hype))} HYPE</b>\n${esc(num(e.tokens))} ${esc(e.token.symbol ?? "tokens")} on ${esc(e.token.venue)}\n<a href="${e.explorer}">Transaction</a> · <a href="${e.chart}">Chart</a>`;
    case "launch":
      return `🚀 New launch on ${esc(e.token.venue)}: ${t}${e.token.name ? ` · ${esc(e.token.name)}` : ""}\n<a href="${e.chart}">Chart</a>`;
    case "update":
      return `🔨 ${t} build log\n${esc(e.text)}${e.link ? `\n<a href="${esc(e.link)}">${esc(e.link)}</a>` : ""}\n<a href="${e.chart}">Token page</a>`;
  }
}

// ------------------------------------------------------------ forwarding

/** POST to a Telegram chat through a bot made with @BotFather. */
export function telegram(botToken: string, chatId: string): (e: MesaEvent) => Promise<void> {
  return async (e: MesaEvent) => {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: telegramText(e), parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (r.status === 429) {
      const j = (await r.json().catch(() => ({}))) as { parameters?: { retry_after?: number } };
      await sleep((j.parameters?.retry_after ?? 3) * 1000);
      return telegram(botToken, chatId)(e);
    }
    if (!r.ok) throw new Error(`Telegram ${r.status}: ${(await r.text()).slice(0, 200)}`);
  };
}

/**
 * POST each event as JSON to a URL. With a secret, the body is signed:
 * header `x-mesa-signature: sha256=<hex HMAC of the raw body>`.
 */
export function webhook(url: string, secret?: string): (e: MesaEvent) => Promise<void> {
  return async (e: MesaEvent) => {
    const body = JSON.stringify(e);
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "mesa-agent" };
    if (secret) headers["x-mesa-signature"] = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(url, { method: "POST", headers, body });
        if (r.ok) return;
        if (r.status < 500) throw new Error(`webhook ${r.status}`);
      } catch (err) {
        if (i === 2) throw err;
      }
      await sleep(1000 * 2 ** i);
    }
  };
}
