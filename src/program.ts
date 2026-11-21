// ProgramRoom: one Durable Object per program. It is the app's memory.
// Each instance has its own SQLite database with the chat, the tracker (milestones,
// risks, dependencies) and the weekly reports. A Durable Object handles one request
// at a time, so two people posting updates at once can't overwrite each other.

import { DurableObject } from "cloudflare:workers";
import { computeHealth, nextMondayMorning, GENERAL, roster, teamOf, type Dependency, type Person, type Health, type Milestone, type ProgramSnapshot, type Risk } from "./status";
import { idFor, runTurn, type ChatMessage, type MilestoneChange, type TurnResult } from "./llm";

export type ReportStatus = "drafting" | "awaiting_approval" | "approved" | "changes_requested" | "expired" | "failed";

export interface Report {
  id: string; // also the Workflow instance id
  trigger: "manual" | "schedule";
  status: ReportStatus;
  health: Health | null;
  draft: string | null;
  /** The approved text. If the reviewer edited the draft, this is their edited version. */
  final: string | null;
  reviewer: string | null;
  reviewNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewInput {
  approved: boolean;
  reviewer: string;
  note: string;
  editedText: string | null;
}

export interface ProgramState extends ProgramSnapshot {
  id: string;
  createdAt: string;
  messages: Array<ChatMessage & { author: string; at: string }>;
  health: Health;
  /** Each person's team and assignments, worked out from the tracker. */
  people: Person[];
  reports: Report[];
  weeklySchedule: string | null; // ISO time of the next scheduled report, or null
}

type ItemKind = "milestone" | "risk" | "dependency";

const MAX_MESSAGE_CHARS = 2000;
const HISTORY_FOR_LLM = 10;

export class ProgramRoom extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL, author TEXT NOT NULL, content TEXT NOT NULL, at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS items (
        kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (kind, id)
      );
      CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
  }

  // ---- small helpers -------------------------------------------------------

  private getMeta(key: string): string | null {
    return this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec("INSERT INTO meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  private addMessage(role: ChatMessage["role"], author: string, content: string): void {
    this.sql.exec(
      "INSERT INTO messages (role, author, content, at) VALUES (?, ?, ?, ?)",
      role,
      author,
      content,
      new Date().toISOString(),
    );
  }

  private items<T>(kind: ItemKind): T[] {
    return this.sql
      .exec<{ data: string }>("SELECT data FROM items WHERE kind = ? ORDER BY rowid", kind)
      .toArray()
      .map((r) => JSON.parse(r.data) as T);
  }

  /**
   * Insert or update one tracker item. Fields the update leaves out keep their old value.
   * `finish` can adjust the merged item before it is saved (used for the original plan date).
   */
  private upsert<T extends { id: string }>(
    kind: ItemKind,
    id: string,
    defaults: T,
    change: Partial<T>,
    by: string,
    finish: (next: T) => T = (next) => next,
  ): void {
    const row = this.sql.exec<{ data: string }>("SELECT data FROM items WHERE kind = ? AND id = ?", kind, id).toArray()[0];
    const current: T = row ? { ...defaults, ...JSON.parse(row.data) } : defaults;
    const defined = Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)) as Partial<T>;
    const next = finish({ ...current, ...defined, id, updatedAt: new Date().toISOString(), updatedBy: by });
    this.sql.exec(
      "INSERT INTO items (kind, id, data) VALUES (?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data",
      kind,
      id,
      JSON.stringify(next),
    );
  }

  private applyTurn(turn: TurnResult, by: string): void {
    // A milestone or risk with no component takes the team its owner (or the poster) already works in.
    const people = roster(this.snapshot());
    for (const { originalDue, baselineDue: _ignored, ...change } of turn.milestones as Array<MilestoneChange & { baselineDue?: string }>) {
      // "General" means the update named no team: let the default (the owner's team) fill it in.
      const m = { ...change, component: change.component === GENERAL ? undefined : change.component };
      const defaults: Milestone = {
        id: "", name: m.name, component: teamOf(people, m.owner || by), owner: "", due: "", baselineDue: "", status: "on_track", note: "", updatedAt: "",
      };
      // The original plan date is set once: from the date the writer calls the original one,
      // otherwise from the first due date the milestone gets. Later updates move `due`, never the baseline.
      this.upsert<Milestone>("milestone", idFor(m), defaults, m, by, (next) =>
        next.baselineDue ? next : { ...next, baselineDue: originalDue || next.due || "" },
      );
    }
    for (const change of turn.risks) {
      const r = { ...change, component: change.component === GENERAL ? undefined : change.component };
      this.upsert<Risk>("risk", idFor(r), { id: "", description: r.description, component: teamOf(people, r.owner || by), severity: "medium", owner: "", mitigation: "", status: "open", updatedAt: "" }, r, by);
    }
    for (const d of turn.dependencies) {
      this.upsert<Dependency>("dependency", idFor(d), { id: "", description: d.description, team: "", neededBy: "", status: "open", updatedAt: "" }, d, by);
    }
  }

  private snapshot(): ProgramSnapshot {
    return {
      name: this.getMeta("name") ?? "",
      milestones: this.items<Milestone>("milestone"),
      risks: this.items<Risk>("risk"),
      dependencies: this.items<Dependency>("dependency"),
    };
  }

  private getReport(id: string): Report | null {
    const row = this.sql.exec<{ data: string }>("SELECT data FROM reports WHERE id = ?", id).toArray()[0];
    return row ? (JSON.parse(row.data) as Report) : null;
  }

  private saveReport(report: Report): Report {
    report.updatedAt = new Date().toISOString();
    this.sql.exec(
      "INSERT INTO reports (id, data, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
      report.id,
      JSON.stringify(report),
      report.createdAt,
    );
    return report;
  }

  private reportInFlight(): Report | null {
    return (
      this.sql
        .exec<{ data: string }>("SELECT data FROM reports ORDER BY created_at DESC LIMIT 1")
        .toArray()
        .map((r) => JSON.parse(r.data) as Report)
        .find((r) => r.status === "drafting" || r.status === "awaiting_approval") ?? null
    );
  }

  // ---- RPC methods called by the Worker --------------------------------------

  async create(id: string, name: string): Promise<ProgramState> {
    if (!this.getMeta("name")) {
      this.setMeta("id", id);
      this.setMeta("name", name.slice(0, 120));
      this.setMeta("createdAt", new Date().toISOString());
      this.addMessage(
        "assistant",
        "agent",
        `Tracking "${name}". Send me status updates in plain words: what moved, what's slipping and why, ` +
          `new risks, and what you're waiting on from other teams. I'll keep the tracker current and draft the weekly report.`,
      );
    }
    return this.getState();
  }

  async exists(): Promise<boolean> {
    return this.getMeta("name") !== null;
  }

  async getState(): Promise<ProgramState> {
    const snap = this.snapshot();
    return {
      ...snap,
      id: this.getMeta("id") ?? "",
      createdAt: this.getMeta("createdAt") ?? "",
      messages: this.sql
        .exec<{ role: string; author: string; content: string; at: string }>(
          "SELECT role, author, content, at FROM messages ORDER BY id",
        )
        .toArray()
        .map((m) => ({ role: m.role as ChatMessage["role"], author: m.author, content: m.content, at: m.at })),
      health: computeHealth(snap),
      people: roster(snap),
      reports: this.sql
        .exec<{ data: string }>("SELECT data FROM reports ORDER BY created_at DESC LIMIT 10")
        .toArray()
        .map((r) => JSON.parse(r.data) as Report),
      weeklySchedule: this.getMeta("weeklySchedule"),
    };
  }

  /** One status update: store it, let the LLM extract changes, merge them into the tracker. */
  async chat(author: string, text: string): Promise<ProgramState> {
    const message = text.trim().slice(0, MAX_MESSAGE_CHARS);
    const speaker = author.trim().slice(0, 60) || "Anonymous";
    if (!message) return this.getState();

    this.addMessage("user", speaker, message);
    const history = this.sql
      .exec<{ role: string; author: string; content: string }>(
        "SELECT role, author, content FROM (SELECT * FROM messages ORDER BY id DESC LIMIT ?) ORDER BY id",
        HISTORY_FOR_LLM,
      )
      .toArray()
      .map((m) => ({
        role: m.role as ChatMessage["role"],
        content: m.role === "user" ? `${m.author}: ${m.content}` : m.content,
      }));

    const turn = await runTurn(this.env, this.snapshot(), speaker, history, new Date().toISOString().slice(0, 10));
    this.applyTurn(turn, speaker);
    this.addMessage("assistant", "agent", turn.reply);
    return this.getState();
  }

  /** Starts the weekly report Workflow, unless a report is already being drafted or reviewed. */
  async startReport(trigger: Report["trigger"]): Promise<Report> {
    const inFlight = this.reportInFlight();
    if (inFlight) return inFlight;

    const programId = this.getMeta("id") ?? "";
    const reportId = `${programId}-${Date.now()}`;
    const now = new Date().toISOString();
    const report = this.saveReport({
      id: reportId, trigger, status: "drafting", health: null, draft: null, final: null,
      reviewer: null, reviewNote: null, createdAt: now, updatedAt: now,
    });
    try {
      await this.env.REPORT_WORKFLOW.create({ id: reportId, params: { programId, reportId } });
    } catch (err) {
      report.status = "failed";
      report.reviewNote = `Could not start the report: ${(err as Error).message}`;
      return this.saveReport(report);
    }
    return report;
  }

  /** Checks that a report is waiting for review before the Worker sends the reviewer's decision to the Workflow. */
  async canReview(reportId: string): Promise<boolean> {
    return this.getReport(reportId)?.status === "awaiting_approval";
  }

  /** Turns the weekly schedule on or off. Each program schedules its own report with a Durable Object alarm. */
  async setWeeklySchedule(enabled: boolean): Promise<string | null> {
    if (!enabled) {
      await this.ctx.storage.deleteAlarm();
      this.sql.exec("DELETE FROM meta WHERE key = 'weeklySchedule'");
      return null;
    }
    const next = nextMondayMorning(new Date());
    await this.ctx.storage.setAlarm(next);
    this.setMeta("weeklySchedule", next.toISOString());
    return next.toISOString();
  }

  /** Runs when the alarm fires: draft this week's report, then schedule next week's. */
  async alarm(): Promise<void> {
    await this.startReport("schedule");
    await this.setWeeklySchedule(true);
  }

  // ---- RPC methods called by the Workflow ------------------------------------

  async getReportInput(): Promise<{ program: ProgramSnapshot; recentUpdates: string[] }> {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const recentUpdates = this.sql
      .exec<{ author: string; content: string; at: string }>(
        "SELECT author, content, at FROM messages WHERE role = 'user' AND at >= ? ORDER BY id",
        weekAgo,
      )
      .toArray()
      .map((m) => `- ${m.at.slice(0, 10)} ${m.author}: ${m.content}`);
    return { program: this.snapshot(), recentUpdates };
  }

  async saveDraft(reportId: string, draft: string, health: Health): Promise<void> {
    const report = this.getReport(reportId);
    if (!report) return;
    this.saveReport({ ...report, status: "awaiting_approval", draft, health });
    this.addMessage("assistant", "agent", `This week's report draft is ready (${health.overall}). It needs a reviewer's approval before it's final.`);
  }

  async recordReview(reportId: string, review: ReviewInput): Promise<Report | null> {
    const report = this.getReport(reportId);
    if (!report) return null;
    const final = review.approved ? (review.editedText?.trim() || report.draft) : null;
    const saved = this.saveReport({
      ...report,
      status: review.approved ? "approved" : "changes_requested",
      final,
      reviewer: review.reviewer,
      reviewNote: review.note,
    });
    const edited = review.approved && review.editedText?.trim() && review.editedText.trim() !== report.draft;
    this.addMessage(
      "assistant",
      "agent",
      review.approved
        ? `${review.reviewer} approved this week's report${edited ? " with edits" : ""}. It's final.`
        : `${review.reviewer} asked for changes to the report${review.note ? `: "${review.note}".` : "."} Post updates, then draft it again.`,
    );
    return saved;
  }

  async markExpired(reportId: string): Promise<void> {
    const report = this.getReport(reportId);
    if (report) this.saveReport({ ...report, status: "expired" });
  }

  async markFailed(reportId: string, reason: string): Promise<void> {
    const report = this.getReport(reportId);
    if (report) this.saveReport({ ...report, status: "failed", reviewNote: reason });
  }
}
