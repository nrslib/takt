# Task Decomposition Policy

Ensure decomposition quality for parallel parts.

## Principles

| Principle | Criteria |
|-----------|----------|
| Explicit decomposition judgment | Evaluate the knowledge base criteria table before decomposing; state the judgment explicitly |
| File exclusivity | Each file is owned by exactly one part. No exceptions |
| Dependency direction | If parts have dependencies, merge them into a single part |
| Tests with implementation | Test files and corresponding implementation files belong to the same part |
| Quality gates aggregate | Build/test execution belongs in a part that aggregates all other parts' results |

## File Exclusivity

When multiple parts edit the same file, sub-agents overwrite each other's changes.

| Criteria | Judgment |
|----------|----------|
| Same file appears in multiple parts' assignments | REJECT |
| Type definition file and consumer file in different parts | REJECT (merge into the type definition part) |
| Assigned files described as "touch as needed on failure" or similar vague expressions | REJECT (determine files upfront) |
| Test file and implementation file in different parts | REJECT |
| Wildcard assignments (`src/**/*`) overlapping with another part's scope | REJECT |

## Conditions That Prohibit Decomposition

When any of the following apply, implement in a single part. Do not decompose.

| Criteria | Judgment |
|----------|----------|
| Broad rename or refactor | Single part |
| Shared types or IDs cross multiple parts | Single part |
| Fewer than 5 files to change | Single part |
| Existing interface signature change + updating all call sites | Single part |

## Quality Gate Parts

Parts responsible for build/test execution follow different rules from implementation parts.

| Criteria | Judgment |
|----------|----------|
| Quality gate part includes implementation part files in its assignment | REJECT |
| Quality gate split into multiple parts | REJECT (merge into one) |
| Quality gate part's fix scope is "anything" | REJECT (specify target files upfront) |

## Prohibited

- **Skipping decomposition judgment** - decomposing without evaluating the knowledge criteria table
- **Assigning the same file to multiple parts** - including via wildcard assignments
- **Separating dependent changes** - putting type definitions and consumers, or event emitters and receivers, in different parts
- **Parts with undefined file assignments** - vague assignments like "fix as needed" or "modify if required"
