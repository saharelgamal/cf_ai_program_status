// Chat UI for the Program Status Agent. Plain JavaScript, no build step.
// All text from the server is inserted with textContent, never innerHTML.

const $ = (id) => document.getElementById(id);
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: ignore */ }
  },
};

let programId = null;
let pollTimer = null;
let lastReportKey = "";

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---- Who is posting: remembered in this browser -----------------------------

$("you").value = store.get("you", "");
$("you").addEventListener("change", () => store.set("you", $("you").value.trim()));
const you = () => $("you").value.trim();

// ---- Start screen -----------------------------------------------------------

function showStart() {
  $("program").hidden = true;
  $("start").hidden = false;
  const list = $("recent");
  list.replaceChildren();
  const recent = store.get("recent", []);
  if (!recent.length) list.append(el("li", "None yet.", "muted"));
  for (const p of recent) {
    const li = el("li");
    const a = el("a", p.name);
    a.href = `#${p.id}`;
    li.append(a);
    list.append(li);
  }
}

$("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("program-name").value.trim();
  if (!name) return;
  try {
    const program = await api("/api/programs", { method: "POST", body: { name } });
    const recent = store.get("recent", []).filter((p) => p.id !== program.id);
    store.set("recent", [{ id: program.id, name: program.name }, ...recent].slice(0, 10));
    location.hash = program.id;
  } catch (err) {
    alert(err.message);
  }
});

// ---- Program screen ---------------------------------------------------------

async function openProgram(id) {
  programId = id;
  $("start").hidden = true;
  $("program").hidden = false;
  lastReportKey = "";
  try {
    render(await api(`/api/programs/${id}`));
  } catch (err) {
    alert(err.message);
    location.hash = "";
  }
}

function render(state) {
  $("program-title").textContent = state.name;
  document.title = `${state.name} · Program Status Agent`;
  renderMessages(state.messages);
  renderHealth(state.health);
  renderTracker(state);
  renderReport(state.reports[0]);
  $("schedule").checked = Boolean(state.weeklySchedule);
  $("schedule-note").textContent = state.weeklySchedule
    ? `Next report: ${new Date(state.weeklySchedule).toLocaleString()}`
    : "";

  // Poll while a report is being drafted, so the draft appears without a refresh.
  const drafting = state.reports[0]?.status === "drafting";
  clearTimeout(pollTimer);
  if (drafting) pollTimer = setTimeout(refresh, 2500);
}

async function refresh() {
  if (programId) render(await api(`/api/programs/${programId}`));
}

function renderMessages(messages) {
  const box = $("messages");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.replaceChildren();
  for (const m of messages) {
    const div = el("div", null, `msg ${m.role}`);
    div.append(el("span", m.role === "user" ? m.author : "Agent", "who"), el("span", m.content));
    box.append(div);
  }
  if (atBottom || box.dataset.first !== "done") box.scrollTop = box.scrollHeight;
  box.dataset.first = "done";
}

function renderHealth(health) {
  const rag = $("rag");
  rag.textContent = health.overall;
  rag.className = `rag ${health.overall}`;
  $("reasons").replaceChildren(...health.reasons.map((r) => el("li", r)));
  $("components").replaceChildren(
    ...(health.components.length
      ? health.components.map((c) => {
          const li = el("li");
          li.append(el("span", c.rag, `pill ${c.rag}`), document.createTextNode(` ${c.name}`));
          const facts = [c.milestones ? `${c.done} of ${c.milestones} done` : "risks only, no milestones yet"];
          if (c.slipped) facts.push(`${c.slipped} slipped against plan`);
          li.append(el("span", ` · ${facts.join(" · ")}`, "muted"));
          return li;
        })
      : [el("li", "None yet.", "muted")]),
  );
  $("plan").textContent = health.plan.summary;
  $("stale-box").hidden = !health.stale.length;
  $("stale").replaceChildren(...health.stale.map((s) => el("li", s)));
}

const GENERAL = "General";

/** Whole days from the original date to the current one (positive = late). */
function daysLate(planned, current) {
  return Math.round((Date.parse(current) - Date.parse(planned)) / 86400000);
}

function dueCell(m) {
  const td = el("td", m.due || "—");
  if (m.due && m.baselineDue && m.baselineDue !== m.due) {
    const days = daysLate(m.baselineDue, m.due);
    td.append(el("div", `planned ${m.baselineDue} (${days > 0 ? "+" : ""}${days}d)`, days > 0 ? "small slip" : "small muted"));
  }
  return td;
}

function renderTracker(state) {
  // Milestones grouped by component, each group headed by that component's own health colour.
  const rows = [];
  for (const c of state.health.components.filter((c) => c.milestones)) {
    const head = el("tr", null, "group");
    const th = el("td");
    th.colSpan = 5;
    th.append(el("strong", c.name), document.createTextNode(" "), el("span", c.rag, `pill ${c.rag}`));
    head.append(th);
    rows.push(head);
    for (const m of state.milestones.filter((m) => (m.component || GENERAL) === c.name)) {
      const tr = el("tr");
      tr.title = m.note || "";
      tr.append(el("td", m.name), el("td", m.owner || "—"), dueCell(m));
      const td = el("td");
      td.append(el("span", m.status.replace("_", " "), `pill ${m.status}`));
      tr.append(td, el("td", lastUpdate(m), "muted"));
      rows.push(tr);
    }
  }
  $("milestones").replaceChildren(...(rows.length ? rows : [emptyRow(5)]));

  $("risks").replaceChildren(
    ...(state.risks.length
      ? state.risks.map((r) => {
          const li = el("li");
          li.append(el("span", r.severity, `pill ${r.severity}`), document.createTextNode(` ${r.component ? `${r.component}: ` : ""}${r.description}`));
          li.append(el("div", `Owner: ${r.owner || "—"} · Mitigation: ${r.mitigation || "none yet"} · ${r.status} · Last update: ${lastUpdate(r)}`, "muted"));
          return li;
        })
      : [el("li", "None yet.", "muted")]),
  );

  $("dependencies").replaceChildren(
    ...(state.dependencies.length
      ? state.dependencies.map((d) => {
          const li = el("li", d.description);
          li.append(el("div", `Team: ${d.team || "—"} · Needed by: ${d.neededBy || "—"} · ${d.status} · Last update: ${lastUpdate(d)}`, "muted"));
          return li;
        })
      : [el("li", "None yet.", "muted")]),
  );
}

/** "Priya, Nov 21": who posted the update that last changed an item, and when. */
function lastUpdate(item) {
  const when = item.updatedAt ? new Date(item.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
  return [item.updatedBy, when].filter(Boolean).join(", ") || "—";
}

function emptyRow(cols) {
  const tr = el("tr");
  const td = el("td", "None yet. Post an update in the chat.", "muted");
  td.colSpan = cols;
  tr.append(td);
  return tr;
}

function renderReport(report) {
  const box = $("report");
  // Don't redraw an open review form on every refresh, or the reviewer's edits would be lost.
  const key = report ? `${report.id}:${report.status}` : "none";
  if (key === lastReportKey) return;
  lastReportKey = key;
  box.replaceChildren();
  $("draft-report").disabled = report && (report.status === "drafting" || report.status === "awaiting_approval");
  if (!report) {
    box.append(el("p", "No report yet.", "muted small"));
    return;
  }

  const head = el("p", null, "small");
  head.append(
    el("span", report.status.replace("_", " "), `pill ${report.status}`),
    document.createTextNode(` ${new Date(report.createdAt).toLocaleString()} · ${report.trigger}`),
  );
  box.append(head);

  if (report.status === "drafting") {
    box.append(el("p", "Scoring health and drafting the report…", "muted small"));
    return;
  }

  if (report.status === "awaiting_approval") {
    box.append(el("p", "Review the draft. You can edit it before approving; your edited text becomes the final report.", "muted small"));
    const form = el("form", null, "review-form");
    const text = el("textarea");
    text.value = report.draft || "";
    const reviewer = el("input");
    reviewer.placeholder = "Reviewer name";
    reviewer.value = $("you").value.trim();
    const note = el("input");
    note.placeholder = "Note (optional, e.g. what to change)";
    const row = el("div", null, "row");
    const approve = el("button", "Approve");
    approve.type = "button";
    const changes = el("button", "Request changes", "secondary");
    changes.type = "button";
    row.append(approve, changes);
    form.append(text, reviewer, note, row);
    box.append(form);

    const send = async (approved) => {
      if (!reviewer.value.trim()) return alert("Add the reviewer's name.");
      approve.disabled = changes.disabled = true;
      try {
        await api(`/api/programs/${programId}/reports/${report.id}/review`, {
          method: "POST",
          body: { approved, reviewer: reviewer.value.trim(), note: note.value.trim(), editedText: text.value },
        });
        setTimeout(refresh, 1200); // the Workflow records the decision a moment later
      } catch (err) {
        alert(err.message);
        approve.disabled = changes.disabled = false;
      }
    };
    approve.addEventListener("click", () => send(true));
    changes.addEventListener("click", () => send(false));
    return;
  }

  if (report.status === "approved") {
    box.append(el("p", `Approved by ${report.reviewer}.`, "small"), el("div", report.final, "report-text"));
  } else {
    if (report.reviewNote) box.append(el("p", report.reviewNote, "small"));
    if (report.draft) box.append(el("div", report.draft, "report-text"));
  }
}

$("update-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("update-text").value.trim();
  if (!you()) {
    alert("Add your name in Posting as, so the team knows who posted the update.");
    $("you").focus();
    return;
  }
  if (!text) return;
  $("send").disabled = true;
  $("send").textContent = "Thinking…";
  try {
    render(await api(`/api/programs/${programId}/updates`, { method: "POST", body: { author: you(), text } }));
    $("update-text").value = "";
  } catch (err) {
    alert(err.message);
  } finally {
    $("send").disabled = false;
    $("send").textContent = "Send update";
  }
});

$("update-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("update-form").requestSubmit();
});

$("draft-report").addEventListener("click", async () => {
  $("draft-report").disabled = true;
  try {
    await api(`/api/programs/${programId}/reports`, { method: "POST" });
    await refresh();
  } catch (err) {
    alert(err.message);
    $("draft-report").disabled = false;
  }
});

$("schedule").addEventListener("change", async () => {
  try {
    await api(`/api/programs/${programId}/schedule`, { method: "POST", body: { enabled: $("schedule").checked } });
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

// ---- Routing: #<programId> opens a program ---------------------------------

function route() {
  const id = location.hash.slice(1);
  if (/^[0-9a-f-]{36}$/.test(id)) openProgram(id);
  else {
    programId = null;
    clearTimeout(pollTimer);
    showStart();
  }
}
window.addEventListener("hashchange", route);
route();
