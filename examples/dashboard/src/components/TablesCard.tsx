import { useEffect, useState } from "react";
import { Database, RefreshCw, Table as TableIcon } from "lucide-react";
import { AptevaError } from "@apteva/web-sdk";
import { apteva, TABLES_APP } from "../lib/apteva";
import type { RowsSearchResult, TableSummary, TablesListResult } from "../lib/types";
import { formatDateTime } from "../lib/format";

export function TablesCard() {
  const [tables, setTables] = useState<TableSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [rows, setRows] = useState<Array<Record<string, unknown>> | null>(null);
  const [tablesLoading, setTablesLoading] = useState(true);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshTables = async () => {
    setTablesLoading(true);
    setError(null);
    try {
      const r = await apteva
        .app(TABLES_APP)
        .tool<TablesListResult>("tables_list", {});
      setTables(r.tables ?? []);
      if (!selected && r.tables?.length) setSelected(r.tables[0]!.name);
    } catch (err) {
      const msg =
        err instanceof AptevaError
          ? err.status === 404
            ? `The "${TABLES_APP}" app isn't installed on this server.`
            : err.body || `error ${err.status}`
          : "failed to load tables";
      setError(msg);
    } finally {
      setTablesLoading(false);
    }
  };

  useEffect(() => {
    refreshTables();
    // refreshTables is intentionally stable for the lifetime of the component
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selected) {
      setRows(null);
      return;
    }
    let cancelled = false;
    setRowsLoading(true);
    apteva
      .app(TABLES_APP)
      .tool<RowsSearchResult>("rows_search", { table: selected, limit: 20 })
      .then((r) => {
        if (!cancelled) setRows(r.rows ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        const msg =
          err instanceof AptevaError ? err.body || `error ${err.status}` : "failed to load rows";
        setError(msg);
        setRows([]);
      })
      .finally(() => {
        if (!cancelled) setRowsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const selectedTable = tables.find((t) => t.name === selected);

  return (
    <section className="surface p-5 space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold t-primary">Tables</h2>
          <p className="text-xs t-tertiary mt-0.5">From {TABLES_APP}</p>
        </div>
        <button
          type="button"
          onClick={refreshTables}
          disabled={tablesLoading}
          className="btn-ghost flex items-center gap-1.5"
        >
          <RefreshCw size={14} className={tablesLoading ? "animate-spin" : ""} />
          Refresh
        </button>
      </header>

      {error && (
        <div className="text-xs text-[var(--color-red)] bg-[var(--color-red-light)] rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {tables.length === 0 && !tablesLoading && !error && (
        <div className="flex flex-col items-center gap-2 py-10 t-tertiary">
          <Database size={28} />
          <p className="text-xs">No tables yet.</p>
        </div>
      )}

      {tables.length > 0 && (
        <div className="grid grid-cols-[180px_1fr] gap-4">
          <ul className="space-y-1">
            {tables.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => setSelected(t.name)}
                  className={
                    "w-full text-left px-2.5 py-2 rounded-md flex items-start gap-2 transition-colors " +
                    (t.name === selected
                      ? "bg-[var(--color-accent-light)] text-[var(--color-accent)]"
                      : "hover:bg-[var(--color-slate-light)] t-primary")
                  }
                >
                  <TableIcon size={14} className="mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-xs font-medium truncate">{t.name}</div>
                    <div className="text-[11px] t-tertiary mt-0.5">
                      {t.row_count} row{t.row_count === 1 ? "" : "s"}
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>

          <div className="min-w-0">
            {selectedTable && rows ? (
              <RowsList cols={selectedTable.columns} rows={rows} loading={rowsLoading} />
            ) : (
              <div className="text-xs t-tertiary py-6 text-center surface-inset">
                {rowsLoading ? "Loading rows…" : "Select a table to view rows."}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

interface RowsListProps {
  cols: TableSummary["columns"];
  rows: Array<Record<string, unknown>>;
  loading: boolean;
}

// Field heuristics — which columns get special treatment in the card
// view. Pure rendering hints; the underlying schema is unchanged.
const TITLE_KEYS = ["name", "title", "label", "subject", "email"];
const PILL_KEYS = ["status", "state", "stage", "type"];
const HIDDEN_KEYS = new Set(["id", "created_at", "updated_at"]);

function pickTitleCol(cols: TableSummary["columns"]): string | null {
  for (const k of TITLE_KEYS) if (cols.some((c) => c.name === k)) return k;
  const firstText = cols.find((c) => c.type === "text" && c.name !== "id");
  return firstText?.name ?? null;
}

function pickPillCol(cols: TableSummary["columns"]): string | null {
  for (const k of PILL_KEYS) if (cols.some((c) => c.name === k)) return k;
  return null;
}

const PILL_STYLES: Record<string, string> = {
  new:       "bg-[var(--color-accent-light)] text-[var(--color-accent)]",
  contacted: "bg-[var(--color-amber-light)] text-[var(--color-amber)]",
  qualified: "bg-[var(--color-green-light)] text-[var(--color-green)]",
  won:       "bg-[var(--color-green-light)] text-[var(--color-green)]",
  lost:      "bg-[var(--color-slate-light)] text-[var(--color-slate)]",
};

function RowsList({ cols, rows, loading }: RowsListProps) {
  if (rows.length === 0 && !loading) {
    return (
      <div className="text-xs t-tertiary py-6 text-center surface-inset">
        No rows in this table.
      </div>
    );
  }
  const titleCol = pickTitleCol(cols);
  const pillCol = pickPillCol(cols);
  const detailCols = cols.filter(
    (c) => !HIDDEN_KEYS.has(c.name) && c.name !== titleCol && c.name !== pillCol,
  );

  return (
    <div className="space-y-2">
      {rows.map((row, i) => {
        const id = row.id;
        const title = titleCol ? renderCell(row[titleCol], colType(cols, titleCol)) : "";
        const pill = pillCol ? String(row[pillCol] ?? "") : "";
        const createdAt = row.created_at;

        return (
          <div
            key={typeof id === "number" ? id : i}
            className="surface-inset p-3 space-y-2 hover:bg-[var(--color-bg)] transition-colors"
          >
            <div className="flex items-center gap-2">
              {id !== undefined && id !== null && (
                <span className="font-mono text-[10px] t-tertiary px-1.5 py-0.5 rounded bg-[var(--color-slate-light)]">
                  #{String(id)}
                </span>
              )}
              {title && (
                <span className="text-sm font-medium t-primary truncate flex-1">{title}</span>
              )}
              {pill && (
                <span
                  className={`pill ${PILL_STYLES[pill.toLowerCase()] ?? "bg-[var(--color-slate-light)] text-[var(--color-slate)]"}`}
                >
                  {pill}
                </span>
              )}
            </div>

            {detailCols.length > 0 && (
              <dl className="grid grid-cols-[80px_1fr] gap-x-3 gap-y-1 text-xs">
                {detailCols.map((c) => (
                  <FieldRow key={c.name} label={c.name} value={renderCell(row[c.name], c.type)} />
                ))}
              </dl>
            )}

            {createdAt !== undefined && createdAt !== null && (
              <div className="text-[11px] t-tertiary pt-1 border-t border-[var(--color-border)]">
                {renderCell(createdAt, "datetime")}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function FieldRow({ label, value }: { label: string; value: string }) {
  if (value === "—") return null;
  return (
    <>
      <dt className="t-tertiary truncate">{label}</dt>
      <dd className="t-primary truncate" title={value}>
        {value}
      </dd>
    </>
  );
}

function colType(cols: TableSummary["columns"], name: string): string | undefined {
  return cols.find((c) => c.name === name)?.type;
}

function renderCell(v: unknown, type?: string): string {
  if (v === null || v === undefined || v === "") return "—";
  if (type === "datetime" || type === "date" || type === "timestamp") {
    const f = formatDateTime(v);
    if (f) return f;
  }
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
