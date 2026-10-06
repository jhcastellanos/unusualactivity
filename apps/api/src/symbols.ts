import type { SecurityRow } from "./db.js";

const NASDAQ_LISTED = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt";
const OTHER_LISTED = "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt";
const SP500 = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/master/data/constituents.csv";

const EXCHANGE_LABEL: Record<string, string> = {
  A: "NYSE American",
  N: "NYSE",
  P: "NYSE Arca",
  Z: "Cboe BZX",
  V: "IEX",
  Q: "NASDAQ",
  G: "NASDAQ",
  S: "NASDAQ",
};

type Draft = {
  ticker: string;
  companyName: string;
  exchange: string;
  assetType: string;
  inSp500: boolean;
  inNasdaq: boolean;
};

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": "unusualactivity-personal/0.1" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`No se pudo descargar ${url} (${response.status})`);
  }
  return response.text();
}

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("File Creation"));
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of line) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

export async function loadSecurityUniverse(): Promise<{ rows: SecurityRow[]; source: string }> {
  const [nasdaqText, otherText, sp500Text] = await Promise.all([
    fetchText(NASDAQ_LISTED),
    fetchText(OTHER_LISTED),
    fetchText(SP500),
  ]);

  const byTicker = new Map<string, Draft>();

  const otherLines = lines(otherText);
  for (const line of otherLines.slice(1)) {
    const [symbol, name, exchange, , etf, , testIssue] = line.split("|");
    if (!symbol || testIssue === "Y") continue;
    const ticker = symbol.trim().toUpperCase();
    byTicker.set(ticker, {
      ticker,
      companyName: (name ?? ticker).trim(),
      exchange: EXCHANGE_LABEL[exchange ?? ""] ?? exchange ?? "—",
      assetType: etf === "Y" ? "etf" : "stock",
      inSp500: false,
      inNasdaq: false,
    });
  }

  const nasdaqLines = lines(nasdaqText);
  for (const line of nasdaqLines.slice(1)) {
    const [symbol, name, category, testIssue, , , etf] = line.split("|");
    if (!symbol || testIssue === "Y") continue;
    const ticker = symbol.trim().toUpperCase();
    const existing = byTicker.get(ticker);
    byTicker.set(ticker, {
      ticker,
      companyName: (name ?? existing?.companyName ?? ticker).trim(),
      exchange: "NASDAQ",
      assetType: etf === "Y" ? "etf" : "stock",
      inSp500: existing?.inSp500 ?? false,
      inNasdaq: true,
    });
    void category;
  }

  const spLines = lines(sp500Text);
  for (const line of spLines.slice(1)) {
    const [symbol, security] = parseCsvLine(line);
    if (!symbol) continue;
    const ticker = symbol.trim().toUpperCase();
    const existing = byTicker.get(ticker);
    byTicker.set(ticker, {
      ticker,
      companyName: (existing?.companyName || security || ticker).trim(),
      exchange: existing?.exchange ?? "S&P 500",
      assetType: existing?.assetType ?? "stock",
      inSp500: true,
      inNasdaq: existing?.inNasdaq ?? false,
    });
  }

  const rows = [...byTicker.values()]
    .filter((row) => row.inSp500 || row.inNasdaq)
    .map((row) => ({
      ticker: row.ticker,
      companyName: row.companyName,
      exchange: row.exchange,
      assetType: row.assetType,
      inSp500: row.inSp500 ? 1 : 0,
      inNasdaq: row.inNasdaq ? 1 : 0,
    }))
    .sort((a, b) => a.ticker.localeCompare(b.ticker));

  if (rows.filter((row) => row.inSp500).length < 400) {
    throw new Error("El listado del S&P 500 llegó incompleto");
  }
  if (rows.filter((row) => row.inNasdaq).length < 1000) {
    throw new Error("El listado de NASDAQ llegó incompleto");
  }

  return {
    rows,
    source: `${NASDAQ_LISTED} + ${SP500}`,
  };
}
