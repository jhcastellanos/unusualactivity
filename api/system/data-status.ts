import { countVisibleContracts, getLastUpdatedAt } from "../../apps/api/src/neon.js";
import directory from "../securities-directory.json" with { type: "json" };

export async function GET(): Promise<Response> {
  try {
    const activity = await countVisibleContracts();
    const lastUpdatedAt = await getLastUpdatedAt();
    const total = directory.length;
    return Response.json({
      securityCount: total,
      provider: "Cboe delayed quotes",
      source: "cboe-delayed-quotes",
      activityCount: activity.count,
      lastOccurredAt: activity.last,
      lastUpdatedAt,
      scan: {
        running: false,
        scanned: total,
        total,
        unusual: activity.count,
        errors: 0,
        current: [],
        startedAt: null,
        finishedAt: null,
        source: "cboe-delayed-quotes",
        phase: "saved",
      },
    });
  } catch {
    return Response.json({ error: "No pude leer el estado." }, { status: 500 });
  }
}
