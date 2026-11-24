# Program Status Agent (cf_ai_program_status)

An AI agent on Cloudflare that takes routine status tracking off a technical program manager's plate.

Team members post status updates in plain words in a chat. The agent turns each update into tracker
entries (milestones grouped by team or component, risks, dependencies, owners, dates), asks a short follow-up
when an update is vague, and drafts the weekly executive status report: a status for each component, then where
the program stands against its original plan. **A person reviews, edits and approves the report
before it becomes final.** The red / amber / green health colour is set by fixed, auditable rules, not by the LLM.

**Live demo:** _add your workers.dev link here after deploying_

## Why

On a large infrastructure program, a TPM spends hours each week chasing updates, normalising them into a
tracker and rewriting them for leadership. This agent automates that routine administration while keeping
a human in the loop on the one thing that leaves the team: the report leadership reads.

## How it maps to the assignment

| Required component | What this app uses | Where |
| --- | --- | --- |
| LLM | Llama 3.3 70B (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) on Workers AI, with JSON mode for structured extraction | `src/llm.ts` |
| Workflow / coordination | A Cloudflare **Workflow** drafts the report step by step, retries the LLM step on failure, then **pauses with `waitForEvent` until a reviewer approves** (up to 7 days) | `src/workflow.ts` |
| User input via chat | Chat UI (plain HTML/JS) served by Workers Static Assets | `public/` |
| Memory / state | One **Durable Object per program**, with its own SQLite database: chat history, tracker, reports. A Durable Object alarm schedules the Monday report | `src/program.ts` |

## Architecture

```
 Browser (chat UI, public/)
        │  JSON API
        ▼
 Worker (src/index.ts) ──────────────► Workflow: WeeklyReportWorkflow (src/workflow.ts)
        │  RPC                            1. load program        (from the Durable Object)
        ▼                                 2. score health        (fixed rules, src/status.ts)
 Durable Object: ProgramRoom              3. draft report        (Workers AI, retried 3x)
   (src/program.ts, one per program)      4. save draft          → status "awaiting approval"
   SQLite: messages, items, reports       5. waitForEvent "review" (pauses, up to 7 days)
   alarm: every Monday 9 AM PT ──────►    6. record review       → "approved" (final text) or "changes requested"
        │
        ▼
 Workers AI: Llama 3.3 (src/llm.ts)
```

### What happens on a status update

1. The UI posts `{ author, text }` to `/api/programs/:id/updates`.
2. The program's Durable Object stores the message and sends the LLM a system prompt with the current
   tracker plus the last 10 messages.
3. The LLM answers in JSON (Workers AI JSON mode): a short reply, plus changes to milestones, risks and dependencies.
4. The Durable Object **validates** the output (known statuses only, real `YYYY-MM-DD` dates, length limits)
   and merges it into the tracker. A field the update didn't mention keeps its old value.
5. The reply either confirms what was recorded or asks one or two follow-up questions
   (for example "What's the new date?" or "What's the mitigation?").

### Design choices

- **Rules decide the health colour, the LLM writes the words.** `computeHealth` in `src/status.ts` is a few
  lines anyone can read: RED for an off-track milestone or an open high risk; AMBER for at-risk or overdue
  milestones, late dependencies, or unmitigated medium risks. The report prompt tells the model to copy the colour, not choose it.
- **Human in the loop.** The Workflow cannot finish until a named reviewer approves or asks for changes.
  If the reviewer edits the draft, the edited text becomes the final report. Every decision is recorded with the reviewer's name.
- **Model output is untrusted.** `sanitizeTurn` drops anything that doesn't match the expected shape, and user
  messages are framed as information, not instructions, in the system prompt.
- **One Durable Object per program.** It processes one request at a time, so two people posting updates
  at once can't overwrite each other, and each program's data lives in its own small database.
- **Components and the original plan.** Every milestone belongs to a component (the team or workstream doing it)
  and keeps its original plan date, set from the first due date it was given and never moved by later updates.
  The same health rules run for each component, and `planVariance` counts how many milestones are still on their
  original dates, the largest slip, and how many days the last milestone has moved. The LLM writes the words around these numbers; it doesn't compute them.
- **Who works on what fills itself in.** Nobody maintains a team list. A person's team is the component of the
  work they own (open work counts most), and their assignments are their open milestones and risks. The
  **Status updates** table shows each update with the poster's name, team and assignments, and an update that
  names no team is filed under the poster's team.
- **Stale-update detection.** Open items nobody has updated for 7 days are listed under "Needs an update", the usual TPM chase list.

## The dashboard

The first visit opens a **demo program** already filled with a week of sample updates from seven people
across five teams, so every part of the screen has something to show:

- **Overall health** with the rules' reasons, and buttons to draft the weekly report or schedule it.
- **Key numbers:** milestones by status, open risks by severity, overdue items, end date against the plan,
  items with no update for a week, and how many updates came in this week from how many people.
- **Key numbers:** eight tiles (milestones, at risk, off track, open risks, overdue, end date vs plan, needs an
  update, updates this week). Click a tile to list the items behind its number; click a row to jump to that item.
- **Component cards:** each team's own red, amber or green, a progress bar by status, slips, open risks,
  the next milestone and who works there.
- **Timeline:** every milestone's original date against its current date, with the slip in days and a today line.
- **Risks by severity**, **dependencies** with how late or how soon each one is due, the **milestones** table,
  **recent updates** with each poster's team and assignments, and the **weekly report** for review.
- The **status chat** stays beside the dashboard. Each update redraws the dashboard at once, says what it
  changed ("FRA rack install: at risk → done", "Overall health: RED → AMBER") and highlights those items.
- **Milestone status:** on track, ahead of schedule, at risk, off track or done. A milestone is marked done only
  when the update says the work is finished: "will be completed Dec 4" keeps it open with the new date, and
  "it's not done" reopens it.

The demo is written straight to the tracker, so it costs no AI calls. Open it again from **All programs → Open the demo program**.

## Try it

1. Look around the demo, then create your own program (for example "EU edge capacity expansion").
2. Type your name in **Posting as** and post updates. Every update, and every tracker item it changes, records who posted it. For example:
   Name the team or component with each milestone, and say the original date when one moves:
   - `Network - Canary rollout is done in 3 PoPs. DC ops - FRA rack install is due 2026-12-15.`
   - `DC ops - FRA rack install slips to 2027-01-20, originally 2026-12-15, because of a vendor delay.`
   - `Hardware - New risk: optics shortage could block Q1 turn-ups, high, mitigated by a second supplier.`
3. Watch the **Status updates** table fill in each poster's team and assignments, and the tracker update: milestones are grouped by component, each with its own health colour, and slipped
   dates show the original plan date. Answer the agent's follow-up questions.
4. Click **Draft report now**. The draft gives a status for each component, then the overall position against
   the original plan. Edit it if you like, enter a reviewer name and **Approve**.
5. Tick **Every Monday 9 AM** to have the report drafted on a schedule.

## Deploy

**From the Cloudflare dashboard (no local tools needed):** push this repo to GitHub, then in the Cloudflare
dashboard go to **Workers & Pages → Create → Import a repository**, pick the repo, keep the project name
`cf-ai-program-status`, and deploy. Cloudflare runs `npx wrangler deploy`, which creates the Durable Object,
the Workflow and the Workers AI binding from `wrangler.jsonc`. Everything used here is available on the Workers Free plan.

**From the command line:**

```bash
npm install
npx wrangler login
npm run deploy
```

## Run locally

```bash
npm install
npm run dev:offline   # no Cloudflare account needed: the LLM is replaced by simple keyword rules
npm run dev           # the real app; Workers AI runs remotely, so this needs `npx wrangler login`
```

Open http://localhost:8787.

Offline mode is a stand-in so the app can run without an AI model. It reads one update per sentence, a
"Team - Milestone" prefix, everyday dates ("mid December", "Dec 3", "next Friday") and a short answer to its own
last question, and it matches an update to the milestone, risk or dependency it names ("FRA rack install is done"). Its replies start with "[offline mode]". The real model on Workers AI understands far more.

## Tests

```bash
npm test                  # unit tests: health rules, output validation, scheduling, offline mode
npm run typecheck
npm run dev:offline       # then, in another terminal:
bash scripts/smoke.sh     # end to end: updates → health → Workflow draft → approve with edits → schedule
```

## API

| Method | Path | Does |
| --- | --- | --- |
| POST | `/api/programs` | Create a program `{ name }`, or the demo program `{ demo: true }` |
| GET | `/api/programs/:id` | Chat, tracker, health and recent reports |
| POST | `/api/programs/:id/updates` | Post a status update `{ author, text }` |
| POST | `/api/programs/:id/reports` | Draft this week's report (starts the Workflow) |
| POST | `/api/programs/:id/reports/:reportId/review` | `{ approved, reviewer, note, editedText }`, sent to the paused Workflow |
| POST | `/api/programs/:id/schedule` | `{ enabled }` turns the Monday report on or off |

## Project structure

```
src/index.ts      Worker: routes the API, serves the UI
src/program.ts    Durable Object: state in SQLite, chat turns, scheduling
src/workflow.ts   Workflow: draft, wait for approval, record
src/llm.ts        Prompts, Workers AI calls, output validation, offline mock
src/demo.ts       The demo program shown on the first visit
src/status.ts     Data types, the health rules per program and per component, and the plan comparison (unit tested)
public/           Dashboard and chat UI (plain HTML, CSS and JavaScript)
test/             Unit tests (Vitest)
scripts/smoke.sh  End-to-end test against a running server
PROMPTS.md        AI prompts used to build this project
```

## Limits and next steps

- No sign-in: the poster's name is what they type in **Posting as**, and anyone with a program's link can post to it. Next step: put Cloudflare Access in front of the app and take the name from the signed-in identity.
- Updates come from the web chat only. Next steps: Slack or email intake, and voice updates with Cloudflare Realtime.
- Send the approved report by email or post it to a channel, and keep a week-over-week history of health.

## Prompt history

AI-assisted coding was used to build this project. The prompts are in [PROMPTS.md](PROMPTS.md).
