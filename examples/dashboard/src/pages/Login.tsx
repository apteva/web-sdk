import { useState } from "react";
import { ArrowRight, Sparkles } from "lucide-react";

interface Props {
  onLogin: (email: string, password: string) => Promise<void>;
  error: string | null;
  loading: boolean;
}

export function Login({ onLogin, error, loading }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const canSubmit = email.trim().length > 0 && password.length > 0 && !loading;

  return (
    <div className="min-h-dvh grid grid-cols-1 lg:grid-cols-2">
      <div className="hidden lg:flex flex-col justify-between p-12 bg-[var(--color-accent)] text-white">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-lg bg-white/15 grid place-items-center">
            <Sparkles size={20} />
          </div>
          <span className="text-lg font-semibold tracking-tight">Apteva</span>
        </div>
        <div className="space-y-4 fade-up max-w-md">
          <h1 className="text-3xl font-semibold leading-tight">
            Your project, in one place.
          </h1>
          <p className="text-white/80 text-sm leading-relaxed">
            Sign in to read live data from any app installed on your
            apteva-server — leads, tasks, contacts, custom tables.
          </p>
        </div>
        <p className="text-xs text-white/60">
          Built with @apteva/web-sdk
        </p>
      </div>

      <div className="grid place-items-center p-6 sm:p-12">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) onLogin(email.trim(), password);
          }}
          className="w-full max-w-sm space-y-5 fade-up"
        >
          <div className="lg:hidden flex items-center gap-2.5 mb-8">
            <div className="w-9 h-9 rounded-lg bg-[var(--color-accent)] grid place-items-center">
              <Sparkles size={20} color="white" />
            </div>
            <span className="text-lg font-semibold tracking-tight">Apteva</span>
          </div>

          <div>
            <h2 className="text-xl font-semibold t-primary">Sign in</h2>
            <p className="text-sm t-secondary mt-1">
              Welcome back. Use your Apteva account.
            </p>
          </div>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium t-secondary">Email</span>
            <input
              type="email"
              autoComplete="username"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input"
              placeholder="you@company.com"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium t-secondary">Password</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input"
              placeholder="••••••••"
            />
          </label>

          {error && (
            <div className="text-xs text-[var(--color-red)] bg-[var(--color-red-light)] rounded-lg px-3 py-2 fade-up">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            className="btn-primary w-full h-10 flex items-center justify-center gap-2"
          >
            {loading ? "Signing in…" : (<>Continue <ArrowRight size={16} /></>)}
          </button>

          <p className="text-[11px] t-tertiary text-center">
            Authenticates against your apteva-server's <code className="font-mono">/api/auth/login</code>.
          </p>
        </form>
      </div>
    </div>
  );
}
