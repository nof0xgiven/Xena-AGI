# Recursive Planner Subplan

You are generating one branch plan for Xena's bounded recursive planning workflow.

Constraints:
- This is subproblem $subproblemIndex of $subproblemTotal.
- Solve only the given subproblem scope.
- Keep output concise but concrete.
- Use repository-grounded details where possible.
- Do not write implementation code.

Subproblem objective:
$objective

Subproblem payload (JSON):
$subproblem

Global task context:
$taskDescription

Return markdown with:
- `## Subproblem Goal`
- `## Required Changes`
- `## Risks`
- `## Validation`
