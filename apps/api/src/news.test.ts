import { describe, expect, it } from "vitest";
import { interpretHeadlines, parseHeadlineRss } from "./news.ts";

const rss = `<?xml version="1.0"?>
<rss><channel>
<item>
  <title>Costco's September Sales Rise 13% on Strong Comps</title>
  <link>https://finance.yahoo.com/markets/story</link>
  <pubDate>Thu, 08 Oct 2026 14:48:00 +0000</pubDate>
  <description>COST's September sales rose 13% to $30.02 billion.</description>
</item>
<item>
  <title>Costco’s Sales Rebound Looks Great on Paper</title>
  <link>https://www.barrons.com/articles/costco</link>
  <pubDate>Thu, 08 Oct 2026 14:13:00 +0000</pubDate>
  <description>A Wall Street analyst says part of that surge was fueled by lower-margin boosters.</description>
</item>
</channel></rss>`;

describe("parseHeadlineRss", () => {
  it("reads the newest headline first and keeps the article text", () => {
    const items = parseHeadlineRss(rss);
    expect(items).toHaveLength(2);
    expect(items[0]?.title).toContain("September Sales Rise");
    expect(items[0]?.source).toBe("Yahoo Finance");
    expect(items[1]?.source).toBe("Barron's");
    expect(items[0]?.summary).toContain("$30.02 billion");
  });
});

describe("interpretHeadlines", () => {
  it("calls a book mixed when the notes mention both a gain and a warning", () => {
    const read = interpretHeadlines(parseHeadlineRss(rss));
    expect(read.lean).toBe("mixta");
    expect(read.text).toContain("La lectura que saco es mixta");
    expect(read.text).toContain("$30.02 billion");
    expect(read.text).toContain("lower-margin");
  });

  it("keeps the same reading when the notes are already in Spanish", () => {
    const read = interpretHeadlines([
      { title: "Las ventas de septiembre subieron 13%", summary: "Las ventas llegaron a 30.020 millones." },
      { title: "El rebote se ve bien en el papel", summary: "Parte del salto vino de combustible de menor margen." },
    ]);
    expect(read.lean).toBe("mixta");
    expect(read.text).toContain("30.020 millones");
    expect(read.text).toContain("menor margen");
  });

  it("does not invent a direction when the notes are quiet", () => {
    const read = interpretHeadlines([
      { title: "Company schedules its annual meeting", summary: "Shareholders will vote next month." },
    ]);
    expect(read.lean).toBe("sin_direccion");
  });
});
