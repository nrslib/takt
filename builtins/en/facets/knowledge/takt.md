# TAKT Architecture Knowledge

## Core Structure

PieceEngine is a state machine. It manages movement transitions via EventEmitter.

```
CLI → PieceEngine → Runner (4 types) → RuleEvaluator → next movement
```

| Runner | Purpose | When to Use |
|--------|---------|-------------|
| MovementExecutor | Standard 3-phase execution | Default |
| ParallelRunner | Concurrent sub-movements | parallel block |
| ArpeggioRunner | Data-driven batch processing | arpeggio block |
| TeamLeaderRunner | Task decomposition → parallel sub-agents | team_leader block |

Runners are mutually exclusive. Do not specify multiple runner types on a single movement.

### 3-Phase Execution Model

Normal movements execute in up to 3 phases. Sessions persist across phases.

| Phase | Purpose | Tools | Condition |
|-------|---------|-------|-----------|
| Phase 1 | Main work | Movement's allowed_tools | Always |
| Phase 2 | Report output | Write only | When output_contracts defined |
| Phase 3 | Status judgment | None (judgment only) | When tag-based rules exist |

## Rule Evaluation

RuleEvaluator determines the next movement via 5-stage fallback. Earlier match takes priority.

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

Adding new special syntax requires updating both pieceParser.ts regex and RuleEvaluator.

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
2. Movement model field
3. CLI `--model` override
4. config.yaml (when resolved provider matches)
5. Provider default

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
| `it-` | Integration test | Piece execution simulation |
| `engine-` | Engine test | PieceEngine scenario verification |

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

Agent sessions are stored per-cwd. Session resume is skipped during worktree/clone execution.

| Criteria | Judgment |
|----------|----------|
| Session resuming when `cwd !== projectCwd` | REJECT (cross-project contamination) |
| Session key missing provider identifier | REJECT (cross-provider contamination) |
| Session broken between phases | REJECT (context loss) |
