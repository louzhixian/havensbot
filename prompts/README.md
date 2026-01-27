# Prompts

## Purpose
Store prompt definitions and their change rationale separate from code.

## Key Files
- `prompts/README.md`: prompt management rules and naming.
- `prompts/editorial.item_enrichment.prompt.md`: item-level writing suggestion prompt.
- `prompts/editorial.daily_report.prompt.md`: daily editorial report prompt.
- `prompts/deeper.article_summary.prompt.md`: deep dive article summary prompt.
- `prompts/editorial.thread_assistant.prompt.md`: editorial thread assistant prompt.
- `prompts/editorial.translation.prompt.md`: editorial translation prompt.
- `prompts/voice.text_polish.prompt.md`: voice transcript polishing prompt.

## Conventions
- One prompt per `.md` file.
- Naming: `<feature>.<purpose>.prompt.md`.
- Prompt changes must be recorded in `DECISIONS.md` with the motivation.
- Prompt changes must update the related feature DoD and risks in `docs/features.md`.
- Link new prompts from `docs/README.md` when they become core workflow assets.

## Change Log
- 2026-01-03: require prompt updates to adjust feature DoD/risks (files: prompts/README.md) impact: doc
- 2026-01-03: add editorial enrichment and report prompts (files: prompts/editorial.item_enrichment.prompt.md, prompts/editorial.daily_report.prompt.md) impact: editorial
- 2026-01-04: add deep dive summary prompt (files: prompts/deeper.article_summary.prompt.md, prompts/README.md) impact: deep-dive
- 2026-01-05: add editorial thread assistant prompt (files: prompts/editorial.thread_assistant.prompt.md, prompts/README.md) impact: editorial
- 2026-01-06: add editorial translation prompt (files: prompts/editorial.translation.prompt.md, prompts/README.md) impact: editorial
- 2026-01-15: add voice transcript polishing prompt (files: prompts/voice.text_polish.prompt.md, prompts/README.md) impact: voice

## References
- `agent.md`
- `DECISIONS.md`
- `docs/README.md`
