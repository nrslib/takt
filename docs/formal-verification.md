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
    model_check_timeout_seconds: 900  # limit for quint verify and Alloy model checking, integer 1-86400 (default: 900)
```

`true` and `false` are used without asking. `Y/n` and `y/N` prompt once at the start of an interactive session; the uppercase letter is the answer chosen when you just press Enter. See [Configuration](./configuration.md) for the full option reference.

## How verification proceeds

Verification starts only when the assistant's response contains a Quint or Alloy code block. Without either, TAKT reports just that.

For a Quint block, TAKT runs the stages in order, and a stage that does not pass skips everything after it.

1. `parse` checks the syntax.
2. `typecheck` checks types and effects.
3. `run` simulates one sample for up to 20 steps. It runs only when a main module with `init` and `step` actions is found and the selected verification targets live in that module.
4. With Java 17 or later, `quint verify` runs with a bound of 20 steps. A specification with temporal properties switches to the TLC backend, which exhaustively explores the state space.

For an Alloy block, TAKT runs the Alloy Analyzer independently of the Quint results. Every `run` and `check` command in the specification is executed, including models with only `run` commands.

`parse`, `typecheck`, and `run` have a 60-second timeout. Model checking with `quint verify` and the Alloy Analyzer waits up to 15 minutes by default, adjustable with `assistant.formal_spec.model_check_timeout_seconds` (an integer from 1 to 86,400 seconds). If TLC is cut off on a specification with many states, raise this value or shrink the model.

### Alloy concurrency and JVM settings

These environment variables are read once at the start of verification. They are not YAML keys and do not apply to Quint-only verification.

| Environment variable | Default | Format |
|----------------------|---------|--------|
| `TAKT_ALLOY_CONCURRENCY` | `2` | Positive safe integer; `1` runs sequentially |
| `TAKT_ALLOY_HEAP` | `4g` | Positive integer followed by lowercase `k`, `m`, or `g` |
| `TAKT_ALLOY_STACK` | `64m` | Positive integer followed by lowercase `k`, `m`, or `g` |

Only unset values use defaults; empty or invalid values produce an error naming the variable. Settings stay fixed for one verification. All Alloy JVM launches, including command enumeration, receive `-Xmx4g -Xss64m` by default. Overrides replace the defaults without duplicate arguments.

```bash
TAKT_ALLOY_CONCURRENCY=1 TAKT_ALLOY_HEAP=2g TAKT_ALLOY_STACK=128m takt
```

If memory is limited, lower the heap limit or set concurrency to 1. Use these TAKT-specific settings to change the JVM arguments instead of relying on `JAVA_TOOL_OPTIONS` alone.

`assistant.formal_spec.model_check_timeout_seconds` applies separately to each Alloy command (default: 900 seconds). There is no overall timeout; failures and timeouts do not prevent the remaining commands from running. A free slot starts the next command immediately. Each command result identifies a timeout with `timedOut: true`.

Failed, errored, or timed-out verification retains specifications and logs under `.takt/runs/verify-*/` and reports the directory in the result message. Retained directories are excluded from automatic cleanup; remove them manually when no longer needed. Successful verification artifacts are deleted after result interpretation.

## How targets are selected

Only conventionally named Quint definitions become verification targets.

| Kind | Rule | Example |
|------|------|---------|
| Invariant | A `val` whose name starts with `inv` | `val invBalanceNonNegative = ...` |
| Temporal property | A `temporal` whose name starts with `prop` | `temporal propEventuallyDone = ...` |

Put them in the module that has the `init` and `step` actions. If a target lives outside the main module, `run` is skipped. The assistant already knows this convention from the formal specification mode guidance, so normally you do not need to think about it; follow the same naming when you add specifications by hand.

In Alloy, every `run` and `check` is a target. A `run` passes when an instance exists within its scope (SAT) and fails when none exists (UNSAT). A `check` passes without a counterexample (UNSAT) and fails with one (SAT). Include a consistency `run {}` with a finite scope so contradictory model constraints cannot make every check pass vacuously. Use additional `run` commands for required scenarios and reachability; each is expected to be satisfiable. Keep the scope and temporal trace length finite for both command types.

The result records each `run` and `check` command's type, label, status, and message. If an instance or counterexample was found, inspect the diagnostic artifacts. An Alloy `expect` annotation does not override TAKT's verdict from the observed SAT/UNSAT result. Commands without an explicit `for` clause use Alloy's default finite scope.

## Reading the result

`/verify` supports `claude`, `claude-headless`, `claude-terminal`, `codex`, `cursor`, `copilot`, `kiro`, `opencode`, and `pi`. Result interpretation allows reading the verification artifacts. Claude providers restrict reads to the listed artifacts; the other supported providers use session-level read-only settings, which do not restrict readable paths to those artifacts.

The result is summarized as `passed`, `failed`, or `error`, with per-stage status and messages.

- `passed` means every stage that ran succeeded.
- `failed` means an invariant or temporal property was violated, an Alloy `check` found a counterexample, or an Alloy `run` found no instance within its scope. Counterexample traces are preserved in the diagnostic artifacts.
- `error` means verification could not be completed: a syntax or type error, a timeout, or a verifier that failed to start. A skipped model-checking stage due to missing Java also lands here, with the skipped stage and reason in the message.

When TLC reports a violation or failure, the result includes the diagnostic information.

## Troubleshooting

If `quint verify` and Alloy are skipped, check that `java -version` reports 17 or later. TAKT invokes `java` from `PATH` as is.

If TLC times out, first raise `model_check_timeout_seconds`. If it still does not finish, the state space is too large or unbounded. `--max-steps` does not limit TLC, so bound every state variable, especially `int` variables, to a finite range.

If an Alloy `check` ends with "Bounded engines do not support complete model checking", the command scope asks for an unbounded trace such as `1.. steps`. TAKT runs Alloy with the default SAT solver (SAT4J), which can only do bounded checking; Electrod and nuXmv, which complete model checking requires, are not used. Give the trace a finite length, for example `for 3 but 8 steps`.

If `quint verify` stops with "Parsing or semantic analysis failed" while Quint `parse` and `typecheck` passed, a temporal property uses a form TLC does not accept. The typical case is `next(...)` inside `always`, as in `always(x.subseteq(next(x)))`. Rewrite the property without next-state references, using only the state variables.

If the Alloy JAR download fails, check your network and proxy settings, or supply a local JAR through `TAKT_ALLOY_JAR`. A downloaded JAR whose SHA-256 does not match is also treated as a failure.

A retention marker protects workspaces with completed failed, errored, or timed-out results from automatic cleanup. An ownership marker also protects workspaces unless deletion has explicitly been requested, regardless of whether the owner Node process is still running. This includes workspaces left by an abnormal exit before a result is finalized; remove them manually when no longer needed. If the ownership marker cannot be inspected, the workspace is not deleted. Successful workspaces are removed after interpretation; explicitly cancelled verification waits for its processes to stop, then removes its workspace.

If writing the retention marker fails, TAKT moves the ownership marker to the retention marker and reports the directory and write error. If the move also fails, TAKT leaves the ownership marker in place and reports that retention could not be confirmed, together with both errors. The remaining ownership marker protects the workspace from automatic cleanup even after the owner exits. Follow the notice to copy any needed artifacts manually.

Workspaces without either marker become eligible for cleanup after more than one hour of inactivity. When deletion following success or cancellation fails, TAKT records the pending deletion in the current process. The next `/verify` in that process retries deletion after more than one hour of inactivity, even if the ownership marker could not be removed.
