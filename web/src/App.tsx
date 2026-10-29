import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgStudioProvider, AgStudio } from "ag-studio-react";
import {
  AgStudioAiModule,
  enableStudioDevValidations,
  type AgStudioApi,
  type AgStudioMode,
} from "ag-studio";
import { buildStudioData, hasData } from "./studio/data";
import { dashboardReport } from "./studio/initial-report";
import { agStudioPayPalTheme } from "./studio/theme";
import { buildAi } from "./studio/ai";
import type { DashboardData } from "./studio/types";
import { DeliveryView } from "./DeliveryView";
import { describeChanges, type FlowUpdate, type TimelineModel } from "./flowTypes";

if (import.meta.env.DEV) {
  enableStudioDevValidations();
}

const LICENSE_KEY = import.meta.env.VITE_AG_STUDIO_LICENSE as string | undefined;

const PAGE_LABELS: Record<string, string> = {
  revenue: "Revenue",
  receivables: "Receivables",
  cash: "Cash",
  catalogue: "Catalogue",
};

type View = "dashboard" | "delivery";

export function App() {
  const [view, setView] = useState<View>("dashboard");
  const [data, setData] = useState<DashboardData | null>(null);
  const [timeline, setTimeline] = useState<TimelineModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);
  const [mode, setMode] = useState<AgStudioMode>("view");
  const [activePage, setActivePage] = useState<string>(dashboardReport.selectedPageId ?? "revenue");
  const apiRef = useRef<AgStudioApi | null>(null);

  const notify = useCallback((message: string) => setToast({ id: Date.now(), message }), []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(timer);
  }, [toast]);

  const selectPage = (pageId: string) => {
    setActivePage(pageId);
    const api = apiRef.current;
    if (api) api.setState({ ...api.getState(), selectedPageId: pageId });
  };

  const loadSnapshot = useCallback(async () => {
    try {
      const res = await fetch("/api/snapshot");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      setData(body.dashboard as DashboardData);
      setTimeline(body.timeline as TimelineModel);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  // Initial load, then live updates pushed by the server whenever PayPal reports a change.
  useEffect(() => {
    void loadSnapshot();
    const events = new EventSource("/api/events");
    let connectedBefore = false;
    events.onopen = () => {
      // After a dropped connection, catch up on anything missed while offline.
      if (connectedBefore) void loadSnapshot();
      connectedBefore = true;
    };
    events.addEventListener("update", (e) => {
      const update = JSON.parse((e as MessageEvent).data) as FlowUpdate;
      setData(update.dashboard);
      setTimeline(update.timeline);
      const message = describeChanges(update.changes);
      if (message) notify(message);
    });
    return () => events.close();
  }, [loadSnapshot, notify]);

  // New data flows into the same Studio instance, so the open page and any widgets the
  // AI assistant built stay as they are.
  const studioData = useMemo(() => (data ? buildStudioData(data) : null), [data]);
  const ai = useMemo(() => buildAi(), []);

  return (
    <div className="flow-app">
      <header className="flow-header">
        <h1>Flow</h1>
        <span className="tag">PayPal money copilot</span>

        <nav className="flow-nav">
          <button
            type="button"
            className={`flow-top${view === "dashboard" ? " active" : ""}`}
            onClick={() => setView("dashboard")}
          >
            Dashboard
          </button>
          <button
            type="button"
            className={`flow-top${view === "delivery" ? " active" : ""}`}
            onClick={() => setView("delivery")}
          >
            Delivery
          </button>
        </nav>

        {view === "dashboard" && (
          <>
            <nav className="flow-nav flow-pages">
              {dashboardReport.pages.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`flow-tab${p.id === activePage ? " active" : ""}`}
                  onClick={() => selectPage(p.id)}
                >
                  {PAGE_LABELS[p.id] ?? p.id}
                </button>
              ))}
            </nav>
            <button
              className="flow-mode"
              type="button"
              onClick={() => setMode((m) => (m === "view" ? "edit" : "view"))}
            >
              {mode === "view" ? "Edit / Ask AI" : "Done"}
            </button>
          </>
        )}
      </header>

      {/* Both views stay mounted so switching between them keeps their state. */}
      <div className="flow-body">
        <div className={`flow-pane${view === "dashboard" ? "" : " flow-hidden"}`}>
          {error && !data ? (
            <div className="flow-error">Could not load dashboard: {error}</div>
          ) : !data || !studioData ? (
            <div className="flow-loading">Loading PayPal data…</div>
          ) : !hasData(data) ? (
            <div className="flow-loading">No PayPal data yet. Run `npm run seed`, then refresh.</div>
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
                onApiReady={(event) => {
                  apiRef.current = event.api;
                }}
              />
            </AgStudioProvider>
          )}
        </div>
        <div className={`flow-pane${view === "delivery" ? "" : " flow-hidden"}`}>
          <DeliveryView
            timeline={timeline}
            error={timeline ? null : error}
            active={view === "delivery"}
            notify={notify}
          />
        </div>
      </div>

      {toast && (
        <div key={toast.id} className="flow-toast" role="status">
          {toast.message}
        </div>
      )}
    </div>
  );
}
