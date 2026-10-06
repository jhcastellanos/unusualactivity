export function parseOptionSymbol(symbol: string): { expiration: string; optionType: "call" | "put"; strike: number } | null {
  const match = symbol.match(/(\d{6})([CP])(\d{8})$/);
  if (!match) return null;
  const year = 2000 + Number(match[1].slice(0, 2));
  const expiration = `${year}-${match[1].slice(2, 4)}-${match[1].slice(4, 6)}`;
  const strike = Number(match[3]) / 1000;
  if (!Number.isFinite(strike)) return null;
  return { expiration, optionType: match[2] === "C" ? "call" : "put", strike };
}

export function daysToExpiration(expiration: string, today: string): number | null {
  const end = Date.parse(`${expiration}T00:00:00Z`);
  const start = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(end) || Number.isNaN(start)) return null;
  return Math.round((end - start) / 86_400_000);
}

export function todayInNewYork(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
}

export function volumeOiRatio(volume: number | null, openInterest: number | null): number | null {
  if (volume == null || openInterest == null || openInterest <= 0) return null;
  if (!Number.isFinite(volume) || !Number.isFinite(openInterest)) return null;
  return volume / openInterest;
}

export const DAY_UNUSUAL_VOLUME_RATIO = 2;

export function isDayUnusualVolume(volumeOiRatio: number | null): boolean {
  return volumeOiRatio != null && Number.isFinite(volumeOiRatio) && volumeOiRatio >= DAY_UNUSUAL_VOLUME_RATIO;
}

export const MIN_UNUSUAL_SIZE = 500_000;

export function plusMonths(day: string, months: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1 + months, date));
  return formatUtcDay(utc);
}

export function plusDays(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, date + days));
  return formatUtcDay(utc);
}

function formatUtcDay(utc: Date): string {
  const y = utc.getUTCFullYear();
  const m = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const d = String(utc.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export type FlowLean = "alza" | "baja" | "neutral" | "sin_flujo";

export type FlowWindow = {
  lean: FlowLean;
  callPremium: number;
  putPremium: number;
  callContracts: number;
  putContracts: number;
};

export function flowLean(callPremium: number, putPremium: number): FlowLean {
  const total = callPremium + putPremium;
  if (!(total > 0)) return "sin_flujo";
  const callShare = callPremium / total;
  if (callShare >= 0.65) return "alza";
  if (callShare <= 0.35) return "baja";
  return "neutral";
}

export function summarizeFlow(
  rows: Array<{ optionType: "call" | "put"; expiration: string; estimatedPremium: number | null }>,
  today: string,
): { weekly: FlowWindow; monthly: FlowWindow } {
  const weekEnd = plusDays(today, 7);
  const monthEnd = plusDays(today, 31);
  return {
    weekly: windowFlow(rows, today, weekEnd),
    monthly: windowFlow(rows, today, monthEnd),
  };
}

function windowFlow(
  rows: Array<{ optionType: "call" | "put"; expiration: string; estimatedPremium: number | null }>,
  start: string,
  end: string,
): FlowWindow {
  let callPremium = 0;
  let putPremium = 0;
  let callContracts = 0;
  let putContracts = 0;
  for (const row of rows) {
    if (row.expiration < start || row.expiration > end) continue;
    const premium = row.estimatedPremium ?? 0;
    if (row.optionType === "call") {
      callPremium += premium;
      callContracts += 1;
    } else {
      putPremium += premium;
      putContracts += 1;
    }
  }
  return { lean: flowLean(callPremium, putPremium), callPremium, putPremium, callContracts, putContracts };
}

export function dateTimeInNewYork(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${pick("year")}-${pick("month")}-${pick("day")}T${pick("hour")}:${pick("minute")}:${pick("second")}`;
}

export function estimatedPremium(
  volume: number | null,
  last: number | null,
  bid: number | null,
  ask: number | null,
): number | null {
  if (volume == null) return null;
  if (last != null) return volume * last * 100;
  if (bid != null && ask != null) return (volume * (bid + ask)) / 2 * 100;
  return null;
}

export function qualifyingPremium(
  volume: number | null,
  openInterest: number | null,
  last: number | null,
  bid: number | null,
  ask: number | null,
): number | null {
  const traded = estimatedPremium(volume, last, bid, ask);
  const open = estimatedPremium(openInterest, last, bid, ask);
  if (traded == null && open == null) return null;
  const size = Math.max(traded ?? 0, open ?? 0);
  return size >= MIN_UNUSUAL_SIZE ? size : null;
}

export function isSizedOpenContract(
  input: {
    volume: number | null;
    openInterest: number | null;
    bid: number | null;
    ask: number | null;
    last: number | null;
    expiration: string;
    occurredAt: string | null;
  },
  now = new Date(),
): boolean {
  if (qualifyingPremium(input.volume, input.openInterest, input.last, input.bid, input.ask) == null) return false;
  if (input.openInterest == null || input.openInterest <= 0 || !input.occurredAt) return false;
  const today = todayInNewYork(now);
  if (input.expiration < today) return false;
  return input.occurredAt.slice(0, 10) >= plusMonths(today, -6);
}

export function isUnusualContract(
  volume: number | null,
  openInterest: number | null,
  options: { minVolume?: number; minRatio?: number } = {},
): boolean {
  const minVolume = options.minVolume ?? 500;
  const minRatio = options.minRatio ?? 2;
  const ratio = volumeOiRatio(volume, openInterest);
  if (ratio == null || volume == null) return false;
  return volume >= minVolume && ratio >= minRatio;
}
