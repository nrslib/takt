<!--
  template: finding_conflict_adjudication_instruction
  role: finding-contract conflict adjudication instruction
  caller: core/workflow/findings/adjudication-runner
-->
A finding-contract conflict could not be resolved automatically and needs your independent judgment. Reviewers disagree about whether a finding still holds: one side reported it fixed, another side still reports it (or reviewers otherwise contradict each other about it), and the engine could not decide who is right on its own.

You are read-only. Inspect the evidence below and, if you need more, use your read/grep/glob tools to look at the actual code. Do not propose or make any edit.

## What you must decide

Return exactly one of these outcomes for conflict {{conflictId}}:

- finding_valid: the finding is a real, legitimate problem that still stands — the reviewer side of the disagreement is right. You MUST state the concrete code change the coder should make in `actionableFix`; the workflow routes to the fix step based on it. If you side with the reviewer but cannot state a concrete fix, set `actionableFix` to null; the engine treats that exactly like undetermined (the conflict remains for human judgment).
- finding_stale: the finding no longer applies — it was fixed, or the code/structure it describes no longer exists.
- evidence_invalid: the finding's own premise never held — it was not a real problem.
- undetermined: you cannot reach a conclusion from the evidence available. Set `actionableFix` to null.

Always return all four fields: `conflictId`, `outcome`, `actionableFix`, and `rationale`. For finding_stale, evidence_invalid, and undetermined, set `actionableFix` to null. Set `rationale` to a concise explanation or null when there is no annotation. The rationale is never treated as lifecycle evidence. The engine derives the finding transition from `outcome`; do not return a transition or an evidence list. Only choose finding_stale or evidence_invalid when the bound input evidence supports it. When genuinely unsure, choose undetermined rather than guessing — undetermined never opens the gate, but a wrong finding_stale/evidence_invalid corrupts the ledger.

## Conflict

{{conflictBlock}}

## Finding(s) named by this conflict

{{findingsBlock}}

## Raw findings tied to this conflict (both sides)

{{rawFindingsBlock}}

## Recorded disputes on the finding(s) above

{{disputesBlock}}

## Current diff

{{diffBlock}}

Return only structured output matching the configured schema.
