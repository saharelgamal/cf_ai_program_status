// The Worker: a small JSON API in front of the program Durable Objects and the report Workflow.
// Static files in ./public (the chat UI) are served by Workers Static Assets before this code runs.

import type { ReviewInput } from "./program";

export { ProgramRoom } from "./program";
export { WeeklyReportWorkflow } from "./workflow";

const UUID = "[0-9a-f-]{36}";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

async function body<T>(request: Request): Promise<Partial<T>> {
  try {
    return (await request.json()) as Partial<T>;
  } catch {
    return {};
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // Create a program.
      if (method === "POST" && path === "/api/programs") {
        const { name } = await body<{ name: string }>(request);
        if (!name?.trim()) return json({ error: "Give the program a name." }, 400);
        const id = crypto.randomUUID();
        const program = env.PROGRAM.get(env.PROGRAM.idFromName(id));
        return json(await program.create(id, name.trim()), 201);
      }

      const match = path.match(new RegExp(`^/api/programs/(${UUID})(/.*)?$`));
      if (!match) return env.ASSETS.fetch(request);

      const [, id, rest = ""] = match;
      const program = env.PROGRAM.get(env.PROGRAM.idFromName(id));
      if (!(await program.exists())) return json({ error: "No program with that id." }, 404);

      // Read the whole program: chat, tracker, health and reports.
      if (method === "GET" && rest === "") return json(await program.getState());

      // Post a status update in chat.
      if (method === "POST" && rest === "/updates") {
        const { author, text } = await body<{ author: string; text: string }>(request);
        if (!text?.trim()) return json({ error: "The update is empty." }, 400);
        return json(await program.chat(author ?? "", text));
      }

      // Draft this week's report now (starts the Workflow).
      if (method === "POST" && rest === "/reports") {
        return json(await program.startReport("manual"), 202);
      }

      // Approve or request changes on a draft (sends an event to the paused Workflow).
      const review = rest.match(/^\/reports\/([\w-]+)\/review$/);
      if (method === "POST" && review) {
        const reportId = review[1];
        const input = await body<ReviewInput>(request);
        const reviewer = input.reviewer?.trim();
        if (!reviewer) return json({ error: "Add the reviewer's name." }, 400);
        if (!(await program.canReview(reportId))) return json({ error: "That report isn't waiting for review." }, 409);
        const payload: ReviewInput = {
          approved: input.approved === true,
          reviewer: reviewer.slice(0, 60),
          note: (input.note ?? "").slice(0, 500),
          editedText: typeof input.editedText === "string" ? input.editedText.slice(0, 5000) : null,
        };
        const instance = await env.REPORT_WORKFLOW.get(reportId);
        await instance.sendEvent({ type: "review", payload });
        return json({ ok: true }, 202);
      }

      // Turn the Monday-morning report on or off.
      if (method === "POST" && rest === "/schedule") {
        const { enabled } = await body<{ enabled: boolean }>(request);
        return json({ weeklySchedule: await program.setWeeklySchedule(enabled === true) });
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: (err as Error).message || "Something went wrong." }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
