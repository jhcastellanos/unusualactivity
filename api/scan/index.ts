import { scheduleProductionSweep, startProductionSweep } from "../../apps/api/src/production-sweep.js";

export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  try {
    const result = await startProductionSweep();
    await scheduleProductionSweep(request, result);
    return Response.json({
      started: result.started,
      running: result.running,
      busy: result.busy,
      scanned: result.scanned,
      total: result.total,
      message: result.busy ? "Ya hay una actualización en curso." : undefined,
    });
  } catch {
    return Response.json({ started: false, running: false, error: "No pude iniciar la actualización." }, { status: 500 });
  }
}
