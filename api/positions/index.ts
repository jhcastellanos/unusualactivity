import { addPosition, isPositionSymbol, listPositions } from "../../apps/api/src/neon.js";

export async function GET(): Promise<Response> {
  try {
    return Response.json({ rows: await listPositions() });
  } catch {
    return Response.json({ error: "No pude leer tus operativas." }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as { optionSymbol?: string };
    const optionSymbol = (body.optionSymbol ?? "").trim().toUpperCase();
    if (!isPositionSymbol(optionSymbol)) return Response.json({ error: "Ese contrato no es válido." }, { status: 400 });
    const result = await addPosition(optionSymbol);
    if (result === "missing") return Response.json({ error: "Ese contrato no está en la lista guardada." }, { status: 404 });
    return Response.json({ added: result === "added", optionSymbol });
  } catch {
    return Response.json({ error: "No pude guardar el contrato." }, { status: 500 });
  }
}
