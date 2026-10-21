import { isPositionSymbol, removePosition } from "../../apps/api/src/neon.js";

export async function DELETE(request: Request): Promise<Response> {
  const optionSymbol = decodeURIComponent(new URL(request.url).pathname.split("/").pop() ?? "").trim().toUpperCase();
  if (!isPositionSymbol(optionSymbol)) return Response.json({ error: "Ese contrato no es válido." }, { status: 400 });
  try {
    const removed = await removePosition(optionSymbol);
    if (!removed) return Response.json({ error: "Ese contrato no está en tus operativas." }, { status: 404 });
    return Response.json({ removed: true, optionSymbol });
  } catch {
    return Response.json({ error: "No pude quitar el contrato." }, { status: 500 });
  }
}
