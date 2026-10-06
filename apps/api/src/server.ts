import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { openDatabase, replaceSecurities } from "./db.js";
import { loadSecurityUniverse } from "./symbols.js";
import { adoptSavedScan, getScanStatus, startUnusualScan, SWEEP_INTERVAL_MS } from "./scan.js";
import { countVisibleContracts, getLastUpdatedAt, listActivity, migrateNeon, tickerFlow } from "./neon.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

loadEnv();

const PORT = Number(process.env.PORT ?? 8787);
const DB_PATH = resolve(ROOT, process.env.DB_PATH ?? "data/unusual.sqlite");
const db = openDatabase(DB_PATH);

function loadEnv(): void {
  const candidates = [resolve(ROOT, ".env"), resolve(process.cwd(), ".env")];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

function listingClause(listing: string): { sql: string; params: number[] } {
  if (listing === "sp500") return { sql: "in_sp500 = ?", params: [1] };
  if (listing === "nasdaq") return { sql: "in_nasdaq = ?", params: [1] };
  return { sql: "(in_sp500 = ? OR in_nasdaq = ?)", params: [1, 1] };
}

function likeTerm(value: string): string {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

function securityMatchSql(length: number): string {
  const companyContains = length >= 4 ? " OR company_name LIKE ? ESCAPE '\\'" : "";
  return `(ticker LIKE ? ESCAPE '\\' OR company_name LIKE ? ESCAPE '\\'${companyContains})`;
}

function securityMatchParams(q: string): string[] {
  const prefix = `${q.replace(/[\\%_]/g, "\\$&")}%`;
  const params = [prefix, prefix];
  if (q.length >= 4) params.push(likeTerm(q));
  return params;
}

const app = Fastify({ logger: true });

app.get("/api/system/data-status", async () => {
  const counts = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(in_sp500) AS sp500,
         SUM(in_nasdaq) AS nasdaq,
         SUM(CASE WHEN in_sp500 = 1 AND in_nasdaq = 1 THEN 1 ELSE 0 END) AS both
       FROM securities`,
    )
    .get() as { total: number; sp500: number | null; nasdaq: number | null; both: number | null };
  const meta = db
    .prepare("SELECT symbol_list_updated_at, symbol_list_source FROM sync_meta WHERE id = 1")
    .get() as { symbol_list_updated_at: string | null; symbol_list_source: string | null };
  const scan = getScanStatus();
  let activity = { count: 0, last: null as string | null };
  let lastUpdatedAt: string | null = null;
  try {
    activity = await countVisibleContracts();
    lastUpdatedAt = await getLastUpdatedAt();
  } catch (error) {
    app.log.error({ message: error instanceof Error ? error.message : "neon" }, "neon read failed");
  }

  return {
    securityCount: counts.total,
    sp500Count: counts.sp500 ?? 0,
    nasdaqCount: counts.nasdaq ?? 0,
    bothCount: counts.both ?? 0,
    symbolListUpdatedAt: meta.symbol_list_updated_at,
    symbolListSource: meta.symbol_list_source,
    provider: "Cboe delayed quotes",
    source: scan.source,
    activityCount: activity.count,
    lastOccurredAt: activity.last,
    lastUpdatedAt,
    scan,
  };
});

app.get("/api/securities", async (request) => {
  const query = request.query as Record<string, string | undefined>;
  const page = clampInt(query.page, 1, 10_000);
  const pageSize = [25, 50, 100, 250].includes(Number(query.pageSize)) ? Number(query.pageSize) : 100;
  const securitySorts: Record<string, string> = { ticker: "ticker", companyName: "company_name", exchange: "exchange" };
  const sort = securitySorts[query.sort ?? ""] ?? "ticker";
  const order = query.order === "desc" ? "DESC" : "ASC";
  const listing = ["sp500", "nasdaq", "all"].includes(query.listing ?? "") ? (query.listing as string) : "all";
  const q = (query.q ?? "").trim().slice(0, 40);
  const filter = listingClause(listing);
  const where = [filter.sql];
  const params: Array<string | number> = [...filter.params];
  if (q) {
    where.push(securityMatchSql(q.length));
    params.push(...securityMatchParams(q));
  }
  const whereSql = where.join(" AND ");
  const total = (
    db.prepare(`SELECT COUNT(*) AS count FROM securities WHERE ${whereSql}`).get(...params) as { count: number }
  ).count;
  const rows = db
    .prepare(
      `SELECT ticker, company_name AS companyName, exchange, asset_type AS assetType, in_sp500 AS inSp500, in_nasdaq AS inNasdaq
       FROM securities
       WHERE ${whereSql}
       ORDER BY ${sort} ${order}, ticker ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize);

  return { page, pageSize, total, sort: query.sort && securitySorts[query.sort] ? query.sort : "ticker", order: order.toLowerCase(), listing, q, rows };
});

app.get("/api/securities/search", async (request) => {
  const q = ((request.query as { q?: string }).q ?? "").trim().slice(0, 40);
  if (q.length < 1) return { rows: [] };
  const prefix = `${q.replace(/[\\%_]/g, "\\$&")}%`;
  const rows = db
    .prepare(
      `SELECT ticker, company_name AS companyName, exchange, in_sp500 AS inSp500, in_nasdaq AS inNasdaq
       FROM securities
       WHERE ${securityMatchSql(q.length)}
       ORDER BY CASE
         WHEN ticker = ? THEN 0
         WHEN ticker LIKE ? ESCAPE '\\' THEN 1
         WHEN company_name LIKE ? ESCAPE '\\' THEN 2
         ELSE 3
       END, ticker
       LIMIT 8`,
    )
    .all(...securityMatchParams(q), q.toUpperCase(), prefix, prefix);
  return { rows };
});

app.get("/api/activity/bias", async (request) => {
  const query = request.query as Record<string, string | undefined>;
  const ticker = (query.ticker ?? "").trim().toUpperCase().slice(0, 12);
  if (!/^[A-Z0-9.-]{1,12}$/.test(ticker)) return { ticker, underlyingPrice: null, weekly: emptyWindow(), monthly: emptyWindow() };
  return tickerFlow(ticker);
});

function emptyWindow() {
  return { lean: "sin_flujo", callPremium: 0, putPremium: 0, callContracts: 0, putContracts: 0 };
}

app.get("/api/activity", async (request) => {
  const query = request.query as Record<string, string | undefined>;
  const page = clampInt(query.page, 1, 10_000);
  const pageSize = [25, 50, 100, 250].includes(Number(query.pageSize)) ? Number(query.pageSize) : 100;
  const order = query.order === "asc" ? "ASC" : "DESC";
  const order2 = query.order2 === "desc" ? "DESC" : "ASC";
  const listing = ["sp500", "nasdaq", "all"].includes(query.listing ?? "") ? (query.listing as string) : "all";
  const q = (query.q ?? "").trim().toUpperCase().slice(0, 12);
  const listed = await listActivity({
    page,
    pageSize,
    sort: query.sort ?? "occurredAt",
    order,
    sort2: query.sort2 ?? "",
    order2,
    listing,
    q,
  });
  return {
    page,
    pageSize,
    total: listed.total,
    sort: listed.sort,
    order: order.toLowerCase(),
    sort2: listed.sort2,
    order2: order2.toLowerCase(),
    listing,
    q,
    rows: listed.rows,
  };
});

async function syncSymbols(): Promise<void> {
  const loaded = await loadSecurityUniverse();
  const updatedAt = new Date().toISOString();
  replaceSecurities(db, loaded.rows, updatedAt, loaded.source);
  app.log.info({ count: loaded.rows.length }, "symbol universe refreshed");
}

function clampInt(value: string | undefined, min: number, max: number): number {
  const parsed = Number(value ?? min);
  if (!Number.isInteger(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

try {
  await migrateNeon();
} catch (error) {
  app.log.error({ message: error instanceof Error ? error.message : "neon" }, "neon migration failed");
  throw error;
}

try {
  await syncSymbols();
} catch (error) {
  app.log.error(error, "symbol sync failed; serving the last saved directory");
}

await app.listen({ port: PORT, host: "127.0.0.1" });
const logScan = (message: string) => app.log.info(message);
const universe = db.prepare("SELECT COUNT(*) AS count FROM securities").get() as { count: number };
await adoptSavedScan(universe.count);
startUnusualScan(db, logScan);
setInterval(() => startUnusualScan(db, logScan), SWEEP_INTERVAL_MS);
