# TalentLens AI — Workspace Rules for Antigravity

This repository is an active, partially implemented product. Treat existing source code, tests, Prisma schema, migrations, and the current Git working tree as the operational source of truth. The companion file `TALENTLENS_PROJECT_HANDOFF.md` contains the project history, intended architecture, security invariants, implementation status, and current handoff. Read it before doing project work.

## Mandatory startup procedure

1. Read `TALENTLENS_PROJECT_HANDOFF.md` completely.
2. Inspect the repository's existing `AGENTS.md`/`GEMINI.md`/Copilot instructions and all package-level instructions. Do not overwrite or replace existing project instructions; merge these requirements with them.
3. Inspect `git status --short --branch` before any work. Preserve every pre-existing staged, unstaged, and untracked change. Never assume the working tree is clean.
4. Verify claims in the handoff against the actual repository. The handoff is context, not permission to trust stale filenames, line numbers, or implementation summaries.
5. Before coding, state the current branch, working-tree state, task scope, files likely to change, risks, and validation plan.

## Non-negotiable engineering rules

- Do not stage, commit, push, reset, checkout over, clean, stash, or discard work unless the user explicitly requests that exact Git action. In particular, never use `git reset --hard`, `git clean`, or destructive restore commands.
- Do not commit automatically. The user prefers to complete the agreed milestone(s), review the diff, then decide whether to create one combined commit.
- Do not run migrations, alter the Prisma schema, regenerate database structures, or change database data unless the task requires it and the user has explicitly approved the plan. If a schema change appears necessary, stop and explain the smallest additive proposal first.
- Never read, print, quote, or expose `.env`, credentials, tokens, cookies, private keys, or secret values. `.env` is local-only. Use `.env.example` only for safe variable names and placeholders.
- Do not claim a command passed unless you actually ran it and observed its exit status. Do not claim mocked tests prove PostgreSQL behavior.
- Do not run independent build/typecheck/test commands concurrently when generation or shared outputs may be involved. Run validation sequentially.
- Prefer the existing stack, conventions, dependency versions, and module boundaries. Do not introduce a new framework, ORM, package, or abstraction without a clear reason.
- Keep changes narrow and explain why every touched file is required. Do not perform unrelated refactors or formatting churn.
- For security-sensitive changes, trace the complete route → middleware → service → repository → database execution path. Tests should prove behavior, not merely exercise function names.
- Validate untrusted input at boundaries with the repository's existing Zod conventions. Use explicit DTO/select allowlists; never return raw Prisma records by default.
- Tenant identity, organization ID, user ID, role, and recruiter assignment must derive from authenticated server-side context and scoped database queries—not caller-supplied IDs.
- Maintain human control over AI screening: no automatic rejection, no unsupported requirement invention, evidence for scoreable criteria, recruiter verification, and auditable decisions.
- Maintain privacy and fairness: do not use protected demographic attributes for scoring; keep candidate contact details masked in client-facing views; enforce consent, purpose limitation, deletion, tenant boundaries, and auditability.
- Never weaken a security check just to make a test pass. Fix the incorrect behavior or test fixture.

## Working style

- Work in explicit, small milestones. First inspect and plan; then implement only the agreed scope; then test; then inspect the final diff and Git state.
- Do not silently skip requirements. If a requirement is ambiguous, use the safest interpretation consistent with the handoff and explain it.
- If blocked by missing context, inspect the repository and available tests first. Ask only when a decision genuinely requires the user's approval.
- For every completed task, report: behavior changed, files changed, security implications, tests actually run and results, known limitations, and final Git state.
- Preserve the user's existing work and report pre-existing changes separately from changes made during the current task.

## Current task handoff

The next task is an **independent, read-only audit** of the scorecard remediation. Do not implement anything during that audit. The user has a separate audit prompt from the prior conversation and intends to paste it after this handoff is loaded. Follow that prompt's read-only restrictions exactly.
