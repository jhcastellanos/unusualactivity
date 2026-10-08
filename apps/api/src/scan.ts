import type { DatabaseSync } from "node:sqlite";
import { fetchOptionChain } from "./cboe.js";
import { dateTimeInNewYork, todayInNewYork } from "./domain.js";
import {
  countVisibleContracts,
  getLastUpdatedAt,
  markScanFinished,
  releaseSweep,
  rememberSavedSweep,
  removeExpiredContracts,
  removeSettledContracts,
  touchSweep,
  tryAcquireSweep,
  upsertContracts,
} from "./neon.js";

export type ScanStatus = {
  running: boolean;
  scanned: number;
  total: number;
  unusual: number;
  errors: number;
  current: string[];
  startedAt: string | null;
  finishedAt: string | null;
  source: string;
  phase: "saved" | "refresh" | "initial";
};

const status: ScanStatus = {
  running: false,
  scanned: 0,
  total: 0,
  unusual: 0,
  errors: 0,
  current: [],
  startedAt: null,
  finishedAt: null,
  source: "cboe-delayed-quotes",
  phase: "initial",
};

export function getScanStatus(): ScanStatus {
  return { ...status };
}

export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export async function adoptSavedScan(total: number): Promise<boolean> {
  const visible = await countVisibleContracts();
  const updated = await getLastUpdatedAt();
  if (visible.count === 0 && !updated) return false;
  if (!updated) await rememberSavedSweep(dateTimeInNewYork(new Date()));
  status.running = false;
  status.scanned = total;
  status.total = total;
  status.unusual = visible.count;
  status.errors = 0;
  status.current = [];
  status.startedAt = null;
  status.finishedAt = new Date().toISOString();
  status.phase = "saved";
  return true;
}

let retryTimer: ReturnType<typeof setTimeout> | null = null;

export function startUnusualScan(db: DatabaseSync, log: (message: string) => void): Promise<boolean> {
  if (status.running) return Promise.resolve(false);
  status.running = true;
  const symbols = db
    .prepare(
      `SELECT ticker, in_sp500 AS inSp500, in_nasdaq AS inNasdaq
       FROM securities
       ORDER BY in_sp500 DESC, ticker ASC`,
    )
    .all() as Array<{ ticker: string; inSp500: number; inNasdaq: number }>;
  return begin(db, symbols, log);
}

async function begin(
  db: DatabaseSync,
  symbols: Array<{ ticker: string; inSp500: number; inNasdaq: number }>,
  log: (message: string) => void,
): Promise<boolean> {
  const locked = await tryAcquireSweep();
  if (!locked) {
    status.running = false;
    log("sweep already running elsewhere; retrying shortly");
    if (!retryTimer) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void startUnusualScan(db, log);
      }, 20_000);
    }
    return false;
  }
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  let visibleCount = 0;
  try {
    const visible = await countVisibleContracts();
    visibleCount = visible.count;
  } catch (error) {
    status.running = false;
    log(`sweep stopped: ${error instanceof Error ? error.message : "error"}`);
    await releaseSweep();
    return false;
  }
  status.scanned = 0;
  status.total = symbols.length;
  status.unusual = visibleCount;
  status.errors = 0;
  status.current = [];
  status.startedAt = new Date().toISOString();
  status.finishedAt = null;
  status.phase = visibleCount > 0 ? "refresh" : "initial";
  void run(symbols, status.startedAt, null, log).catch((error: unknown) => {
    status.running = false;
    status.current = [];
    status.phase = status.unusual > 0 ? "saved" : "initial";
    log(`sweep stopped: ${error instanceof Error ? error.message : "error"}`);
  }).finally(() => {
    if (!status.running) void releaseSweep();
  });
  return true;
}

async function run(
  symbols: Array<{ ticker: string; inSp500: number; inNasdaq: number }>,
  scanId: string,
  watermark: string | null,
  log: (message: string) => void,
): Promise<void> {
  await removeExpiredContracts(todayInNewYork());
  let cursor = 0;
  const inflight = new Set<string>();
  const publishCurrent = () => {
    status.current = [...inflight].sort();
  };
  const workers = Array.from({ length: 4 }, async () => {
    while (cursor < symbols.length) {
      const index = cursor;
      cursor += 1;
      const symbol = symbols[index];
      inflight.add(symbol.ticker);
      publishCurrent();
      let chain: Awaited<ReturnType<typeof fetchOptionChain>> | null = null;
      try {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          try {
            chain = await fetchOptionChain(symbol.ticker);
            break;
          } catch (error) {
            const retryable = typeof error === "object" && error !== null && "retryable" in error;
            if (!retryable || attempt === 4) {
              status.errors += 1;
              chain = null;
              break;
            }
            await sleep(3_000 * (attempt + 1));
          }
        }
        if (chain?.complete) {
          try {
            await upsertContracts(chain.unusual, symbol.ticker, symbol.inSp500, symbol.inNasdaq, scanId, watermark);
            await removeSettledContracts(symbol.ticker, chain.stillOpen);
            const visible = await countVisibleContracts();
            status.unusual = visible.count;
          } catch {
            status.errors += 1;
          }
        }
      } finally {
        inflight.delete(symbol.ticker);
        status.scanned += 1;
        publishCurrent();
      }
      if (status.scanned % 25 === 0) {
        await touchSweep();
        log(`scan ${status.scanned}/${status.total} unusual=${status.unusual} errors=${status.errors}`);
      }
      await sleep(120);
    }
  });
  await Promise.all(workers);
  const started = status.startedAt ? new Date(status.startedAt) : new Date();
  await markScanFinished(dateTimeInNewYork(started));
  const visible = await countVisibleContracts();
  status.current = [];
  status.unusual = visible.count;
  status.running = false;
  status.finishedAt = new Date().toISOString();
  status.phase = "saved";
  log(`scan finished unusual=${status.unusual} errors=${status.errors}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

