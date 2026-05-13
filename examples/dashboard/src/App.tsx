import { useAuth } from "./hooks/useAuth";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";

export function App() {
  const auth = useAuth();

  if (auth.loading && !auth.user) {
    return (
      <div className="min-h-dvh grid place-items-center t-tertiary text-xs">
        Loading…
      </div>
    );
  }

  if (!auth.user) {
    return <Login onLogin={auth.login} error={auth.error} loading={auth.loading} />;
  }

  return <Dashboard user={auth.user} onLogout={auth.logout} />;
}
