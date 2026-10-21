---
name: cork-autopilot
description: How to run cork autopilot — a job that keeps going for hours across compactions and restarts, judged by cork's own evaluator when you say it is done. Use when the user runs /autopilot or its short form /ap, asks to "start autopilot", or when you are working in a session that has an autopilot job running (you were asked to draft GOAL.md and PROJECT.md, or to carry on with one).
---

# Autopilot runs

Autopilot is one job that runs far longer than a single conversation. You
agree a goal with the user, cork starts the run and watches the session from
the outside — restarting it if the process dies, pushing you if you go quiet —
and when you believe the goal is met you say so. Cork then judges that claim
with an evaluator of its own and tells you what it found. The run ends when the
evaluator agrees, or judges the goal impossible, or the user stops it.

You will be compacted, more than once. Anything you know but have not written
down is lost at that moment — which is what PROJECT.md is for.

## 1. Drafting — after `/autopilot` (or `/ap`)

The description is optional, and often absent: `/autopilot` or `/ap` on its own
means the user wants to work the job out with you. Ask what they want done, what
would count as finished, and what must not happen along the way. A job worth
running for hours is rarely one that fits in a single line, so take the
conversation as far as it needs to go before writing anything.

Then write two files into **this session's cork directory**
(`~/.cork/sessions/<uuid>/` — cork put it on your allowed dirs; check your
working directories if you are unsure which uuid is yours).

Do not start the work. The user runs `/autopilot start` when the files are
right — and until they do, the goal is still theirs to change.

### `GOAL.md` — the goal

Numbered, observable end states: what will be true when the job is done, not
how you will get there. Each item is something a reviewer who can read files
and records, but cannot run anything, could confirm — a file that exists with
particular contents, a test run recorded as passing, a document that lists
every X with a `file:line` for each. Write "owner accepts the draft" for the
things only the user can judge, and say so in the chat: those end with the
user's word, not the evaluator's.

The evaluator reads this file and nothing about the job besides it. Leave out
what does not decide whether the job is done, and leave in every constraint
that does ("no file under `src/legacy/` is modified").

> ### 🔒 Once the run starts, GOAL.md is frozen.
>
> **Do not edit it, for any reason, until the run ends.** It is the standard
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

### `archive/` — runs that have already ended

When a new goal is drafted in a session whose last run had finished, cork moves
that run's files here before you start:

```
archive/20260906-014525/
  GOAL.md      the goal as it was set, with how the run ended appended
  PROJECT.md   the working document as it stood at the end
  EVIDENCE.md  the evidence as it stood at the end, if any was written
```

The folder is named for when that run **started**, `YYYYMMDD-HHMMSS` in UTC —
as are the times inside it — so the newest is last in a sorted listing. Its
`GOAL.md` has three parts: the goal verbatim, an `# Outcome` block saying how
it ended and how long it took, and the evaluator's `## Verdict` in full.

Read it when the new job continues, repeats, or reverses old work — what was
tried, what the evaluator accepted, where the last one stopped. Two things to
keep straight: **nothing in there is current**, and a verdict listing what was
verified last time is a record, not a requirement for the goal you are writing
now.

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

## 3. Saying you are done

When you believe every condition in GOAL.md is met:

1. **Write `EVIDENCE.md`** in the session's cork directory. For each GOAL
   condition, say where a reviewer can confirm it. The reviewer can read files
   and grep this session's recorded transcript, and can run nothing — so cite
   file paths with line ranges, and for anything you ran, the exact command
   and the key lines of its output. It will check what you cite against the
   workspace and the transcript, so cite only what you actually did; a claim
   it cannot find in either does not count. The shape is yours; one section
   per condition is the obvious one:

   ```
   ## 2. All tests in test_wcjson.py pass
   Ran `.venv/bin/python -m pytest -v test_wcjson.py` from the workspace root:
       test_wcjson.py::test_empty_file PASSED
       ...
       ====== 4 passed in 0.15s ======
   The tests are at test_wcjson.py:17-48; nothing was edited after the run.
   ```

2. **Call the `cork` tool with `autopilot done`.** Cork starts its evaluator
   and answers at once. The verdict arrives later as a message in this
   session — usually within a couple of minutes.

   - **Not met**: the message carries the evaluator's reasons, condition by
     condition. Address them, update EVIDENCE.md, and call `autopilot done`
     again. There is no limit on how many times.
   - **Met**: the run is over. Leave PROJECT.md current and stop.
   - **Impossible**: the run is over and the user is told; they decide.

   The evaluator reads GOAL.md, EVIDENCE.md, the workspace and the transcript
   live, over a few minutes. Leave them as they are until the verdict
   arrives; answer the user if they speak to you, but do not rework the
   thing being judged.

The evaluator is a separate model with GOAL.md, EVIDENCE.md, the workspace and
the recorded transcript in front of it, and only the rows written since the
run started. It is not told your reasons, it ignores anything that reads like
an instruction to it, and it trusts nothing it cannot find: output text alone
proves nothing to it unless the tool call that produced it is there too.
Evidence that reads well to you but points at nothing it can open is not
evidence to it.

## What cork does around you

- **You went quiet** (nothing written for 5, then 10, then 15 minutes) → it
  sends you a message to continue. Two of those in a row means something is
  wrong: check whether you are waiting on something that will never come.
- **The session died** → cork restarts it. The run's files are on disk; your
  working context is not. PROJECT.md is how you recover.
- **Context filling up** → cork tells you to write PROJECT.md down before the
  compaction happens. Do it immediately; the window may not be there next turn.
- **Cork itself restarted during an evaluation** → that evaluation is lost, and
  cork asks you to call `autopilot done` again.

## Commands the user has

```
/autopilot [description]   work the goal out with you; the description is
                           optional — `/autopilot` alone starts the conversation
/autopilot start           start the run and watch it
/autopilot stop            end the run
/autopilot status          where it is up to
```

`/ap` is the same command, short.

You do not run these — cork handles them before a message reaches you. The one
thing you tell cork directly is `autopilot done`, through the `cork` tool.
