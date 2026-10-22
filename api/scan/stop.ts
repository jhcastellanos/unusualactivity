import { stopProductionSweep } from "../../apps/api/src/production-sweep.js";

export async function POST(): Promise<Response> {
  try {
    const stopping = await stopProductionSweep();
    if (!stopping) return Response.json({ stopping: false });
    return Response.json({ stopping: true });
  } catch {
    return Response.json({ stopping: false, error: "No pude parar la actualización." }, { status: 500 });
  }
}
