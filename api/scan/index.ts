import { requestRemoteSweep } from "../../apps/api/src/neon.js";

export async function POST(): Promise<Response> {
  try {
    const { online, running } = await requestRemoteSweep();
    if (running) {
      return Response.json({
        started: false,
        running: true,
        busy: false,
        message: "Ya hay una actualización en curso.",
      });
    }
    return Response.json({
      started: true,
      running: false,
      requested: true,
      message: online
        ? "Actualización pedida. Arranca en el equipo que barre los activos."
        : "Dejé pedida la actualización. Enciende el equipo que barre los activos para que arranque.",
    });
  } catch {
    return Response.json({ started: false, running: false, error: "No pude pedir la actualización." }, { status: 500 });
  }
}
