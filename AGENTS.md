# Agent Workflow

## Mission
- Assist with feature delivery, bug fixes, documentation updates, and cross-file consistency in this repo.
- Every change must update the relevant docs and the affected directory README Change Log.

## First 10 Minutes: Session Bootstrap
Required reading list for each new chat session (if any item is missing, mark it as optional/future in your bootstrap output):
- `README.md` (project overview)
- `docs/README.md` (documentation map)
- `DECISIONS.md` (key decisions)
- `RUNBOOK.md` (ops/troubleshooting)
- `docker-compose.yml`
- `apps/arkcore/src/index.ts` (entry)
- `apps/arkcore/src/commands.ts` (Discord commands)
- `apps/arkcore/src/scheduler.ts` (scheduled tasks)
- `apps/arkcore/src/rss.ts` (fetch/parse)
- `apps/arkcore/src/digest.ts` (digest)
- `apps/arkcore/src/messaging.ts` (message output)
- `apps/arkcore/src/verify.ts` (verification)
- `prisma/schema.prisma` (if present)

Bootstrap output format (must follow this exact ordering and titles):
1) 已阅读文件清单
2) 当前架构 10 行摘要
3) 本次计划做的改动点（bullet）
4) 潜在风险与回滚方式

## Work Style
Principles:
- Minimal, scoped changes.
- Observability first.
- Fail explicitly.
- Do not add unnecessary dependencies.

Prohibited:
- Unjustified large refactors.
- Updating many files without updating docs.
- Writing secrets into logs.

## Feature Tracking
Location: `docs/features.md` (template: `docs/templates/feature_template.md`).

Each feature entry must include:
- Background/Goal
- Scope (In / Out)
- Status (Planned / In Progress / Done / Deferred)
- Acceptance Criteria (DoD)
- Related Files/Dirs
- Risks & Rollback

Rule: any feature implementation or change must update the corresponding entry status and change summary in `docs/features.md`.

## Git Workflow
Branches: `feat/*`, `fix/*`, `chore/*`, `docs/*`.

Commit messages (Conventional-ish):
- `feat: ...`
- `fix: ...`
- `docs: ...`
- `chore: ...`

Commit granularity: split schema/logic/docs changes where practical.

Pre-merge checklist:
- `scripts/verify.sh` (must run if it exists).
- `docker compose up -d --build` (if containers are involved).
- Smoke tests for key commands (e.g., `/ping`, `/fetch now`, `/digest run`).

## Verification & Observability
- Every new capability must have a verifiable path (command, script, or log).
- Errors must be visible to users (Discord reply and/or logs/reports), avoid silent failures.

## Prompts Management
- All prompts live under `prompts/` with one prompt per file (`.md`).
- Prompt changes must be recorded in `DECISIONS.md` with the motivation (e.g., shorten output, switch to JSON, reduce hallucinations).
- Naming convention: `<feature>.<purpose>.prompt.md` (see `prompts/README.md`).

## Directory README Mechanism
Rules:
1) Key directories must have `README.md` (or `_README.md`) describing responsibilities, key files, and common pitfalls.
2) Every directory README must include a `Change Log` section using the standard template.
3) Any change under a directory must update that directory README Change Log with date + summary + impact.
4) If a PR touches multiple directories, each directory README Change Log must be updated.

Change Log template: `docs/templates/changelog_template.md`.

## Templates
Templates live in `docs/templates/`:
- `docs/templates/feature_template.md`
- `docs/templates/changelog_template.md`
- `docs/templates/directory_readme_template.md`

## Deployment
Server access: `ssh arkcore`
Project directory on server: `~/arkcore`

## References
- `docs/README.md`
- `docs/features.md`
- `prompts/README.md`
