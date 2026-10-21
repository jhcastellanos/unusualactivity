import { countVisibleContracts, getLastUpdatedAt, getRemoteScan } from "../../apps/api/src/neon.js";
import directory from "../securities-directory.json" with { type: "json" };

export async function GET(): Promise<Response> {
  try {
    const activity = await countVisibleContracts();
    const lastUpdatedAt = await getLastUpdatedAt();
    const total = directory.length;
    const scan = await getRemoteScan(total);
    return Response.json({
      securityCount: total,
      provider: "Cboe delayed quotes",
      source: "cboe-delayed-quotes",
      activityCount: activity.count,
      lastOccurredAt: activity.last,
      lastUpdatedAt,
      scan: {
        running: scan.running,
        scanned: scan.scanned,
        total: scan.total,
        unusual: activity.count,
        errors: scan.errors,
        current: scan.current,
        startedAt: scan.startedAt,
        finishedAt: scan.finishedAt,
        source: "cboe-delayed-quotes",
        phase: scan.phase,
      },
    });
  } catch {
    return Response.json({ error: "No pude leer el estado." }, { status: 500 });
  }
}
