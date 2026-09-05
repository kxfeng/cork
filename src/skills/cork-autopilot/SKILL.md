---
name: cork-autopilot
description: How to run cork autopilot — a job that keeps going for hours across compactions and restarts, driven by a /goal condition. Use when the user runs /autopilot, asks to "start autopilot", or when you are working in a session whose AUTOPILOT.json says a task is running (you were asked to draft GOAL.md and PROJECT.md, or to carry on with one).
---

# Autopilot runs

Autopilot is one job that runs far longer than a single conversation. Cork
sets a `/goal` condition and then watches the session from the outside:
restarting it if the process dies, pushing you if you go quiet, and telling the
user when it ends.

You will be compacted, more than once. Anything you know but have not written
down is lost at that moment — which is what PROJECT.md is for.

## 1. Drafting — after `/autopilot`

The description is optional, and often absent: `/autopilot` on its own means the
user wants to work the job out with you. Ask what they want done, what would
count as finished, and what must not happen along the way. A job worth running
for hours is rarely one that fits in a single line, so take the conversation as
far as it needs to go before writing anything.

Then write two files into **this session's cork directory**
(`~/.cork/sessions/<uuid>/` — cork put it on your allowed dirs; check your
working directories if you are unsure which uuid is yours).

Do not start the work. The user runs `/autopilot start` when the files are
right — and until they do, the goal is still theirs to change.

### `GOAL.md` — the goal

**The whole file becomes the goal**, verbatim, line breaks and all. Not a
summary with detail behind it: what you write here is the entire condition, so
it has to stand on its own.

Claude Code's own guidance for writing one, quoted:

> A condition that holds up across many turns usually has:
>
> * **One measurable end state**: a test result, a build exit code, a file
>   count, an empty queue
> * **A stated check**: how Claude should prove it, such as "`npm test` exits 0"
>   or "`git status` is clean"
> * **Constraints that matter**: anything that must not change on the way there,
>   such as "no other test file is modified"
>
> To bound how long a goal runs, include a turn or time clause in the condition,
> such as `or stop after 20 turns`.

**Do not add a turn or time clause by default.** The jobs worth running
unattended are usually the ones whose length nobody can predict, and `or stop
after 20 turns` on one of those ends it half-finished — reported as a goal that
was met. The run is already bounded from the outside: the user can stop it with
`/autopilot stop` at any point, and cork reports every ending.

Add one only if the user asks for it, or if the job is bounded by its own
nature — "try three approaches and report which works", "spend an hour surveying
and write up what you find". Even then, say out loud what the clause will do
before writing it in: at that point the run stops, finished or not.

One thing cork enforces rather than trusts: **the goal must not be judged
against PROJECT.md**, or any other file you rewrite as the work proceeds. That
is a standard you could pass by editing the file. Cork refuses to start a goal
naming PROJECT.md.

Cork also refuses a file over **3000 characters**, a **line over 512**
characters (claude folds a longer single input into a paste, where a leading
`/goal` stops being a command at all), or one starting with `/` — cork adds the
prefix itself.

> ### 🔒 Once the task starts, GOAL.md is frozen.
>
> **Do not edit it, for any reason, until the task ends.** It is the standard
> you are being measured against; editing it is grading your own work, whether
> or not you meant it that way. This holds even when a requirement turns out to
> be wrong, impossible, or badly worded: say so in the chat and let the user
> decide.
>
> Everything you learn while working belongs in PROJECT.md, which exists
> precisely so that GOAL.md never has to move.

### `PROJECT.md` — the working document

Your memory across compactions: the objective in context, the constraints, the
decisions already made and why, what is finished, what is in flight, what is
blocked. Write it for a reader with no memory of having written it, because
that is who reads it after the first compaction.

It is not the standard — GOAL.md is. Keeping the two apart is what stops the
job's own progress notes from quietly becoming its acceptance criteria.

## 2. Running

**Start by reading GOAL.md and PROJECT.md** — both of them, from this session's
cork directory. Skip this only if you just wrote them and they are still in
front of you. You may be picking up a task set hours ago by a version of
yourself whose context is gone; nothing else tells you what you agreed to do.

**Keep PROJECT.md current.** Every decision, every finished piece, every dead
end and why. Update it as you go, not at the end — the compaction will not
announce itself. When cork tells you the session was compacted, re-read
PROJECT.md before doing anything else.

**Report progress in the chat yourself.** Cork suspends the rule that normally
makes you answer the user every turn, so nothing will remind you. Send a short
message through `mcp__cork-channel__reply` when you finish a meaningful piece,
make a decision the user would want to know about, or hit something that needs
their input. Every few turns, not every turn.

**And answer the user when they speak to you.** The same suspension means a
question asked mid-task goes unanswered unless you notice it. Deal with it as it
arrives, then carry on.

**About once an hour cork will ask you to check yourself against the goal.**
Do it properly: open GOAL.md and read it, rather than working from what you
remember it saying — memory of a goal drifts, and after a compaction it is
gone. Compare it against what you have actually done, and write the check and
its conclusion into PROJECT.md.

If the work has drifted, **steer it back yourself** and say in the chat what
drifted and what you changed. You are running unattended; waiting for the user
to confirm a course correction defeats the point, and there is nothing to
decide — GOAL.md is the fixed point and the correction is toward it. Never edit
GOAL.md. The one thing worth stopping for is a goal that turns out to be
unachievable or wrong, which is a different conversation (see below).

**When you are blocked**, do not spin. Write the blocker into PROJECT.md, say so
in the chat, and — if there is other work in scope — carry on with that.

**If the goal turns out to be unachievable**, say so plainly in the chat and
explain why. The user decides what happens next.

## 3. Ending

The task ends by itself when the goal is met, and cork tells the user. You do
not clear the goal yourself. If the user wants it stopped, they run
`/autopilot stop`.

## What cork does around you

- **You went quiet** (nothing written for 5, then 10, then 15 minutes) → it
  sends you a message to continue. Two of those in a row means something is
  wrong: check whether you are waiting on something that will never come.
- **The session died** → cork restarts it; the goal comes back by itself, your
  working context does not. PROJECT.md is how you recover.
- **Context filling up** → cork tells you to write PROJECT.md down before the
  compaction happens. Do it immediately; the window may not be there next turn.

## Commands the user has

```
/autopilot [description]   work the goal out with you; the description is
                           optional — `/autopilot` alone starts the conversation
/autopilot start           set the goal and start watching
/autopilot stop            clear the goal and stop watching
/autopilot status          where it is up to
```

`/ap` is the same command, short.

You do not run these — cork handles them before a message reaches you.
