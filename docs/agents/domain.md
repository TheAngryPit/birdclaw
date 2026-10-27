# Domain docs

How engineering skills should consume this repo's domain documentation.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root, when it exists.
- **`docs/adr/`**: read ADRs that touch the area you are about to work in.

If these files do not exist yet, proceed without flagging their absence. **`/domain-modeling`** (via **`/grill-with-docs`** and **`/improve-codebase-architecture`**) creates glossary and ADR material when terms or decisions are actually resolved.

## Layout (single-context)

This repo uses a single glossary and shared ADR directory:

```
/
├── GLOSSARY.md          (created when needed)
├── docs/adr/            (created when needed)
└── src/
```

Human-facing product and data design docs also live under **`docs/`** (for example **`docs/data-architecture.md`**, **`docs/spec.md`**). Prefer those for end-user behavior; use **`GLOSSARY.md`** for vocabulary agents should reuse in issues and code.

## Use the glossary's vocabulary

When output names a domain concept (issue title, refactor proposal, test name), use the term as defined in **`GLOSSARY.md`**. If the concept is missing, note the gap for **`/domain-modeling`** rather than inventing synonyms.

## Flag ADR conflicts

If output contradicts an existing ADR, say so explicitly and cite the ADR number.
