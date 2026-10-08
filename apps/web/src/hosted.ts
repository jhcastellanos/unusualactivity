import { useEffect, useMemo, useState } from "react";

export type Listing = "all" | "sp500" | "nasdaq";
export type Order = "asc" | "desc";

export type Scan = {
  running: boolean;
  scanned: number;
  total: number;
  unusual: number;
  errors: number;
  current?: string[];
};

export type Status = {
  provider: string;
  activityCount: number;
  lastOccurredAt: string | null;
  lastUpdatedAt?: string | null;
  scan: Scan;
};

export type Contract = {
  id: number;
  optionSymbol: string;
  occurredAt: string | null;
  ticker: string;
  optionType: "call" | "put";
  direction: "UNKNOWN";
  strike: number | null;
  expiration: string | null;
  dte: number | null;
  volume: number | null;
  openInterest: number | null;
  volumeOiRatio: number | null;
  bid: number | null;
  ask: number | null;
  last: number | null;
  underlyingPrice: number | null;
  estimatedPremium: number | null;
  inSp500?: number;
  inNasdaq?: number;
};

export type PageState = {
  q: string;
  page: number;
  pageSize: number;
  sort: string;
  order: Order;
  listing: Listing;
};

type SymbolRow = { ticker: string; inSp500: number; inNasdaq: number };

type Snapshot = {
  exportedAt: string;
  scanned: number;
  total: number;
  symbols: SymbolRow[];
  contracts: Contract[];
};

type Cache = {
  scanned: number;
  total: number;
  contracts: Contract[];
};

const CACHE_KEY = "unusual-hosted-v1";

export function useHostedBoard(enabled: boolean, state: PageState) {
  const [all, setAll] = useState<Contract[]>([]);
  const [scan, setScan] = useState<Scan | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [lastOccurredAt, setLastOccurredAt] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const inflight = new Set<string>();

    const run = async () => {
      let snapshot: Snapshot;
      try {
        const response = await fetch("/snapshot.json");
        if (!response.ok) throw new Error("snapshot");
        snapshot = (await response.json()) as Snapshot;
      } catch {
        if (!cancelled) {
          setError("No pude cargar los contratos.");
          setLoading(false);
        }
        return;
      }
      if (cancelled) return;

      const cache = readCache();
      const sameUniverse = cache != null && cache.total === snapshot.symbols.length;
      const scannedStart = sameUniverse ? Math.max(snapshot.scanned, cache.scanned) : snapshot.scanned;
      const merged = assignIds(mergeContracts(snapshot.contracts, sameUniverse ? cache.contracts : []));
      let scanned = Math.min(scannedStart, snapshot.symbols.length);
      let errors = 0;
      const contracts = merged;

      const publish = (running: boolean) => {
        if (cancelled) return;
        const latest = contracts.reduce<string | null>((best, row) => {
          if (!row.occurredAt) return best;
          if (!best || row.occurredAt > best) return row.occurredAt;
          return best;
        }, null);
        setAll(contracts.slice());
        setLastOccurredAt(latest);
        setScan({
          running,
          scanned,
          total: snapshot.symbols.length,
          unusual: contracts.length,
          errors,
          current: [...inflight].sort(),
        });
        setLoading(false);
      };

      publish(true);
      const symbols = snapshot.symbols;
      let cursor = scanned;
      const workers = Array.from({ length: 2 }, async () => {
        while (!cancelled) {
          const index = cursor;
          cursor += 1;
          if (index >= symbols.length) return;
          const symbol = symbols[index];
          inflight.add(symbol.ticker);
          publish(true);
          const pulled = await pullSymbol(symbol);
          inflight.delete(symbol.ticker);
          if (cancelled) return;
          if (pulled == null) errors += 1;
          else addContracts(contracts, pulled);
          scanned += 1;
          if (scanned % 10 === 0) writeCache({ scanned, total: symbols.length, contracts });
          publish(cursor < symbols.length || inflight.size > 0);
          await sleep(150);
        }
      });
      await Promise.all(workers);
      if (cancelled) return;
      writeCache({ scanned, total: symbols.length, contracts });
      publish(false);
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const view = useMemo(() => pageContracts(all, state), [all, state]);

  if (!enabled) return null;
  return {
    rows: view.rows,
    total: view.total,
    loading,
    error,
    status: {
      provider: "Cboe delayed",
      activityCount: view.total,
      lastOccurredAt,
      lastUpdatedAt: null,
      scan: scan ?? { running: false, scanned: 0, total: 0, unusual: 0, errors: 0, current: [] },
    } satisfies Status,
  };
}

function pageContracts(all: Contract[], state: PageState): { rows: Contract[]; total: number } {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  const oldest = plusMonths(today, -6);
  const filtered = all.filter((row) => {
    if ((row.estimatedPremium ?? 0) < 500_000) return false;
    if ((row.openInterest ?? 0) <= 0) return false;
    if (!row.expiration || row.expiration < today) return false;
    const occurred = row.occurredAt?.slice(0, 10);
    if (!occurred || occurred < oldest) return false;
    if (state.listing === "sp500" && row.inSp500 !== 1) return false;
    if (state.listing === "nasdaq" && row.inNasdaq !== 1) return false;
    if (state.q && row.ticker !== state.q) return false;
    return true;
  });
  const key = state.sort as keyof Contract;
  filtered.sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av == null && bv == null) return a.ticker.localeCompare(b.ticker);
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av < bv) return state.order === "asc" ? -1 : 1;
    if (av > bv) return state.order === "asc" ? 1 : -1;
    return a.ticker.localeCompare(b.ticker);
  });
  const start = (state.page - 1) * state.pageSize;
  return { rows: filtered.slice(start, start + state.pageSize), total: filtered.length };
}

async function pullSymbol(symbol: SymbolRow): Promise<Contract[] | null> {
  const params = new URLSearchParams({
    ticker: symbol.ticker,
    inSp500: String(symbol.inSp500),
    inNasdaq: String(symbol.inNasdaq),
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(`/api/pull?${params}`);
      if (response.status === 429) {
        await sleep(3_000 * (attempt + 1));
        continue;
      }
      if (!response.ok) return null;
      const body = (await response.json()) as { contracts?: Contract[] };
      return body.contracts ?? [];
    } catch {
      return null;
    }
  }
  return null;
}

function addContracts(target: Contract[], incoming: Contract[]) {
  const bySymbol = new Map(target.map((row) => [row.optionSymbol, row]));
  let nextId = target.reduce((max, row) => Math.max(max, row.id), 0);
  for (const row of incoming) {
    const existing = bySymbol.get(row.optionSymbol);
    if (existing) {
      Object.assign(existing, row, { id: existing.id });
      continue;
    }
    nextId += 1;
    const created = { ...row, id: nextId, direction: "UNKNOWN" as const };
    target.push(created);
    bySymbol.set(created.optionSymbol, created);
  }
}

function mergeContracts(base: Contract[], extra: Contract[]): Contract[] {
  const merged = base.map((row) => ({ ...row, direction: "UNKNOWN" as const }));
  addContracts(merged, extra);
  return merged;
}

function assignIds(rows: Contract[]): Contract[] {
  return rows.map((row, index) => ({ ...row, id: index + 1, direction: "UNKNOWN" }));
}

function readCache(): Cache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Cache;
    if (!Array.isArray(parsed.contracts) || !Number.isFinite(parsed.scanned)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(cache: Cache) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // The table still updates in memory when the browser refuses more storage.
  }
}

function plusMonths(day: string, months: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1 + months, date));
  const y = utc.getUTCFullYear();
  const m = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const d = String(utc.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
