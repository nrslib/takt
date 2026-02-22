# AI Antipattern Detection Criteria

## Assumption Verification

AI often makes assumptions. Verify them.

| Check | Question |
|-------|----------|
| Requirements | Does the implementation match what was actually requested? |
| Context | Does it follow the existing codebase conventions? |
| Domain | Are business rules correctly understood? |
| Edge Cases | Did the AI consider realistic edge cases? |

Red flags:
- Implementation appears to answer a different question
- Uses patterns not found elsewhere in the codebase
- Overly generic solution for a specific problem

## Plausible-but-Wrong Detection

AI generates code that looks correct but is wrong.

| Pattern | Example |
|---------|---------|
| Syntactically correct but semantically wrong | Validation that checks format but misses business rules |
| Hallucinated APIs | Calling methods that don't exist in the library version being used |
| Stale patterns | Using deprecated approaches from training data |
| Over-engineering | Adding unnecessary abstraction layers for the task |
| Under-engineering | Missing error handling for realistic scenarios |
| Forgotten wiring | Mechanism is implemented but not passed from entry points |

Verification approach:
1. Can this code actually compile/run?
2. Do the imported modules/functions exist?
3. Is the API used correctly for this library version?
4. If new parameters/fields were added, are they actually passed from callers?
   - AI often implements correctly within individual files but forgets cross-file wiring
   - Grep to check if `options.xxx ?? fallback` always uses the fallback

## Copy-Paste Pattern Detection

AI often repeats the same patterns, including mistakes.

| Check | Action |
|-------|--------|
| Repeated dangerous patterns | Same vulnerability in multiple places |
| Inconsistent implementation | Same logic implemented differently across files |
| Boilerplate explosion | Unnecessary repetition that could be abstracted |

## Context Fitness Assessment

Does the code fit this specific project?

| Aspect | Verification |
|--------|-------------|
| Naming conventions | Matches existing codebase style |
| Error handling style | Consistent with project patterns |
| Logging approach | Uses project's logging conventions |
| Test style | Matches existing test patterns |

Questions to ask:
- Would a developer familiar with this codebase write it this way?
- Does it feel like it belongs here?
- Are there unexplained deviations from project conventions?

## Scope Creep Detection

AI tends to over-deliver. Check for unnecessary additions.

| Check | Problem |
|-------|---------|
| Extra features | Functionality not requested |
| Premature abstraction | Interfaces/abstractions for single implementations |
| Over-configuration | Making things configurable that don't need to be |
| Gold-plating | "Nice-to-have" additions not asked for |
| Unnecessary legacy support | Adding mapping/normalization logic for old values without explicit instruction |

The best code is the minimum code that solves the problem.

Legacy support criteria:
- Unless explicitly instructed to "support legacy values" or "maintain backward compatibility", legacy support is unnecessary
- Do not add `.transform()` normalization, `LEGACY_*_MAP` mappings, or `@deprecated` type definitions
- Support only new values and keep it simple

## Dead Code Detection

AI adds new code but often forgets to remove code that is no longer needed.

| Pattern | Example |
|---------|---------|
| Unused functions/methods | Old implementations remaining after refactoring |
| Unused variables/constants | Definitions no longer needed after condition changes |
| Unreachable code | Processing remaining after early returns, always-true/false conditions |
| Logically unreachable defensive code | Branches that never execute due to caller constraints |
| Unused imports/dependencies | Import statements or package dependencies for removed features |
| Orphaned exports/public APIs | Re-exports or index registrations remaining after implementation is removed |
| Unused interfaces/type definitions | Old types remaining after implementation changes |
| Disabled code | Code left commented out |

Logical dead code detection:

AI tends to add "just in case" defensive code, but when considering caller constraints, it may be unreachable. Code that is syntactically reachable but logically unreachable due to call chain preconditions should be removed.

```typescript
// REJECT - callers are only from interactive menus that require TTY
// This function is never called from non-TTY environments
function showFullDiff(cwd: string, branch: string): void {
  const usePager = process.stdin.isTTY === true;
  // usePager is always true (callers assume TTY)
  const pager = usePager ? 'less -R' : 'cat';  // else branch is unreachable
}

// OK - understands caller constraints and removes unnecessary branching
function showFullDiff(cwd: string, branch: string): void {
  // Only called from interactive menus, so TTY is always present
  spawnSync('git', ['diff', ...], { env: { GIT_PAGER: 'less -R' } });
}
```

Verification approach:
1. When finding defensive branches, grep to check all callers of the function
2. If all callers already satisfy the condition, the defense is unnecessary
3. Grep to confirm no references to changed/deleted code remain
4. Verify that public module (index files, etc.) export lists match actual implementations
5. Check that no old code remains corresponding to newly added code

## Fallback/Default Argument Overuse Detection

AI overuses fallbacks and default arguments to hide uncertainty.

| Pattern | Example | Verdict |
|---------|---------|---------|
| Fallback on required data | `user?.id ?? 'unknown'` | REJECT |
| Default argument overuse | `function f(x = 'default')` where all callers omit it | REJECT |
| Nullish coalescing with no input path | `options?.cwd ?? process.cwd()` with no way to pass from above | REJECT |
| try-catch returning empty | `catch { return ''; }` | REJECT |
| Multi-level fallback | `a ?? b ?? c ?? d` | REJECT |
| Silent ignore in conditionals | `if (!x) return;` silently skipping what should be an error | REJECT |

Verification approach:
1. Grep the diff for `??`, `||`, `= defaultValue`, `catch`
2. For each fallback/default argument:
   - Is it required data? -> REJECT
   - Do all callers omit it? -> REJECT
   - Is there a path to pass the value from above? -> If not, REJECT
3. REJECT if any fallback/default argument exists without justification

## Unused Code Detection

AI tends to generate unnecessary code for "future extensibility", "symmetry", or "just in case". Code not currently called from anywhere should be removed.

| Verdict | Criteria |
|---------|----------|
| REJECT | Public functions/methods not called from anywhere currently |
| REJECT | Setters/getters created "for symmetry" but not used |
| REJECT | Interfaces or options prepared for future extension |
| REJECT | Exported but no usage found via grep |
| OK | Implicitly called by framework (lifecycle hooks, etc.) |

Verification approach:
1. Grep to confirm no references to changed/deleted code remain
2. Verify that public module (index files, etc.) export lists match actual implementations
3. Check that no old code remains corresponding to newly added code

## Unnecessary Backward Compatibility Code Detection

AI tends to leave unnecessary code "for backward compatibility". Don't miss this.

Code to remove:

| Pattern | Example | Verdict |
|---------|---------|---------|
| deprecated + no usage | `@deprecated` annotation with no one using it | Remove immediately |
| Both old and new APIs exist | Old function remains alongside new function | Remove old, unless both have active usage sites |
| Completed migration wrapper | Wrapper created for compatibility but migration is complete | Remove |
| Comment says "remove later" | `// TODO: remove after migration` left abandoned | Remove now |
| Excessive proxy/adapter usage | Complexity added solely for backward compatibility | Replace simply |

Code to keep:

| Pattern | Example | Verdict |
|---------|---------|---------|
| Externally published API | npm package exports | Consider carefully |
| Config file compatibility | Can read old format config | Maintain until major version |
| During data migration | In the middle of DB schema migration | Maintain until complete |

Decision criteria:
1. Are there usage sites? -> Verify with grep/search. Remove if none
2. Do both old and new have usage sites? -> If both are currently in use, this may be intentional coexistence rather than backward compatibility. Check callers
3. Is it externally published? -> Can remove immediately if internal only
4. Is migration complete? -> Remove if complete

When AI says "for backward compatibility", be skeptical. Verify if it's truly necessary.

## Decision Traceability Review

Verify that the Coder's decision log is valid.

| Check | Question |
|-------|----------|
| Decision is documented | Are non-obvious choices explained? |
| Rationale is sound | Does the reasoning make sense? |
| Alternatives considered | Were other approaches evaluated? |
| Assumptions explicit | Are assumptions explicit and reasonable? |
