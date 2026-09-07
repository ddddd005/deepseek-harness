---
description: "Prompt Control's frozen catalog service for maintainers building prompt-profile management, rule evaluation, or request finalization on top of the prompt registry."
kind: "package-reference"
---

# @deepseek-ai/dsh-prompt-control


## Summary

`dsh-prompt-control` defines the Prompt Control service (`ctx.promptControl`) for session-scoped prompt management. This increment freezes the read-only surface: `catalog()` delegates to the system-prompt registry and returns the evaluated, provenance-carrying view of the prompt contributions behind one assembly — sections, contexts, and variables, each with its stable branded identity, owner package, scope, placement order, dynamic flag, `complete` claim, and evaluated text. Resolver functions never escape the registry. Prompt profiles, the rule interpreter, and request finalization build on this same service in later increments. Choose it when you need to enumerate what the model was told and where each part came from — not to contribute prompt content, which stays with `dsh-system-prompt`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the package wherever agents run and `dsh-system-prompt` is mounted — the service requires the registry through its inject list and provides `ctx.promptControl`.

### Read the prompt catalog

`catalog(context, options)` returns the frozen catalog for one assembly scope. The default view lists only the effective contributions — exactly what an assembly of that scope would use; `includeShadowed: true` adds registered-but-shadowed entries marked `effective: false` with the nearer scope that displaced them.

```text
const catalog = ctx.promptControl.catalog({ scope: agentScope })
for (const section of catalog.sections) {
  // section.id — the stable branded identity (equals section.name)
  // section.source.ownerPackage / section.source.scope / section.source.lifetime
  // section.order / section.text (evaluated) / section.dynamic / section.complete
  // section.effective
}
catalog.contexts // the same view for dynamic runtime-context contributions
catalog.variables // evaluated values plus the same provenance
```

Context entries mirror assembly suppression: a view whose runtime context is suppressed lists none. The catalog does not run the `system-prompt/assemble` waterfall and does not enforce a complete section — `complete` is reported as a claim. Resolver evaluation failures propagate exactly as the equivalent assembly would.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the package realizes the behavior above; the observable contract is covered in [Use this package](#use-this-package).

### Design concept

This increment owns no prompt state. Provenance is captured where the contribution is registered — the system-prompt registry stamps each section, context, and variable with its owner package (the registering caller's Cordis fiber name), scope, and dynamic flag at insertion — so the catalog is a pure read over registered state, not a parallel inventory that could drift. The service delegates the entire contract to `SystemPrompt.catalog` and freezes the signature as the stable seam that profile storage, the rule interpreter, and request finalization build on.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `PromptControl` service, `catalog()` delegation, public brand and catalog type re-exports |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The package-level contract is enough for most consumers; read these when you need the surrounding domain and the design rationale.

- [system-prompt package](../../core/system-prompt/README.md) — the registry whose sections, contexts, and variables the catalog mirrors.
- [Prompt Control P0 Agent Note](../../../.agents/notes/proposed/feature/2026-09-07-prompt-control-p0.md) — the decision gates (takeover point, post-projection audit, `request/input` vocabulary) the later increments implement.

-----

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the service needs special care. They are current package constraints, not a task backlog.

- **No prompt state of its own yet** — profile storage, session profile selection, and the rule interpreter land behind this same service in later increments; the catalog is the only surface today.
- **Tool registration sources are not cataloged yet** — tool schemas flow into assembly through the system-prompt tool providers; their source catalog arrives with the request-takeover increment.
- **The catalog is a pre-waterfall view** — contributions transformed by an assembly waterfall listener are not attributed here; the dispatched request is what the later audit records.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No runtime invariant companion is published; the service owns no prompt state and the catalog is a pure read over the system-prompt registry, whose own invariant companion covers assembly.

</details>
