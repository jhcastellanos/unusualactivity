import { writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("data/unusual.sqlite", { readOnly: true });
const symbols = db
  .prepare(
    `SELECT ticker, in_sp500 AS inSp500, in_nasdaq AS inNasdaq
     FROM securities
     ORDER BY in_sp500 DESC, ticker ASC`,
  )
  .all();

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const oldest = plusMonths(today, -6);
const contracts = db
  .prepare(
    `SELECT option_symbol AS optionSymbol, occurred_at AS occurredAt, ticker, option_type AS optionType,
            strike, expiration, dte, volume, open_interest AS openInterest,
            volume_oi_ratio AS volumeOiRatio, bid, ask, last, underlying_price AS underlyingPrice,
            in_sp500 AS inSp500, in_nasdaq AS inNasdaq, source,
            CASE
              WHEN volume IS NULL THEN NULL
              WHEN last IS NOT NULL THEN volume * last * 100
              WHEN bid IS NOT NULL AND ask IS NOT NULL THEN volume * (bid + ask) / 2.0 * 100
              ELSE NULL
            END AS estimatedPremium
     FROM unusual_activity
     WHERE open_interest > 0
       AND expiration >= ?
       AND occurred_at IS NOT NULL
       AND substr(occurred_at, 1, 10) >= ?
     ORDER BY occurred_at DESC, ticker ASC`,
  )
  .all(today, oldest);

let scanned = 0;
try {
  const response = await fetch("http://127.0.0.1:8787/api/system/data-status");
  if (response.ok) {
    const status = await response.json();
    scanned = Number(status.scan?.scanned ?? 0);
  }
} catch {
  scanned = 0;
}
scanned = Math.max(0, Math.min(symbols.length, scanned));

const snapshot = {
  exportedAt: new Date().toISOString(),
  scanned,
  total: symbols.length,
  symbols,
  contracts: contracts.map((contract) => ({ ...contract, direction: "UNKNOWN" })),
};

await writeFile("apps/web/public/snapshot.json", JSON.stringify(snapshot));
console.log(`snapshot symbols=${symbols.length} scanned=${scanned} contracts=${contracts.length}`);

function plusMonths(day, months) {
  const [year, month, date] = day.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1 + months, date));
  const y = utc.getUTCFullYear();
  const m = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const d = String(utc.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
