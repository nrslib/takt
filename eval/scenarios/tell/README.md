# `/tell` semantic evaluation

`npm run eval:tell` runs the `TEST-015` evaluation against a real provider. The
provider defaults to `codex`; set `TAKT_TELL_EVAL_PROVIDER` to another real
provider and optionally set `TAKT_TELL_EVAL_MODEL` when the provider needs an
explicit model. `TAKT_TELL_EVAL_CWD` can override the project directory passed
to the provider.

The evaluation executes `runTellCommand` with the production template loading
and `callAIWithRetry` path. It runs the P1 and N1 agreement/correction pair in
both Japanese and English. Candidate discovery, selection, confirmation, and
the final writer are isolated at their existing module boundaries; the
generated body is never replaced by a fixture response. A separate model call
judges whether each generated body is standalone and reflects the applicable
latest agreement. The same judge, provider, model, working directory, and
conversation history are then reused for contrast cases that change only the
candidate body: P1 includes Android, N1 preserves the superseded Android
exclusion, and both scenarios include a non-standalone acknowledgement in each
language. Those candidates must be rejected. Generated cases record the
provider, model, generated body, confirmation body, writer body, pass/fail
result, and judgment reason; contrast cases record the provider, model,
candidate body, pass/fail result, and judgment reason. Real-generation results
and contrast results are evaluated separately.

This suite is intentionally excluded from `npm test` and `npm run test:it`
because it requires real-model credentials and consumes provider quota.
