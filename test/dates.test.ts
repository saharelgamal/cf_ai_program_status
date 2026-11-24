import { describe, expect, it } from "vitest";
import { mockTurn, normalizeDates } from "../src/llm";

const TODAY = "2026-11-21"; // a Saturday

describe("normalizeDates (offline mode)", () => {
  it.each([
    ["expected by mid dec", "expected by 2026-12-15"],
    ["mid December", "2026-12-15"],
    ["early January", "2027-01-07"],
    ["end of February", "2027-02-28"],
    ["late Nov", "2026-11-25"],
    ["Dec 3rd", "2026-12-03"],
    ["3 March 2027", "2027-03-03"],
    ["due in December", "due in 2026-12-31"],
    ["next Friday", "2026-11-27"],
    ["end of the month", "2026-11-30"],
    ["it may slip", "it may slip"],
    ["2026-12-01 stays", "2026-12-01 stays"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeDates(input, TODAY)).toBe(expected);
  });
});

describe("mockTurn understands everyday updates", () => {
  it("names the milestone after the work and reads 'mid dec'", () => {
    const t = mockTurn("Delay on the backbone deployment - expected by mid dec", "Sahar", TODAY);
    expect(t.milestones[0]).toMatchObject({ name: "Backbone deployment", due: "2026-12-15", status: "at_risk" });
    expect(t.reply).not.toContain("due date");
  });

  it("takes a short answer as the reply to its last question", () => {
    const first = mockTurn("Delay on the backbone deployment", "Sahar", TODAY);
    expect(first.reply).toContain('What\'s the due date for "Backbone deployment"?');
    const answer = mockTurn("mid december", "Sahar", TODAY, "", first.reply);
    expect(answer.milestones).toEqual([{ name: "Backbone deployment", due: "2026-12-15" }]);
    expect(answer.reply).toContain("2026-12-15");
  });

  it("takes a short team name as the answer to the team question", () => {
    const answer = mockTurn("Network team", "Sahar", TODAY, "", 'Which team or component is "Backbone deployment" part of?');
    expect(answer.milestones).toEqual([{ name: "Backbone deployment", component: "Network" }]);
  });
});

describe("offline mode updates items already in the tracker", () => {
  const program = {
    name: "Demo",
    milestones: [
      { id: "fra-rack-install-24-racks", name: "FRA rack install (24 racks)", component: "DC ops", owner: "Marco", due: "2026-12-10", baselineDue: "2026-12-01", status: "at_risk", note: "", updatedAt: "" },
      { id: "optics-delivery-120-units", name: "Optics delivery (120 units)", component: "Hardware", owner: "Lena", due: "2026-12-10", baselineDue: "2026-12-01", status: "off_track", note: "", updatedAt: "" },
      { id: "backbone-upgrade-fra-ams", name: "Backbone upgrade FRA–AMS", component: "Network", owner: "Priya", due: "2026-12-17", baselineDue: "2026-12-10", status: "at_risk", note: "", updatedAt: "" },
    ],
    risks: [{ id: "optics-shortage", description: "Optics shortage could delay Q1 turn-ups", component: "Hardware", severity: "high", owner: "Lena", mitigation: "", status: "open", updatedAt: "" }],
    dependencies: [{ id: "ams-contract", description: "AMS colocation contract signed", team: "Legal", neededBy: "2026-11-22", status: "open", updatedAt: "" }],
  } as never;

  it.each([
    ["FRA rack install is done", "fra-rack-install-24-racks", "done", undefined],
    ["Optics delivery is back on track", "optics-delivery-120-units", "on_track", undefined],
    ["The backbone upgrade slipped to mid January", "backbone-upgrade-fra-ams", "at_risk", "2027-01-15"],
  ])("%s", (text, id, status, due) => {
    const t = mockTurn(text, "Sahar", TODAY, "", "", program);
    expect(t.milestones).toHaveLength(1);
    expect(t.milestones[0]).toMatchObject({ id, status, ...(due ? { due } : {}) });
    expect(t.reply).not.toContain("Which team");
  });

  it("adds a new milestone when the subject is a different one", () => {
    const t = mockTurn("DC ops - AMS rack install is due Dec 20", "Sahar", TODAY, "", "", program);
    expect(t.milestones[0].id).toBeUndefined();
    expect(t.milestones[0].name).toBe("AMS rack install is due 2026-12-20".split(" is ")[0]);
  });

  it("closes a risk and resolves a dependency", () => {
    expect(mockTurn("The optics shortage risk is closed", "Lena", TODAY, "", "", program).risks[0]).toMatchObject({ id: "optics-shortage", status: "closed" });
    expect(mockTurn("Legal signed the AMS colocation contract", "Aisha", TODAY, "", "", program).dependencies[0]).toMatchObject({ id: "ams-contract", status: "resolved" });
  });

  it("doesn't take a full update as the answer to the last question", () => {
    const t = mockTurn("The backbone upgrade slipped to mid January", "Sahar", TODAY, "", 'What\'s the due date for "Something else"?', program);
    expect(t.milestones[0].id).toBe("backbone-upgrade-fra-ams");
  });
});
