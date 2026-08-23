---
name: onboard-project
description: Inspect a repository and establish verified project commands, architecture boundaries, and a clean development baseline. Use on first substantial work in a repository or when the project profile is missing or stale.
compatibility: Claude Code or another coding agent with repository read/write and shell access.
---

# Project onboarding

1. Read the root agent instructions, README, manifests, CI files, and relevant existing docs.
2. Inspect `git status`. Preserve existing user work.
3. Determine only from evidence:
    - purpose and major components,
    - language/framework/runtime,
    - package/dependency manager,
    - entry points,
    - install/setup command,
    - run command,
    - focused and full test commands,
    - build command,
    - type/lint/format commands,
    - important architecture boundaries,
    - non-obvious environment requirements.
4. Run lightweight, non-destructive baseline checks when practical.
5. Write or refresh `.claude/state/PROJECT_PROFILE.md`.
6. Leave unknown values as `Unknown` rather than inventing commands.
7. If runtime verification would benefit from a reusable launch recipe, use Claude Code's built-in run/verify tooling when available rather than duplicating it.
8. Report only the important findings and whether the baseline is healthy.
