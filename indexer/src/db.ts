import { DatabaseSync } from 'node:sqlite'

/**
 * Amounts are stored as decimal strings of wei / token units (exact), and as
 * REAL in whole units for sorting and aggregation (display precision).
 */
export function open(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE IF NOT EXISTS tokens (
      address TEXT PRIMARY KEY,
      pool_id TEXT NOT NULL UNIQUE,
      creator TEXT NOT NULL,
      quote TEXT NOT NULL,
      quote_is0 INTEGER NOT NULL,
      fee_recipient TEXT NOT NULL,
      name TEXT NOT NULL,
      symbol TEXT NOT NULL,
      metadata_uri TEXT NOT NULL,
      buy_fee_bps INTEGER NOT NULL,
      sell_fee_bps INTEGER NOT NULL,
      sniper_fee_bps INTEGER NOT NULL,
      snipe_seconds INTEGER NOT NULL,
      max_buy_bps INTEGER NOT NULL,
      dev_buy_quote REAL NOT NULL,
      dev_buy_tokens REAL NOT NULL,
      block INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      tx TEXT NOT NULL,
      genesis INTEGER NOT NULL DEFAULT 0,
      initial_price REAL
    );
    CREATE INDEX IF NOT EXISTS tokens_creator ON tokens(creator);
    CREATE INDEX IF NOT EXISTS tokens_time ON tokens(timestamp);

    CREATE TABLE IF NOT EXISTS trades (
      tx TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      token TEXT NOT NULL,
      block INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      trader TEXT NOT NULL,
      side TEXT NOT NULL,         -- buy | sell
      kind TEXT NOT NULL,         -- trade | dev | buyback
      quote_amount REAL NOT NULL, -- what the trader paid (buy) or received (sell), fees included
      token_amount REAL NOT NULL,
      fee REAL NOT NULL,
      sniper_fee REAL NOT NULL,
      price REAL NOT NULL,        -- quote per token after the trade
      PRIMARY KEY (tx, log_index)
    );
    CREATE INDEX IF NOT EXISTS trades_token_time ON trades(token, timestamp);
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
