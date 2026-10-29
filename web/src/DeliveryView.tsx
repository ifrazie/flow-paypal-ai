import { useEffect, useMemo, useRef, useState } from "react";
import { BryntumGantt } from "@bryntum/gantt-react";
import type { GridColumnConfig } from "@bryntum/gantt";
import "@bryntum/gantt/stockholm-light.css";
import "./delivery.css";
import { money, type GanttTask, type TimelineModel } from "./flowTypes";

const COLUMNS: GridColumnConfig[] = [
  { type: "name", field: "name", text: "Client / phase", width: 270 },
  { text: "Tranche", field: "invoiceNumber", width: 140 },
  {
    text: "Status",
    field: "paymentStatus",
    width: 100,
    renderer: ({ value }: { value?: string }) =>
      value ? `<span class="pill pill-${value}">${value}</span>` : "",
  },
];

// Unpaid tranches first by urgency.
const URGENCY: Record<string, number> = { overdue: 0, partial: 1, pending: 2 };

type TreeTask = Omit<GanttTask, "parentId"> & { children?: TreeTask[] };

/** Nests the flat task list under its client rows, the shape Bryntum's task store expects. */
function toTree(tasks: GanttTask[]): TreeTask[] {
  const nodes = new Map<string, TreeTask & { children: TreeTask[] }>();
  for (const { parentId: _parent, ...task } of tasks) nodes.set(task.id, { ...task, children: [] });
  const roots: TreeTask[] = [];
  for (const task of tasks) {
    const node = nodes.get(task.id)!;
    const parent = task.parentId ? nodes.get(task.parentId) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  // An empty children array would make a phase look like a collapsible group.
  for (const node of nodes.values()) if (node.children.length === 0) delete (node as TreeTask).children;
  return roots;
}

const projectData = (timeline: TimelineModel) => ({
  tasksData: toTree(timeline.tasks),
  dependenciesData: timeline.dependencies,
});

interface Props {
  timeline: TimelineModel | null;
  error: string | null;
  /** Whether the Delivery view is on screen; the chart is fitted to its dates when first shown. */
  active: boolean;
  notify: (message: string) => void;
}

export function DeliveryView({ timeline, error, active, notify }: Props) {
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<{ invoiceId: string; invoiceNumber: string; text: string } | null>(null);
  const [confirmPay, setConfirmPay] = useState<GanttTask | null>(null);
  const [busy, setBusy] = useState(false);
  const ganttRef = useRef<any>(null);
  const fitted = useRef(false);

  // Fit every phase into view the first time the chart is visible. It can't measure itself
  // while hidden, so give it a moment to lay out after being shown.
  useEffect(() => {
    if (!active || fitted.current || !timeline) return;
    const timer = setTimeout(() => {
      const gantt = ganttRef.current?.instance;
      if (!gantt) return;
      fitted.current = true;
      void gantt.zoomToFit({ leftMargin: 40, rightMargin: 60 });
    }, 300);
    return () => clearTimeout(timer);
  }, [active, timeline]);

  // Bryntum gets its first dataset once; later updates are loaded into the same project
  // so the view keeps its scroll position instead of re-creating the chart.
  const initialProject = useRef<ReturnType<typeof projectData> | null>(null);
  if (timeline && !initialProject.current) initialProject.current = projectData(timeline);
  const loadedOnce = useRef(false);
  useEffect(() => {
    if (!timeline) return;
    if (!loadedOnce.current) {
      loadedOnce.current = true;
      return;
    }
    void ganttRef.current?.instance?.project?.loadInlineData(projectData(timeline));
  }, [timeline]);

  const unpaid = useMemo(
    () =>
      (timeline?.tasks ?? [])
        .filter((t) => t.milestone && t.paymentStatus && t.paymentStatus !== "paid")
        .sort((a, b) => (URGENCY[a.paymentStatus!] ?? 9) - (URGENCY[b.paymentStatus!] ?? 9)),
    [timeline],
  );
  const selected = unpaid.find((t) => t.invoiceId === selectedId) ?? null;

  // Once the chosen tranche is paid it leaves the list; go back to the prompt.
  useEffect(() => {
    if (selectedId && !selected) setSelectedId("");
  }, [selectedId, selected]);

  const draftReminder = async () => {
    if (!selected?.invoiceId) return;
    setBusy(true);
    try {
      const res = await fetch("/api/collections/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoiceId: selected.invoiceId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      setDraft({ invoiceId: selected.invoiceId, invoiceNumber: selected.invoiceNumber ?? "", text: body.message });
    } catch (err) {
      notify(`Could not draft a reminder: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  const sendReminder = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/invoices/${draft.invoiceId}/remind`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: draft.text }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      notify(`Reminder sent for ${draft.invoiceNumber}.`);
      setDraft(null);
    } catch (err) {
      notify(`Could not send the reminder: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  const recordPayment = async () => {
    if (!confirmPay?.invoiceId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/invoices/${confirmPay.invoiceId}/record-payment`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      notify(`Payment recorded in PayPal for ${confirmPay.invoiceNumber}. Waiting for PayPal to confirm…`);
      setConfirmPay(null);
    } catch (err) {
      notify(`Could not record the payment: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="flow-error">Could not load timeline: {error}</div>;
  if (!timeline || !initialProject.current) return <div className="flow-loading">Loading delivery timeline…</div>;

  return (
    <div className="delivery">
      <div className="delivery-bar">
        <div className="delivery-hint">
          A tranche that's past due and not paid in full blocks the next phase. Payments made in PayPal
          update this timeline automatically.
        </div>
        <div className="delivery-actions">
          <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} disabled={unpaid.length === 0}>
            <option value="" disabled>
              {unpaid.length ? "Select an unpaid tranche…" : "Every tranche is paid"}
            </option>
            {unpaid.map((t) => (
              <option key={t.id} value={t.invoiceId}>
                {t.customer} · {t.invoiceNumber} · {money(t.outstanding, t.currency)} {t.paymentStatus}
              </option>
            ))}
          </select>
          <button type="button" className="pay-btn ghost" disabled={busy || !selected} onClick={draftReminder}>
            Draft reminder ✨
          </button>
          <a
            className={`pay-btn ghost${selected?.payerUrl ? "" : " disabled"}`}
            href={selected?.payerUrl ?? undefined}
            target="_blank"
            rel="noreferrer"
            title="The PayPal page where the customer pays this invoice. Sign in as their sandbox account."
          >
            Open as customer ↗
          </a>
          <button type="button" className="pay-btn" disabled={busy || !selected} onClick={() => setConfirmPay(selected)}>
            Record payment
          </button>
        </div>
      </div>

      <div className="delivery-gantt">
        <BryntumGantt
          ref={ganttRef}
          project={initialProject.current}
          columns={COLUMNS}
          viewPreset="weekAndMonth"
          rowHeight={40}
          barMargin={8}
          dependencyIdField="id"
          projectLinesFeature={false}
          timeRangesFeature={{ showCurrentTimeLine: true }}
        />
      </div>

      {draft && (
        <div className="modal" onClick={() => setDraft(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">AI reminder · {draft.invoiceNumber}</div>
            <p className="modal-sub">Review and edit the draft. Nothing is sent until you approve.</p>
            <textarea
              className="modal-text"
              rows={7}
              value={draft.text}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            />
            <div className="modal-actions">
              <button type="button" className="pay-btn ghost" onClick={() => setDraft(null)}>
                Cancel
              </button>
              <button type="button" className="pay-btn" disabled={busy} onClick={sendReminder}>
                {busy ? "Sending…" : "Approve & send reminder"}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmPay && (
        <div className="modal" onClick={() => setConfirmPay(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Record a payment in PayPal?</div>
            <p className="modal-sub">
              {confirmPay.customer} · {confirmPay.invoiceNumber} · {money(confirmPay.outstanding, confirmPay.currency)}{" "}
              outstanding
            </p>
            <p className="modal-body">
              PayPal will mark this invoice as paid, the same as if the customer had paid it outside PayPal.
              Flow updates as soon as PayPal confirms.
            </p>
            <div className="modal-actions">
              <button type="button" className="pay-btn ghost" onClick={() => setConfirmPay(null)}>
                Cancel
              </button>
              <button type="button" className="pay-btn" disabled={busy} onClick={recordPayment}>
                {busy ? "Recording…" : "Record payment"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
