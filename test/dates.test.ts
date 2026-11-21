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
