# Prompt history

This project was built with AI-assisted coding, using Claude (Anthropic) as the coding assistant.
I set the goal, picked the use case, and reviewed the design and the result. Claude wrote the code,
tests and docs, and ran them locally. Below are the prompts, in order.

## 1. My prompts

> ok I have been working on Claude on a position with CloudFlare - how can i let you access it so that we get to work on a required app

> i do not have a cloudflare account

The assistant first proposed a "Change Readiness Assistant" (a go/no-go review for production changes) and
started building it. I paused it and picked a different use case from my list of ideas:

> pause for now please

> ok, so go to the first point then - program status tracking and updates

> so we don't need a working app ?

> can we do that so that I can see it working

After the first version was on GitHub, I tried it and asked for changes:

> how can i run it locally ?

> ok give me valid status I can use to test

> can we add a field to show who is populating the updates ? Or is this linked to whoever is signed to the app ?

> Ok - i need to include some changes. 1. in the milestones, include the name, the team/item included in the project, so that the output is more descriptive 2. the report should have a summary of the status of each component followed by an overall summary with regards to where we stand with respect to the original plan

> I want the name and the team and what everyone is assigned to to be automatically populated in the status update table next to it

## 2. Task brief given to the coding assistant

From the job posting's optional assignment:

> Build a type of AI-powered application on Cloudflare. An AI-powered application should include the following components:
> LLM (recommend using Llama 3.3 on Workers AI), or an external LLM of your choice;
> Workflow / coordination (recommend using Workflows, Workers or Durable Objects);
> User input via chat or voice (recommend using Pages or Realtime);
> Memory or state.
> AI-assisted coding is encouraged, but you have to submit prompt history.

The brief for the Program Status Agent:

> Build a Program Status Agent. It ties to the posting lines "Build automations and AI agents to handle routine
> program administration at scale" and "rigorous human-in-the-loop review of AI output". Team members send status
> updates in chat; the agent keeps per-program state (milestones, risks, dependencies, owners) in memory, asks
> follow-ups when an update is vague, and on demand or on a schedule drafts an executive weekly status report that a
> human approves before it is final. Use Workers AI (Llama 3.3), Durable Objects for state, a Workflow for the
> report-and-approve step, and a chat UI. Keep it simple enough to explain each part in an interview. Include a
> README and this PROMPTS.md. Test what can be tested locally.

## 3. Design decisions made while building

These were the assistant's proposals, kept in the final code:

- One Durable Object per program, using its built-in SQLite database for chat, tracker items and reports.
- The LLM extracts structured changes with Workers AI JSON mode; all model output is validated before it is stored.
- Red / amber / green health is computed by fixed rules (`src/status.ts`), not by the LLM, so it can be audited.
- The weekly report is a Workflow: load, score, draft (LLM call retried on failure), save, then `waitForEvent`
  for a named reviewer. A reviewer's edits replace the draft in the final report.
- A Durable Object alarm drafts the report every Monday at 9 AM Pacific when the schedule is on.
- An offline mode (`npm run dev:offline`) swaps the LLM for keyword rules, so the app runs and can be tested with no Cloudflare account.
- Plain HTML and JavaScript for the UI, with no build step, to keep the project small and readable.
- Every update records who posted it ("Posting as"), and every tracker item shows who last changed it.
- Each milestone belongs to a component (team or workstream) and keeps its original plan date, set once from
  its first due date and never moved. The same health rules run per component, and a plan comparison counts
  slipped milestones, the largest slip and how far the end date has moved. The report is ordered: status by
  component, then the overall position against the original plan.
- A status updates table beside the chat shows each update's poster, team and assignments, worked out from the
  tracker rather than typed in. An update that names no team is filed under the poster's team.

## 4. Prompts the app sends to the LLM at runtime

Both live in `src/llm.ts`:

- `turnSystemPrompt`: turns one status update into tracker changes and decides whether to ask a follow-up question.
- `reportPrompt`: writes the weekly executive report from the tracker, this week's updates, the rule-based health colours (overall and per component) and the computed comparison with the original plan.
