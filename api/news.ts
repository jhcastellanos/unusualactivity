import { tickerNews } from "../apps/api/src/news.js";

export async function GET(request: Request): Promise<Response> {
  const ticker = new URL(request.url).searchParams.get("ticker") ?? "";
  try {
    return Response.json(await tickerNews(ticker));
  } catch {
    return Response.json({ error: "No pude leer las noticias." }, { status: 500 });
  }
}
