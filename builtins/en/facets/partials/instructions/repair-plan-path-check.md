{{include:instructions/contract-path-analysis}}

For every authorized repair, reconstruct its invariant, responsible source, and complete affected path graph. Include required migrations, obsolete-path removal, preservation conditions, and falsifiable completion evidence in the fix units. Do not use only the cited line as the repair boundary.

Do not treat the contracts of multiple paths as identical merely because they share an implementation. If changing the shared location would alter inputs, return values, or failure behavior that the current task does not require changing, include a boundary that preserves those established conditions in the plan.

Do not edit, add or dismiss concerns, or declare completion in this procedure.
