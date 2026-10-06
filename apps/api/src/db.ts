import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SecurityRow = {
  ticker: string;
  companyName: string;
  exchange: string;
  assetType: string;
  inSp500: number;
  inNasdaq: number;
};

export function openDatabase(filePath: string): DatabaseSync {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS securities (
      id INTEGER PRIMARY KEY,
      ticker TEXT NOT NULL UNIQUE,
      company_name TEXT NOT NULL,
      exchange TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      in_sp500 INTEGER NOT NULL,
      in_nasdaq INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_securities_ticker ON securities(ticker);
    CREATE INDEX IF NOT EXISTS idx_securities_sp500 ON securities(in_sp500);
    CREATE INDEX IF NOT EXISTS idx_securities_nasdaq ON securities(in_nasdaq);
    CREATE TABLE IF NOT EXISTS sync_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      symbol_list_updated_at TEXT,
      symbol_list_source TEXT
    );
    INSERT OR IGNORE INTO sync_meta (id) VALUES (1);
  `);
  migrateActivity(db);
  return db;
}

function migrateActivity(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(unusual_activity)").all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === "option_symbol")) return;
  db.exec("DROP TABLE IF EXISTS unusual_activity");
  db.exec(`
    CREATE TABLE unusual_activity (
      id INTEGER PRIMARY KEY,
      option_symbol TEXT NOT NULL UNIQUE,
      occurred_at TEXT,
      ticker TEXT NOT NULL,
      option_type TEXT NOT NULL,
      direction TEXT NOT NULL,
      strike REAL,
      expiration TEXT,
      dte INTEGER,
      volume INTEGER,
      open_interest INTEGER,
      volume_oi_ratio REAL,
      bid REAL,
      ask REAL,
      last REAL,
      underlying_price REAL,
      in_sp500 INTEGER NOT NULL,
      in_nasdaq INTEGER NOT NULL,
      source TEXT NOT NULL,
      scan_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_activity_occurred ON unusual_activity(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_ticker ON unusual_activity(ticker);
  `);
}

export function replaceSecurities(db: DatabaseSync, rows: SecurityRow[], updatedAt: string, source: string): void {
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM securities");
    const insert = db.prepare(`
      INSERT INTO securities (
        ticker, company_name, exchange, asset_type, in_sp500, in_nasdaq, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      insert.run(
        row.ticker,
        row.companyName,
        row.exchange,
        row.assetType,
        row.inSp500,
        row.inNasdaq,
        updatedAt,
      );
    }
    db.prepare(
      "UPDATE sync_meta SET symbol_list_updated_at = ?, symbol_list_source = ? WHERE id = 1",
    ).run(updatedAt, source);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
