import { continueProductionSweep, scheduleProductionSweep } from "../../apps/api/src/production-sweep.js";

export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  try {
    const result = await continueProductionSweep();
    await scheduleProductionSweep(request, result);
    return Response.json(result);
  } catch {
    return Response.json({ running: false, error: "No pude seguir la actualización." }, { status: 500 });
  }
}
