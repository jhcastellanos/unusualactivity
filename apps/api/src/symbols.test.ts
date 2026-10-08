import { describe, expect, it } from "vitest";
import { includeSecurity } from "./symbols.ts";

describe("includeSecurity", () => {
  it("keeps the index ETFs that trade outside NASDAQ and the S&P 500", () => {
    expect(includeSecurity({ ticker: "SPY", inSp500: false, inNasdaq: false })).toBe(true);
    expect(includeSecurity({ ticker: "IWM", inSp500: false, inNasdaq: false })).toBe(true);
    expect(includeSecurity({ ticker: "DIA", inSp500: false, inNasdaq: false })).toBe(true);
  });

  it("keeps a NASDAQ name and leaves out an unrelated NYSE stock", () => {
    expect(includeSecurity({ ticker: "QQQ", inSp500: false, inNasdaq: true })).toBe(true);
    expect(includeSecurity({ ticker: "WAL", inSp500: false, inNasdaq: false })).toBe(false);
  });
});
