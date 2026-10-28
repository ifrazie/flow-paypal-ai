import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BryntumGantt } from "@bryntum/gantt-react";
import "@bryntum/gantt/stockholm-light.css";
import "./delivery.css";

interface GanttTask {
  id: string;
  name: string;
  startDate?: string;
  endDate?: string;
  duration?: number;
  milestone?: boolean;
  manuallyScheduled?: boolean;
  parentId?: string;
  expanded?: boolean;
  percentDone?: number;
  cls?: string;
  eventColor?: string;
  invoiceId?: string;
  invoiceNumber?: string;
  amount?: number;
  currency?: string;
  paymentStatus?: "paid" | "overdue" | "pending";
}

interface TimelineModel {
  tasks: GanttTask[];
  dependencies: { id: string; from: string; to: string; type?: number }[];
}

const COLUMNS = [
  { type: "name", field: "name", text: "Client / phase", width: 260 },
  { text: "Tranche", field: "invoiceNumber", width: 120 },
  {
    text: "Status",
    field: "paymentStatus",
    width: 100,
    renderer: ({ value }: { value?: string }) =>
      value ? `<span class="pill pill-${value}">${value}</span>` : "",
  },
];

export function DeliveryView() {
  const [model, setModel] = useState<TimelineModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const ganttRef = useRef<any>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      setModel(body as TimelineModel);
      setVersion((v) => v + 1);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Overdue tranches the user can mark paid to see the timeline unblock live.
  const overdue = useMemo(
    () => (model?.tasks ?? []).filter((t) => t.milestone && t.paymentStatus === "overdue"),
    [model],
  );

  const simulatePayment = async (invoiceId: string) => {
    if (!invoiceId) return;
    setBusy(true);
    try {
      await fetch("/api/dev/simulate-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoiceId }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const project = useMemo(
    () => ({ tasksData: model?.tasks ?? [], dependenciesData: model?.dependencies ?? [] }),
    [model],
  );

  if (error) return <div className="flow-error">Could not load timeline: {error}</div>;
  if (!model) return <div className="flow-loading">Loading delivery timeline…</div>;

  return (
    <div className="delivery">
      <div className="delivery-bar">
        <div className="delivery-hint">
          Phases are gated by PayPal payments — <span className="pill pill-overdue">overdue</span>{" "}
          tranches block the next phase. Mark one paid to watch the timeline unblock.
        </div>
        <div className="delivery-actions">
          <select id="pay-select" disabled={busy || overdue.length === 0} defaultValue="">
            <option value="" disabled>
              {overdue.length ? "Select an overdue tranche…" : "No overdue tranches"}
            </option>
            {overdue.map((t) => (
              <option key={t.id} value={t.invoiceId}>
                {t.invoiceNumber} · {t.currency} {t.amount?.toFixed(0)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="pay-btn"
            disabled={busy}
            onClick={() => {
              const sel = document.getElementById("pay-select") as HTMLSelectElement | null;
              if (sel?.value) simulatePayment(sel.value);
            }}
          >
            Mark paid (simulate)
          </button>
        </div>
      </div>
      <div className="delivery-gantt">
        <BryntumGantt
          key={version}
          ref={ganttRef}
          project={project}
          columns={COLUMNS}
          viewPreset="weekAndMonth"
          rowHeight={40}
          barMargin={8}
          dependencyIdField="id"
        />
      </div>
    </div>
  );
}
