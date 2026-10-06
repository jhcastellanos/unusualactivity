import { daysToExpiration, estimatedPremium, isSizedOpenContract, parseOptionSymbol, todayInNewYork, volumeOiRatio } from "./domain.js";

const SOURCE = "cboe-delayed-quotes";

export type UnusualContract = {
  optionSymbol: string;
  occurredAt: string | null;
  ticker: string;
  optionType: "call" | "put";
  direction: "UNKNOWN";
  strike: number;
  expiration: string;
  dte: number | null;
  volume: number;
  openInterest: number;
  volumeOiRatio: number | null;
  bid: number | null;
  ask: number | null;
  last: number | null;
  underlyingPrice: number | null;
  estimatedPremium: number | null;
  source: string;
};

type ChainContract = {
  option?: string;
  bid?: number;
  ask?: number;
  open_interest?: number;
  volume?: number;
  last_trade_price?: number;
  last_trade_time?: string;
};

export async function fetchUnusualContracts(ticker: string): Promise<UnusualContract[]> {
  const response = await fetch(`https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(ticker)}.json`, {
    headers: { "User-Agent": "unusualactivity-personal/0.1" },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404) return [];
  if (!response.ok) {
    if (response.status === 429 || response.status === 503) {
      await response.arrayBuffer().catch(() => undefined);
      const error = new Error(`${ticker} ${response.status}`);
      (error as Error & { retryable: boolean }).retryable = true;
      throw error;
    }
    throw new Error(`${ticker} ${response.status}`);
  }
  const payload = (await response.json()) as { data?: { current_price?: number; options?: ChainContract[] } };
  const options = payload.data?.options;
  if (!options) return [];
  const today = todayInNewYork();
  const underlyingPrice = numberOrNull(payload.data?.current_price);
  const unusual: UnusualContract[] = [];
  for (const contract of options) {
    if (!contract.option) continue;
    const parsed = parseOptionSymbol(contract.option);
    const volume = wholeNumber(contract.volume);
    const openInterest = wholeNumber(contract.open_interest);
    if (!parsed || volume == null || openInterest == null) continue;
    const bid = numberOrNull(contract.bid);
    const ask = numberOrNull(contract.ask);
    const last = numberOrNull(contract.last_trade_price);
    const occurredAt = contract.last_trade_time ?? null;
    if (
      !isSizedOpenContract({
        volume,
        openInterest,
        bid,
        ask,
        last,
        expiration: parsed.expiration,
        occurredAt,
      })
    ) {
      continue;
    }
    unusual.push({
      optionSymbol: contract.option,
      occurredAt,
      ticker,
      optionType: parsed.optionType,
      direction: "UNKNOWN",
      strike: parsed.strike,
      expiration: parsed.expiration,
      dte: daysToExpiration(parsed.expiration, today),
      volume,
      openInterest,
      volumeOiRatio: volumeOiRatio(volume, openInterest),
      bid,
      ask,
      last,
      underlyingPrice,
      estimatedPremium: estimatedPremium(volume, last, bid, ask),
      source: SOURCE,
    });
  }
  return unusual;
}

function wholeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value);
}

function numberOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}
