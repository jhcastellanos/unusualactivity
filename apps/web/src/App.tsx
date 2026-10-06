import { useEffect, useState } from "react";
import { useHostedBoard } from "./hosted";

type Listing = "all" | "sp500" | "nasdaq";
type Order = "asc" | "desc";

type Scan = {
  running: boolean;
  scanned: number;
  total: number;
  unusual: number;
  errors: number;
  current?: string[];
};

type Status = {
  provider: string;
  activityCount: number;
  lastOccurredAt: string | null;
  lastUpdatedAt?: string | null;
  scan: Scan;
};

type Contract = {
  id: number;
  optionSymbol: string;
  occurredAt: string | null;
  ticker: string;
  optionType: "call" | "put";
  direction: "UNKNOWN";
  strike: number | null;
  expiration: string | null;
  dte: number | null;
  volume: number | null;
  openInterest: number | null;
  volumeOiRatio: number | null;
  bid: number | null;
  ask: number | null;
  last: number | null;
  underlyingPrice: number | null;
  estimatedPremium: number | null;
};

type PageState = {
  q: string;
  page: number;
  pageSize: number;
  sort: string;
  order: Order;
  listing: Listing;
};

const PAGE_SIZES = [25, 50, 100, 250];
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function readState(): PageState {
  const url = new URL(window.location.href);
  const pageSize = Number(url.searchParams.get("pageSize") ?? 100);
  const listing = url.searchParams.get("listing");
  const order = url.searchParams.get("order") === "asc" ? "asc" : "desc";
  return {
    q: url.searchParams.get("q") ?? "",
    page: Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1),
    pageSize: PAGE_SIZES.includes(pageSize) ? pageSize : 100,
    sort: url.searchParams.get("sort") ?? "occurredAt",
    order,
    listing: listing === "sp500" || listing === "nasdaq" ? listing : "all",
  };
}

function writeUrl(state: PageState) {
  const params = new URLSearchParams();
  if (state.q) params.set("q", state.q);
  if (state.page > 1) params.set("page", String(state.page));
  if (state.pageSize !== 100) params.set("pageSize", String(state.pageSize));
  if (state.listing !== "all") params.set("listing", state.listing);
  if (state.sort !== "occurredAt") params.set("sort", state.sort);
  if (state.order !== "desc") params.set("order", state.order);
  const next = `/${params.size ? `?${params}` : ""}`;
  if (`${window.location.pathname}${window.location.search}` === next) return;
  window.history.pushState(null, "", next);
}

function formatOccurred(value: string | null): string {
  if (!value) return "—";
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return value;
  const seconds = match[6] ?? "00";
  return `${match[4]}:${match[5]}:${seconds} · ${Number(match[3])} ${MONTHS[Number(match[2]) - 1]}`;
}

function formatExpiration(value: string | null): string {
  if (!value) return "—";
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value;
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}

function formatNumber(value: number | null): string {
  if (value == null) return "—";
  return new Intl.NumberFormat("en-US").format(value);
}

function formatPrice(value: number | null): string {
  if (value == null) return "—";
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatRatio(value: number | null): string {
  if (value == null) return "—";
  return `${value.toFixed(1)}x`;
}

function formatMoney(value: number | null): string {
  if (value == null) return "—";
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export function App() {
  const [state, setState] = useState<PageState>(readState);
  const [draft, setDraft] = useState(state.q);
  const [status, setStatus] = useState<Status | null>(null);
  const [rows, setRows] = useState<Contract[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bias, setBias] = useState<Bias | null>(null);
  const hosted = import.meta.env.PROD;
  const hostedBoard = useHostedBoard(hosted, state);

  useEffect(() => {
    const onPop = () => {
      const next = readState();
      setState(next);
      setDraft(next.q);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      if (draft === state.q) return;
      const next = { ...state, q: draft.toUpperCase(), page: 1 };
      setState(next);
      writeUrl(next);
    }, 300);
    return () => window.clearTimeout(handle);
  }, [draft, state]);

  useEffect(() => {
    if (!state.q) {
      setBias(null);
      return;
    }
    let ignore = false;
    const load = () => {
      fetch(`/api/activity/bias?ticker=${encodeURIComponent(state.q)}`)
        .then((response) => {
          if (!response.ok) throw new Error("bias");
          return response.json();
        })
        .then((body: Bias) => {
          if (!ignore) setBias(body);
        })
        .catch(() => {
          if (!ignore) setBias(null);
        });
    };
    load();
    const timer = window.setInterval(load, 10_000);
    return () => {
      ignore = true;
      window.clearInterval(timer);
    };
  }, [state.q]);

  useEffect(() => {
    if (hosted) return;
    const controller = new AbortController();
    const load = () => {
      fetch("/api/system/data-status", { signal: controller.signal })
        .then((response) => response.json())
        .then(setStatus)
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 2000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [hosted]);

  useEffect(() => {
    if (hosted) return;
    let ignore = false;
    const load = () => {
      const params = new URLSearchParams({
        page: String(state.page),
        pageSize: String(state.pageSize),
        sort: state.sort,
        order: state.order,
        listing: state.listing,
        q: state.q,
      });
      fetch(`/api/activity?${params}`)
        .then((response) => {
          if (!response.ok) throw new Error("api");
          return response.json();
        })
        .then((body: { rows: Contract[]; total: number }) => {
          if (ignore) return;
          const lastPage = Math.max(1, Math.ceil(body.total / state.pageSize));
          if (state.page > lastPage) {
            const next = { ...state, page: 1 };
            setState(next);
            writeUrl(next);
            return;
          }
          setRows(body.rows);
          setTotal(body.total);
          setLoading(false);
          setError(null);
        })
        .catch(() => {
          if (ignore) return;
          setError("No pude cargar los contratos.");
          setLoading(false);
        });
    };
    load();
    const timer = window.setInterval(load, 5000);
    return () => {
      ignore = true;
      window.clearInterval(timer);
    };
  }, [hosted, state]);

  useEffect(() => {
    if (!hostedBoard) return;
    const lastPage = Math.max(1, Math.ceil(hostedBoard.total / state.pageSize));
    if (state.page > lastPage) {
      const next = { ...state, page: 1 };
      setState(next);
      writeUrl(next);
    }
  }, [hostedBoard?.total, state]);

  function update(partial: Partial<PageState>) {
    const next = { ...state, ...partial };
    setState(next);
    if (partial.q != null) setDraft(partial.q);
    writeUrl(next);
  }

  function sortBy(column: string) {
    const order: Order = state.sort === column && state.order === "desc" ? "asc" : "desc";
    update({ sort: column, order, page: 1 });
  }

  const shownRows = hostedBoard?.rows ?? rows;
  const shownTotal = hostedBoard?.total ?? total;
  const shownLoading = hostedBoard?.loading ?? loading;
  const shownError = hostedBoard?.error ?? error;
  const shownStatus = hostedBoard?.status ?? status;
  const pageCount = Math.max(1, Math.ceil(shownTotal / state.pageSize));
  const start = shownTotal === 0 ? 0 : (state.page - 1) * state.pageSize + 1;
  const end = Math.min(shownTotal, state.page * state.pageSize);
  const scan = shownStatus?.scan;

  return (
    <div className="app">
      <header className="top">
        <div>
          <p className="eyebrow">Options Flow</p>
          <h1>Contratos inusuales</h1>
            <p className="note">
            Contratos inusuales con prima de al menos $500,000, open interest mayor que cero y último trade de como máximo 6 meses.
            Si la fecha de expiración ya pasó, el contrato no aparece. Cada 5 minutos se buscan trades nuevos desde la última actualización.
          </p>
        </div>
        <dl className="status">
          <div>
            <dt>Proveedor</dt>
            <dd>Cboe delayed</dd>
          </div>
          <div>
            <dt>Contratos</dt>
            <dd>{shownTotal.toLocaleString("en-US")}</dd>
          </div>
          <div>
            <dt>Actualización</dt>
            <dd>{formatOccurred(shownStatus?.lastUpdatedAt ?? null)}</dd>
          </div>
          <div>
            <dt>Último trade</dt>
            <dd>{formatOccurred(shownStatus?.lastOccurredAt ?? null)}</dd>
          </div>
        </dl>
      </header>

      <ScanProgress scan={scan} />

      <nav className="switch" aria-label="Universo">
        <button type="button" className={state.listing === "all" ? "on" : ""} onClick={() => update({ listing: "all", page: 1 })}>Todos</button>
        <button type="button" className={state.listing === "sp500" ? "on" : ""} onClick={() => update({ listing: "sp500", page: 1 })}>S&P 500</button>
        <button type="button" className={state.listing === "nasdaq" ? "on" : ""} onClick={() => update({ listing: "nasdaq", page: 1 })}>NASDAQ</button>
      </nav>

      <form className="search" onSubmit={(event) => event.preventDefault()} role="search">
        <label htmlFor="q">Filtrar ticker</label>
        <input id="q" value={draft} autoComplete="off" placeholder="AAPL" onChange={(event) => setDraft(event.target.value.toUpperCase())} />
        {draft && <button type="button" className="clear" onClick={() => update({ q: "", page: 1 })}>Limpiar</button>}
      </form>

      <FlowRead ticker={state.q} bias={state.q ? bias : null} />

      {shownError && <p className="banner">{shownError}</p>}

      <section className="panel" aria-busy={shownLoading}>
        <div className="panel-head">
          <p>{shownTotal === 0 ? "0 contratos" : `${start.toLocaleString("en-US")}–${end.toLocaleString("en-US")} de ${shownTotal.toLocaleString("en-US")}`}</p>
          <label>
            Filas
            <select value={state.pageSize} onChange={(event) => update({ pageSize: Number(event.target.value), page: 1 })}>
              {PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <Sortable label="Hora" column="occurredAt" sort={state.sort} order={state.order} onSort={sortBy} />
                <Sortable label="Ticker" column="ticker" sort={state.sort} order={state.order} onSort={sortBy} />
                <Sortable label="Tipo" column="optionType" sort={state.sort} order={state.order} onSort={sortBy} />
                <Sortable label="Strike" column="strike" sort={state.sort} order={state.order} onSort={sortBy} />
                <Sortable label="Expiración" column="expiration" sort={state.sort} order={state.order} onSort={sortBy} />
                <Sortable label="DTE" column="dte" sort={state.sort} order={state.order} onSort={sortBy} />
                <Sortable label="Volumen" column="volume" sort={state.sort} order={state.order} onSort={sortBy} />
                <Sortable label="OI" column="openInterest" sort={state.sort} order={state.order} onSort={sortBy} />
                <Sortable label="Vol/OI" column="volumeOiRatio" sort={state.sort} order={state.order} onSort={sortBy} />
                <Sortable label="Premium" column="estimatedPremium" sort={state.sort} order={state.order} onSort={sortBy} />
              </tr>
            </thead>
            <tbody>
              {shownRows.map((row) => (
                <tr key={row.id}>
                  <td className="when" title="Último trade de este contrato, hora del Este">{formatOccurred(row.occurredAt)}</td>
                  <td className="ticker">
                    <button type="button" className="ticker-btn" onClick={() => update({ q: row.ticker, page: 1 })}>
                      {row.ticker}
                    </button>
                  </td>
                  <td className={row.optionType}>{row.optionType === "call" ? "CALL" : "PUT"}</td>
                  <td className="num">{formatPrice(row.strike)}</td>
                  <td>{formatExpiration(row.expiration)}</td>
                  <td className="num">{row.dte ?? "—"}</td>
                  <td className="num">{formatNumber(row.volume)}</td>
                  <td className="num">{formatNumber(row.openInterest)}</td>
                  <td className="num">{formatRatio(row.volumeOiRatio)}</td>
                  <td className="num money" title="Volumen del día × precio de la opción × 100">{formatMoney(row.estimatedPremium)}</td>
                </tr>
              ))}
              {shownRows.length === 0 && (
                <tr>
                  <td colSpan={10} className="empty">
                    {shownLoading || scan?.running
                      ? "Cargando contratos inusuales abiertos de al menos $500,000."
                      : "Ningún contrato abierto de al menos $500,000 con un trade de los últimos 6 meses."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="pager">
          <button type="button" disabled={state.page <= 1} onClick={() => update({ page: state.page - 1 })}>Anterior</button>
          <span>Página {Math.min(state.page, pageCount)} de {pageCount.toLocaleString("en-US")}</span>
          <button type="button" disabled={state.page >= pageCount} onClick={() => update({ page: state.page + 1 })}>Siguiente</button>
        </div>
      </section>
    </div>
  );
}

type BiasWindow = {
  lean: "alza" | "baja" | "neutral" | "sin_flujo";
  callPremium: number;
  putPremium: number;
  callContracts: number;
  putContracts: number;
};

type Bias = {
  ticker: string;
  underlyingPrice: number | null;
  weekly: BiasWindow;
  monthly: BiasWindow;
};

const LEAN_LABEL: Record<BiasWindow["lean"], string> = {
  alza: "Alza",
  baja: "Baja",
  neutral: "Neutral",
  sin_flujo: "Sin flujo",
};

function FlowRead({ ticker, bias }: { ticker: string; bias: Bias | null }) {
  if (!ticker) {
    return <p className="bias-prompt">Elige un ticker para ver si el flujo abierto se inclina a alza, baja o neutral en la semana y en el mes.</p>;
  }
  if (!bias || bias.ticker !== ticker) {
    return <p className="bias-prompt">Leyendo el flujo abierto de {ticker}.</p>;
  }
  return (
    <section className="bias" aria-label={`Sesgo de ${ticker}`}>
      <FlowCard title="Semanal" horizon="en los próximos 7 días" window={bias.weekly} />
      <FlowCard title="Mensual" horizon="en los próximos 31 días" window={bias.monthly} />
      <p className="bias-note">
        {`${ticker}${bias.underlyingPrice != null ? ` · subyacente ${formatPrice(bias.underlyingPrice)}` : ""}. El sesgo es el peso de la prima inusual que sigue abierta, no una probabilidad de que el precio llegue ahí. No se distingue si el trade se compró o se vendió.`}
      </p>
    </section>
  );
}

function FlowCard({ title, horizon, window }: { title: string; horizon: string; window: BiasWindow }) {
  const contracts = window.callContracts + window.putContracts;
  return (
    <article>
      <p className="bias-kicker">{title}</p>
      <p className={`lean ${window.lean}`}>{LEAN_LABEL[window.lean]}</p>
      <p className="bias-detail">
        {window.lean === "sin_flujo"
          ? `No hay contratos inusuales abiertos que venzan ${horizon}.`
          : `${formatMoney(window.callPremium)} en calls (${window.callContracts}) y ${formatMoney(window.putPremium)} en puts (${window.putContracts}). ${contracts} contratos que vencen ${horizon}.`}
      </p>
    </article>
  );
}

function ScanProgress({ scan }: { scan: Scan | undefined }) {
  const scanned = scan?.scanned ?? 0;
  const total = scan?.total ?? 0;
  const done = total > 0 ? Math.min(100, (scanned / total) * 100) : 0;
  const remaining = total > 0 ? Math.max(0, 100 - done) : 0;
  const current = scan?.current ?? [];
  const running = Boolean(scan?.running);
  const label = !scan
    ? "Esperando el barrido"
    : running
      ? current.length > 0
        ? `Barriendo ${current.join(", ")}`
        : "Barriendo"
      : "Barrido listo";
  const remainingLabel = total > 0 ? `falta ${remaining.toLocaleString("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 })}%` : "—";

  return (
    <section className="progress" aria-label="Progreso del barrido">
      <div className="progress-top">
        <span>{label}</span>
        <strong>{remainingLabel}</strong>
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(done)}
        aria-valuetext={`${label}. ${remainingLabel}`}
      >
        <div className="progress-fill" style={{ width: `${done}%` }} />
      </div>
      <div className="progress-meta">
        <span>{scanned.toLocaleString("en-US")} / {total.toLocaleString("en-US")} activos</span>
        <span>extraído {done.toLocaleString("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 })}%</span>
      </div>
    </section>
  );
}

function Sortable({
  label,
  column,
  sort,
  order,
  onSort,
}: {
  label: string;
  column: string;
  sort: string;
  order: Order;
  onSort: (column: string) => void;
}) {
  const active = sort === column;
  return (
    <th>
      <button type="button" onClick={() => onSort(column)}>
        {label}
        {active ? (order === "desc" ? " ↓" : " ↑") : ""}
      </button>
    </th>
  );
}
