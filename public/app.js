const form = document.getElementById("form");
const input = document.getElementById("input");
const send = document.getElementById("send");
const log = document.getElementById("log");
const status = document.getElementById("status");
const reset = document.getElementById("reset");

// Persist a session id so the server keeps conversation memory across messages.
let sessionId = localStorage.getItem("paypal-agent-session") || crypto.randomUUID();
localStorage.setItem("paypal-agent-session", sessionId);

/* ---------------------------------------------------------------- chat view */

function addMessage(cls, text = "") {
  const el = document.createElement("div");
  el.className = `msg ${cls}`;
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

function addApprovalCard(tool, inputObj) {
  const card = document.createElement("div");
  card.className = "approval";

  const title = document.createElement("div");
  title.className = "approval-title";
  title.textContent = `Approval required: ${tool}`;
  card.appendChild(title);

  const pre = document.createElement("pre");
  pre.className = "approval-input";
  pre.textContent = JSON.stringify(inputObj, null, 2);
  card.appendChild(pre);

  const actions = document.createElement("div");
  actions.className = "approval-actions";

  const approve = document.createElement("button");
  approve.className = "btn approve";
  approve.textContent = "Approve";

  const deny = document.createElement("button");
  deny.className = "btn deny";
  deny.textContent = "Deny";

  actions.append(approve, deny);
  card.appendChild(actions);
  log.appendChild(card);
  log.scrollTop = log.scrollHeight;

  const finish = (label) => {
    actions.remove();
    const note = document.createElement("div");
    note.className = "approval-resolved";
    note.textContent = label;
    card.appendChild(note);
  };

  approve.addEventListener("click", () => {
    finish("Approved");
    runTurn(`Approved — please proceed with the "${tool}" action.`, [tool]);
  });
  deny.addEventListener("click", () => {
    finish("Denied");
    runTurn(`I do not approve the "${tool}" action. Please cancel it.`, []);
  });
}

async function runTurn(prompt, approvals = []) {
  setBusy(true);
  let agentEl = null;

  try {
    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, sessionId, approvals }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      addMessage("error", err.error || `Request failed (${res.status})`);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        const event = JSON.parse(line);
        if (event.type === "session") {
          sessionId = event.sessionId;
          localStorage.setItem("paypal-agent-session", sessionId);
        } else if (event.type === "text") {
          if (!agentEl) agentEl = addMessage("agent");
          agentEl.textContent += event.text;
          log.scrollTop = log.scrollHeight;
        } else if (event.type === "tool") {
          addMessage("tool", `using ${event.name}…`);
          agentEl = null;
        } else if (event.type === "approval_required") {
          addApprovalCard(event.tool, event.input);
        } else if (event.type === "error") {
          addMessage("error", event.message);
        }
      }
    }
  } catch (err) {
    addMessage("error", String(err));
  } finally {
    setBusy(false);
  }
}

function setBusy(busy) {
  input.disabled = busy;
  send.disabled = busy;
  if (!busy) input.focus();
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const prompt = input.value.trim();
  if (!prompt) return;
  input.value = "";
  addMessage("user", prompt);
  runTurn(prompt, []);
});

reset.addEventListener("click", async () => {
  await fetch("/api/session/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  }).catch(() => {});
  sessionId = crypto.randomUUID();
  localStorage.setItem("paypal-agent-session", sessionId);
  log.replaceChildren();
  input.focus();
});

/* ------------------------------------------------------- invoices dashboard */

let gridApi = null;
let selectedInvoice = null;

const money = (p) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: p.data.currency || "USD" }).format(
    p.value ?? 0,
  );

function statusRenderer(p) {
  const span = document.createElement("span");
  span.className = `badge badge-${String(p.value || "").toLowerCase()}`;
  span.textContent = p.value || "—";
  return span;
}

function initGrid() {
  const options = {
    columnDefs: [
      { headerName: "Invoice #", field: "invoiceNumber", minWidth: 120 },
      { headerName: "Recipient", field: "recipient", flex: 1, minWidth: 160 },
      { headerName: "Amount", field: "amount", valueFormatter: money, type: "rightAligned", minWidth: 120 },
      { headerName: "Status", field: "status", cellRenderer: statusRenderer, minWidth: 130 },
      { headerName: "Date", field: "date", minWidth: 120 },
    ],
    defaultColDef: { sortable: true, filter: true, resizable: true },
    rowSelection: "single",
    animateRows: true,
    onSelectionChanged: () => {
      const rows = gridApi.getSelectedRows();
      selectedInvoice = rows[0] || null;
      document.getElementById("nudge").disabled = !selectedInvoice;
    },
    overlayNoRowsTemplate:
      "No invoices yet — create one from the Chat tab, then Refresh.",
  };
  gridApi = agGrid.createGrid(document.getElementById("grid"), options);
}

async function loadInvoices() {
  if (!gridApi) return;
  gridApi.setGridOption("loading", true);
  try {
    const res = await fetch("/api/invoices");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    gridApi.setGridOption("rowData", data.invoices || []);
  } catch (err) {
    gridApi.setGridOption("rowData", []);
    gridApi.setGridOption("overlayNoRowsTemplate", `Could not load invoices: ${err}`);
    gridApi.showNoRowsOverlay();
  } finally {
    gridApi.setGridOption("loading", false);
  }
}

// Nudge modal
const modal = document.getElementById("nudge-modal");
const nudgeBtn = document.getElementById("nudge");
const nudgeText = document.getElementById("nudge-text");
const nudgeMeta = document.getElementById("nudge-meta");

nudgeBtn.addEventListener("click", async () => {
  if (!selectedInvoice) return;
  nudgeBtn.disabled = true;
  const original = nudgeBtn.textContent;
  nudgeBtn.textContent = "Drafting…";
  try {
    const res = await fetch("/api/nudge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invoice: selectedInvoice }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    nudgeMeta.textContent = `To ${selectedInvoice.recipient} · ${selectedInvoice.amount} ${selectedInvoice.currency} · #${selectedInvoice.invoiceNumber}`;
    nudgeText.value = data.message || "";
    modal.classList.remove("hidden");
  } catch (err) {
    alert(`Could not draft a nudge: ${err}`);
  } finally {
    nudgeBtn.textContent = original;
    nudgeBtn.disabled = false;
  }
});

document.getElementById("nudge-close").addEventListener("click", () => modal.classList.add("hidden"));
document.getElementById("nudge-copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(nudgeText.value).catch(() => {});
});
document.getElementById("refresh").addEventListener("click", loadInvoices);

/* ------------------------------------------------------------ view switching */

const views = { chat: document.getElementById("view-chat"), invoices: document.getElementById("view-invoices") };
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const view = tab.dataset.view;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    Object.entries(views).forEach(([name, el]) => el.classList.toggle("hidden", name !== view));
    if (view === "invoices") {
      if (!gridApi) initGrid();
      loadInvoices();
    }
  });
});

/* ------------------------------------------------------------------- startup */

async function refreshStatus() {
  status.classList.remove("on", "off");
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    status.classList.add(data.paypalTools ? "on" : "off");
    status.title = data.paypalTools
      ? "PayPal tools enabled"
      : "PayPal tools disabled — set PAYPAL_CLIENT_ID/PAYPAL_SECRET";
  } catch {
    status.classList.add("off");
  }
}

refreshStatus();
input.focus();
