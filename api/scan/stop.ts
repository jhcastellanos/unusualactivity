import { requestRemoteStop } from "../../apps/api/src/neon.js";

export async function POST(): Promise<Response> {
  try {
    const { online, running } = await requestRemoteStop();
    if (!running && !online) {
      return Response.json(
        { stopping: false, error: "El equipo que barre los activos está apagado." },
        { status: 409 },
      );
    }
    return Response.json({ stopping: running });
  } catch {
    return Response.json({ stopping: false, error: "No pude parar la actualización." }, { status: 500 });
  }
}
