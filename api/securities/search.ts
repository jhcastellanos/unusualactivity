import directory from "../securities-directory.json" with { type: "json" };

type Security = {
  ticker: string;
  companyName: string;
  exchange: string;
  inSp500: number;
  inNasdaq: number;
};

const securities = directory as Security[];

export function GET(request: Request): Response {
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 40);
  if (q.length < 1) return Response.json({ rows: [] });
  const upper = q.toUpperCase();
  const folded = q.toLowerCase();
  const ranked: Array<{ rank: number; row: Security }> = [];
  for (const row of securities) {
    const ticker = row.ticker.toUpperCase();
    const company = row.companyName.toLowerCase();
    let rank = -1;
    if (ticker === upper) rank = 0;
    else if (ticker.startsWith(upper)) rank = 1;
    else if (company.startsWith(folded)) rank = 2;
    else if (q.length >= 4 && company.includes(folded)) rank = 3;
    if (rank >= 0) ranked.push({ rank, row });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.row.ticker.localeCompare(b.row.ticker));
  return Response.json({ rows: ranked.slice(0, 8).map((item) => item.row) });
}
