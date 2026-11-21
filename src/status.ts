// Program data types and the rule-based health check.
// Pure TypeScript with no Cloudflare imports, so it is easy to unit test.

export type MilestoneStatus = "on_track" | "at_risk" | "off_track" | "done";
export type Severity = "high" | "medium" | "low";

export interface Milestone {
  id: string;
  name: string;
  owner: string;
  /** YYYY-MM-DD, or "" when nobody has given a date yet. */
  due: string;
  status: MilestoneStatus;
  note: string;
  updatedAt: string;
  /** Who posted the update that last changed this item. */
  updatedBy?: string;
}

export interface Risk {
  id: string;
  description: string;
  severity: Severity;
  owner: string;
  mitigation: string;
  status: "open" | "closed";
  updatedAt: string;
  updatedBy?: string;
}

export interface Dependency {
  id: string;
  description: string;
  /** The team we are waiting on. */
  team: string;
  /** YYYY-MM-DD, or "". */
  neededBy: string;
  status: "open" | "resolved";
  updatedAt: string;
  updatedBy?: string;
}

export interface ProgramSnapshot {
  name: string;
  milestones: Milestone[];
  risks: Risk[];
  dependencies: Dependency[];
}

export type Rag = "GREEN" | "AMBER" | "RED";

export interface Health {
  overall: Rag;
  /** Why the program has this colour, one line each. */
  reasons: string[];
  /** Open items nobody has updated for STALE_DAYS days. */
  stale: string[];
}

export const STALE_DAYS = 7;

/** Turns a name into a stable id, so "EU PoP rollout" and "eu pop rollout" are the same milestone. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function daysBetween(fromIso: string, to: Date): number {
  const from = new Date(fromIso);
  if (Number.isNaN(from.getTime())) return 0;
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

/** Dates are compared as YYYY-MM-DD strings, which sort correctly. */
function isPast(date: string, today: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && date < today;
}

/**
 * The RAG (red / amber / green) rules. They are deterministic on purpose: the LLM
 * gathers updates and writes the report, but the health colour is a rule anyone can audit.
 *
 * RED:   any milestone off track, or any open high-severity risk.
 * AMBER: any milestone at risk or past its due date, any open dependency past its
 *        needed-by date, or any open medium risk with no mitigation.
 * GREEN: none of the above.
 */
export function computeHealth(p: ProgramSnapshot, now: Date = new Date()): Health {
  const today = now.toISOString().slice(0, 10);
  const red: string[] = [];
  const amber: string[] = [];
  const stale: string[] = [];

  for (const m of p.milestones) {
    if (m.status === "done") continue;
    if (m.status === "off_track") red.push(`Milestone "${m.name}" is off track`);
    else if (m.status === "at_risk") amber.push(`Milestone "${m.name}" is at risk`);
    if (isPast(m.due, today)) amber.push(`Milestone "${m.name}" is past its due date (${m.due})`);
    if (daysBetween(m.updatedAt, now) >= STALE_DAYS) stale.push(`Milestone "${m.name}" (owner: ${m.owner || "none"})`);
  }

  for (const r of p.risks) {
    if (r.status !== "open") continue;
    if (r.severity === "high") red.push(`Open high risk: ${r.description}`);
    else if (r.severity === "medium" && !r.mitigation) amber.push(`Medium risk with no mitigation: ${r.description}`);
    if (daysBetween(r.updatedAt, now) >= STALE_DAYS) stale.push(`Risk "${r.description}"`);
  }

  for (const d of p.dependencies) {
    if (d.status !== "open") continue;
    if (isPast(d.neededBy, today)) amber.push(`Dependency on ${d.team || "another team"} is late: ${d.description}`);
    if (daysBetween(d.updatedAt, now) >= STALE_DAYS) stale.push(`Dependency "${d.description}"`);
  }

  const overall: Rag = red.length ? "RED" : amber.length ? "AMBER" : "GREEN";
  const reasons = [...red, ...amber];
  if (!reasons.length) reasons.push("No milestones off track or at risk, and no open high risks");
  return { overall, reasons, stale };
}

/** Next Monday at 17:00 UTC (9 AM Pacific in winter). */
export function nextMondayMorning(from: Date): Date {
  const next = new Date(from);
  next.setUTCHours(17, 0, 0, 0);
  const daysAhead = (1 - next.getUTCDay() + 7) % 7;
  next.setUTCDate(next.getUTCDate() + daysAhead);
  if (next <= from) next.setUTCDate(next.getUTCDate() + 7);
  return next;
}
