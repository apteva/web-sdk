import { LogOut, Sparkles } from "lucide-react";
import type { User } from "@apteva/web-sdk";
import { LeadsCard } from "../components/LeadsCard";
import { TablesCard } from "../components/TablesCard";
import { ChatCard } from "../components/ChatCard";

interface Props {
  user: User;
  onLogout: () => void;
}

export function Dashboard({ user, onLogout }: Props) {
  const label = user.email || user.name || `user #${user.user_id ?? user.id ?? ""}`;
  return (
    <div className="min-h-dvh">
      <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)] sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-7 h-7 rounded-md bg-[var(--color-accent)] grid place-items-center shrink-0">
              <Sparkles size={15} color="white" />
            </div>
            <span className="text-sm font-semibold tracking-tight">Apteva</span>
            <span className="t-tertiary hidden sm:inline">/</span>
            <span className="text-sm t-secondary hidden sm:inline">Dashboard</span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <div className="hidden sm:flex items-center gap-2">
              <div className="avatar" style={{ width: 26, height: 26, fontSize: 10 }}>
                {initials(label)}
              </div>
              <span className="text-xs t-secondary">{label}</span>
            </div>
            <button type="button" onClick={onLogout} className="btn-ghost flex items-center gap-1.5">
              <LogOut size={14} />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-6 fade-up">
        <div className="grid gap-6 grid-cols-1 lg:grid-cols-2">
          <LeadsCard />
          <TablesCard />
        </div>
        <ChatCard />
      </main>
    </div>
  );
}

function initials(label: string): string {
  if (label.includes("@")) {
    const local = label.split("@")[0]!;
    return local.slice(0, 2).toUpperCase();
  }
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
