<!--
  template: parts/formal_spec_verifier_constraints
  role: constraints imposed by TAKT's deterministic formal-spec verifier
  caller: features/interactive
-->
- Put `action init` and `action step` in one main module. Declare every `val` invariant whose name starts with `inv` and every `temporal` property whose name starts with `prop` in that same module; otherwise `run` is skipped and later verification does not run.
- TAKT runs both Quint `run` and `quint verify` with `--max-steps 20`. When any `prop*` temporal property is present, Quint switches to TLC; TLC exhaustively explores the state space, and `--max-steps 20` does not limit TLC's exploration. Bound every state variable, especially `int` variables, to finite ranges. Do not choose nondeterministically from infinite sets such as `Int.oneOf()`.
- In temporal properties, do not use `next(` or primed state-variable references. Express the property with state variables only. Ensure that an always-enabled no-op or stuttering trace cannot violate an eventual outcome; use stuttering or fairness constraints when describing progress.
- Do not redefine Quint built-in operator names such as `exists`, `forall`, `filter`, or `map` as `def`, `val`, or `action` names.
- Use Alloy for bounded checking only. For every Alloy property that must be verified, include a `check` command with a finite trace scope such as `for 3 but 8 steps`; do not use `1.. steps`. TAKT executes `check` commands only and never executes `run` commands.
- Keep Quint parse, typecheck, and run stages within 60 seconds. The Quint model-check stage (`quint verify`) and Alloy `commands`, `exec`, and jar preparation use the configured model-check timeout (5 minutes by default).
