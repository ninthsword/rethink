---
name: autonomous-dev
description: Execute non-trivial software development autonomously from repository investigation through implementation, testing, independent review, and concise reporting. Use for features, bug fixes, refactors, and meaningful code changes.
compatibility: Claude Code or another agentic coding environment with repository and test execution access.
---

# Autonomous development workflow

## 1. Understand

Read enough of the affected system to trace the relevant behavior and blast radius.
Use the project profile when available.

## 2. Define done

Translate the request into concrete acceptance criteria.
Resolve ordinary technical ambiguity yourself.
Ask only if a real user decision gate exists.

## 3. Plan

Match the process to the work. One obvious localized fix needs only
understand -> implement -> verify -> review. Multiple files or non-trivial behavior
adds acceptance criteria, a task plan, and independent review before repair. Cross-layer
or migration work earns a dependency-aware task graph, subagents for independent
research, worktrees where parallel workers would collide, and checkpointed state.

For three or more meaningful steps, use structured tasks.
Add dependency edges when ordering matters.
Identify independent work that can safely run in parallel.

## 4. Establish evidence

For a bug, reproduce when practical.
For existing behavior, identify tests or runtime checks that prove the baseline.

## 5. Implement

Make the smallest coherent change.
Follow existing architecture and conventions unless they are the root cause.

## 6. Verify iteratively

Run focused checks first.
Fix failures based on evidence.
Broaden to appropriate regression/build/type/lint/runtime checks.

## 7. Evaluate independently

For medium/large work, use the `independent-reviewer` subagent or an equivalent
isolated review. Treat its findings as hypotheses to confirm, not commands to apply
blindly.

## 8. Repair

Address real defects and rerun the relevant checks.

## 9. Preserve state

If work may continue in another context/session, update `WORK_STATUS.md`.
Record only durable consequential decisions in `DECISIONS.md`.

## 10. Finish

Review the final diff and give a concise completion report with verification evidence and any unverified areas.

Never claim “works” when the code was only inspected, “tested” when only type checking
ran, or “no issue” in an area that was not examined. Name unverified areas explicitly.

Do not stop after producing code. Stop when the change is verified to the strongest practical level.
