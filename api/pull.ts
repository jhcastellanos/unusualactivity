import { fetchUnusualContracts, type UnusualContract } from "../apps/api/src/cboe.js";
import { daysToExpiration, todayInNewYork } from "../apps/api/src/domain.js";

type ListedContract = UnusualContract & {
  inSp500: number;
  inNasdaq: number;
  estimatedPremium: number | null;
  dte: number | null;
};

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const ticker = (url.searchParams.get("ticker") ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9.-]{1,12}$/.test(ticker)) {
    return Response.json({ contracts: [], error: "ticker" }, { status: 400 });
  }
  const inSp500 = url.searchParams.get("inSp500") === "1" ? 1 : 0;
  const inNasdaq = url.searchParams.get("inNasdaq") === "1" ? 1 : 0;
  try {
    const found = await fetchUnusualContracts(ticker);
    const contracts = found.filter(isListed).map((contract) => decorate(contract, inSp500, inNasdaq));
    return Response.json({ contracts });
  } catch (error) {
    const retryable = typeof error === "object" && error !== null && "retryable" in error;
    return Response.json({ contracts: [], retryable }, { status: retryable ? 429 : 502 });
  }
}

function isListed(contract: UnusualContract): boolean {
  if (contract.openInterest <= 0 || !contract.occurredAt) return false;
  const today = todayInNewYork();
  if (contract.expiration < today) return false;
  return contract.occurredAt.slice(0, 10) >= plusMonths(today, -6);
}

function decorate(contract: UnusualContract, inSp500: number, inNasdaq: number): ListedContract {
  const today = todayInNewYork();
  return {
    ...contract,
    dte: daysToExpiration(contract.expiration, today),
    inSp500,
    inNasdaq,
    estimatedPremium: contract.estimatedPremium,
  };
}

function plusMonths(day: string, months: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1 + months, date));
  const y = utc.getUTCFullYear();
  const m = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const d = String(utc.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
