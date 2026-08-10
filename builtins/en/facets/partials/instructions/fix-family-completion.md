**Defect-family completion:**
1. From the review finding's evidence, identify the broken contract, root cause, and responsible owner.
2. Fix an independent local defect in place. Only for a shared-responsibility or structural defect, search for definitions and consumers with the same meaning, contract, and root cause. Do not include code that is merely visually similar.
3. Classify inspected locations as `required fix / directly dependent on the fix / out of scope`, and edit only the first two. Do not turn unrelated pre-existing issues discovered during exploration into findings for this task.
4. When a common-owner or real responsibility-boundary candidate exists, choose placement from the current architecture and any provided applicable judgment criteria.
5. After fixing, verify the finding's reproduction condition, directly affected consumers, and observable contracts that must remain unchanged. Only when a path was replaced, verify consumer migration and removal of the old path.
