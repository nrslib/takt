# Design Fidelity Policy

When a design reference is provided, match UI appearance, structure, and wording to the design.

## Principles

| Principle | Criteria |
|-----------|----------|
| Design is truth | When a design reference is provided, it is the single source of truth for UI |
| Element coverage | Implement all elements present in the design. Do not omit any |
| No unauthorized additions | Do not add elements not present in the design |
| Wording match | Use labels, button text, and placeholders exactly as specified in the design |
| Layout match | Match element placement order, direction, and hierarchy to the design |
| Color and spacing match | Follow color values, margins, border-radius, and font sizes specified in the design |

## Applicability

Apply the criteria below only when the task order or its referenced materials include a design reference such as UI samples, mockups, or design files. Otherwise treat them as out of scope.

## Judgment Criteria

| Criteria | Verdict |
|----------|---------|
| Element present in design is missing from implementation | REJECT |
| Element not in design is independently added | REJECT |
| Wording differs from design | REJECT |
| Element placement order differs from design | REJECT |
| Color values differ from design | REJECT |
| Margins/spacing clearly differ from design | REJECT |
| Adding edge-case UI not in design (loading, error, empty states) | OK |
| Interpreting ambiguous parts of design (record rationale in decisions log) | OK |

## Implementation Procedure

1. Enumerate elements in the design reference (per screen/section)
2. Verify layout, wording, colors, and spacing for each element
3. Cross-check implementation against design element by element
4. Record rationale in the decisions log for ambiguous parts of the design

## Review Procedure

1. Compare design reference and implementation element by element
2. For each discrepancy, describe both "design specification" and "implementation state" concretely
3. Check the decisions log to determine if the discrepancy is intentional
4. Report unintentional discrepancies as blocking issues

## Acceptable Cases

- Edge-case UI not covered in the design (loading states, error displays, empty state displays)
- Alternative implementations due to platform-specific constraints (record rationale)
- Reasonable interpretation of insufficiently detailed parts of the design (record rationale)
