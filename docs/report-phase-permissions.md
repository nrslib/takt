# Report Phase Permissions Design

## Summary

The report phase now uses permission mode as the primary control surface.
Call sites only provide resume metadata (for example, `maxTurns`), and tool compatibility details are isolated inside `OptionsBuilder`.

## Problem

Historically, report phase calls passed `allowedTools: []` directly from `phase-runner`.
This made phase control depend on a tool list setting that is treated as legacy in OpenCode.

## Design

1. `phase-runner` uses `buildResumeOptions(step, sessionId, { maxTurns })`.
2. `OptionsBuilder.buildResumeOptions` enforces:
   - `permissionMode: 'readonly'`
   - `allowedTools: []` (compatibility layer for SDK behavior differences)
3. OpenCode-specific execution is controlled by permission rules (`readonly` => deny).

## Rationale

- OpenCode permission rules are the stable and explicit control mechanism for report-phase safety.
- Centralizing compatibility behavior in `OptionsBuilder` prevents policy leakage into movement orchestration code.
- Resume-session behavior remains deterministic for both report and status phases.

## Test Coverage

- `src/__tests__/options-builder.test.ts`
  - verifies report/status resume options force `readonly` and empty tools.
- `src/__tests__/phase-runner-report-history.test.ts`
  - verifies report phase passes only `{ maxTurns: 3 }` override.
- `src/__tests__/opencode-types.test.ts`
  - verifies readonly maps to deny in OpenCode permission config.
