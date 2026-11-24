import { describe, expect, it } from "vitest";
import { demoProgram } from "../src/demo";
import { computeHealth, roster } from "../src/status";

describe("demo program", () => {
  const now = new Date("2026-11-24T17:00:00Z");
  const demo = demoProgram(now);
  const health = computeHealth(demo, now);

  it("is full enough to show every part of the dashboard", () => {
    expect(demo.milestones).toHaveLength(11);
    expect(health.overall).toBe("RED");
    expect(health.components.map((c) => c.name)).toEqual(["Network", "DC ops", "Hardware", "Software", "Security"]);
    expect(health.plan.slips.filter((s) => s.days > 0)).toHaveLength(3);
    expect(health.stale.length).toBeGreaterThan(0);
    expect(roster(demo).map((p) => p.name)).toContain("Lena");
  });

  it("has unique ids and no timestamps in the future", () => {
    for (const list of [demo.milestones, demo.risks, demo.dependencies]) {
      expect(new Set(list.map((i) => i.id)).size).toBe(list.length);
    }
    const early = new Date("2026-11-24T01:00:00Z");
    for (const m of demoProgram(early).messages) expect(Date.parse(m.at)).toBeLessThanOrEqual(early.getTime());
  });
});
