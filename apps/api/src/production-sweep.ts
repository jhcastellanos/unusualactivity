import directory from "../../../api/securities-directory.json" with { type: "json" };
import { fetchOptionChain } from "./cboe.js";
import { dateTimeInNewYork } from "./domain.js";
import { getPool, listWatchedSymbols, migrateNeon, recordWatchProgress, removeExpiredContracts, removeSettledContracts, upsertContracts } from "./neon.js";

const OWNER = "production";
const BATCH = 4;
const WORKERS = 4;

type Security = { ticker: string; inSp500: number; inNasdaq: number };

export type SweepStep = {
  started: boolean;
  running: boolean;
  done: boolean;
  busy: boolean;
  scanned: number;
  total: number;
};

const symbols: Security[] = [...(directory as Security[])].sort(
  (a, b) => b.inSp500 - a.inSp500 || a.ticker.localeCompare(b.ticker),
);

let migrated = false;

async function ready(): Promise<void> {
  if (migrated) return;
  await migrateNeon();
  migrated = true;
}

export async function startProductionSweep(): Promise<SweepStep> {
  await ready();
  const total = symbols.length;
  const claimed = await getPool().query(
    `UPDATE scan_state
     SET sweep_owner = $1,
         sweep_heartbeat = NOW(),
         sweep_cursor = 0,
         sweep_scanned = 0,
         sweep_errors = 0,
         sweep_total = $2,
         sweep_phase = 'refresh',
         sweep_stop_requested = FALSE,
         sweep_requested_at = NULL,
         sweep_batch_open = TRUE,
         sweep_started_at = NOW(),
         sweep_finished_at = NULL,
         sweep_current = NULL
     WHERE id = 1
       AND NOT (
         sweep_owner = $1
         AND sweep_batch_open IS TRUE
         AND sweep_heartbeat > NOW() - INTERVAL '70 seconds'
       )
     RETURNING sweep_started_at`,
    [OWNER, total],
  );
  if ((claimed.rowCount ?? 0) === 0) {
    return { started: false, running: true, done: false, busy: true, scanned: 0, total };
  }
  await removeExpiredContracts();
  const scanId = `production-${new Date(claimed.rows[0].sweep_started_at).toISOString()}`;
  return runSlice(0, scanId, 0);
}

export async function continueProductionSweep(): Promise<SweepStep> {
  await ready();
  const stopped = await getPool().query<{ sweep_scanned: number | null; sweep_total: number | null }>(
    `UPDATE scan_state
     SET sweep_owner = NULL,
         sweep_heartbeat = NULL,
         sweep_batch_open = FALSE,
         sweep_stop_requested = FALSE,
         sweep_finished_at = NOW(),
         sweep_current = NULL
     WHERE id = 1
       AND sweep_owner = $1
       AND sweep_stop_requested IS TRUE
       AND sweep_batch_open IS NOT TRUE
     RETURNING sweep_scanned, sweep_total`,
    [OWNER],
  );
  if ((stopped.rowCount ?? 0) > 0) {
    return {
      started: false,
      running: false,
      done: true,
      busy: false,
      scanned: stopped.rows[0]?.sweep_scanned ?? 0,
      total: stopped.rows[0]?.sweep_total ?? symbols.length,
    };
  }
  const claimed = await getPool().query<{ sweep_cursor: number; sweep_total: number; sweep_errors: number; sweep_started_at: Date }>(
    `UPDATE scan_state
     SET sweep_batch_open = TRUE,
         sweep_heartbeat = NOW(),
         sweep_owner = $1
     WHERE id = 1
       AND sweep_owner = $1
       AND sweep_phase = 'refresh'
       AND sweep_stop_requested IS NOT TRUE
       AND sweep_cursor < sweep_total
       AND (
         sweep_batch_open IS NOT TRUE
         OR sweep_heartbeat IS NULL
         OR sweep_heartbeat < NOW() - INTERVAL '70 seconds'
       )
     RETURNING sweep_cursor, sweep_total, sweep_errors, sweep_started_at`,
    [OWNER],
  );
  const row = claimed.rows[0];
  if (!row) return idleStep();
  const scanId = `production-${new Date(row.sweep_started_at).toISOString()}`;
  return runSlice(row.sweep_cursor, scanId, row.sweep_errors ?? 0);
}

export async function stopProductionSweep(): Promise<boolean> {
  await ready();
  const result = await getPool().query<{ sweep_batch_open: boolean }>(
    `UPDATE scan_state
     SET sweep_stop_requested = TRUE
     WHERE id = 1
       AND sweep_owner = $1
       AND sweep_phase = 'refresh'
       AND sweep_cursor < COALESCE(sweep_total, 0)
     RETURNING sweep_batch_open`,
    [OWNER],
  );
  if ((result.rowCount ?? 0) === 0) return false;
  if (!result.rows[0]?.sweep_batch_open) await continueProductionSweep();
  return true;
}

async function idleStep(): Promise<SweepStep> {
  const result = await getPool().query<{ sweep_scanned: number | null; sweep_total: number | null; running: boolean }>(
    `SELECT sweep_scanned, sweep_total,
            (sweep_owner = $1 AND sweep_phase = 'refresh' AND sweep_heartbeat > NOW() - INTERVAL '90 seconds') AS running
     FROM scan_state WHERE id = 1`,
    [OWNER],
  );
  const row = result.rows[0];
  return {
    started: false,
    running: Boolean(row?.running),
    done: !row?.running,
    busy: Boolean(row?.running),
    scanned: row?.sweep_scanned ?? 0,
    total: row?.sweep_total ?? symbols.length,
  };
}

async function runSlice(cursor: number, scanId: string, errors: number): Promise<SweepStep> {
  const slice = symbols.slice(cursor, cursor + BATCH);
  const watched = new Set(await listWatchedSymbols());
  let batchErrors = 0;
  let index = 0;
  const current: string[] = [];
  async function worker() {
    while (index < slice.length) {
      const symbol = slice[index];
      index += 1;
      current.push(symbol.ticker);
      const ok = await refreshTicker(symbol, scanId, watched);
      if (!ok) batchErrors += 1;
    }
  }
  await Promise.all(Array.from({ length: Math.min(WORKERS, slice.length) }, () => worker()));
  const next = cursor + slice.length;
  const stop = await stopRequested();
  const done = stop || next >= symbols.length;
  await getPool().query(
    `UPDATE scan_state
     SET sweep_cursor = $2,
         sweep_scanned = $2,
         sweep_errors = $3,
         sweep_current = $4,
         sweep_batch_open = FALSE,
         sweep_heartbeat = CASE WHEN $5 THEN NULL ELSE NOW() END,
         sweep_owner = CASE WHEN $5 THEN NULL ELSE $1 END,
         sweep_phase = CASE WHEN $5 AND $6 THEN 'saved' ELSE sweep_phase END,
         sweep_finished_at = CASE WHEN $5 THEN NOW() ELSE NULL END,
         sweep_stop_requested = FALSE,
         last_updated_at = CASE WHEN $6 AND NOT $7 THEN NOW() ELSE last_updated_at END,
         trade_since = CASE WHEN $6 AND NOT $7 THEN $8 ELSE trade_since END
     WHERE id = 1 AND sweep_owner = $1`,
    [OWNER, next, errors + batchErrors, current.join(", "), done, next >= symbols.length, stop, dateTimeInNewYork(new Date())],
  );
  return {
    started: cursor === 0,
    running: !done,
    done,
    busy: false,
    scanned: next,
    total: symbols.length,
  };
}

async function stopRequested(): Promise<boolean> {
  const result = await getPool().query<{ sweep_stop_requested: boolean }>(
    "SELECT sweep_stop_requested FROM scan_state WHERE id = 1",
  );
  return Boolean(result.rows[0]?.sweep_stop_requested);
}

async function refreshTicker(symbol: Security, scanId: string, watched: Set<string>): Promise<boolean> {
  let chain: Awaited<ReturnType<typeof fetchOptionChain>> | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      chain = await fetchOptionChain(symbol.ticker, AbortSignal.timeout(7_000));
      break;
    } catch (error) {
      const retryable = typeof error === "object" && error !== null && "retryable" in error;
      if (!retryable || attempt === 1) return false;
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
  if (!chain?.complete) return true;
  try {
    await upsertContracts(chain.unusual, symbol.ticker, symbol.inSp500, symbol.inNasdaq, scanId, null);
    await removeSettledContracts(symbol.ticker, chain.stillOpen);
    const mine = chain.quotes.filter((quote) => watched.has(quote.optionSymbol));
    if (mine.length > 0) await recordWatchProgress(mine);
    return true;
  } catch {
    return false;
  }
}

export async function scheduleProductionSweep(request: Request, result: SweepStep): Promise<void> {
  if (!result.running || result.done) return;
  const url = new URL("/api/scan/step", request.url);
  const task = fetch(url, { method: "POST" }).then((response) => response.arrayBuffer()).catch(() => undefined);
  try {
    const { waitUntil } = await import("@vercel/functions");
    waitUntil(task);
  } catch {
    void task;
  }
}
