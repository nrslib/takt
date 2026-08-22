# TAKT Policy

Provide one source of truth for independent judgments about takt.

## Principles

| Principle | Criterion |
|-----------|-----------|
| Check applicability | Apply the policy only to the original requirement, changed contract, and real impact paths |
| Use evidence | Judge only conditions confirmed by code, contracts, or evidence |
| Preserve ownership boundaries | Distinguish the responsible owner from observable effects |
| Keep the scope bounded | Judge only the scope causally related to the request |
| Centralize judgment | This policy is authoritative; Knowledge examples do not grant judgment authority |

## TAKT Criteria

### Provider Integration

| Criteria | Judgment |
|----------|----------|
| SDK-specific error handling leaking outside Provider | REJECT |
| Errors not propagated to AgentResponse.error | REJECT |
| Session key collision between providers | REJECT |
| Session key format `{persona}:{provider}` | OK |

### Auxiliary Entry Contracts

| Criteria | Judgment |
|----------|----------|
| Runtime and preview resolve provider, model, tool, or permission from different inputs | REJECT |
| Preview only displays a value without verifying the same override conditions as runtime | REJECT |
| Doctor or validation accepts config that fails at runtime due to different conditions | Warning |
| Runtime and auxiliary entries share the same normalized input or resolver | OK |

### Runtime Asset Consumption Boundaries

| Criteria | Judgment |
|----------|----------|
| Treating an entry that resolves asset references and an entry that only uses identifiers as equivalent | REJECT |
| Adding a same-named facet and assuming it affects an entry that receives body content directly | REJECT |
| Workflow-derived runtime assets and feature-local runtime assets share the same responsibility name | Warning |
| Each entry point confirms which resolver or loader consumes which asset type before placing the asset | OK |
| Shared body content is centralized behind the existing runtime asset loader | OK |

### Facet Assembly

| Criteria | Judgment |
|----------|----------|
| Import from faceted-prompting to TAKT core | REJECT |
| TAKT core depending on faceted-prompting | OK |
| Facet path resolution logic outside faceted-prompting | Warning |

### Test Isolation

| Criteria | Judgment |
|----------|----------|
| Tests sharing global state | REJECT |
| Environment variables not cleared in test setup | Warning |
| E2E tests assuming real API | Isolate via `provider` config |

### Error Propagation

| Criteria | Judgment |
|----------|----------|
| SDK error results in empty `blocked` status | REJECT |
| Error details not recorded in session log | REJECT |
| No ABORT transition defined for error cases | Warning |

### Session Management

| Criteria | Judgment |
|----------|----------|
| Session resuming when `cwd !== projectCwd` | REJECT (cross-project contamination) |
| Session key missing provider identifier | REJECT (cross-provider contamination) |
| Session broken between phases that should continue context | REJECT (context loss) |
| Old resumed session remains after successful new-session retry | REJECT (unintended resume) |
| Report retry/fallback drops readonly mode, tool-free execution, or capability overrides | REJECT |
