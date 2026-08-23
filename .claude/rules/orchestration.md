# Orchestration

## Complexity routing

Use the simplest sufficient mode:

### Small

One obvious fix or a small localized change:
`understand → implement → verify → review`

### Medium

Multiple files or non-trivial behavior:
`understand → acceptance criteria → task plan → implement → verify → independent review → repair`

### Large

Cross-layer, multi-module, migration, or high uncertainty:

- build a dependency-aware task graph,
- identify critical path and independent branches,
- use subagents for independent research/review,
- use worktrees for parallel editing where appropriate,
- checkpoint durable state.

## Task graph

For complex work, use Claude Code Task tools rather than maintaining a prose-only checklist.

Create task dependencies only where real ordering exists.
A task must not be marked complete until its own acceptance criteria are verified.

Parallelize only independent nodes.

## Parallel execution

Prefer:

1. main agent for tightly coupled implementation,
2. subagents for focused independent work,
3. worktree-isolated subagents for independent edits,
4. agent teams only for genuinely collaborative complex work and only after user authorization because the feature is experimental.

Do not use multi-agent orchestration merely because it is available.
