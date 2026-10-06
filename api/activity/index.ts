import { listActivity } from "../../apps/api/src/neon.js";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pageSizeRaw = Number(url.searchParams.get("pageSize"));
  const pageSize = [25, 50, 100, 250].includes(pageSizeRaw) ? pageSizeRaw : 100;
  const page = Math.min(10_000, Math.max(1, Number(url.searchParams.get("page")) || 1));
  const order = url.searchParams.get("order") === "asc" ? "ASC" : "DESC";
  const order2 = url.searchParams.get("order2") === "desc" ? "DESC" : "ASC";
  const listingParam = url.searchParams.get("listing") ?? "all";
  const listing = listingParam === "sp500" || listingParam === "nasdaq" ? listingParam : "all";
  const q = (url.searchParams.get("q") ?? "").trim().toUpperCase().slice(0, 12);
  try {
    const listed = await listActivity({
      page,
      pageSize,
      sort: url.searchParams.get("sort") ?? "occurredAt",
      order,
      sort2: url.searchParams.get("sort2") ?? "",
      order2,
      listing,
      q,
    });
    return Response.json({
      page,
      pageSize,
      total: listed.total,
      sort: listed.sort,
      order: order.toLowerCase(),
      sort2: listed.sort2,
      order2: order2.toLowerCase(),
      listing,
      q,
      rows: listed.rows,
    });
  } catch {
    return Response.json({ error: "No pude leer los contratos." }, { status: 500 });
  }
}
