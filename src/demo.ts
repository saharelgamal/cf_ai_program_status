// A realistic demo program, so the dashboard is full the first time someone opens the app.
// Dates are relative to the day the demo is created, so the demo always looks current.
// Seeding writes straight to the tracker: it does not call the LLM.

import type { Dependency, Milestone, Risk } from "./status";

export interface DemoMessage {
  role: "user" | "assistant";
  author: string;
  content: string;
  at: string;
}

export interface DemoProgram {
  name: string;
  milestones: Milestone[];
  risks: Risk[];
  dependencies: Dependency[];
  messages: DemoMessage[];
}

const DAY = 86_400_000;

export function demoProgram(now: Date = new Date()): DemoProgram {
  const day = (offset: number) => new Date(now.getTime() + offset * DAY).toISOString().slice(0, 10);
  const ago = (days: number, hour = 16) => {
    const d = new Date(now.getTime() - days * DAY);
    d.setUTCHours(hour, 15, 0, 0);
    // Never in the future, even when the demo is created early in the day.
    return (d > now ? new Date(now.getTime() - (24 - hour) * 60_000) : d).toISOString();
  };

  const m = (
    component: string, name: string, owner: string, baseline: number, due: number,
    status: Milestone["status"], note: string, updated: number,
  ): Milestone => ({
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    name, component, owner, baselineDue: day(baseline), due: day(due), status, note,
    updatedAt: ago(updated), updatedBy: owner,
  });

  const milestones: Milestone[] = [
    m("Network", "Canary rollout in 3 PoPs", "Priya", -18, -18, "done", "Live in FRA, AMS and WAW with no customer impact.", 3),
    m("Network", "Backbone upgrade FRA–AMS", "Priya", 16, 23, "at_risk", "2 of 4 line cards installed; the rest wait on optics.", 1),
    m("Network", "Peering turn-up at DE-CIX", "Jonas", 30, 30, "on_track", "Ports ordered, LOAs received.", 2),
    m("DC ops", "FRA rack install (24 racks)", "Marco", 9, 45, "at_risk", "Rack vendor delay; 10 of 24 racks on site.", 1),
    m("DC ops", "Power feed upgrade FRA", "Marco", 6, 6, "on_track", "Electrical work booked for the weekend.", 2),
    m("DC ops", "AMS cage build", "Aisha", -2, -2, "on_track", "Final inspection still to book.", 4),
    m("Hardware", "Optics delivery (120 units)", "Lena", 3, 17, "off_track", "Supplier missed the ship date; second supplier qualified.", 0),
    m("Hardware", "Server burn-in (480 nodes)", "Lena", 12, 12, "on_track", "Burn-in racks reserved in WAW.", 2),
    m("Software", "Config automation for new PoPs", "Daniel", -9, -11, "done", "Shipped two days early.", 5),
    m("Software", "Edge software 4.2 release", "Daniel", 25, 25, "on_track", "Release candidate passed canary.", 1),
    m("Security", "Penetration test of new PoPs", "Sofia", 38, 38, "on_track", "Scope agreed with the vendor.", 10),
  ];

  const r = (
    component: string, description: string, severity: Risk["severity"], owner: string,
    mitigation: string, status: Risk["status"], updated: number,
  ): Risk => ({
    id: description.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60).replace(/-$/, ""),
    description, component, severity, owner, mitigation, status, updatedAt: ago(updated), updatedBy: owner,
  });

  const risks: Risk[] = [
    r("Hardware", "Optics shortage could delay Q1 turn-ups", "high", "Lena", "Second supplier qualified; first lot ships next week.", "open", 0),
    r("DC ops", "Rack vendor capacity in FRA", "medium", "Marco", "", "open", 1),
    r("Network", "Holiday change freeze squeezes cutover windows", "medium", "Priya", "Front-load cutovers before the freeze.", "open", 2),
    r("Software", "Too few engineers for night cutovers", "low", "Daniel", "Contractor on call for cutover nights.", "open", 3),
    r("Network", "Customs hold on line cards", "medium", "Priya", "Released by customs.", "closed", 6),
  ];

  const d = (description: string, team: string, neededBy: number, status: Dependency["status"], updated: number, by: string): Dependency => ({
    id: description.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60).replace(/-$/, ""),
    description, team, neededBy: day(neededBy), status, updatedAt: ago(updated), updatedBy: by,
  });

  const dependencies: Dependency[] = [
    d("Second 400A power feed in FRA", "DC power", 5, "open", 2, "Marco"),
    d("AMS colocation contract signed", "Legal", -2, "open", 8, "Aisha"),
    d("Purchase order for 120 optics", "Procurement", 8, "open", 1, "Lena"),
    d("Capacity plan sign-off", "Network planning", -12, "resolved", 9, "Priya"),
  ];

  const say = (days: number, hour: number, author: string, content: string, reply: string): DemoMessage[] => [
    { role: "user", author, content, at: ago(days, hour) },
    { role: "assistant", author: "agent", content: reply, at: ago(days, hour) },
  ];

  const messages: DemoMessage[] = [
    {
      role: "assistant", author: "agent", at: ago(10, 9),
      content: "This is a demo program filled with sample updates. Post your own updates to see the tracker, the health and the report change.",
    },
    ...say(10, 10, "Sofia", "Security - Penetration test of new PoPs: scope agreed with the vendor, due in about five weeks.",
      "Recorded the penetration test as on track. Thanks, that's clear."),
    ...say(5, 11, "Daniel", "Software - Config automation for new PoPs is done, two days early.",
      "Marked config automation as done, two days ahead of plan. Nice."),
    ...say(4, 15, "Aisha", "DC ops - AMS cage build is on track. Still waiting on Legal for the AMS colocation contract.",
      "Recorded the cage build and the dependency on Legal. When do you need the contract signed?"),
    ...say(3, 14, "Priya", "Network - Canary rollout is live in FRA, AMS and WAW with no customer impact.",
      "Marked the canary rollout as done."),
    ...say(2, 10, "Marco", "DC ops - Power feed upgrade in FRA is booked for the weekend. We need the second 400A feed from the DC power team first.",
      "Recorded the power feed upgrade as on track and the dependency on DC power. Thanks."),
    ...say(1, 9, "Marco", `DC ops - FRA rack install slips from ${day(9)} to ${day(45)}. The rack vendor is short on capacity; 10 of 24 racks are on site.`,
      "Moved the FRA rack install to its new date and marked it at risk. What's the mitigation for the vendor capacity risk?"),
    ...say(1, 13, "Priya", "Network - Backbone upgrade FRA–AMS is at risk: 2 of 4 line cards are in, the rest wait on optics.",
      "Marked the backbone upgrade at risk. Is the new date firm?"),
    ...say(0, 8, "Lena", `Hardware - Optics delivery is off track. The supplier missed the ship date; new date ${day(17)}. New risk: optics shortage, high, mitigated by a second supplier.`,
      "Marked optics delivery off track and recorded a high risk with its mitigation. This makes the program RED."),
  ];

  return { name: "EU edge capacity expansion (demo)", milestones, risks, dependencies, messages };
}
