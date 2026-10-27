# Agent instructions

## Agent skills

### Issue tracker

GitHub issues on **TheAngryPit/birdclaw**. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`GLOSSARY.md`, `docs/adr/` when present). See `docs/agents/domain.md`.

### Stack and verification

TypeScript monolith layout, toolchains, CI parity, and the tweet ingest contract are documented in `docs/agents/STACK.md`.

### pstack

Install the **pstack** Cursor plugin (`/add-plugin pstack`) for **`/poteto-mode`** workflows. This repo pins a **small** reasoning budget in `.cursor/rules/pstack-models.mdc` so subagent roles stay on cheaper models.

### Birdclaw archive skill

The project skill at `.agents/skills/birdclaw/` is maintained separately; do not replace it when updating other skills.
