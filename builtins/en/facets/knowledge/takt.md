# TAKT Architecture Knowledge

## Core Structure

WorkflowEngine is a state machine. It manages step transitions via EventEmitter.

```
CLI → WorkflowEngine → Runner (4 types) → RuleEvaluator → next step
```

| Runner | Purpose | When to Use |
|--------|---------|-------------|
| StepExecutor | Standard 3-phase execution | Default |
| ParallelRunner | Concurrent sub-steps | parallel block |
| ArpeggioRunner | Data-driven batch processing | arpeggio block |
| TeamLeaderRunner | Task decomposition → parallel sub-agents | team_leader block |

Runners are mutually exclusive. Do not specify multiple runner types on a single step.

### 3-Phase Execution Model

Normal steps execute in up to 3 phases. Sessions persist across phases.

| Phase | Purpose | Tools | Condition |
|-------|---------|-------|-----------|
| Phase 1 | Main work | Step's allowed_tools | Always |
| Phase 2 | Report output | Write only | When output_contracts defined |
| Phase 3 | Status judgment | None (judgment only) | When tag-based rules exist |

## Rule Evaluation

RuleEvaluator determines the next step via 5-stage fallback. Earlier match takes priority.

| Priority | Method | Target |
|----------|--------|--------|
| 1 | aggregate | parallel parent (all/any) |
| 2 | Phase 3 tag | `[STEP:N]` output |
| 3 | Phase 1 tag | `[STEP:N]` output (fallback) |
| 4 | ai() judge | ai("condition") rules |
| 5 | AI fallback | AI evaluates all conditions |

When multiple tags appear in output, the **last match** wins.

### Condition Syntax

| Syntax | Parsing | Regex |
|--------|---------|-------|
| `ai("...")` | AI condition evaluation | `AI_CONDITION_REGEX` |
| `all("...")` / `any("...")` | Aggregate condition | `AGGREGATE_CONDITION_REGEX` |
| Plain string | Tag or AI fallback | — |

Adding new special syntax requires updating both workflowParser.ts regex and RuleEvaluator.

## Provider Integration

Abstracted through the Provider interface. SDK-specific details are encapsulated within each provider.

```
Provider.setup(AgentSetup) → ProviderAgent
ProviderAgent.call(prompt, options) → AgentResponse
```

| Criteria | Judgment |
|----------|----------|
| SDK-specific error handling leaking outside Provider | REJECT |
| Errors not propagated to AgentResponse.error | REJECT |
| Session key collision between providers | REJECT |
| Session key format `{persona}:{provider}` | OK |

### Model Resolution

Models resolve through 5-level priority. Higher takes precedence.

1. persona_providers model specification
2. Step model field
3. CLI `--model` override
4. config.yaml (when resolved provider matches)
5. Provider default

## Auxiliary Entry Contracts

In TAKT, workflow runtime is not the only user-visible contract entry. Preview, doctor, workflow summary, validation, and report paths are also contract entries. Auxiliary entries that display or validate config values, providers, models, tools, permissions, or output contracts should use the same normalized input, resolver, and override order as runtime.

| Criteria | Judgment |
|----------|----------|
| Runtime and preview resolve provider, model, tool, or permission from different inputs | REJECT |
| Preview only displays a value without verifying the same override conditions as runtime | REJECT |
| Doctor or validation accepts config that fails at runtime due to different conditions | Warning |
| Runtime and auxiliary entries share the same normalized input or resolver | OK |

## Runtime Asset Consumption Boundaries

TAKT runtime assets get their meaning from the entry point that consumes them, not only from their location or name. The same string can be an asset reference, session identifier, display name, or directly supplied body, and each is a separate contract.

| Criteria | Judgment |
|----------|----------|
| Treating an entry that resolves asset references and an entry that only uses identifiers as equivalent | REJECT |
| Adding a same-named facet and assuming it affects an entry that receives body content directly | REJECT |
| Workflow-derived runtime assets and feature-local runtime assets share the same responsibility name | Warning |
| Each entry point confirms which resolver or loader consumes which asset type before placing the asset | OK |
| Shared body content is centralized behind the existing runtime asset loader | OK |

### Reference Names and Identity Names

Strings such as `persona`, `session_key`, and `name` mean different things depending on whether they are reference names or identity names. A reference name causes the corresponding resolver to load an asset. An identity name is a key for sessions, logs, state, or display, and a same-named file is not used unless that entry reads it. When adding a new asset, trace the loader that reads it and the call site that consumes it.

## Facet Assembly

The faceted-prompting module is independent from TAKT core.

```
compose(facets, options) → ComposedPrompt { systemPrompt, userMessage }
```

| Criteria | Judgment |
|----------|----------|
| Import from faceted-prompting to TAKT core | REJECT |
| TAKT core depending on faceted-prompting | OK |
| Facet path resolution logic outside faceted-prompting | Warning |

### 3-Layer Facet Resolution Priority

Project `.takt/` → User `~/.takt/` → Builtin `builtins/{lang}/`

Same-named facets are overridden by higher-priority layers. Customize builtins by overriding in upper layers.

## Testing Patterns

Uses vitest. Test file naming conventions distinguish test types.

| Prefix | Type | Content |
|--------|------|---------|
| None | Unit test | Individual function/class verification |
| `it-` | Integration test | Workflow execution simulation |
| `engine-` | Engine test | WorkflowEngine scenario verification |

### Mock Provider

`--provider mock` returns deterministic responses. Scenario queues compose multi-turn tests.

```typescript
// NG - Calling real API in tests
const response = await callClaude(prompt)

// OK - Set up scenario with mock provider
setMockScenario([
  { persona: 'coder', status: 'done', content: '[STEP:1]\nDone.' },
  { persona: 'reviewer', status: 'done', content: '[STEP:1]\napproved' },
])
```

### Test Isolation

| Criteria | Judgment |
|----------|----------|
| Tests sharing global state | REJECT |
| Environment variables not cleared in test setup | Warning |
| E2E tests assuming real API | Isolate via `provider` config |

## Error Propagation

Provider errors propagate through: `AgentResponse.error` → session log → console output.

| Criteria | Judgment |
|----------|----------|
| SDK error results in empty `blocked` status | REJECT |
| Error details not recorded in session log | REJECT |
| No ABORT transition defined for error cases | Warning |

## Session Management

Agent sessions are stored per-cwd and per-provider. Session resume is skipped during worktree/clone execution.

When a normal Phase 1 response merely omits `sessionId`, that alone is not a reason to discard the existing session. Paths that are allowed to continue the existing resume context should preserve the old sessionId.

However, when a retry or fallback explicitly runs as a new session and succeeds, a missing `sessionId` must not continue using the old resumed session. The storage layer must be told that the new run produced no sessionId, so the old session is cleared or isolated.

The Report Phase is Phase 2 and reads Phase 1 outputs. Its execution contract is readonly and tool-free. Report retry/fallback must preserve `permissionMode: readonly`, empty tool permission, and provider capability overrides such as turn limits.

| Criteria | Judgment |
|----------|----------|
| Session resuming when `cwd !== projectCwd` | REJECT (cross-project contamination) |
| Session key missing provider identifier | REJECT (cross-provider contamination) |
| Session broken between phases that should continue context | REJECT (context loss) |
| Old resumed session remains after successful new-session retry | REJECT (unintended resume) |
| Report retry/fallback drops readonly mode, tool-free execution, or capability overrides | REJECT |
