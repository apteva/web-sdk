import { useEffect, useState } from "react";
import { Inbox, RefreshCw } from "lucide-react";
import { ApteveError } from "@apteva/web-sdk";
import { apteva, LEADS_TABLE, TABLES_APP } from "../lib/apteva";
import type { Lead, RowsSearchResult } from "../lib/types";
import { relativeTime } from "../lib/format";

const STATUS_STYLE: Record<string, string> = {
  new:       "bg-[var(--color-accent-light)] text-[var(--color-accent)]",
  contacted: "bg-[var(--color-amber-light)] text-[var(--color-amber)]",
  qualified: "bg-[var(--color-green-light)] text-[var(--color-green)]",
  won:       "bg-[var(--color-green-light)] text-[var(--color-green)]",
  lost:      "bg-[var(--color-slate-light)] text-[var(--color-slate)]",
};

function statusClass(status: string | undefined): string {
  return STATUS_STYLE[status ?? ""] ?? STATUS_STYLE.new!;
}

export function LeadsCard() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await apteva.app(TABLES_APP).tool<RowsSearchResult>("rows_search", {
        table: LEADS_TABLE,
        order_by: [{ col: "created_at", dir: "desc" }],
        limit: 25,
      });
      setLeads((r.rows ?? []).map(rowToLead));
    } catch (err) {
      const msg = explainError(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  return (
    <section className="surface p-5 space-y-4">
      <header className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <h2 className="text-sm font-semibold t-primary">Recent leads</h2>
            {leads.length > 0 && (
              <span className="text-[11px] t-tertiary">{leads.length} shown</span>
            )}
          </div>
          <p className="text-xs t-tertiary mt-0.5 truncate">
            From <code className="font-mono">{LEADS_TABLE}</code> · newest first
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="btn-ghost flex items-center gap-1.5 shrink-0"
          aria-label="Refresh leads"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          Refresh
        </button>
      </header>

      {error ? (
        <div className="text-xs text-[var(--color-red)] bg-[var(--color-red-light)] rounded-lg px-3 py-2">
          {error}
        </div>
      ) : loading && leads.length === 0 ? (
        <div className="text-xs t-tertiary py-8 text-center">Loading…</div>
      ) : leads.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 t-tertiary">
          <Inbox size={28} />
          <p className="text-xs">No leads yet.</p>
        </div>
      ) : (
        <ul className="divide-y divide-[var(--color-border)] -mx-2">
          {leads.map((lead, i) => (
            <li
              key={lead.id ?? i}
              className="px-2 py-3 flex items-center gap-3 hover:bg-[var(--color-bg)] transition-colors rounded-md -mx-1 px-3"
            >
              <div className="avatar" aria-hidden>
                {initials(lead.name)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <div className="text-sm font-medium t-primary truncate">
                    {lead.name || "(no name)"}
                  </div>
                  {lead.created_at && (
                    <div className="text-[11px] t-tertiary whitespace-nowrap">
                      {relativeTime(lead.created_at)}
                    </div>
                  )}
                </div>
                <div className="text-xs t-secondary truncate mt-0.5">
                  {lead.email || lead.phone || "—"}
                  {lead.source && (
                    <span className="t-tertiary"> · {lead.source}</span>
                  )}
                </div>
              </div>
              {lead.status && (
                <span className={`pill ${statusClass(lead.status)} shrink-0`}>{lead.status}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// Coerce a generic row (Record<string, unknown>) into the Lead shape
// the UI renders. Unknown columns are ignored; missing columns default
// to "" / undefined so the card stays robust against schema drift.
function rowToLead(row: Record<string, unknown>): Lead {
  return {
    id: typeof row.id === "number" ? row.id : Number(row.id ?? 0),
    name: str(row.name),
    email: str(row.email),
    phone: str(row.phone),
    source: str(row.source),
    status: str(row.status) as Lead["status"],
    notes: str(row.notes),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}
function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function explainError(err: unknown): string {
  if (err instanceof ApteveError) {
    if (err.status === 404) {
      return `The "${TABLES_APP}" app isn't installed on this server.`;
    }
    // The tables app returns a JSON-RPC error when the table doesn't
    // exist; surface it directly so the user knows what to fix.
    if (err.status === -1) {
      return `Table "${LEADS_TABLE}" not found in ${TABLES_APP}. Create it first, or set LEADS_TABLE at build time.`;
    }
    return err.body || `error ${err.status}`;
  }
  return "failed to load leads";
}
