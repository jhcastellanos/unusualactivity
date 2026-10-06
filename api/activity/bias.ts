import { tickerFlow } from "../../apps/api/src/neon.js";

export async function GET(request: Request): Promise<Response> {
  const ticker = (new URL(request.url).searchParams.get("ticker") ?? "").trim().toUpperCase().slice(0, 12);
  if (!/^[A-Z0-9.-]{1,12}$/.test(ticker)) {
    return Response.json({
      ticker,
      underlyingPrice: null,
      weekly: emptyWindow(),
      monthly: emptyWindow(),
    });
  }
  try {
    return Response.json(await tickerFlow(ticker));
  } catch {
    return Response.json({ error: "No pude leer el sesgo." }, { status: 500 });
  }
}

function emptyWindow() {
  return { lean: "sin_flujo", callPremium: 0, putPremium: 0, callContracts: 0, putContracts: 0 };
}
