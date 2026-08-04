# Issue #1136 snapshot

Source: https://github.com/nrslib/takt/issues/1136

Introduce global and project `.takt/runtime.yaml` files that move provider execution configuration out of workflows. Support named provider profiles, defaults, targets for personas/tags/fully-qualified leaf steps/internal agents, and auto-routing pools whose candidates reference profiles. Project definitions override global definitions as whole profiles; explicit `extends` provides inheritance. Same-priority target conflicts and invalid or unknown references fail before agent execution.

Defaults and each target must select exactly one fixed `profile` or auto-routing `pool`. Limit targets to the four named maps, use `<leaf-workflow-name>/<step-name>` for step targets, and resolve them in this order:

```text
defaults < personas < tags < steps < internal_agents
```

Router, candidate, and fallback settings reference profiles. Router parse/schema failures must not be hidden by fallback.

When no valid `runtime.yaml.provider` exists, preserve legacy provider resolution. When runtime-v1 and legacy provider settings are both present, fail fast with source locations and migration guidance. CLI provider overrides remain valid in both modes. Compile legacy and runtime formats at configuration/bootstrap boundaries into a common `ProviderResolutionPolicy`; executors, runners, and provider SDKs must not branch on configuration format.

On first startup, atomically create a valid global runtime file without overwriting an existing file, and do not auto-create the project file. New environments receive an active default profile from setup. Existing legacy environments receive an inactive `version: 1` file so behavior does not switch implicitly. Do not change credential storage, workflow control flow/facet behavior, or provider SDK execution.

Plan schema/loading, resolution precedence, mode selection and conflict diagnostics, the shared policy boundary, first-run generation, builtin migration, documentation, unit/integration coverage, and mock-provider E2E coverage. Inspect the current repository and produce an implementation plan.
