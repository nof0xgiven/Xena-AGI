# North Star Task Workspace

This folder tracks North Star execution for Xena in local files (no Linear dependency).

Files:
- `tasks/north-star-roadmap.md`: what is done, what is missing, and execution sequence.
- `tasks/north-star-task-list.md`: prioritized implementation backlog with acceptance criteria.

Architecture rule for this workspace:
- Prefer thin orchestration workflows.
- Keep strategy and matrix policy in registry/config where possible.
- Use shared runtime helpers for matrix selection/switching across stages.
- Keep docs aligned to `north-star.md` invariants: immutable engine method, modular registry, learned workflow promotion, personal-first operation.

Usage:
1. Move tasks from `Planned` to `In Progress`.
2. Execute and validate with real runs.
3. Mark as `Done` only after proof exists in logs/artifacts/tests.
