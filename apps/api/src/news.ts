export type NewsItem = {
  title: string;
  summary: string | null;
  source: string;
  url: string;
  publishedAt: string;
};

export type NewsLean = "alza" | "baja" | "mixta" | "sin_direccion";

export type NewsRead = {
  lean: NewsLean;
  text: string;
};

export type TickerNews = {
  ticker: string;
  source: string;
  items: NewsItem[];
  read: NewsRead;
};

const POSITIVE = /\b(rise|rises|rose|rising|jump|jumped|growth|grew|beat|beats|record|upgrade|upgraded|strong|profit|gains|outperform|tops|subi[oó]|subieron|aument\w*|alza|crecimiento|r[eé]cord|mejora|fuerte|ganancias?)\b/i;
const NEGATIVE = /\b(miss|missed|fell|falls|fall|drop|dropped|downgrade|downgraded|cut|cuts|lawsuit|probe|recall|warning|weak|decline|declined|lower-margin|slump|plunge|below consensus|menor margen|ca[ií]d\w*|cayeron|recort\w*|advertenc\w*|deterior\w*|cautela)\b/i;

const cache = new Map<string, { at: number; value: TickerNews }>();
const CACHE_MS = 10 * 60 * 1000;

export function interpretHeadlines(items: Array<Pick<NewsItem, "title" | "summary">>): NewsRead {
  if (items.length === 0) {
    return { lean: "sin_direccion", text: "No hay notas recientes para este activo." };
  }
  const favorable = items.find((item) => hasCue(item, POSITIVE) && !hasCue(item, NEGATIVE));
  const caution = items.find((item) => hasCue(item, NEGATIVE));
  const lead = point(items[0]);
  if (favorable && caution) {
    const points = caution === favorable ? [lead] : [point(favorable), point(caution)];
    return {
      lean: "mixta",
      text: `La lectura que saco es mixta. ${points.join(" ")} Hay un dato que empuja y otro que pide no tomarlo completo.`,
    };
  }
  if (favorable || items.some((item) => hasCue(item, POSITIVE))) {
    return {
      lean: "alza",
      text: `La lectura que saco es de mejora. ${lead} Es lo que las notas están sosteniendo, no una proyección de precio.`,
    };
  }
  if (caution) {
    return {
      lean: "baja",
      text: `La lectura que saco es de cautela. ${point(caution)} La nota señala un deterioro o un aviso, no solo un titular neutro.`,
    };
  }
  return {
    lean: "sin_direccion",
    text: `Las notas no me dan una dirección. ${lead} Las dejo como contexto, sin convertirlas en una señal de alza o de baja.`,
  };
}

export function parseHeadlineRss(xml: string, limit = 6): NewsItem[] {
  const items: NewsItem[] = [];
  for (const block of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const title = tagText(block[1], "title");
    const url = tagText(block[1], "link");
    const published = tagText(block[1], "pubDate");
    if (!title || !url || !published) continue;
    const publishedAt = new Date(published);
    if (Number.isNaN(publishedAt.getTime())) continue;
    const summary = cleanSummary(tagText(block[1], "description"), title);
    items.push({
      title,
      summary,
      source: sourceFromUrl(url),
      url,
      publishedAt: publishedAt.toISOString(),
    });
  }
  items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return items.slice(0, limit);
}

export async function tickerNews(ticker: string, now = Date.now()): Promise<TickerNews> {
  const symbol = ticker.trim().toUpperCase();
  if (!/^[A-Z0-9.-]{1,12}$/.test(symbol)) {
    return { ticker: symbol, source: "Yahoo Finance", items: [], read: interpretHeadlines([]) };
  }
  const cached = cache.get(symbol);
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const value = await loadTickerNews(symbol);
  cache.set(symbol, { at: now, value });
  return value;
}

async function loadTickerNews(ticker: string): Promise<TickerNews> {
  const response = await fetch(
    `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`,
    { headers: { "User-Agent": "unusualactivity-personal/0.1" }, signal: AbortSignal.timeout(12_000) },
  );
  if (!response.ok) throw new Error(`news ${response.status}`);
  const items = await translateItems(parseHeadlineRss(await response.text()), ticker);
  return { ticker, source: "Yahoo Finance", items, read: interpretHeadlines(items) };
}

async function translateItems(items: NewsItem[], ticker: string): Promise<NewsItem[]> {
  const translated: NewsItem[] = [];
  for (const item of items) {
    const title = await translateToSpanish(item.title, ticker);
    const summary = item.summary ? await translateToSpanish(item.summary, ticker) : null;
    if (!title) continue;
    translated.push({ ...item, title, summary });
  }
  return translated;
}

async function translateToSpanish(text: string, ticker: string): Promise<string | null> {
  const source = shieldTicker(text.trim().slice(0, 450), ticker);
  if (!source) return null;
  const response = await fetch(
    `https://api.mymemory.translated.net/get?langpair=en|es&q=${encodeURIComponent(source)}`,
    { headers: { "User-Agent": "unusualactivity-personal/0.1" }, signal: AbortSignal.timeout(12_000) },
  );
  if (!response.ok) return null;
  const body = (await response.json()) as { responseStatus?: number; responseData?: { translatedText?: string } };
  const translated = body.responseData?.translatedText?.trim();
  if (body.responseStatus !== 200 || !translated || /MYMEMORY WARNING|INVALID/i.test(translated)) return null;
  return translated.replaceAll("ZZTICKERZZ", ticker);
}

function shieldTicker(text: string, ticker: string): string {
  if (!ticker) return text;
  return text.replace(new RegExp(`\\b${ticker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), "ZZTICKERZZ");
}

function hasCue(item: Pick<NewsItem, "title" | "summary">, pattern: RegExp): boolean {
  return pattern.test(`${item.title} ${item.summary ?? ""}`);
}

function point(item: Pick<NewsItem, "title" | "summary"> | undefined): string {
  const text = (item?.summary ?? item?.title ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

function tagText(block: string, name: string): string {
  const match = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return match ? decodeXml(match[1]) : "";
}

function decodeXml(value: string): string {
  const text = value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function cleanSummary(summary: string, title: string): string | null {
  if (!summary || summary === title) return null;
  return summary.length > 220 ? `${summary.slice(0, 217).trim()}…` : summary;
}

function sourceFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host === "finance.yahoo.com" || host.endsWith(".yahoo.com")) return "Yahoo Finance";
    if (host === "fool.com") return "Motley Fool";
    if (host.includes("barrons")) return "Barron's";
    if (host === "tikr.com") return "TIKR";
    if (host === "zacks.com") return "Zacks";
    return host;
  } catch {
    return "Yahoo Finance";
  }
}
