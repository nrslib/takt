# Formal Specification Verification (/verify)

[日本語](./formal-verification.ja.md) | [简体中文](./formal-verification.zh-CN.md)

While refining requirements in interactive mode, run `/verify` to write the current agreement out as formal specifications and check them with model checkers. TAKT asks the assistant to express the agreement in [Quint](https://quint-lang.org/) and [Alloy](https://alloytools.org/), extracts the `quint` and `alloy` code blocks from the response, and runs the verifiers. The results are sent back to the same session, where the assistant interprets and explains them.

## Requirements

Nothing extra has to be installed for the Quint `parse`, `typecheck`, and `run` stages. Quint ships as a dependency of TAKT and runs on the same Node.js that runs TAKT.

Model checking with `quint verify` and the Alloy Analyzer needs Java 17 or later. Any JDK works as long as `java` is on `PATH`. When Java is missing or older than 17, the model-checking stages are skipped and the result says so explicitly; the basic Quint stages still run.

Two artifacts are downloaded automatically on first use.

| Artifact | When | Location |
|----------|------|----------|
| Apalache | Fetched by Quint on the first `quint verify` | `~/.quint/` (override with `QUINT_HOME`) |
| Alloy Analyzer 6.2.0 JAR | Fetched by TAKT on the first Alloy verification; SHA-256 is checked | `.takt/cache/alloy/6.2.0/alloy.jar` inside the project |

TLC, which is used for temporal properties, is part of the Apalache distribution, so no separate TLC install is needed. The downloads happen once and require network access; later `/verify` runs work offline.

To use Alloy without network access, point the `TAKT_ALLOY_JAR` environment variable at an Alloy JAR you already have. Relative paths are resolved from the project directory.

## Enabling it

`/verify` is only available in a session where formal specification mode is enabled. Configure it with `assistant.formal_spec` in `~/.takt/config.yaml` or `.takt/config.yaml`.

```yaml
assistant:
  formal_spec:
    mode: 'Y/n'     # true, false, Y/n, or y/N (default: y/N)
    comments: true  # natural-language meaning comments on each formal construct (default: true)
    model_check_timeout_seconds: 300  # limit for quint verify and Alloy model checking, integer 1-86400 (default: 300)
```

`true` and `false` are used without asking. `Y/n` and `y/N` prompt once at the start of an interactive session; the uppercase letter is the answer chosen when you just press Enter. See [Configuration](./configuration.md) for the full option reference.

## How verification proceeds

Verification starts only when the assistant's response contains a Quint or Alloy code block. Without either, TAKT reports just that.

For a Quint block, TAKT runs the stages in order, and a stage that does not pass skips everything after it.

1. `parse` checks the syntax.
2. `typecheck` checks types and effects.
3. `run` simulates one sample for up to 20 steps. It runs only when a main module with `init` and `step` actions is found and the selected verification targets live in that module.
4. With Java 17 or later, `quint verify` runs with a bound of 20 steps. A specification with temporal properties switches to the TLC backend, which exhaustively explores the state space.

For an Alloy block, TAKT runs the Alloy Analyzer independently of the Quint results. Every `check` command in the specification is verified.

`parse`, `typecheck`, and `run` have a 60-second timeout. Model checking with `quint verify` and the Alloy Analyzer waits up to 5 minutes by default, adjustable with `assistant.formal_spec.model_check_timeout_seconds` (an integer from 1 to 86,400 seconds). If TLC is cut off on a specification with many states, raise this value or shrink the model.

## How targets are selected

Only conventionally named Quint definitions become verification targets.

| Kind | Rule | Example |
|------|------|---------|
| Invariant | A `val` whose name starts with `inv` | `val invBalanceNonNegative = ...` |
| Temporal property | A `temporal` whose name starts with `prop` | `temporal propEventuallyDone = ...` |

Put them in the module that has the `init` and `step` actions. If a target lives outside the main module, `run` is skipped. The assistant already knows this convention from the formal specification mode guidance, so normally you do not need to think about it; follow the same naming when you add specifications by hand.

In Alloy, `check` commands are the targets. `run` commands are not executed.

## Reading the result

The result is summarized as `passed`, `failed`, or `error`, with per-stage status and messages.

- `passed` means every stage that ran succeeded.
- `failed` means an invariant or temporal property was violated, or an Alloy `check` found a counterexample. The message includes the counterexample trace.
- `error` means verification could not be completed: a syntax or type error, a timeout, or a verifier that failed to start. A skipped model-checking stage due to missing Java also lands here, with the skipped stage and reason in the message.

When TLC reports a violation or failure, TAKT extracts the diagnostics starting at the `Error:` line and includes them in the result. Unrecognized output is included verbatim.

## Troubleshooting

If `quint verify` and Alloy are skipped, check that `java -version` reports 17 or later. TAKT invokes `java` from `PATH` as is.

If TLC times out, first raise `model_check_timeout_seconds`. If it still does not finish, the state space is too large or unbounded. `--max-steps` does not limit TLC, so bound every state variable, especially `int` variables, to a finite range.

If an Alloy `check` ends with "Bounded engines do not support complete model checking", the command scope asks for an unbounded trace such as `1.. steps`. TAKT runs Alloy with the default SAT solver (SAT4J), which can only do bounded checking; Electrod and nuXmv, which complete model checking requires, are not used. Give the trace a finite length, for example `for 3 but 8 steps`.

If `quint verify` stops with "Parsing or semantic analysis failed" while Quint `parse` and `typecheck` passed, a temporal property uses a form TLC does not accept. The typical case is `next(...)` inside `always`, as in `always(x.subseteq(next(x)))`. Rewrite the property without next-state references, using only the state variables.

If the Alloy JAR download fails, check your network and proxy settings, or supply a local JAR through `TAKT_ALLOY_JAR`. A downloaded JAR whose SHA-256 does not match is also treated as a failure.

Temporary files created during verification live under `.takt/runs/verify-*/` and are removed when verification ends. If one is left behind by an abnormal exit, the next `/verify` cleans up directories older than one hour.
