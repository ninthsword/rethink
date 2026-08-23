---
name: handoff
description: Create a compact durable handoff when substantial work remains for another context or session. Capture verified state, next tasks, blockers, and exact validation status without turning the file into a verbose development diary.
compatibility: Claude Code or another coding agent with repository write access.
---

# Session handoff

Update `.claude/state/WORK_STATUS.md` with:

- current objective,
- acceptance criteria,
- completed and verified work,
- current incomplete work,
- next concrete tasks in dependency order,
- blockers or decisions needed,
- exact checks already run and their results,
- known failures or unverified areas,
- any repository state the next session must not overwrite.

Update `DECISIONS.md` only for durable consequential decisions.

Keep the handoff compact enough that a fresh agent can read it in under a minute.
