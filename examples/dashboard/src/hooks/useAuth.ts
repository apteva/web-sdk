import { useCallback, useEffect, useState } from "react";
import type { User } from "@apteva/web-sdk";
import { AptevaError } from "@apteva/web-sdk";
import { apteva } from "../lib/apteva";

export interface AuthState {
  user: User | null;
  loading: boolean;
  error: string | null;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    user: null,
    loading: true,
    error: null,
  });

  // Boot probe: if there's a session cookie or kiosk key set, /auth/me
  // returns the user — otherwise we land on the login screen.
  useEffect(() => {
    let cancelled = false;
    apteva.auth
      .me()
      .then((u) => {
        if (!cancelled) setState({ user: u, loading: false, error: null });
      })
      .catch(() => {
        if (!cancelled) setState({ user: null, loading: false, error: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const u = await apteva.auth.login(email, password);
      setState({ user: u, loading: false, error: null });
    } catch (err) {
      const message =
        err instanceof AptevaError
          ? err.body || `error ${err.status}`
          : err instanceof Error
            ? err.message
            : "login failed";
      setState({ user: null, loading: false, error: message });
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await apteva.auth.logout();
    } catch {
      // best-effort; clear local state regardless
    }
    setState({ user: null, loading: false, error: null });
  }, []);

  return { ...state, login, logout };
}
