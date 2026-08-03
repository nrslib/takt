# Issue #1127 snapshot

Source: https://github.com/nrslib/takt/issues/1127

Move command quality gates after rule-condition and transition resolution but before the selected transition is applied.

Add `command_gates: required | skip` to each rule. Omission means `required`. A `required` gate runs for the already selected transition: exit 0 applies it; non-zero, timeout, or spawn error must leave the transition unapplied and retry the same step with the existing failure information. A `skip` rule applies its transition without invoking the gate. Existing `blocked` and `error` early exits stay unchanged, and no transition may be persisted before a required gate succeeds.

The contract must be consistent for ordinary `next`, `COMPLETE`, `ABORT`, rule `return`, and `requires_user_input`, in both the normal execution loop and `runSingleWorkflowIteration`. Update schema, internal types, normalization, loader/fragment handling, documentation, and behavior-focused tests. Invalid values must fail during workflow loading.

Inspect the current repository and produce an implementation plan.
