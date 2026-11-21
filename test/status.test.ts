import { describe, expect, it } from "vitest";
import { computeHealth, nextMondayMorning, slugify, type ProgramSnapshot } from "../src/status";

const NOW = new Date("2026-11-21T12:00:00Z");
const fresh = "2026-11-20T12:00:00Z";
const old = "2026-11-01T12:00:00Z";

function program(over: Partial<ProgramSnapshot> = {}): ProgramSnapshot {
  return { name: "Test", milestones: [], risks: [], dependencies: [], ...over };
}
const ms = (o: object) => ({ id: "m", name: "Rollout", component: "Network", owner: "Priya", due: "2026-12-12", baselineDue: "2026-12-12", status: "on_track", note: "", updatedAt: fresh, ...o }) as never;
const risk = (o: object) => ({ id: "r", description: "Vendor delay", severity: "medium", owner: "", mitigation: "", status: "open", updatedAt: fresh, ...o }) as never;
const dep = (o: object) => ({ id: "d", description: "Racks from DC ops", team: "DC ops", neededBy: "2026-12-01", status: "open", updatedAt: fresh, ...o }) as never;

describe("computeHealth", () => {
  it("is GREEN when everything is on track", () => {
    const h = computeHealth(program({ milestones: [ms({})] }), NOW);
    expect(h.overall).toBe("GREEN");
    expect(h.stale).toEqual([]);
  });

  it("is AMBER for an at-risk milestone", () => {
    expect(computeHealth(program({ milestones: [ms({ status: "at_risk" })] }), NOW).overall).toBe("AMBER");
  });

  it("is AMBER for an overdue milestone even if marked on track", () => {
    const h = computeHealth(program({ milestones: [ms({ due: "2026-11-10" })] }), NOW);
    expect(h.overall).toBe("AMBER");
    expect(h.reasons[0]).toContain("past its due date");
  });

  it("ignores done milestones, even overdue ones", () => {
    expect(computeHealth(program({ milestones: [ms({ status: "done", due: "2026-11-01" })] }), NOW).overall).toBe("GREEN");
  });

  it("is RED for an off-track milestone or an open high risk", () => {
    expect(computeHealth(program({ milestones: [ms({ status: "off_track" })] }), NOW).overall).toBe("RED");
    expect(computeHealth(program({ risks: [risk({ severity: "high" })] }), NOW).overall).toBe("RED");
  });

  it("ignores closed risks and only flags unmitigated medium risks", () => {
    expect(computeHealth(program({ risks: [risk({ severity: "high", status: "closed" })] }), NOW).overall).toBe("GREEN");
    expect(computeHealth(program({ risks: [risk({})] }), NOW).overall).toBe("AMBER");
    expect(computeHealth(program({ risks: [risk({ mitigation: "Second vendor" })] }), NOW).overall).toBe("GREEN");
  });

  it("is AMBER for a late open dependency", () => {
    expect(computeHealth(program({ dependencies: [dep({ neededBy: "2026-11-15" })] }), NOW).overall).toBe("AMBER");
    expect(computeHealth(program({ dependencies: [dep({ neededBy: "2026-11-15", status: "resolved" })] }), NOW).overall).toBe("GREEN");
  });

  it("lists open items with no update for a week as stale", () => {
    const h = computeHealth(program({ milestones: [ms({ updatedAt: old })], risks: [risk({ updatedAt: old, mitigation: "x" })] }), NOW);
    expect(h.stale).toHaveLength(2);
  });
});

describe("by component and against the original plan", () => {
  it("scores each component with the same rules", () => {
    const h = computeHealth(
      program({
        milestones: [
          ms({ id: "a", name: "Backbone upgrade", component: "Network" }),
          ms({ id: "b", name: "Rack install", component: "DC ops", status: "at_risk" }),
          ms({ id: "c", name: "Firmware", component: "", status: "done" }),
        ],
        risks: [risk({ component: "DC ops", severity: "high" })],
      }),
      NOW,
    );
    expect(h.overall).toBe("RED");
    expect(h.components.map((c) => [c.name, c.rag])).toEqual([
      ["Network", "GREEN"],
      ["DC ops", "RED"],
      ["General", "GREEN"],
    ]);
    expect(h.components[2].done).toBe(1);
  });

  it("measures slips against the original dates and the planned end", () => {
    const h = computeHealth(
      program({
        milestones: [
          ms({ id: "a", name: "Backbone upgrade", due: "2026-12-10", baselineDue: "2026-12-10" }),
          ms({ id: "b", name: "Rack install", component: "DC ops", due: "2027-01-20", baselineDue: "2026-12-15" }),
          ms({ id: "c", name: "No date yet", due: "", baselineDue: "" }),
        ],
      }),
      NOW,
    );
    expect(h.plan.dated).toBe(2);
    expect(h.plan.onPlan).toBe(1);
    expect(h.plan.slips[0]).toMatchObject({ name: "Rack install", component: "DC ops", days: 36 });
    expect(h.plan.endSlipDays).toBe(36);
    expect(h.plan.summary).toContain("1 of 2 dated milestones");
    expect(h.plan.summary).toContain("36 days after the planned 2026-12-15");
    expect(h.components.find((c) => c.name === "DC ops")?.slipped).toBe(1);
  });

  it("says when there are no dates to compare", () => {
    expect(computeHealth(program(), NOW).plan.summary).toContain("No milestone has a date yet");
  });
});

describe("helpers", () => {
  it("slugify makes stable ids", () => {
    expect(slugify("EU PoP Rollout!")).toBe("eu-pop-rollout");
    expect(slugify("eu pop rollout")).toBe("eu-pop-rollout");
  });

  it("nextMondayMorning finds the coming Monday 17:00 UTC", () => {
    expect(nextMondayMorning(new Date("2026-11-21T12:00:00Z")).toISOString()).toBe("2026-11-23T17:00:00.000Z"); // Saturday
    expect(nextMondayMorning(new Date("2026-11-23T10:00:00Z")).toISOString()).toBe("2026-11-23T17:00:00.000Z"); // Monday morning
    expect(nextMondayMorning(new Date("2026-11-23T18:00:00Z")).toISOString()).toBe("2026-11-30T17:00:00.000Z"); // Monday evening
  });
});
