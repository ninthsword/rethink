# Verification and review

Verification is part of implementation, not a final ritual.

## Before editing

When practical, establish the current baseline:

- relevant tests,
- current failure/reproduction,
- build/type/lint status if the task depends on them.

Do not spend excessive time running the entire suite before a tiny isolated change.

## After editing

Use the narrowest fast check first, then broaden:

1. focused test or direct runtime check,
2. affected component/package checks,
3. appropriate regression suite,
4. build/type/lint/static checks.

For user-visible or runtime behavior, prefer direct execution or the bundled `/verify` workflow when available.

## Bug fixes

Prefer a regression test that fails before the fix and passes after it.

## Independent evaluation

For medium/large work, ask the `independent-reviewer` to challenge the implementation after the main verification passes.

Treat reviewer findings as hypotheses to confirm, not commands to blindly apply.

## Completion

Never claim:

- “works” when it was only inspected,
- “tested” when only type-checking ran,
- “no issue” in an area that was not examined.

Use explicit wording for unverified areas.
