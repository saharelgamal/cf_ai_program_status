// Program data types and the rule-based health check.
// Pure TypeScript with no Cloudflare imports, so it is easy to unit test.

export type MilestoneStatus = "on_track" | "at_risk" | "off_track" | "done";
export type Severity = "high" | "medium" | "low";

export interface Milestone {
  id: string;
  name: string;
  /** The team or workstream this milestone belongs to, e.g. "Network" or "DC ops". */
  component: string;
  owner: string;
  /** Current due date, YYYY-MM-DD, or "" when nobody has given a date yet. */
  due: string;
  /** The original plan date: the first due date this milestone ever had. It never moves. */
  baselineDue: string;
  status: MilestoneStatus;
  note: string;
  updatedAt: string;
  /** Who posted the update that last changed this item. */
  updatedBy?: string;
}

export interface Risk {
  id: string;
  description: string;
  /** The team or workstream the risk affects, or "" for the whole program. */
  component?: string;
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
  /** The same rules applied to each component's own milestones and risks. */
  components: ComponentHealth[];
  /** Where the program stands against the original plan dates. */
  plan: PlanVariance;
}

export interface ComponentHealth {
  name: string;
  rag: Rag;
  reasons: string[];
  milestones: number;
  done: number;
  /** Milestones whose current date is later than the original plan date. */
  slipped: number;
}

export interface Slip {
  name: string;
  component: string;
  baselineDue: string;
  due: string;
  /** Positive means late against the original plan, negative means early. */
  days: number;
}

export interface PlanVariance {
  /** Milestones that have both an original and a current date. */
  dated: number;
  onPlan: number;
  slips: Slip[];
  /** Latest original date across the program, and latest current date. */
  plannedEnd: string;
  forecastEnd: string;
  /** How many days later than planned the program now finishes (0 if on time or early). */
  endSlipDays: number;
  /** One plain sentence, for the UI and the report. */
  summary: string;
}

export const GENERAL = "General";

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

/** Whole days from one YYYY-MM-DD date to another. */
export function daysLate(planned: string, current: string): number {
  return Math.round((Date.parse(current) - Date.parse(planned)) / 86_400_000);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The RAG (red / amber / green) rules. They are deterministic on purpose: the LLM
 * gathers updates and writes the report, but the health colour is a rule anyone can audit.
 *
 * RED:   any milestone off track, or any open high-severity risk.
 * AMBER: any milestone at risk or past its due date, any open dependency past its
 *        needed-by date, or any open medium risk with no mitigation.
 * GREEN: none of the above.
 */
function rag(p: ProgramSnapshot, now: Date): { overall: Rag; reasons: string[]; stale: string[] } {
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

/** Compares every milestone's current date with its original plan date. */
export function planVariance(milestones: Milestone[]): PlanVariance {
  const dated = milestones.filter((m) => DATE.test(m.baselineDue) && DATE.test(m.due));
  const slips = dated
    .map((m) => ({ name: m.name, component: m.component || GENERAL, baselineDue: m.baselineDue, due: m.due, days: daysLate(m.baselineDue, m.due) }))
    .filter((s) => s.days !== 0)
    .sort((a, b) => b.days - a.days);
  const late = slips.filter((s) => s.days > 0);
  const plannedEnd = dated.map((m) => m.baselineDue).sort().at(-1) ?? "";
  const forecastEnd = dated.map((m) => m.due).sort().at(-1) ?? "";
  const endSlipDays = plannedEnd && forecastEnd ? Math.max(0, daysLate(plannedEnd, forecastEnd)) : 0;

  let summary: string;
  if (!dated.length) summary = "No milestone has a date yet, so there is no plan to compare against.";
  else {
    summary = `${dated.length - late.length} of ${dated.length} dated milestones are on or ahead of their original dates`;
    if (late.length) summary += `; ${late.length} slipped (largest: "${late[0].name}", ${late[0].days} days)`;
    summary += endSlipDays
      ? `. The last milestone is now due ${forecastEnd}, ${endSlipDays} days after the planned ${plannedEnd}.`
      : `. The program still finishes by the planned ${plannedEnd}.`;
  }
  return { dated: dated.length, onPlan: dated.length - late.length, slips, plannedEnd, forecastEnd, endSlipDays, summary };
}

/** Health for the whole program, for each component, and against the original plan. */
export function computeHealth(p: ProgramSnapshot, now: Date = new Date()): Health {
  // Components come from milestones, plus any component that so far only has risks.
  const names = [...new Set([...p.milestones.map((m) => m.component || GENERAL), ...p.risks.flatMap((r) => (r.component ? [r.component] : []))])];
  const components: ComponentHealth[] = names.map((name) => {
    const milestones = p.milestones.filter((m) => (m.component || GENERAL) === name);
    const risks = p.risks.filter((r) => (r.component || "") === name);
    const own = rag({ name, milestones, risks, dependencies: [] }, now);
    return {
      name,
      rag: own.overall,
      reasons: own.reasons,
      milestones: milestones.length,
      done: milestones.filter((m) => m.status === "done").length,
      slipped: planVariance(milestones).slips.filter((s) => s.days > 0).length,
    };
  });
  return { ...rag(p, now), components, plan: planVariance(p.milestones) };
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
