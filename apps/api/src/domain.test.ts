import { describe, expect, it } from "vitest";
import { daysToExpiration, estimatedPremium, flowLean, isDayUnusualVolume, isSizedOpenContract, isUnusualContract, parseOptionSymbol, qualifyingPremium, remainsOpen, selectionScore, summarizeFlow, volumeOiRatio } from "./domain.ts";

describe("selectionScore", () => {
  const positioned = { openInterest: 2_000, volumeOiRatio: 3, estimatedPremium: 8_000_000 };

  it("prefers a medium dated contract with useful delta, slow decay, and real size", () => {
    const score = selectionScore({ delta: 0.41, theta: -0.035, dte: 162, last: 7.3, underlyingPrice: 79.3, ...positioned });
    expect(score).toBeGreaterThanOrEqual(75);
  });

  it("marks a one day spike on thin open interest as a poor medium term choice", () => {
    const score = selectionScore({
      delta: 0.41,
      theta: -0.79,
      dte: 1,
      last: 0.73,
      underlyingPrice: 79.3,
      openInterest: 20,
      volumeOiRatio: 50,
      estimatedPremium: 600_000,
    });
    expect(score).not.toBeNull();
    expect(score!).toBeLessThan(45);
  });

  it("ranks a built position above the same contract when today's volume dwarfs open interest", () => {
    const base = { delta: 0.45, theta: -0.02, dte: 200, last: 8, underlyingPrice: 80, estimatedPremium: 6_000_000 };
    const built = selectionScore({ ...base, openInterest: 1_500, volumeOiRatio: 3 });
    const spike = selectionScore({ ...base, openInterest: 30, volumeOiRatio: 40 });
    expect(built).not.toBeNull();
    expect(spike).not.toBeNull();
    expect(built!).toBeGreaterThan(spike!);
  });

  it("returns null when Cboe did not send the greeks", () => {
    expect(selectionScore({ delta: null, theta: null, dte: 162, last: 7.3, underlyingPrice: 79.3, ...positioned })).toBeNull();
  });
});

describe("parseOptionSymbol", () => {
  it("reads expiration, call/put and strike from the OCC symbol", () => {
    expect(parseOptionSymbol("AAPL261007C00245000")).toEqual({
      expiration: "2026-10-07",
      optionType: "call",
      strike: 245,
    });
  });

  it("returns null when the symbol is not an option code", () => {
    expect(parseOptionSymbol("AAPL")).toBeNull();
  });
});

describe("daysToExpiration", () => {
  it("counts calendar days until expiration", () => {
    expect(daysToExpiration("2026-10-07", "2026-10-06")).toBe(1);
  });
});

describe("volumeOiRatio", () => {
  it("divides volume by open interest", () => {
    expect(volumeOiRatio(50_000, 5_000)).toBe(10);
  });

  it("returns null when open interest is missing or zero", () => {
    expect(volumeOiRatio(100, null)).toBeNull();
    expect(volumeOiRatio(100, 0)).toBeNull();
    expect(volumeOiRatio(null, 10)).toBeNull();
  });
});

describe("isDayUnusualVolume", () => {
  it("marks today's volume at least twice the open interest", () => {
    expect(isDayUnusualVolume(2)).toBe(true);
    expect(isDayUnusualVolume(34.39)).toBe(true);
  });

  it("leaves a quiet contract unmarked", () => {
    expect(isDayUnusualVolume(1.99)).toBe(false);
    expect(isDayUnusualVolume(0)).toBe(false);
    expect(isDayUnusualVolume(null)).toBe(false);
  });
});

describe("isUnusualContract", () => {
  it("flags a contract above the volume and ratio floors", () => {
    expect(isUnusualContract(2_000, 500)).toBe(true);
  });

  it("does not flag a liquid contract with a low ratio", () => {
    expect(isUnusualContract(10_000, 50_000)).toBe(false);
  });

  it("does not invent a signal when open interest is missing", () => {
    expect(isUnusualContract(10_000, null)).toBe(false);
  });
});

describe("sized open contracts", () => {
  it("requires at least $500,000 of premium", () => {
    expect(estimatedPremium(31_250, 0.16, null, null)).toBe(500_000);
    expect(estimatedPremium(1_000, 1, null, null)).toBe(100_000);
  });

  it("keeps an open contract at or above the size floor", () => {
    expect(
      isSizedOpenContract(
        {
          volume: 31_250,
          openInterest: 100,
          bid: null,
          ask: null,
          last: 0.16,
          expiration: "2026-12-18",
          occurredAt: "2026-10-06T15:59:59",
        },
        new Date("2026-10-06T20:00:00Z"),
      ),
    ).toBe(true);
  });

  it("keeps an open position of at least $500,000 even when today's volume is smaller", () => {
    expect(qualifyingPremium(91, 4_970, 21, 20.85, 21.15)).toBe(4_970 * 21 * 100);
    expect(
      isSizedOpenContract(
        {
          volume: 91,
          openInterest: 4_970,
          bid: 20.85,
          ask: 21.15,
          last: 21,
          expiration: "2027-03-19",
          occurredAt: "2026-10-06T15:32:34",
        },
        new Date("2026-10-06T20:00:00Z"),
      ),
    ).toBe(true);
  });

  it("drops a trade older than 6 months", () => {
    expect(
      isSizedOpenContract(
        {
          volume: 91,
          openInterest: 4_970,
          bid: null,
          ask: null,
          last: 21,
          expiration: "2027-03-19",
          occurredAt: "2026-01-06T15:32:34",
        },
        new Date("2026-10-06T20:00:00Z"),
      ),
    ).toBe(false);
  });

  it("drops a contract below $500,000 or already expired", () => {
    const now = new Date("2026-10-06T20:00:00Z");
    expect(
      isSizedOpenContract(
        {
          volume: 1_000,
          openInterest: 100,
          bid: null,
          ask: null,
          last: 1,
          expiration: "2026-12-18",
          occurredAt: "2026-10-06T15:59:59",
        },
        now,
      ),
    ).toBe(false);
    expect(
      isSizedOpenContract(
        {
          volume: 31_250,
          openInterest: 100,
          bid: null,
          ask: null,
          last: 0.16,
          expiration: "2026-10-05",
          occurredAt: "2026-10-06T15:59:59",
        },
        now,
      ),
    ).toBe(false);
  });
});

describe("remainsOpen", () => {
  it("keeps a contract that still has open interest and has not expired", () => {
    expect(remainsOpen(120, "2026-12-18", "2026-10-08")).toBe(true);
  });

  it("treats a missing open interest as still listed", () => {
    expect(remainsOpen(null, "2026-12-18", "2026-10-08")).toBe(true);
  });

  it("drops a liquidated or expired contract", () => {
    expect(remainsOpen(0, "2026-12-18", "2026-10-08")).toBe(false);
    expect(remainsOpen(120, "2026-10-07", "2026-10-08")).toBe(false);
  });
});

describe("flow lean", () => {
  it("calls a call-heavy book alza and a put-heavy book baja", () => {
    expect(flowLean(800, 200)).toBe("alza");
    expect(flowLean(200, 800)).toBe("baja");
    expect(flowLean(500, 500)).toBe("neutral");
    expect(flowLean(0, 0)).toBe("sin_flujo");
  });

  it("splits weekly and monthly windows from today", () => {
    const summary = summarizeFlow(
      [
        { optionType: "call", expiration: "2026-10-09", estimatedPremium: 2_000_000 },
        { optionType: "put", expiration: "2026-10-09", estimatedPremium: 200_000 },
        { optionType: "put", expiration: "2026-10-30", estimatedPremium: 5_000_000 },
      ],
      "2026-10-06",
    );
    expect(summary.weekly.lean).toBe("alza");
    expect(summary.monthly.lean).toBe("baja");
    expect(summary.weekly.callContracts).toBe(1);
    expect(summary.monthly.putContracts).toBe(2);
  });
});
