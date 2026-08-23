# Durable state and context management

Use repository state files as a compact cross-session handoff, not as a second source tree.

## PROJECT_PROFILE.md

Read when you need commands, architecture boundaries, or project-specific conventions.

Update it only with verified, durable information.
Do not copy directory listings or dependency catalogs that Claude can cheaply rediscover.

## WORK_STATUS.md

Use only when work may survive a context reset/session boundary or is genuinely long-running.

Keep:

- current objective,
- acceptance criteria,
- completed work,
- current task,
- next tasks,
- blockers,
- verification status,
- known issues.

Remove stale details when the objective is complete.

## DECISIONS.md

Record only durable decisions with future consequence:

- architecture boundary,
- data model choice,
- compatibility policy,
- important external dependency,
- user-approved tradeoff.

Do not log variable names, routine refactors, or ordinary implementation details.

## Context hygiene

Prefer reading targeted files when needed over stuffing large reference material into always-on instructions.
Use subagents when exploratory output would pollute the main context.
