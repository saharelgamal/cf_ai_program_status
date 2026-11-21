// WeeklyReportWorkflow: drafts the weekly status report, then waits for a human to approve it.
//
// Why a Workflow and not a plain function: each step is saved as it finishes, a failed
// LLM call is retried on its own, and the run can pause for days on waitForEvent until a
// reviewer approves, without anything running (or costing anything) while it waits.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { computeHealth } from "./status";
import { writeReport } from "./llm";
import type { ReviewInput } from "./program";

export interface ReportParams {
  programId: string;
  reportId: string;
}

export class WeeklyReportWorkflow extends WorkflowEntrypoint<Env, ReportParams> {
  async run(event: WorkflowEvent<ReportParams>, step: WorkflowStep) {
    const { programId, reportId } = event.payload;
    const program = () => this.env.PROGRAM.get(this.env.PROGRAM.idFromName(programId));

    // 1. Read the tracker and this week's updates from the program's Durable Object.
    const input = await step.do("load program", () => program().getReportInput());

    // 2. Set the red / amber / green colour with fixed rules, not the LLM.
    const health = await step.do("score health", async () => computeHealth(input.program));

    // 3. Ask the LLM to write the report. Retried on its own if Workers AI fails.
    let draft: string;
    try {
      draft = await step.do(
        "draft report",
        { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "2 minutes" },
        () => writeReport(this.env, input.program, health, input.recentUpdates, new Date().toISOString().slice(0, 10)),
      );
    } catch (err) {
      await step.do("mark failed", () => program().markFailed(reportId, `The LLM call failed: ${(err as Error).message}`));
      return { status: "failed" };
    }

    // 4. Save the draft and show it to reviewers.
    await step.do("save draft", () => program().saveDraft(reportId, draft, health));

    // 5. Human in the loop: pause until a reviewer approves or asks for changes (up to a week).
    let review: ReviewInput;
    try {
      const reviewEvent = await step.waitForEvent<ReviewInput>("wait for reviewer", { type: "review", timeout: "7 days" });
      review = reviewEvent.payload;
    } catch {
      await step.do("mark expired", () => program().markExpired(reportId));
      return { status: "expired" };
    }

    // 6. Record the decision. An approved report becomes final; edits by the reviewer win over the draft.
    await step.do("record review", () => program().recordReview(reportId, review));
    return { status: review.approved ? "approved" : "changes_requested" };
  }
}
