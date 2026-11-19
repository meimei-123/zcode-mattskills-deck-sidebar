# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the project root (`zcode-plugin/GLOSSARY.md`)
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## 本项目的特殊边界

`zcode-plugin/` 是父仓库(上游 DSH 快照)中的独立项目根。父仓库根部的 `GLOSSARY.md`、`CONTEXT.md`、`docs/`、`AGENTS.md` 属于**上游 DSH 上下文**,视为 vendor 领地:可以读作参照,不修改、不并入本项目词汇表。本项目自己的域文档以 `zcode-plugin/GLOSSARY.md` 和 `zcode-plugin/docs/adr/` 为准。

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
