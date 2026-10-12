# Getting real work out of your agents

A pile of installed agents isn't the point — *directing* them is. The pushback
you'll hear ("agents don't really do anything") is almost always a directing
problem, not a capability one. Here's the short version of how to get shipped,
tested work out of the catalog.

> In the app, this lives under the **Playbook** (the book icon in the title bar,
> or `⌘K → Open the Playbook`). The copy here and there comes from the same
> source, so they never drift.

## The five habits

1. **Name the outcome, not the steps.** Tell the team what *done* looks like —
   the work product and how you'll know it's finished — then let them plan the
   path. The more concrete the done-bar, the better the result.

2. **Cast a team, not a soloist.** One agent is a contractor; a team is a
   studio. Deploy a **Team** (or a whole **Division**) so a builder and a critic
   work together — pair a maker with a *Code Reviewer* and a *Reality Checker* so
   nothing gets rubber-stamped.

3. **Loop until it's tested.** "It compiles" isn't done. Make the loop exit on
   *evidence*: browser-driven, functional, unit, and a pen-test pass where it
   applies. Ask for the proof, not the promise.

4. **Feed it context.** Garbage in, garbage out. Point at the repo, the
   constraints, and the success criteria up front. Five minutes of context beats
   fifty prompts of correction.

5. **Start with one, then scale.** New to this? Install one agent into one
   project and give it one task. Watch it work — then graduate to a team and the
   loop.

## Starter prompts

Copy one, swap the `[brackets]`, and paste it into your tool.

### Build & test loop

> Use all available agents as a team and work in a loop until **[the work
> product]** is built and tested — browser, functional, unit, and pen-test where
> applicable. Don't stop until every gate passes; show me the evidence for each.

### Review pass

> Review **[the change or file]**. Have a Code Reviewer assess correctness,
> security, and maintainability, then have a Reality Checker independently verify
> each finding with proof. Give me only the issues that survive scrutiny, ranked
> by severity.

### Discovery pass

> Before building, research **[the problem]**. Have a Trend Researcher and
> Feedback Synthesizer map the landscape and user needs, then a Sprint
> Prioritizer turn it into a sequenced plan with a clear first milestone. Surface
> assumptions and open questions.

## The four pillars

The app is organized around four questions — the same ones a good brief answers:

| Pillar | Question | Use it to… |
| --- | --- | --- |
| **Agents** | *who* | Browse the catalog by division; install a single specialist. |
| **Tools** | *how* | See which AI tools (Claude Code, Codex, Cursor, …) each agent is deployed into. |
| **Teams** | *which* | Deploy a curated squad as a unit — each preset ships with example tasks. |
| **Projects** | *where* | Scope a deployment to a specific repo/folder instead of globally. |

## Team presets

Each preset under **Teams → Team presets** opens a detail panel with its member
agents (grouped by division) and a couple of **curated example tasks** — concrete
starting prompts that show what that squad is actually for. Open one, copy an
example, swap the brackets, and go.
