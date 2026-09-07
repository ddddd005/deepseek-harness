---
description: "The prompt group map: session-scoped prompt management services that build on the system-prompt registry — starting from the frozen read-only catalog."
kind: "package-group"
---

# packages/prompt


## Summary

The prompt group hosts the Prompt Control services that manage what the model is told without touching the plugins that own the facts. It builds directly on the system-prompt registry: contributions keep their provenance there, and this group exposes management surfaces over them. The group starts minimal — the `prompt-control` package freezes the read-only catalog and the public brand types — and grows behind the same service: prompt profiles, the rule interpreter, and request finalization. Choose this group when you need to enumerate or control prompt contributions per session; contributing prompt content itself stays with [`packages/core/system-prompt`](../core/system-prompt/README.md).

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`prompt-control/`](prompt-control/README.md) | The Prompt Control service: the evaluated, read-only catalog of prompt contributions with their provenance | `ctx.promptControl` |

`prompt-control` is the group's single package today. Provenance capture lives in the system-prompt registry at registration time, so the catalog is a pure read over registered state rather than a parallel inventory.

-----

<a id="related-documentation"></a>
## Related documentation

- [System-prompt subsystem](../../docs/subsystems/system-prompt.md) — the registry, assembly pipeline, and contribution types the catalog mirrors.
- [Prompt Control P0 Agent Note](../../.agents/notes/proposed/feature/2026-09-07-prompt-control-p0.md) — the decision gates (takeover point, post-projection audit, `request/input` vocabulary) the later increments implement.
- [Architecture](../../docs/architecture.md) — the turn flow and where new behavior goes.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
