import { DatabaseSync } from 'node:sqlite'

/**
 * Amounts are REAL in whole units (display precision). Prices: `price` is
 * the pool's quote per token; `price_hype` is HYPE per token when the quote's
 * HYPE value was known at the time of the trade.
 */
export function open(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE IF NOT EXISTS pools (
      id TEXT PRIMARY KEY,
      pool_manager TEXT NOT NULL,
      hook TEXT NOT NULL,
      venue TEXT NOT NULL,
      currency0 TEXT NOT NULL,
      currency1 TEXT NOT NULL,
      token TEXT NOT NULL,
      quote TEXT NOT NULL,
      quote_is0 INTEGER NOT NULL,
      fee INTEGER NOT NULL,
      tick_spacing INTEGER NOT NULL,
      block INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      tx TEXT NOT NULL,
      creator TEXT NOT NULL,
      initial_price REAL
    );
    CREATE INDEX IF NOT EXISTS pools_token ON pools(token);
    CREATE INDEX IF NOT EXISTS pools_venue ON pools(venue);
    CREATE INDEX IF NOT EXISTS pools_creator ON pools(creator);

    CREATE TABLE IF NOT EXISTS tokens (
      address TEXT PRIMARY KEY,
      name TEXT,
      symbol TEXT,
      decimals INTEGER NOT NULL DEFAULT 18,
      supply REAL,
      first_block INTEGER NOT NULL
    );

    -- Mesa's own launches: settings and the declared dev buy.
    CREATE TABLE IF NOT EXISTS mesa_launches (
      token TEXT PRIMARY KEY,
      pool_id TEXT NOT NULL,
      creator TEXT NOT NULL,
      fee_recipient TEXT NOT NULL,
      metadata_uri TEXT NOT NULL,
      buy_fee_bps INTEGER NOT NULL,
      sell_fee_bps INTEGER NOT NULL,
      sniper_fee_bps INTEGER NOT NULL,
      snipe_seconds INTEGER NOT NULL,
      max_buy_bps INTEGER NOT NULL,
      dev_buy_quote REAL NOT NULL,
      dev_buy_tokens REAL NOT NULL,
      genesis INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS trades (
      tx TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      pool TEXT NOT NULL,
      token TEXT NOT NULL,
      block INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      trader TEXT,
      side TEXT NOT NULL,          -- buy | sell
      kind TEXT NOT NULL,          -- trade | dev | buyback
      quote_amount REAL NOT NULL,  -- quote paid (buy) or received (sell); fees included on Mesa pools
      token_amount REAL NOT NULL,
      fee REAL NOT NULL DEFAULT 0,
      sniper_fee REAL NOT NULL DEFAULT 0,
      price REAL NOT NULL,         -- quote per token after the trade
      price_hype REAL,             -- HYPE per token, when known
      value_hype REAL,             -- the trade's size in HYPE, when known
      PRIMARY KEY (tx, log_index)
    );
    CREATE INDEX IF NOT EXISTS trades_token_time ON trades(token, timestamp);
    CREATE INDEX IF NOT EXISTS trades_pool_time ON trades(pool, timestamp);
    CREATE INDEX IF NOT EXISTS trades_time ON trades(timestamp);
    CREATE INDEX IF NOT EXISTS trades_trader ON trades(trader);

    CREATE TABLE IF NOT EXISTS transfers (
      tx TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      token TEXT NOT NULL,
      block INTEGER NOT NULL,
      src TEXT NOT NULL,
      dst TEXT NOT NULL,
      amount REAL NOT NULL,
      PRIMARY KEY (tx, log_index)
    );
    CREATE INDEX IF NOT EXISTS transfers_token ON transfers(token);

    -- Running balances, maintained as transfers are indexed.
    CREATE TABLE IF NOT EXISTS balances (
      token TEXT NOT NULL,
      holder TEXT NOT NULL,
      balance REAL NOT NULL,
      PRIMARY KEY (token, holder)
    );
    CREATE INDEX IF NOT EXISTS balances_token ON balances(token, balance);
    CREATE INDEX IF NOT EXISTS balances_holder ON balances(holder);

    -- What each launchpad published about a token at launch: image, links.
    -- checked_at is set even when nothing was found, so a token is looked up once.
    CREATE TABLE IF NOT EXISTS token_meta (
      token TEXT PRIMARY KEY,
      image TEXT,
      description TEXT,
      website TEXT,
      twitter TEXT,
      telegram TEXT,
      checked_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS burns (
      tx TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      block INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      hype_in REAL NOT NULL,
      mesa_burned REAL NOT NULL,
      PRIMARY KEY (tx, log_index)
    );
  `)
  return db
}

export function getMeta(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value
}

export function setMeta(db: DatabaseSync, key: string, value: string) {
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}
