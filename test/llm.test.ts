import { describe, expect, it } from "vitest";
import { idFor, mockTurn, sanitizeTurn } from "../src/llm";

describe("sanitizeTurn (model output is never trusted as-is)", () => {
  it("keeps valid fields and drops bad values", () => {
    const t = sanitizeTurn({
      reply: "Got it.",
      milestones: [
        { name: "EU rollout", status: "at_risk", due: "2026-12-12", owner: "Priya" },
        { name: "Bad", status: "exploded", due: "next week" },
        { status: "done" },
      ],
      risks: [{ description: "Vendor delay", severity: "catastrophic" }],
      dependencies: "not a list",
    });
    expect(t.reply).toBe("Got it.");
    expect(t.milestones).toHaveLength(2);
    expect(t.milestones[0]).toMatchObject({ name: "EU rollout", status: "at_risk", due: "2026-12-12" });
    expect(t.milestones[1]).toMatchObject({ name: "Bad", status: undefined, due: undefined });
    expect(t.risks[0].severity).toBeUndefined();
    expect(t.dependencies).toEqual([]);
  });

  it("falls back to a polite reply when the model returns nothing useful", () => {
    expect(sanitizeTurn(null).reply).toMatch(/couldn't process/);
  });
});

describe("idFor", () => {
  it("prefers the id the model gave, else slugifies the name", () => {
    expect(idFor({ id: "eu-rollout", name: "whatever" })).toBe("eu-rollout");
    expect(idFor({ name: "EU Rollout" })).toBe("eu-rollout");
    expect(idFor({ description: "Vendor delay on optics" })).toBe("vendor-delay-on-optics");
  });
});

describe("mockTurn (offline mode)", () => {
  it("extracts a slipping milestone, a risk and a dependency, and asks follow-ups", () => {
    const t = mockTurn(
      "Canary rollout: done in 3 PoPs. EU racks: delayed by vendor. Risk: optics shortage could block Q1. Waiting on DC ops for power.",
      "Priya",
      "2026-11-21",
    );
    expect(t.milestones.map((m) => [m.name, m.status])).toEqual([
      ["Canary rollout", "done"],
      ["EU racks", "at_risk"],
    ]);
    expect(t.risks[0]).toMatchObject({ severity: "medium", owner: "Priya" });
    expect(t.dependencies).toHaveLength(1);
    expect(t.reply).toContain("due date");
  });
});
