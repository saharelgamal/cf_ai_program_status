// Dashboard and chat UI for the Program Status Agent. Plain JavaScript, no build step.
// All text from the server is inserted with textContent, never innerHTML.
// The health colours come from the server's rules; this file only counts and draws.

const $ = (id) => document.getElementById(id);
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: ignore */ }
  },
};

const GENERAL = "General";
const DAY = 86400000;
const STATUS_LABEL = { on_track: "on track", ahead: "ahead of schedule", at_risk: "at risk", off_track: "off track", done: "done" };

let programId = null;
let current = null; // the state on screen, to show what the next update changed
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

// ---- Dates ------------------------------------------------------------------

const todayIso = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || "");
const shortDate = (d) => (isDate(d) ? new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }) : "—");
const signed = (n) => `${n > 0 ? "+" : ""}${n}d`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "Priya, Nov 21": who posted the update that last changed an item, and when. */
function lastUpdate(item) {
  const when = item.updatedAt ? new Date(item.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
  return [item.updatedBy, when].filter(Boolean).join(", ") || "—";
}

function initials(name) {
  return name.split(/\s+/).map((w) => w[0] || "").join("").slice(0, 2).toUpperCase();
}

// ---- Who is posting: remembered in this browser -----------------------------

$("you").value = store.get("you", "");
$("you").addEventListener("change", () => store.set("you", $("you").value.trim()));
const you = () => $("you").value.trim();

// ---- Start screen -----------------------------------------------------------

function remember(program) {
  const recent = store.get("recent", []).filter((p) => p.id !== program.id);
  store.set("recent", [{ id: program.id, name: program.name }, ...recent].slice(0, 10));
}

function showStart() {
  $("program").hidden = true;
  $("start").hidden = false;
  document.title = "Program Status Agent";
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

async function createProgram(body) {
  try {
    const program = await api("/api/programs", { method: "POST", body });
    remember(program);
    location.hash = program.id;
  } catch (err) {
    alert(err.message);
  }
}

$("create-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("program-name").value.trim();
  if (name) createProgram({ name });
});
$("open-demo").addEventListener("click", () => createProgram({ demo: true }));

// ---- Program screen ---------------------------------------------------------

async function openProgram(id) {
  programId = id;
  $("changes").hidden = true;
  openTile = null;
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
  current = state;
  $("program-title").textContent = state.name;
  document.title = `${state.name} · Program Status Agent`;
  renderHero(state);
  renderKpis(state);
  renderComponents(state);
  renderTimeline(state);
  renderRisks(state.risks);
  renderDependencies(state.dependencies, state.health);
  renderMilestones(state);
  renderUpdates(state.messages, state.people);
  renderMessages(state.messages);
  renderReport(state.reports[0]);
  $("schedule").checked = Boolean(state.weeklySchedule);
  $("schedule-note").textContent = state.weeklySchedule
    ? `Next report: ${new Date(state.weeklySchedule).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
    : "";

  // Poll while a report is being drafted, so the draft appears without a refresh.
  const drafting = state.reports[0]?.status === "drafting";
  clearTimeout(pollTimer);
  if (drafting) pollTimer = setTimeout(refresh, 2500);
}

async function refresh() {
  if (programId) render(await api(`/api/programs/${programId}`));
}

// ---- Header: overall health -------------------------------------------------

function renderHero(state) {
  const { health } = state;
  const rag = $("rag");
  rag.textContent = health.overall;
  rag.className = `rag-big ${health.overall}`;
  $("reasons").replaceChildren(...health.reasons.slice(0, 5).map((r) => el("li", r)));
  if (health.reasons.length > 5) $("reasons").append(el("li", `and ${health.reasons.length - 5} more`, "muted"));
  const latest = [...state.milestones, ...state.risks, ...state.dependencies].map((i) => i.updatedAt).filter(Boolean).sort().at(-1);
  $("as-of").textContent = latest ? `Last update ${new Date(latest).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "No updates yet";
}

// ---- Key numbers ------------------------------------------------------------

let openTile = null; // the key-number tile whose list is open, kept across redraws

function tile(key, label, value, sub, tone = "") {
  const btn = el("button", null, `kpi ${tone}${openTile === key ? " open" : ""}`);
  btn.type = "button";
  btn.dataset.tile = key;
  btn.setAttribute("aria-expanded", String(openTile === key));
  btn.title = "Show the items behind this number";
  btn.append(el("div", label, "kpi-label"), el("div", String(value), "kpi-value"), el("div", sub, "kpi-sub"));
  btn.addEventListener("click", () => {
    openTile = openTile === key ? null : key;
    renderKpis(current);
    if (openTile) $("kpi-detail").scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  });
  return btn;
}

/** Open items with no update for STALE_DAYS days, matching the server's rule. */
function staleItems(state) {
  const cutoff = Date.now() - 7 * DAY;
  const old = (i) => i.updatedAt && Date.parse(i.updatedAt) <= cutoff;
  return [
    ...state.milestones.filter((m) => m.status !== "done" && old(m)).map((m) => ({ kind: "milestone", item: m, name: m.name, team: m.component, owner: m.owner })),
    ...state.risks.filter((r) => r.status === "open" && old(r)).map((r) => ({ kind: "risk", item: r, name: r.description, team: r.component, owner: r.owner })),
    ...state.dependencies.filter((d) => d.status === "open" && old(d)).map((d) => ({ kind: "dependency", item: d, name: d.description, team: d.team, owner: d.updatedBy })),
  ];
}

function statusPill(status) {
  return el("span", STATUS_LABEL[status] || status, `pill ${status}`);
}

function nameCell(title, note) {
  const td = el("td");
  td.append(el("div", title));
  if (note) td.append(el("div", note, "muted small"));
  return td;
}

const milestoneRow = (m) => ({
  key: `milestone:${m.id}`,
  cells: [nameCell(m.name, m.note), el("td", m.component || GENERAL), el("td", m.owner || "—"), dueCell(m), (() => { const td = el("td"); td.append(statusPill(m.status)); return td; })()],
});
const MILESTONE_HEAD = ["Milestone", "Team", "Owner", "Due (vs plan)", "Status"];

/** The items behind each key number: a title, column headings and rows. */
function tileDetail(key, state) {
  const today = todayIso();
  const ms = state.milestones;
  const open = state.risks.filter((r) => r.status === "open");
  const sevOrder = { high: 0, medium: 1, low: 2 };
  const byDue = (a, b) => (a.due || "9999").localeCompare(b.due || "9999");
  switch (key) {
    case "milestones":
      return { title: "All milestones", head: MILESTONE_HEAD, rows: [...ms].sort(byDue).map(milestoneRow) };
    case "at_risk":
      return { title: "Milestones at risk", head: MILESTONE_HEAD, rows: ms.filter((m) => m.status === "at_risk").sort(byDue).map(milestoneRow) };
    case "off_track":
      return { title: "Milestones off track", head: MILESTONE_HEAD, rows: ms.filter((m) => m.status === "off_track").sort(byDue).map(milestoneRow) };
    case "risks":
      return {
        title: "Open risks",
        head: ["Risk", "Team", "Severity", "Owner", "Mitigation"],
        rows: [...open].sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]).map((r) => ({
          key: `risk:${r.id}`,
          cells: [el("td", r.description), el("td", r.component || "—"), (() => { const td = el("td"); td.append(el("span", r.severity, `pill ${r.severity === "high" ? "RED" : r.severity === "medium" ? "AMBER" : "GREEN"}`)); return td; })(),
            el("td", r.owner || "—"), el("td", r.mitigation || "None yet", r.mitigation ? "small" : "small warn")],
        })),
      };
    case "overdue":
      return {
        title: "Overdue",
        head: ["Item", "Team", "Was due", "Late by", "Owner"],
        rows: [
          ...ms.filter((m) => m.status !== "done" && isDate(m.due) && m.due < today).map((m) => ({
            key: `milestone:${m.id}`,
            cells: [nameCell(m.name, "Milestone"), el("td", m.component || GENERAL), el("td", shortDate(m.due), "nowrap"), el("td", `${daysBetween(m.due, today)}d`, "bad"), el("td", m.owner || "—")],
          })),
          ...state.dependencies.filter((d) => d.status === "open" && isDate(d.neededBy) && d.neededBy < today).map((d) => ({
            key: `dependency:${d.id}`,
            cells: [nameCell(d.description, "Dependency"), el("td", d.team || "—"), el("td", shortDate(d.neededBy), "nowrap"), el("td", `${daysBetween(d.neededBy, today)}d`, "bad"), el("td", d.updatedBy || "—")],
          })),
        ],
      };
    case "plan": {
      const plan = state.health.plan;
      return {
        title: "End date vs plan",
        intro: plan.summary,
        head: ["Milestone", "Team", "Original date", "Current date", "Slip"],
        rows: plan.slips.map((sl) => {
          const m = ms.find((x) => x.name === sl.name);
          return {
            key: m ? `milestone:${m.id}` : "",
            cells: [el("td", sl.name), el("td", sl.component), el("td", shortDate(sl.baselineDue), "nowrap"), el("td", shortDate(sl.due), "nowrap"), el("td", signed(sl.days), sl.days > 0 ? "bad" : "ok")],
          };
        }),
        empty: "No date has moved from the original plan.",
      };
    }
    case "stale":
      return {
        title: "Needs an update",
        intro: "Open items nobody has posted about for 7 days. This is the chase list.",
        head: ["Item", "Kind", "Team", "Owner", "Last update"],
        rows: staleItems(state).map((x) => ({
          key: `${x.kind}:${x.item.id}`,
          cells: [el("td", x.name), el("td", x.kind), el("td", x.team || "—"), el("td", x.owner || "—"), el("td", lastUpdate(x.item), "muted small")],
        })),
      };
    case "updates": {
      const weekAgo = new Date(Date.now() - 7 * DAY).toISOString();
      return {
        title: "Updates this week",
        head: ["When", "Name", "Update"],
        rows: state.messages.filter((m) => m.role === "user" && m.at >= weekAgo).reverse().map((m) => ({
          key: "",
          cells: [el("td", new Date(m.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }), "muted nowrap small"),
            el("td", m.author), el("td", m.content, "small")],
        })),
      };
    }
  }
  return null;
}

function renderTileDetail(state) {
  const box = $("kpi-detail");
  const detail = openTile && tileDetail(openTile, state);
  box.hidden = !detail;
  if (!detail) return box.replaceChildren();

  const head = el("div", null, "card-head");
  head.append(el("h3", `${detail.title} (${detail.rows.length})`));
  const close = el("button", "Close", "secondary small");
  close.type = "button";
  close.addEventListener("click", () => { openTile = null; renderKpis(current); });
  head.append(close);
  box.replaceChildren(head);
  if (detail.intro) box.append(el("p", detail.intro, "small plan-line"));
  if (!detail.rows.length) {
    box.append(el("p", detail.empty || "Nothing here right now.", "muted small"));
    return;
  }
  const table = el("table");
  const thead = el("thead");
  const hr = el("tr");
  for (const h of detail.head) hr.append(el("th", h));
  thead.append(hr);
  const tbody = el("tbody");
  for (const row of detail.rows) {
    const tr = el("tr");
    tr.append(...row.cells);
    if (row.key) {
      // Click a row to jump to that item further down the dashboard.
      tr.className = "jump";
      tr.title = "Show it on the dashboard";
      tr.addEventListener("click", () => {
        const target = document.querySelector(`#milestones [data-key="${row.key}"], #risks [data-key="${row.key}"], #dependencies [data-key="${row.key}"]`);
        if (!target) return;
        target.scrollIntoView?.({ behavior: "smooth", block: "center" });
        target.classList.remove("flash");
        void target.offsetWidth;
        target.classList.add("flash");
      });
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  const wrap = el("div", null, "table-wrap");
  wrap.append(table);
  box.append(wrap);
}

function renderKpis(state) {
  const today = todayIso();
  const ms = state.milestones;
  const count = (s) => ms.filter((m) => m.status === s).length;
  const open = state.risks.filter((r) => r.status === "open");
  const sev = (s) => open.filter((r) => r.severity === s).length;
  const overdueMs = ms.filter((m) => m.status !== "done" && isDate(m.due) && m.due < today).length;
  const lateDeps = state.dependencies.filter((d) => d.status === "open" && isDate(d.neededBy) && d.neededBy < today).length;
  const weekAgo = new Date(Date.now() - 7 * DAY).toISOString();
  const updates = state.messages.filter((m) => m.role === "user" && m.at >= weekAgo);
  const posters = new Set(updates.map((m) => m.author.toLowerCase())).size;
  const plan = state.health.plan;

  $("kpis").replaceChildren(
    tile("milestones", "Milestones", ms.length, `${count("done")} done · ${count("on_track")} on track${count("ahead") ? ` · ${count("ahead")} ahead` : ""}`),
    tile("at_risk", "At risk", count("at_risk"), "may slip", count("at_risk") ? "AMBER" : ""),
    tile("off_track", "Off track", count("off_track"), "will miss or blocked", count("off_track") ? "RED" : ""),
    tile("risks", "Open risks", open.length, `${sev("high")} high · ${sev("medium")} medium · ${sev("low")} low`, sev("high") ? "RED" : sev("medium") ? "AMBER" : ""),
    tile("overdue", "Overdue", overdueMs + lateDeps, `${plural(overdueMs, "milestone")} · ${lateDeps} ${lateDeps === 1 ? "dependency" : "dependencies"}`, overdueMs + lateDeps ? "AMBER" : ""),
    tile("plan", "End date vs plan", plan.dated ? signed(plan.endSlipDays) : "—",
      plan.dated ? `forecast ${shortDate(plan.forecastEnd)}, planned ${shortDate(plan.plannedEnd)}` : "no dates yet", plan.endSlipDays ? "AMBER" : ""),
    tile("stale", "Needs an update", state.health.stale.length, "nothing posted for 7 days", state.health.stale.length ? "AMBER" : ""),
    tile("updates", "Updates this week", updates.length, `from ${posters} ${posters === 1 ? "person" : "people"}`),
  );
  renderTileDetail(state);
}

// ---- Component cards --------------------------------------------------------

function renderComponents(state) {
  const today = todayIso();
  const cards = state.health.components.map((c) => {
    const ms = state.milestones.filter((m) => (m.component || GENERAL) === c.name);
    const risks = state.risks.filter((r) => r.status === "open" && (r.component || "") === c.name);
    const card = el("div", null, `comp ${c.rag}`);
    card.dataset.key = `component:${c.name}`;

    const head = el("div", null, "comp-head");
    head.append(el("strong", c.name), el("span", c.rag, `pill ${c.rag}`));
    card.append(head);

    if (ms.length) {
      const bar = el("div", null, "progress");
      for (const s of ["done", "ahead", "on_track", "at_risk", "off_track"]) {
        const n = ms.filter((m) => m.status === s).length;
        if (!n) continue;
        const seg = el("span", null, `seg ${s}`);
        seg.style.width = `${(n / ms.length) * 100}%`;
        seg.title = `${n} ${STATUS_LABEL[s]}`;
        bar.append(seg);
      }
      card.append(bar, el("div", `${c.done} of ${c.milestones} milestones done`, "small"));
    } else {
      card.append(el("div", "No milestones yet", "small muted"));
    }

    const facts = el("ul", null, "comp-facts small");
    const slips = ms.filter((m) => isDate(m.due) && isDate(m.baselineDue)).map((m) => daysBetween(m.baselineDue, m.due)).filter((d) => d > 0);
    facts.append(el("li", slips.length ? `${slips.length} slipped, largest ${signed(Math.max(...slips))}` : "No slips against plan", slips.length ? "warn" : ""));
    facts.append(el("li", risks.length ? `${risks.length} open risk${risks.length > 1 ? "s" : ""}${risks.some((r) => r.severity === "high") ? ", 1+ high" : ""}` : "No open risks", risks.some((r) => r.severity === "high") ? "bad" : ""));
    const next = ms.filter((m) => m.status !== "done" && isDate(m.due)).sort((a, b) => a.due.localeCompare(b.due))[0];
    if (next) facts.append(el("li", `Next: ${next.name}, ${shortDate(next.due)}${next.due < today ? " (overdue)" : ""}`));
    card.append(facts);

    const people = state.people.filter((p) => p.teams.includes(c.name));
    if (people.length) {
      const row = el("div", null, "avatars");
      for (const p of people) {
        const a = el("span", initials(p.name), "avatar");
        a.title = `${p.name}: ${p.assignments.join("; ") || "no open items"}`;
        row.append(a);
      }
      card.append(row);
    }
    return card;
  });
  $("components").replaceChildren(...(cards.length ? cards : [el("p", "Components appear when updates name a team, e.g. \"Network - Backbone upgrade...\".", "muted small")]));
}

// ---- Timeline: original vs current dates --------------------------------------

function renderTimeline(state) {
  const box = $("timeline");
  $("plan").textContent = state.health.plan.summary;
  const today = todayIso();
  const ms = state.milestones.filter((m) => isDate(m.due) || isDate(m.baselineDue));
  if (!ms.length) {
    box.replaceChildren(el("p", "Milestones with dates appear here.", "muted small"));
    return;
  }

  const dates = [today, ...ms.flatMap((m) => [m.due, m.baselineDue].filter(isDate))].sort();
  const start = Date.parse(dates[0]) - 5 * DAY;
  const end = Date.parse(dates.at(-1)) + 5 * DAY;
  const pos = (d) => `${((Date.parse(d) - start) / (end - start)) * 100}%`;

  // Axis: a tick on the first of each month (or every week when the span is short).
  const axis = el("div", null, "tl-row tl-axis");
  axis.append(el("div", "", "tl-label"));
  const ticks = el("div", null, "tl-track");
  const span = (end - start) / DAY;
  const cursor = new Date(start);
  cursor.setUTCHours(0, 0, 0, 0);
  if (span > 70) cursor.setUTCDate(1);
  while (cursor.getTime() <= end) {
    if (cursor.getTime() >= start) {
      const iso = cursor.toISOString().slice(0, 10);
      const t = el("span", span > 70 ? cursor.toLocaleDateString(undefined, { month: "short", timeZone: "UTC" }) : shortDate(iso), "tick");
      t.style.left = pos(iso);
      ticks.append(t);
    }
    if (span > 70) cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    else cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  const todayTick = el("span", "Today", "tick today-label");
  todayTick.style.left = pos(today);
  ticks.append(todayTick);
  axis.append(ticks);

  const rows = [axis];
  for (const c of state.health.components.filter((c) => c.milestones)) {
    const group = el("div", null, "tl-group");
    group.append(el("span", c.name), el("span", c.rag, `pill ${c.rag}`));
    rows.push(group);
    for (const m of ms.filter((m) => (m.component || GENERAL) === c.name)) {
      const row = el("div", null, "tl-row");
      row.dataset.key = `milestone:${m.id}`;
      const label = el("div", null, "tl-label");
      label.append(el("span", m.name, "tl-name"), el("span", m.owner || "", "muted small"));
      const track = el("div", null, "tl-track");
      const now = el("i", null, "today-line");
      now.style.left = pos(today);
      track.append(now);

      const due = isDate(m.due) ? m.due : m.baselineDue;
      const base = isDate(m.baselineDue) ? m.baselineDue : due;
      const slip = daysBetween(base, due);
      if (slip !== 0) {
        const bar = el("i", null, `bar ${slip > 0 ? "late" : "early"}`);
        const [a, b] = slip > 0 ? [base, due] : [due, base];
        bar.style.left = pos(a);
        bar.style.width = `calc(${pos(b)} - ${pos(a)})`;
        track.append(bar);
        const delta = el("span", signed(slip), `delta ${slip > 0 ? "late" : "early"}`);
        delta.style.left = pos(slip > 0 ? due : base);
        track.append(delta);
      }
      const baseMark = el("i", null, "mk base");
      baseMark.style.left = pos(base);
      baseMark.title = `Original date ${base}`;
      const cur = el("i", null, `mk cur ${m.status}`);
      cur.style.left = pos(due);
      cur.title = `${m.name}: ${STATUS_LABEL[m.status]}, due ${due}${slip ? ` (planned ${base}, ${signed(slip)})` : ""}`;
      track.append(baseMark, cur);
      row.append(label, track);
      rows.push(row);
    }
  }
  box.replaceChildren(...rows);
}

// ---- Risks, dependencies, milestones ------------------------------------------

function renderRisks(risks) {
  const cols = ["high", "medium", "low"].map((sev) => {
    const col = el("div", null, `risk-col ${sev}`);
    const list = risks.filter((r) => r.status === "open" && r.severity === sev);
    const head = el("div", null, "risk-col-head");
    head.append(el("span", sev[0].toUpperCase() + sev.slice(1)), el("span", String(list.length), "count"));
    col.append(head);
    for (const r of list) {
      const card = el("div", null, "risk");
      card.dataset.key = `risk:${r.id}`;
      card.append(el("div", r.description, "risk-title"));
      card.append(el("div", [r.component, r.owner && `owner ${r.owner}`].filter(Boolean).join(" · ") || "No owner yet", "muted small"));
      card.append(el("div", r.mitigation ? `Mitigation: ${r.mitigation}` : "No mitigation yet", `small ${r.mitigation ? "" : "warn"}`));
      col.append(card);
    }
    if (!list.length) col.append(el("div", "None", "muted small"));
    return col;
  });
  $("risks").replaceChildren(...cols);
  const closed = risks.filter((r) => r.status !== "open").length;
  $("closed-risks").textContent = closed ? `${closed} closed` : "";
}

function renderDependencies(deps, health) {
  const today = todayIso();
  const order = (d) => (d.status === "resolved" ? 2 : isDate(d.neededBy) ? 0 : 1);
  const rows = [...deps].sort((a, b) => order(a) - order(b) || (a.neededBy || "").localeCompare(b.neededBy || "")).map((d) => {
    const tr = el("tr");
    tr.dataset.key = `dependency:${d.id}`;
    let state = "open";
    let tone = "";
    if (d.status === "resolved") { state = "resolved"; tone = "ok"; }
    else if (isDate(d.neededBy)) {
      const days = daysBetween(today, d.neededBy);
      state = days < 0 ? `late ${-days}d` : days === 0 ? "due today" : `in ${days}d`;
      tone = days < 0 ? "bad" : days <= 7 ? "warn" : "";
    }
    tr.title = `Last update: ${lastUpdate(d)}`;
    tr.append(el("td", d.team || "—"), el("td", d.description), el("td", shortDate(d.neededBy), "nowrap"), el("td", state, `nowrap ${tone}`));
    return tr;
  });
  $("dependencies").replaceChildren(...(rows.length ? rows : [emptyRow(4, "None yet.")]));
  $("stale-box").hidden = !health.stale.length;
  $("stale").replaceChildren(...health.stale.map((s) => el("li", s)));
}

function dueCell(m) {
  const td = el("td", m.due || "—", "nowrap");
  if (m.due && m.baselineDue && m.baselineDue !== m.due) {
    const days = daysBetween(m.baselineDue, m.due);
    td.append(el("div", `planned ${m.baselineDue} (${days > 0 ? "+" : ""}${days}d)`, days > 0 ? "small slip" : "small muted"));
  }
  return td;
}

function renderMilestones(state) {
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
      tr.dataset.key = `milestone:${m.id}`;
      tr.title = m.note || "";
      const name = el("td");
      name.append(el("div", m.name), m.note ? el("div", m.note, "muted small") : "");
      tr.append(name, el("td", m.owner || "—"), dueCell(m));
      const td = el("td");
      td.append(el("span", STATUS_LABEL[m.status], `pill ${m.status}`));
      tr.append(td, el("td", lastUpdate(m), "muted small"));
      rows.push(tr);
    }
  }
  $("milestones").replaceChildren(...(rows.length ? rows : [emptyRow(5)]));
}

/** One row per status update, newest first, with the poster's team and assignments filled in from the tracker. */
function renderUpdates(messages, people) {
  const byName = new Map(people.map((p) => [p.name.toLowerCase(), p]));
  const rows = messages
    .filter((m) => m.role === "user")
    .slice(-20)
    .reverse()
    .map((m) => {
      const person = byName.get(m.author.toLowerCase());
      const teams = person ? person.teams.filter((t) => t !== GENERAL) : [];
      const tr = el("tr");
      const when = new Date(m.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      tr.append(
        el("td", when, "muted nowrap small"),
        el("td", m.author),
        el("td", teams.join(", ") || "—"),
        el("td", person?.assignments.join("; ") || "—", "small"),
        el("td", m.content, "small"),
      );
      return tr;
    });
  $("updates").replaceChildren(...(rows.length ? rows : [emptyRow(5)]));
}

function emptyRow(cols, text = "None yet. Post an update in the chat.") {
  const tr = el("tr");
  const td = el("td", text, "muted");
  td.colSpan = cols;
  tr.append(td);
  return tr;
}

// ---- Chat -------------------------------------------------------------------

function renderMessages(messages) {
  const box = $("messages");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.replaceChildren();
  for (const m of messages) {
    const div = el("div", null, `msg ${m.role}`);
    const who = el("span", null, "who");
    who.append(el("strong", m.role === "user" ? m.author : "Agent"),
      document.createTextNode(m.at ? ` · ${new Date(m.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""));
    div.append(who, el("span", m.content));
    box.append(div);
  }
  if (atBottom || box.dataset.first !== "done") box.scrollTop = box.scrollHeight;
  box.dataset.first = "done";
}

// ---- Weekly report ------------------------------------------------------------

function renderReport(report) {
  const box = $("report");
  // Don't redraw an open review form on every refresh, or the reviewer's edits would be lost.
  const key = report ? `${report.id}:${report.status}` : "none";
  if (key === lastReportKey) return;
  lastReportKey = key;
  box.replaceChildren();
  $("draft-report").disabled = report && (report.status === "drafting" || report.status === "awaiting_approval");
  if (!report) {
    box.append(el("p", "No report yet. Draft one to see it here; a person approves it before it is final.", "muted small"));
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

// ---- What an update changed ----------------------------------------------------

/** Compares the dashboard before and after an update, so the change is easy to see. */
function describeChanges(before, after) {
  const lines = [];
  const keys = [];
  const kinds = [["milestone", "milestones", (i) => i.name], ["risk", "risks", (i) => i.description], ["dependency", "dependencies", (i) => i.description]];
  for (const [kind, list, label] of kinds) {
    const old = new Map(before[list].map((i) => [i.id, i]));
    for (const item of after[list]) {
      const prev = old.get(item.id);
      if (prev && prev.updatedAt === item.updatedAt) continue;
      keys.push(`${kind}:${item.id}`);
      if (kind === "milestone") keys.push(`component:${item.component || GENERAL}`);
      const parts = [];
      if (!prev) parts.push(`new ${kind}`);
      else {
        if (prev.status !== item.status) parts.push(`${STATUS_LABEL[prev.status] || prev.status} → ${STATUS_LABEL[item.status] || item.status}`);
        if (kind === "milestone" && prev.due !== item.due) parts.push(`due ${shortDate(prev.due)} → ${shortDate(item.due)}`);
        if (kind === "risk" && prev.severity !== item.severity) parts.push(`${prev.severity} → ${item.severity}`);
        if (kind === "risk" && !prev.mitigation && item.mitigation) parts.push("mitigation added");
        if (kind === "dependency" && prev.neededBy !== item.neededBy) parts.push(`needed by ${shortDate(item.neededBy)}`);
        if (!parts.length) parts.push("note updated");
      }
      lines.push(`${label(item)}: ${parts.join(", ")}`);
    }
  }
  if (before.health.overall !== after.health.overall) lines.push(`Overall health: ${before.health.overall} → ${after.health.overall}`);
  for (const c of after.health.components) {
    const prev = before.health.components.find((p) => p.name === c.name);
    if (prev && prev.rag !== c.rag) lines.push(`${c.name}: ${prev.rag} → ${c.rag}`);
    if (!prev) lines.push(`New component: ${c.name}`);
  }
  return { lines, keys };
}

function showChanges(author, { lines, keys }) {
  const box = $("changes");
  box.replaceChildren();
  box.hidden = false;
  box.className = `changes ${lines.length ? "" : "none"}`;
  if (!lines.length) {
    box.append(el("strong", `${author}'s update didn't change the tracker.`),
      el("span", " Name the milestone, risk or dependency it's about, or answer the agent's question in the chat.", "muted"));
    return;
  }
  box.append(el("strong", `Dashboard updated from ${author}'s update`));
  const ul = el("ul");
  for (const line of lines.slice(0, 6)) ul.append(el("li", line));
  box.append(ul);
  for (const key of keys) {
    for (const node of document.querySelectorAll(`[data-key="${key.replace(/["\\]/g, "\\$&")}"]`)) {
      node.classList.remove("flash");
      void node.offsetWidth; // restart the animation
      node.classList.add("flash");
    }
  }
}

// ---- Actions ------------------------------------------------------------------

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
    const before = current;
    const after = await api(`/api/programs/${programId}/updates`, { method: "POST", body: { author: you(), text } });
    render(after);
    if (before) showChanges(you(), describeChanges(before, after));
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
    $("report-card").scrollIntoView?.({ behavior: "smooth", block: "start" });
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

$("all-programs").addEventListener("click", (e) => {
  e.preventDefault();
  if (location.hash) location.hash = "";
  else showStart();
});

// ---- Routing: #<programId> opens a program ---------------------------------
// On the very first visit, open a demo program so the dashboard isn't empty.

function route() {
  const id = location.hash.slice(1);
  if (/^[0-9a-f-]{36}$/.test(id)) openProgram(id);
  else if (!store.get("recent", []).length && !store.get("demoOpened", false)) {
    store.set("demoOpened", true);
    createProgram({ demo: true });
  } else {
    programId = null;
    clearTimeout(pollTimer);
    showStart();
  }
}
window.addEventListener("hashchange", route);
route();
