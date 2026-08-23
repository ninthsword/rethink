# Safety and repository integrity

- Preserve unrelated user edits and uncommitted work.
- Inspect `git status` before broad changes.
- Do not use destructive Git cleanup to make failures disappear.
- Do not force-push.
- Do not deploy/release/merge merely because implementation is complete.
- Do not expose secrets in code, logs, commits, tests, or documentation.
- Prefer `.env.example` or documented variable names instead of reading/printing secret values.
- Treat database migrations and data transforms as higher-risk changes; validate reversibility and compatibility.
- Avoid commands that make machine-wide changes when a project-local alternative exists.
- New dependencies require a concrete benefit; prefer existing project capabilities when sufficient.
