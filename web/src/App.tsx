import { useEffect, useMemo, useState } from "react";
import { AgStudioProvider, AgStudio } from "ag-studio-react";
import { AgStudioAiModule, enableStudioDevValidations, type AgStudioMode } from "ag-studio";
import { buildStudioData, hasData } from "./studio/data";
import { dashboardReport } from "./studio/initial-report";
import { agStudioPayPalTheme } from "./studio/theme";
import { buildAi } from "./studio/ai";
import type { DashboardData } from "./studio/types";

if (import.meta.env.DEV) {
  enableStudioDevValidations();
}

const LICENSE_KEY = import.meta.env.VITE_AG_STUDIO_LICENSE as string | undefined;

export function App() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<AgStudioMode>("view");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/dashboard-data")
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
        if (!cancelled) setData(body as DashboardData);
      })
      .catch((err) => !cancelled && setError(String(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  const studioData = useMemo(() => (data ? buildStudioData(data) : null), [data]);
  const ai = useMemo(() => buildAi(), []);

  return (
    <div className="flow-app">
      <header className="flow-header">
        <h1>Flow</h1>
        <span className="tag">PayPal money copilot</span>
        <button
          className="flow-mode"
          type="button"
          onClick={() => setMode((m) => (m === "view" ? "edit" : "view"))}
        >
          {mode === "view" ? "Edit / Ask AI" : "Done"}
        </button>
      </header>
      <div className="flow-body">
        {error ? (
          <div className="flow-error">Could not load dashboard: {error}</div>
        ) : !data || !studioData ? (
          <div className="flow-loading">Loading PayPal data…</div>
        ) : !hasData(data) ? (
          <div className="flow-loading">
            No PayPal data yet. Create some invoices, then refresh.
          </div>
        ) : (
          <AgStudioProvider licenseKey={LICENSE_KEY} modules={[AgStudioAiModule]}>
            <AgStudio
              style={{ height: "100%", width: "100%" }}
              theme={agStudioPayPalTheme}
              layout={{ widgetBorderEnabled: true }}
              data={studioData}
              ai={ai}
              initialState={dashboardReport}
              mode={mode}
            />
          </AgStudioProvider>
        )}
      </div>
    </div>
  );
}
