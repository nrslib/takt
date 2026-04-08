# Design Planning Policy

When a task includes design references, planning must make element inventory and scope decisions explicit.

## Principles

| Principle | Standard |
|------|------|
| Reference-first planning | When design references exist, planning treats them as primary input |
| Element-level inventory | Differences are checked at the element level, not only at the screen level |
| Explicit change decision | Each element includes a keep/change decision with rationale |
| Scope exclusion accountability | If a design element is excluded, the reason must be stated |
| Clear implementation boundary | The boundary between in-scope and out-of-scope elements is fixed during planning |

## Applicability

This policy applies to planning tasks whose task instructions or reference materials include design references. It does not apply when no design reference exists.

## Decision Criteria

| Criteria | Decision |
|------|------|
| Planning proceeds without listing the main design elements | REJECT |
| There is no keep/change decision for each element | REJECT |
| Scope is narrowed with vague statements such as "list only this time" without naming elements | REJECT |
| Out-of-scope elements do not include an exclusion rationale | REJECT |
| Design interpretation is ambiguous but the rationale is recorded | OK |

## Planning Judgment

Planning inventories the design reference without dropping elements that materially affect the UI or flow.

Inventory viewpoints:
- Check not only major sections, but also detailed flows, modals, action controls, and state displays
- Record the current implementation difference and keep/change decision for each element
- When keeping the existing implementation, cite the target file and rationale

## Scope Decisions

If a design-referenced element is placed out of scope, planning records at least:

- the excluded element name
- the reason for exclusion
- the reason no substitute implementation is taken now

Do not split out design-referenced elements as "another task" without explicit rationale.

## Prohibited

- **Planning with only coarse screen-level summaries** - causes missing element coverage
- **Narrowing the intent of the reference without rationale** - misaligns implementation and review
- **Omitting the explanation for out-of-scope elements** - makes later steps ambiguous
