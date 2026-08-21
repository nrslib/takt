Close only the gaps identified by the completion judge, then update the fix result.

A local patch that edits the reported line without re-inspecting its surroundings is the failure mode this recheck exists to catch. Before declaring completion again:

- Keep the fix plan and the adjudicated findings as the sole source of scope and authority. Do not start new refactoring or widen the change.
- For each supplied gap, return to the root cause: check whether the same defect recurs at the other call sites, branches, and error paths that share it, and fix the ones inside the plan's scope.
- Re-read the full diff after editing. Revert changes unrelated to the findings, and confirm the fix does not break the adjacent behavior it touches.
- Verify each closed gap against actual code and executed evidence, not against the previous report's claims.
- Preserve the original output contract and restate the fix results with the verified evidence.
