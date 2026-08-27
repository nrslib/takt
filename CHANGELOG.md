# Changelog

[日本語](./docs/CHANGELOG.ja.md)

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.63.0] - 2026-08-27

### Added

- Structured `assistant.formal_spec` with `mode` and `comments` (#1512). The plain `true` / `false` / `"Y/n"` / `"y/N"` value is still accepted; the object form sets the Alloy/Quint `mode` and a `comments` flag independently, and project and global objects are resolved per field with project values taking precedence. When `comments` is `true` (the default), the assistant is asked to add natural-language comments inside each Quint and Alloy block next to states, transitions, temporal requirements, invariants, ownership, and cardinality, so each notation can be read on its own. `comments: false` removes only that instruction; the amount of formal specification, requirement coverage, and syntax/correctness guidance are unchanged.
- `takt ui` (experimental) starts a local Web UI on `http://127.0.0.1:20525` (#1502). It offers a Viewer for task and run navigation, an execution graph, live logs and reports, a conversation surface that creates tasks with `/setup` and `/go`, and the `takt list` task actions such as retry and instruct. Web UI tasks, runs, and sessions are stored in central state under `TAKT_CONFIG_DIR`, while CLI execution stays project-local; using the CLI and the Web UI on the same project at the same time is not supported. `takt ui stop` and `takt ui restart [--port <number>]` manage the process. The interface may change without notice.

### Changed

- Codebase investigation in interactive mode is scoped per mode (#1506). Assistant mode performs read-only investigation to understand the current specification, behavior, prerequisites, and constraints instead of asking the user for them, and Grill Me mode checks the current-state facts it needs to challenge the requirements; both stop once the facts needed to clarify the requirements are established. Identifying files to change, analyzing dependencies and call paths, comparing fixes or designs, and preparing implementation steps are left to workflow execution. Previously the Assistant prompt told the model not to investigate the codebase at all.
- Builtin facets require state-after-change contracts on a persisting entity (#1498). When a requirement names a specific change (input, environment, configuration, connection state, ...) and asks behavior to keep following the state after it, and the same screen, process, connection, session, or cache persists across the change, the `plan`, `write_tests`, and `implement` instructions align the observation unit with that entity: observing before → change → after on the same entity is the completion evidence, artifacts produced before the change are in scope, and a structure that creates once, computes only initially, or caches must be changed in the plan. The `testing` policy rejects evidence that recreates another entity, excludes pre-change artifacts, sends an observable entity to manual verification only, or marks `State / Ownership` or `Continuous Execution, Ownership, and Concurrency` as not applicable when the contract applies. Requirements with no entity that persists across the change are unaffected.

## [0.62.0] - 2026-08-25

### Added

- Conversation settings commands in interactive mode (#1471). `/workflow`, `/interaction`, and `/provider` reopen the usual selectors, and `/model <value>` and `/effort <value>` set free-form overrides for the current conversation. Selections are temporary and never persisted: workflow, mode, provider, and model changes start a new assistant session on the next ordinary message or `/go`, with the prior transcript included once as reference context; an effort-only change applies to the next call; changing provider clears the temporary model and effort overrides; when several commands run before the next input, only the last value per setting is applied. These overrides do not affect workflow execution.
- Rule field `command_gates` (#1127). Rule conditions and the transition are now resolved before command quality gates run. `required` (the default when omitted) runs the step's gates after rule resolution and applies the transition only when they succeed; a failed gate is fed back to the same step as before. `skip` applies the selected transition without running gates, so a `needs_fix` or `ABORT` transition can leave a read-only reviewer step even when its gate would fail. Invalid values fail at load, and parallel sub-steps follow the same policy.
- Companion reviews for Team Leader steps (#1435). A Team Leader step declares `companion` like a normal agent step. Each part gets its own Companion runtime: after the part responds, the current cumulative diff is reviewed, accepted findings go back to the same part session, and the part result is published only after that loop settles while other parts keep running. Once every part is complete and the Team Leader proposes no further work, a Team completion review runs before aggregation; its findings feed the existing additional-part planner, and correction parts are followed by another completion review. `takt-default-team`, `development-implement-team`, and `development-remediation-team` now wire their companions to the Team Leader step.

### Changed

- **BREAKING:** The `quiet` and `passthrough` interactive modes and the workflow-level `interactive_mode` field were removed (#1471). Interactive mode offers `assistant`, `grill-me`, and `persona`; a workflow YAML that still contains `interactive_mode` fails to load, so remove the field. Pass the task as a command-line argument when you previously relied on `passthrough`.
- Gherkin guidance is limited to development and implementation tasks, and Gherkin keywords stay in English (#1471, #1497). The assistant first decides whether a task creates or changes code, configuration, infrastructure, or tests; research, analysis, review, planning, documentation, and other non-implementation tasks are written entirely in Markdown. `Feature`, `Scenario`, `Given`, `When`, `Then`, and the other structural keywords are always written in English even in Japanese instructions, with no `# language` directive; descriptions after the keywords may use the instruction language.
- Submitted user messages are highlighted in the conversation TUI (#1490). Each submitted message is drawn on a full-width background band with one blank row above and below and a `❯ ` marker; the colors adapt to the terminal background when the terminal reports it, falling back to dark gray and white. The unsubmitted draft keeps the normal input styling.
- The `requeue` start-position picker shows the full resume path (#1494). The default resume candidate lists the root workflow, each `workflow_call` step, the called workflow, and the final step as quoted segments joined by ` > `, and the `Selected start position` log prints the same path.
- Loop analysis (experimental) keeps a private copy of the complete report (#1495). Before sanitizing, the worker saves the full report and a `source.json` describing the source run under `loop-analysis/<source-run-slug>-<hash>/` in the global config directory, and the sanitized report and PR comment end with a `source run: <slug>` line.

### Fixed

- Loop analysis reports no longer mask relative paths (#1495). Paths such as `reports/subworkflows/**/plan.md` were turned into `[path]` because the `/` after `**` was treated as an absolute path; the shared path sanitizer now decides from the path boundary, keeping relative paths, globs, `//` comments, HTML closing tags, and URLs while still masking POSIX, Windows, UNC, `file://`, and `~/` paths in reports and external error messages.

### Internal

- Prompt eval suites are organized under `eval/agents/<step>/` and `eval/scenarios/<flow>/`, with recursive suite discovery and duplicate suite ID rejection (#1482).

## [0.61.0] - 2026-08-23

### Added

- Ink-based conversation TUI (#1452). With a TTY on stdin and stdout the task conversation is drawn by Ink; piped input keeps the plain reader, and the `--tui` flag only makes the TTY requirement explicit by failing without an interactive terminal instead of falling back. Enter sends, Shift+Enter or Option+Enter inserts a newline, Esc interrupts the answer in progress, lines submitted while the assistant is answering are queued and sent as later turns, and the input draft survives queue sends and remounts. Workflow, mode, and post-run selection stay on the usual selectors.
- Formal specification mode for assistant conversations (#1454, #1457, #1466). `assistant.formal_spec` accepts `true`, `false`, `"Y/n"`, or `"y/N"`; project values override global values, TTY sessions ask once when configured to ask, and non-TTY and ACP sessions use the configured default without consuming standard input. Enabled sessions express each requirement in both Quint and Alloy — omitting a notation for a requirement needs a stated inexpressibility reason — while Gherkin guidance is always available.
- Runtime MCP configuration in `runtime.yaml` (#1137, #1218). The top-level `mcp` section owns MCP server definitions (with `${ENV}` interpolation) and their assignment to agents, and may be active on its own, so MCP servers are injected while provider resolution stays on the legacy `config.yaml` path. Interpolated commands, arguments, and URLs that may contain secrets are kept out of logs through log-safe sources, read-only and isolated execution paths do not receive the prepared servers, and a `servers`-only section can coexist with legacy workflow `mcp_servers`.
- Directory-scoped provider assignments in `runtime.yaml` (#1455). `provider.assignments` declares named sets with the same shape as the top-level `defaults` / `targets`, and `provider.directories` maps startup project directories (`~` expansion, realpath normalization, exact match) to an assignment name — so multiple checkouts of one repository can use different provider assignments without touching project config. A matched assignment replaces the keys it declares, omitted keys fall back to top level, and unknown assignment names or unknown profile/pool/ladder references fail at load.
- `takt workflow inspect` (#1427, #1445). Inspects a workflow and reports its configuration and resolution sources using the same resolution a run would use, including `--auto-strategy`.
- Companion review mode (#1434, #1447). `companion.review_mode` chooses between the default `completion` — reviewing the cumulative diff after each successful implementer response — and `live`, which keeps quiet, forced, and commit-triggered reviews during the response. The project value overrides the global value, and invalid values fail while loading.
- Codex fast mode (#1425, #1426). `provider_options.codex.fast_mode` sends `features.fast_mode` to Codex only when explicitly set to `true` or `false`; when omitted, Codex keeps its own default. `TAKT_PROVIDER_OPTIONS_CODEX_FAST_MODE` is the environment override, and the setting follows the usual provider-option leaf resolution — runtime profiles, `provider_routing`, project and global config — including the assistant session of `takt exec`.
- Workflow descriptions in the selection menu (#1456, #1459). A category file's `workflows` list accepts the inline `- name: description` pair form, and the description is rendered as its own dim line under the workflow name across category-tree, flat, and bookmark selection. All builtin workflows ship with descriptions in both languages; empty names or descriptions and conflicting descriptions for one workflow in the same file are load errors.
- Automatic back-link comment when creating an Issue from an Issue (#1416, #1417). When the interactive flow creates a new Issue while exactly one source Issue is in context, the source Issue receives a comment linking to the new one without a confirmation prompt. A failed comment prints a warning only — the created Issue and task are kept — and the displayed failure reason is a fixed classification (authentication, permission, not-found, rate limit, network) that never includes provider stderr.
- Exported OTLP metrics (#869, #873). With `observability.enabled: true`, TAKT emits counters for token usage, cached input tokens, estimated cost, provider errors classified as provider-caused (retries counted separately), and command quality gate results, documented in the observability guide. Classified failures and retry counts are preserved through parallel and arpeggio aggregation instead of being flattened into generic errors.
- Post-run loop analysis (experimental) (#1430, #1441). The opt-in top-level `loop_analysis` config analyzes each finished run asynchronously with the builtin `loop-analysis` workflow and writes proposed workflow-rule and facet fixes to the analysis run's `reports/loop-analysis.md`, or to a PR comment with `output: pr-comment`. Experimental: the proposal quality is still being tuned.

### Changed

- **BREAKING:** The builtin workflow catalog was reorganized (#1424, #1433, #1448). The former `experimental` / `takt-experimental` workflows are now `default` / `takt-default`; the former `simple` was renamed `pure`, and `simple` is now a dynamic-facet variant of it; `review-default` was renamed `review` and selects reviewers automatically through `development-review`; `review-fix-default` was replaced by a dynamic `review-fix`; and `default-high` / `default-mini` were removed. A new `maintenance` workflow develops while respecting existing code conventions. Update explicit references to the removed names (`experimental`, `takt-experimental`, `review-default`, `review-fix-default`, `default-high`, `default-mini`).
- `assistant.gherkin` is deprecated (#1431). It is warned about and ignored without conversion, persistence, or configuration-file updates; Gherkin guidance is now always enabled for interactive and final task-instruction prompts.
- Team Leader steps accept `companion` and `dynamic_facets` (#1402, #1409), and team-leader selector and companion calls are bound to the provider inactivity deadline.
- Companion reviewers inspect the repository themselves (#1439). Instead of judging only an inlined diff, reviewers investigate the local working tree read-only within a defined inspection scope, preserving independent discovery per round.
- Builtin review and verification prompts decide from recorded evidence (#1443, #1453, #1469, #1473). Review convergence uses evidence-based problem tracking, reviewers and the final synthesis judge only from recorded evidence, and the fix verifier re-enumerates each bounded set and state axis before its final result, records each gap per element with its classification, keeps out-of-scope plan lines from becoming remediation targets while still checking unchanged-preservation boundaries, and stays read-only — it records findings instead of editing the working tree.
- The Node.js requirement was lowered to >= 22.22.0 (#1451). The floor is set by dependency engines; the compiled `dist/` output already ran on Node 22.

### Fixed

- The status line and tool spinner no longer corrupt terminal output (#1462). Multi-line tool previews are collapsed before display, the spinner line is cleared with an escape sequence instead of a fixed 120-column overwrite, and the status line suspends while interactive prompts read input.
- Claude Code subscription limits trigger the rate-limit fallback (#1429). "Hit your weekly/5-hour/session limit" messages from the Claude CLI are recognized as rate limits — including when they arrive inside parsed stream output — instead of surfacing as generic provider failures.
- Pi npm extensions resolve from project and user scopes before a temporary install (#1422, #1423, #1458). Existing installations are reused without reinstalling, scopes holding only disabled resources fall through, scope failures fall through to the temporary install, and an extension that cannot be loaded falls back instead of failing the run.
- The resume-position picker shows a single tree of executable steps (#1437). It no longer offers `workflow_call` container entries; only steps a resume can actually start from are selectable.
- Prompt/response debug logs are scoped per workflow run (#1428, #1446). They are written to `.takt/runs/<run>/logs/<sessionId>-prompts.jsonl`, so parallel runs no longer interleave in one process-global file; the general debug log stays process-scoped.
- Retry and Instruct revise the task order with confirmation (#1442). Both routes now propose a revised `order.md`, show it for approval, and replace the task order on approval — so a rerun executes the revised order instead of layering conversation notes on top of a stale one. Locale and diagnostics are preserved, and a rejected proposal returns to the conversation.
- Ctrl-C stays responsive during task runs (#1475). The run/watch interrupt handler re-resumes stdin when a shared-stdin prompt's cleanup pauses it, so Ctrl-C keeps working through long concurrent runs instead of going dead after a prompt.
- Phase 3 status judgment and AI judges run isolated (#1476). Judge calls get an empty tool allowlist and no MCP servers, so a judgment can no longer touch the working tree or external tools; the `use_judge: false` workarounds this required were removed from the builtin workflows.
- Interactive conversation input is framed as user comments (#1460). Each assistant / grill-me message carries an explicit user-comment header, and the system prompt states that the deliverable is always the task instruction document — so providers that collapse the system prompt into the user turn (such as Codex) no longer misread a revision-request comment as an implementation request.

### Internal

- `npm test` launches an adaptive number of concurrent unit shards (up to 8 from `availableParallelism()`), and the PR CI unit matrix widened from 4 to 8 jobs (#1464); the on-demand `/ci` workflow opts into the strict one-time birpc-noise re-measurement.
- Windows flakes in the prompt-eval probe lifecycle were fixed by separating probe reporting from cleanup (#1438), the ACP prompt tests follow the user-comment framing contract (#1461), and release verification flakes were stabilized (#1420).
- Unused LocalLLM-era review facets and leftover facets were removed, the implement/fix quality gates run the light integration suite (#1467), gate settings naming nonexistent steps were dropped (#1468), and the dogfooding test scope for TAKT development was lightened (#1472).
- The prompt evaluation suites were centralized in a suite registry and the vestigial recurrence-ledger cases were removed (#1415).
- The README was reorganized as a landing page with internal specifications moved into docs, and AI-sounding phrasing and excess punctuation were cleaned up across the Japanese docs (#1450).

## [0.60.0] - 2026-08-18

### Added

- Official DeepSeek Harness SDK provider (#1388). The new `deepseek-harness` provider drives the official DeepSeek Harness Python SDK through a private JSON-RPC bridge, with `provider_options.deepseek_harness` covering `base_url`, `session_root`, `max_tokens`, `request_timeout_ms`, `shutdown_timeout_ms`, and `runtime_mode` (`python_path` and `cordis` remain trusted-global/environment only). Credentials come from `DEEPSEEK_API_KEY` and the optional `DEEPSEEK_BASE_URL`, and the key is passed only to the bridge environment — never to command arguments or a generated workflow config. It requires Python 3.10+ with matching `deepseek-harness-sdk` / `deepseek-harness-runtime-bin` packages and runs on Linux x64/arm64 and macOS arm64 only; Windows and macOS x64 fail fast instead of silently falling back to another provider. This is a developer-preview compatibility surface — the upstream API and event vocabulary can change between releases, so run the opt-in live smoke procedure in the configuration guide before relying on a new SDK/runtime pair.
- `takt-experimental-team` workflow (#1401, #1404). An experimental TAKT development workflow that keeps `takt-experimental`'s planning, testing, review, and final-gate contracts while running implementation, remediation, and retry remediation as static Team Leader coder execution through the new callable `development-implement-team` and `development-remediation-team` workflows. Leader and part steps carry their own routing tags. Current schema constraints mean this variant does not use implementation dynamic facets or companions.
- Instruct and pull-request actions for failed tasks in `takt list` (#1391, #1339). A failed task can now be sent to the same conversational instruct flow that completed tasks already had — the failed entry point targets the run's uncommitted worktree and seeds the conversation with a summary of the final adjudication report and the working-tree diff. A new Create PR action is available on both completed and failed tasks: it commits with the existing auto-commit naming, pushes through the project repository when the shared clone has no remote of its own, and fills the pull-request body from the run's final report, after showing the file list and body preview for confirmation.
- Codex permission control (`provider_options.codex.permission_control`) (#1397). The default `takt` keeps mapping TAKT permission modes onto the Codex SDK's `sandboxMode` and `networkAccessEnabled`. Setting `permission_control: codex` omits both from every Codex call — including strict isolated structured calls — so Codex's own `config.toml`, `default_permissions`, and permission profile decide the effective permissions; `approvalPolicy: never` is still set for non-interactive execution. It cannot be combined with `network_access`, and the resolved configuration fails fast when both are set. `TAKT_PROVIDER_OPTIONS_CODEX_PERMISSION_CONTROL` is the matching environment override.
- `instruction` accepts an ordered array (#1395). A step or parallel sub-step can compose several instruction facets or inline texts; items are resolved in place and joined with an explicit `---` boundary. In a callable workflow an array item may also be an `instruction` `facet_ref` / `facet_ref[]` parameter, and a `facet_ref[]` value is spliced at its position without disturbing the surrounding order. The scalar form is unchanged.
- Simplified Chinese documentation (#1385, #1408). The onboarding path (README, tutorial, configuration, CLI reference), workflow authoring, provider and external integrations, and task management are available with the `.zh-CN.md` suffix, starting from `docs/README.zh-CN.md`. The remaining pages are intentionally not duplicated and stay in English or Japanese.

### Changed

- **BREAKING:** Provider settings were removed from workflow YAML (#1398). `provider`, `model`, `provider_options`, `auto_routing`, `rate_limit_fallback`, `workflow_config.provider*`, and `workflow_call.overrides` are no longer workflow fields, and a workflow that still writes them fails at the load boundary with a diagnostic naming the migration target. `promotion` entries must now be the strict `{at: N}` shape — provider, model, provider-options, and `condition` are rejected — and a match advances to the next stage of the runtime target's `ladder`. Provider, model, options, and routing belong in `runtime.yaml` (with the retained legacy `config.yaml` mode) and CLI/environment overrides still apply; `capabilities` remains the only provider-option surface in workflow YAML.
- Team Leader feedback reaches the leader as a bounded report summary instead of accumulating in the session (#1407). Part results are written as reports and the leader receives a size-capped summary, so a long decomposition no longer inflates the leader's context. The leader is now expected to open the full reports and verify the actual artifacts, and the engine gives the decomposition and additional-part decision phases a default read-only tool set (`read`, `glob`, `grep`) on providers that support tool allowlists — `inspect_tools` no longer has to be declared in the workflow. An explicit value still overrides the default, an explicit empty list is preserved as an empty allowlist, and providers that cannot restrict tools (such as Codex) leave the allowlist unset. Planning steps keep passing `{previous_response}` losslessly.
- Builtin review guidance was centralized (#1395, #1390). Review scope, findings handling, terminology, family lookup, and recurrence guidance moved out of per-instruction facet partials into shared `workflows/rules/` files applied through `all_steps.rules`, and per-domain review criteria were split into their own policy facets (architecture, backend, frontend, react, cqrs-es, failure-boundary, implementation-semantics, resource-ownership, robustness, takt). The experimental reviewer suites became reusable step fragments, and the internal `experimental-review-adapter` / `takt-experimental-review-adapter` workflows were removed. `{review_scope}` now reaches builtin general-purpose reviewers through the shared `findings-handling` rule instead of the removed `instructions/review-round-scope` partial. Parent and child workflow rules that share `ref`, position, and resolved content are applied once.
- Builtin decision steps no longer carry the `review` tag (#1405). Adjudication, fix planning, fix verification, the final gate, and the supervise/synthesis completion steps are tagged by their actual role (`adjudication`, `plan`, `verification`, `final-gate`, `supervise`) so that routing aimed at reviewers no longer captures them. Routing configured against the `review` tag for these steps must be moved to the role tag.
- The builtin final gate must confirm the called implementation before judging fulfillment (#1406). A requirement is not treated as satisfied on the strength of a call site alone; the gate follows through to the callee's implementation, and genuinely undecidable cases still report as undecidable rather than being forced into a verdict.

### Fixed

- Child-process stdio errors no longer kill the TAKT process (#1410, #1411, #1412). An unhandled `error` event on a child process's stdin/stdout/stderr — an EPIPE on a stream whose peer has already exited, most often — took down the whole run. A shared guard now handles those events locally across the Claude headless, Claude terminal (tmux), Cursor, Kiro, clone-exec, and companion git-diff paths; the OpenCode shared server runs through a dedicated server process wrapper that also keeps a bounded tail of server output to explain abnormal exits; and the Codex SDK's internal spawn is wrapped so a stdin EPIPE inside the SDK cannot crash the process either.
- OpenCode exact-repeat detection now goes through the tool-guard recovery path instead of failing the call outright (#1419). When a tool returns an identical result for identical input often enough, TAKT first issues a correction telling the agent to stop calling that tool and report actual progress, then retries in a fresh session, and only fails after both recovery options are spent.

### Internal

- Build output is cleaned before compilation and a test verifies that stale artifacts are not packaged (#1387); the remaining Finding Contract references were removed from documentation and facets.
- Test suite maintenance: brittle text and builtin-content assertions were removed, and the prompt evaluation suites were restored (#1396, #1399, #1400).
- Eval coverage was extended for coding-review metrics and final-readiness decisions (#1395, #1406), and CI validates the DeepSeek bridge against Python 3.10 (#1388).

## [0.59.1] - 2026-08-16

### Fixed

- The builtin review-fix loop no longer re-adjudicates stale findings from `review-resolution.md` (#1393). A `review-resolution.md` that exists when adjudication starts is treated as adjudication history and the step's output destination, never as a finding submission source: only findings submitted by the reviewer reports of the immediately preceding completed review round can enter the actionable set. The selector continues a reviewer only from the current `Actionable Families` section — history, dispositions, and carry-forward rows cannot keep a reviewer selected — and when the latest round approves with no findings while a verified fix merely repeats in the resolution file, the loop monitor chooses its declared non-retry outcome instead of rerunning reviewers or the same fix.

## [0.59.0] - 2026-08-16

### Added

- Workflow-wide rules (`all_steps.rules`) (#1366). A workflow can declare Markdown rule files that are injected into every agent step's Phase 1 prompt, either after the automatic execution rules or with `position: before_instruction`. Rule files are `<ref>.md` under `workflows/rules/`, resolved project → global → builtin, and a called workflow inherits its parent's rules additively before its own. Rules do not apply to output reports, status routing, or companion reviewers.
- Reviewer completion retry (`completion_retry`) (#1312, #1337, #1341, #1353). A step can opt into bounded completeness checks with `completion_retry: { retry_instruction: <facet>, min_retry?, max_retry? }`: after each successful reviewer response, a fresh completion judge checks the report against the reviewer's actual original instruction, task, scope, and evidence, and an incomplete result is retried in the same reviewer session up to the retry ceiling (default 4). The judge is assignable through the new `internal_agents.review-completion-judge` seat in `runtime.yaml`.
- Selector guidance (#1205, #1338). Dynamic parallel and `dynamic_facets` selectors accept a `selector` block with optional `persona` and required `instruction` guidance referencing the workflow's existing persona/instruction facets. Guidance only describes how to select candidate IDs — TAKT retains the evidence references, read-only structured execution, candidate validation, and output contract.
- A provider inactivity deadline for every provider (#1351, #1358). `guards.call_timeout_ms` now applies to `codex`, `opencode`, `claude` / `claude-sdk`, `claude_terminal`, `cursor`, `copilot`, `kiro`, and `pi`: the timer resets on each observable provider event (default 60 minutes; 60,000–86,400,000 ms) and cumulative execution time is not capped. For OpenCode this replaces the per-call wall-clock limit and the separate 10-minute stream-idle timeout — a healthy long call keeps running while events arrive, and an in-flight tool call becomes stale after six times the deadline. `claude_terminal.timeout_ms` is honored only when `guards.call_timeout_ms` is unset.
- Requirement scenarios (experimental) (#1309, #1310, #1313, #1314, #1364). The `experimental` / `takt-experimental` workflows can plan, write tests, fix-plan, and run the final gate from enumerated requirement scenarios with variant and numeric-boundary coverage; scenarios link to tests through a report correspondence table instead of scenario IDs written into code.

### Changed

- **BREAKING:** Finding Contract configuration, execution, and persistence were removed (#1321). Workflows that retain the old syntax fail to load with migration guidance, while existing `finding-contract.sqlite` files are left in place without being deleted, migrated, or read. Use `review-adjudication`, requirement scenarios, and `final-gate` for review workflows. The Finding Contract runtime seats (`intake-normalizer`, `findings-manager`, `terminal-adjudicator`, `escalation-reviewer`) and the profile-level `escalate` declaration were removed with it; `internal_agents` now holds `selector`, `assistant`, `loop-judge`, and `review-completion-judge`.
- **BREAKING:** `runtime.yaml` auto routing requires explicit pool assignments (#1266, #1336). `provider.defaults` must choose a fixed `profile` or an ordered `ladder` and can no longer name a `pool`; only `personas` / `tags` / `steps` targets that explicitly declare `pool` are auto-routed. Targets without a pool, non-workflow operations, and other auxiliary processing use `provider.defaults` — there is no implicit default pool. A `workflow_call` child keeps its parent's auto-routing context, and `takt workflow preview` shows the assignment the run would actually use.
- Companion reviewers are opt-in now and deliver findings per round (#1307, #1311, #1323, #1344, #1354, #1362, #1367). Companions are disabled by default; enable them with the top-level `companion.enabled: true` policy in `runtime.yaml` (global and project values combine with logical AND). The strict-isolation provider restriction is gone: companion structured calls use the provider-neutral fresh-session transport — OpenCode included — and companion reviewer, moderator, and selector calls always run read-only. The finding lifecycle was replaced by round-based delivery: each review round produces a fresh finding list, an optional moderator accepts or rejects each finding, accepted findings are embedded directly in the implementer's next follow-up prompt, and the JSONL mailbox is an audit log only. Companion findings and failures are advisory diagnostics — workflow routing is decided solely by ordinary conditions and Phase 3 judgment — and the fixed 5-minute companion call timer was removed in favor of the provider deadline.
- The builtin development and review workflows end with the supervisor's final requirement check instead of a separate merge-readiness review (#1370, #1372). The `merge-readiness-reviewer` / `merge-readiness-supervisor` personas and their steps were removed, the final gate is limited to deciding requirement fulfillment, finding resolution, and recurrence-register carry-forward, and provider routing targets the `final-gate` tag or the `supervise` step.
- The builtin security review selects reviewers by threat model in every suite (#1380). Security reviewers are no longer fixed members of the peer-review and standalone review suites: they live in an outer pool whose selection criteria default to not selecting them, and boundary-specific security knowledge is chosen dynamically per target.
- The builtin review and fix prompts converge instead of circling (#1308, #1329, #1330, #1332, #1343, #1346, #1350, #1368, #1369, #1379, #1382). Adjudication results now reach later review and remediation rounds — the invariant ledger is inherited across remediation instances through adjudication, and a finding on the same owner and invariant merges into its existing family instead of opening a new one. Fix plans must cite concrete evidence for bounded-state claims and may not settle on an unconfirmed cause. Review scope contracts are enforced, defaults need an explicit priority, primary run paths take precedence, documented-but-unimplemented config keys are detected, and the review-fix selector keeps choosing the submitter of an unresolved finding until it is resolved.
- Builtin reviewers request new tests only for observable, undetected failures (#1318). The testing policy no longer lets a reviewer demand tests that merely restate the implementation.

### Fixed

- Report references resolve when the report exists and no longer kill the run when it does not (#1377). Reports copied by requeue are recorded in the resume report snapshot so a new run — including chained requeues — reliably finds them, and a missing report or artifact is replaced by an explicit missing notice in the read paths (instruction `{report:...}`, judge reports, dynamic selectors, exec/interactive reads, trace generation) instead of throwing. Fail-fast is kept for real corruption, integrity, and safety violations.
- Requeue is more robust (#1359, #1363, #1365, #1374). A task can be requeued after a pre-step failure, step report numbering continues from inherited artifacts instead of restarting, restart-path matching no longer depends on `call_instance`, and ambiguous legacy-format artifacts are excluded from the index — treated as absent, with their namespaces reserved against collisions — instead of failing the whole requeue at startup.
- Parallel step terminal errors are aggregated explicitly, and the builtin review workflows retry a bounded number of times on reviewer provider errors (#1360).
- Codex: deep reasoning no longer trips the inactivity watchdog — `model_reasoning_summary: auto` keeps stream events flowing during long reasoning (#1344); provider parse failures keep their failure category through parallel aggregation and workflow aborts instead of appearing as empty output (#1272, #1316); and the tool shell preserves the caller's `PATH` (#1386).
- Kiro: compaction-only responses are rejected as errors instead of being treated as empty successful output (#1297, #1298).
- Oversized diffs passed to a dynamic selector are truncated instead of overflowing the selector input (#1328).

### Internal

- The prompt-eval harness moved to `tools/opencode-probe` (#1361), and the Finding-Contract-era eval suites and assets were removed (#1320, #1334).
- Mock E2E shards get the same one-time birpc-noise re-measurement as unit shards (#1333).
- `@openai/codex-sdk` was updated to 0.147.0 (#1371).
- Eval coverage for reviewer-evaluation composition, dynamic facet selection, and CLI execution boundaries, plus removal of non-behavioral and redundant tests (#1315, #1317, #1372, #1375, #1378, #1381, #1383).
- Documented the Pi provider global-settings boundary and resource-loading examples (#1340, #1348, #1349), and repaired documentation broken by the Finding Contract removal (#1322).

## [0.58.0] - 2026-08-11

### Added

- Pi SDK provider (#1283, #1302). The new `pi` provider runs Pi through SDK-only in-memory sessions with streaming, abort handling, and native image attachments. Permission modes map to Pi active-tool allowlists (`readonly` / `edit` / `full`), and `provider_options.pi` controls resource loading (`extensions`, `no_extensions`, `no_skills`, `no_prompt_templates`, `no_themes`, `no_context_files`) with matching `TAKT_PROVIDER_OPTIONS_PI_*` environment overrides. Credentials come from the Pi SDK credential store or provider-native environment variables. Pi permission modes are SDK active-tool allowlists, not an operating-system sandbox — explicit extensions execute inside the TAKT process, implicit project-local extensions are never loaded, and Pi is not eligible for dynamic internal agents that require strict read-only isolation.
- Companion reviewers (#1269, #1300). A normal agent step can declare `companion` to run up to three stateless, read-only reviewers alongside the implementing agent. TAKT observes mutating tool events, reviews the cumulative diff after a quiet period or forced interval, checks for unreviewed changes at implementer completion, and appends findings to per-companion JSONL mailboxes under `.takt/runs/{run}/companion/`. Open `must_fix` findings drive a same-session fix loop before the step's post-execution rules are evaluated, companion findings feed the review adjudication flow, and companion failures are fail-soft — they are retried without blocking the implementer. Companion definitions are YAML files resolved from `.takt/companions/`, `~/.takt/companions/`, then the builtin `companions/` (an AI-antipattern review companion and moderator ship as builtins). Companions require an active `runtime.yaml` provider section: each referenced companion resolves through `provider.targets.companions` (fixed profiles only), falling back to `provider.defaults`, and the resolved provider must support strict isolated execution and structured output.
- `takt-experimental` workflow (#1263, #1276, #1296, #1299). An experimental TAKT development workflow that adds TAKT-specific reviewers and implementation companions on top of the shared adjudication, verified-remediation, follow-up review, and merge-readiness flow. It shares reviewer suites with the generic `experimental` workflow through the new `experimental-review` / `takt-experimental-review` suites and their adapter workflows (#1299).
- Dynamic facets on parallel reviewers (#1299). `dynamic_facets` is now valid on a static `parallel` child and on a dynamic parallel `fixed` / `pool` entry: participant selection runs first, and each selected dynamic child runs its own facet selector before any parallel child starts. Two callable-workflow parameter types support this composition without widening shared contracts (#1263, #1296): `facet_pool_ref` binds a child-local facet pool (`dynamic_facets.pool: { $param: ... }`), and `companion_ref[]` supplies fixed companions (`companion: { $param: ... }`; an empty array omits the `companion` field entirely).

### Changed

- **BREAKING:** The builtin TAKT development and Finding Contract workflow variants were consolidated (#1296). `takt-default-fc`, `takt-default-high`, `takt-default-team-high`, `takt-default-localllm`, `review-fix-takt-default-high`, and the Finding Contract builtin sub-workflows (`finding-contract-boundary-review`, `finding-contract-local-review`, `finding-contract-remediation`, `merge-readiness-finding-contract-final-gate`, `peer-review-finding-contract`, `peer-review-finding-contract-localllm`, `peer-review-suite-finding-contract-base`) were removed. TAKT development consolidates onto `takt-default` and the new `takt-experimental`, and the shared `development-core` now composes injectable `development-implement` / `development-remediation` subworkflows (plus `-dynamic` variants) with adjudication, verified remediation, follow-up review, and merge-readiness, parameterized by implementation facet pool and companions.
- The `experimental` workflow was rebuilt on the shared development core (#1263, #1296, #1299). It is now a thin wrapper over `development-core` with dynamic implementation and remediation subworkflows, reviewer suites bound through `experimental-review-adapter`, and the builtin AI-antipattern review companion and moderator enabled by default — an `experimental` run now includes companion review during implementation.
- `assistant.gherkin` is a global setting now (#1260). Previously project-only, it can also live in `~/.takt/config.yaml`; an explicit project value overrides the global one.
- Builtin review, adjudication, and planning prompts hold the task scope (#1262, #1284, #1291). Review adjudication keeps findings within the task scope while preserving actionable quality findings, backed by a new `review-adjudication` policy facet; the shared review policy controls how far a convergence fix may reach; and the planning and review instructions constrain scope expansion in the development workflows.
- The builtin security review facets were reorganized by system surface (#1270, #1274). The security policy was specialized for review, and the existing security knowledge is routed by the target's system surface, shared across peer review and audit review — a facet reorganization without new review content.
- Resuming a process re-runs dynamic selection (#1292). A process resume no longer restores a saved participant or facet selection; it invokes the selector again against the current pool. Resume points recorded with the removed dynamic-selection fields are not supported.

### Fixed

- Provider `effort` values pass through to the provider (#1261). `effort` / `reasoning_effort` provider options were validated against fixed per-provider enums, so levels a provider accepts but TAKT did not list were rejected at load time; any non-empty value is now passed through unchanged.
- Finding Contract: manager adjudication input overflow no longer drops observations (#1278, #1281, #1287). Call-site identity embedded a redundant ~1.2KB stack encoding into every raw finding ID, and prompt rendering was unbounded against the fixed 24,000-byte input cap, so raw tasks overflowed and observations — including resolution claims — were silently dropped. Raw IDs now use the compact run-path segment, every rendered field has a fixed byte cap with visible truncation markers (verbatim quotes are bounded at publication time and never truncated for byte-exact matching), a static budget proof verifies that a single raw task always fits the cap, and a per-observation accounting check fails the run as an engine bug if a submitted observation neither lands in the ledger nor fails explicitly with a reason.
- Finding Contract: conflict adjudication no longer loops without progress (#1264, #1265, #1267, #1271). Re-adjudication is bound to actual code changes, re-observing the same claim no longer resets the adjudication budget, adjudication requests reference raw findings in a compacted form under a dedicated 96KiB input cap, and the persistent conflict-landing registry keeps append order — ending the reviewer/adjudication round-trips that exhausted the input budget and terminated the run.
- Finding Contract: resolving a finding that holds an unsettled conflict landing is deferred instead of failing the run (#1285, #1288, #1290). The normal resolution path could resolve such a provisional finding without settling the landing, and the next adjudication snapshot failed the whole run on an invariant violation. Resolution is now held while the conflict is active — the claim is recorded as an audit-only attachment, reported in a dedicated verification-report field, without altering the adjudication basis — and proceeds normally on the round after the adjudication settles.
- Retried runs separate report inheritance from operation ancestry (#1293). A fallback execution that inherits an earlier run's reports recorded that inheritance as its verified operation lineage in run metadata; the two sources are now tracked separately.

### Internal

- The prompt-eval gate was removed from `check:release` (#1259), package-lock metadata was normalized, and the Nix flake lock integrity was restored.
- SQLite-heavy integration suites moved to the serial test group and the heavy parallel CI shards increased from four to six (#1264).

## [0.57.0] - 2026-08-09

### Added

- `capabilities` references (#1231, #1237). A workflow, step, or parallel sub-step can declare `capabilities: <name>` (or a list, merged left to right with later names winning per leaf) referencing a semantic provider-options preset instead of writing inline `provider_options`. The bundled presets are `readonly` (read, search, shell, and web lookup plus network access), `edit` (`readonly` plus file creation and editing), and `enable-skills` (Codex repo/user skills). Only capability leaves (`allowed_tools` / `network_access` / `sandbox` / `skills`) are accepted — a preset carrying a quality or machine leaf fails fast at load time, as does an unresolved name. A step's own declaration replaces the workflow default, and a parallel parent's resolved capabilities become the sub-steps' default.
- Profile ladders in `runtime.yaml` (#1231). `defaults` and every `provider.targets` entry now pick exactly one assignment form: a fixed `profile`, an auto-routing `pool`, or an ordered `ladder` of profiles whose first profile is the initial assignment and whose later stages are advanced by a step `promotion`. Self-referencing and cyclic ladders are rejected at load time. Steps can also reference workflow-level `mcp_servers` definitions by name via `mcp: [name, ...]`, with unresolved names failing fast.
- Grill Me interactive mode (#1251). The new `grill-me` mode refines a task by resolving material decision branches one recommended question at a time, then suggests `/go` when the requirements are ready. It is offered in the interactive mode prompt and selectable as the default via `interactive_mode: grill-me`.
- Markdown + Gherkin task instructions (#1252). The project-only `assistant.gherkin: true` setting makes final task instructions generated from assistant conversations (including quiet mode) keep background, scope, design intent, constraints, and verification in Markdown while expressing important observable behavior, state transitions, boundaries, failures, and invariants as a minimal number of Gherkin scenarios. Unset preserves the existing Markdown-only instructions.
- An experimental dynamic coding workflow (#1247, #1275). The `experimental` and `takt-experimental` wrappers select reviewer-suite adapters that bind generic or TAKT-specific external security-review facet pools only at the consuming `parallel` security reviewer, without widening shared workflow contracts. `dynamic_facets.max_selected` is optional: when omitted, the selector may select up to every candidate in the pool; selector failure still stops the run with no all-candidate fallback.

### Changed

- **BREAKING:** Finding Contract synthetic roles are no longer assigned a provider or model in the workflow (#1234). `finding_contract.manager` / `finding_contract.adjudicator` accept persona/instruction customization only; leftover `provider` / `model` keys are rejected at load time. Assign the roles through the new `runtime.yaml` `provider.targets.internal_agents` seats instead — `findings-manager`, `terminal-adjudicator`, `loop-judge`, `escalation-reviewer`, and `intake-normalizer`. Every seat is optional: an unassigned seat keeps the role's existing default resolution, and the `escalation-reviewer` seat only replaces the destination of an escalation that the reviewer profile's `escalate` declaration already enabled.
- **BREAKING:** The builtin workflows migrated from inline `provider_options` to `capabilities` references, and the provider-options presets were reworked to match (#1238, #1239): `review-readonly` was renamed to `readonly`, `review-files` was removed, and `enable-skills` was added alongside the existing `edit`. User workflows or fragments using `extends: review-readonly` / `review-files` must switch to `readonly` / `edit`.
- The `compound-eye` review workflow is provider-neutral now (#1239, #1241). Its parallel reviewers, previously the provider-pinned `claude-eye` (claude-sdk) and `codex-eye` (codex) sub-steps, are the neutral sub-steps `eye1` / `eye2` with no provider names in the workflow YAML. Both eyes run on the default provider until each is assigned a different provider in `runtime.yaml` (`provider.targets.steps`), which is what produces the multi-engine review; routing rules targeting the old sub-step names must switch to `eye1` / `eye2`.
- Finding Contract review (experimental) was reworked around a single Markdown intake path (#1219, #1221, #1222, #1226, #1227, #1229, #1230, #1232, #1235, #1246). Every FC reviewer — including the escalation slot — writes an ordinary Markdown report, and one isolated intake-normalizer call turns it into findings whose quotes and anchors are verified byte-exact against the files; the structured and legacy publication descriptors are gone. Reviewers are observation-only: they report what is broken, where, why, and where evidence can be quoted, while the normalizer assigns severity, title, and family classification — so a correct observation can no longer die over classification bookkeeping. The engine now computes each reviewer's review scope and injects it as a `review_scope` variable, and a REJECT-consistency gate keeps a REJECT verdict with no surviving claims from being silently swallowed. Restatement moved from next-round piggybacking to per-reviewer slots inside the same round, so follow-ups no longer burn the review budget, and a reviewer profile may declare `escalate: <profile>` in `runtime.yaml` to hand the final presentation to a stronger model for a full re-review.
- The builtin review facets gained three investigation-discipline principles, raising finding detection (#1220).
- Finding Contract review (experimental) no longer aborts immediately on restatement exhaustion or an undetermined conflict (#1257). A claim-bearing anomaly that reaches its presentation limit now gets one engine-side evidence-search attempt before terminal disposition: the engine reads the claimed files, supplies bounded windows around the claimed lines to the isolated intake normalizer, and only a byte-exact verified quote promotes the claim (recorded as `promotionOrigin: evidence-search`). A conflict whose adjudication ends `verification_undetermined` gets one grounded re-adjudication over digest-bound windows from the review-scope snapshot, and the builtin FC workflows keep an active conflict in the fix/review loop while `findings.rounds.budgetExhausted == false`, reserving the `ABORT` arm for the exhausted-budget exit.

### Fixed

- Steps combining `structured_output` with a report output contract write the Phase 2 Markdown report again instead of the Phase 1 structured-output JSON (#1242, #1245). A regression from the 0.56.0 Finding Contract overhaul passed the step's structured-output schema to the report phase, so the report file contained schema-shaped JSON.
- OpenCode's idle-timeout guard no longer misfires during long silent tool executions (#1243). OpenCode emits no stream events between `tool_use` and `tool_result`, so a long-running tool call such as a test suite looked idle and healthy runs were cut off after 10 minutes; in-flight tool calls now pause the idle measurement.
- Retrying a task now selects the correct session log (#1254). Phase-usage and OTel shadow logs are excluded from the candidate set and the selection is deterministic.

### Internal

- The test gates were restructured (#1249, #1250, #1253, #1255, #1258): a light integration gate (`npm run test:it`) was split from the heavy one (`npm run test:it:heavy`), observed integration boundaries moved out of the unit gate, the heavy integration jobs are sharded across isolated CI runners, and the serial workflow integration group was stabilized.
- A unit shard that fails only due to the spurious vitest birpc `onTaskUpdate` timeout noise is re-measured once locally instead of failing the gate (#1244); CI remains strict.

## [0.56.0] - 2026-08-07

### Added

- Finding Contract (experimental) was overhauled (#1128, #1193, #1187, #1188, #1201, #1180): findings now live in a per-run SQLite ledger as machine-verified records, intake is contract-based so weak reviewer models no longer stall a round, a `takt-default-fc` workflow variant was added, and the manager/adjudicator roles are configurable from the workflow. Ledgers from before the consolidation are not readable. Workflows without `finding_contract:` are unaffected.
- Dynamic facet pools (#1138). A normal agent step can declare `dynamic_facets: { pool, max_selected }`, and an internal selector agent picks which policies or knowledge facets from the named pool to inject for that round. Pools live in `.takt/facet-pools/`, `~/.takt/facet-pools/`, or a repertoire package; unknown selections fail before the step runs rather than silently degrading to the whole pool, and a resumed round restores its saved selection without re-running the selector. `parallel` sub-steps reject `dynamic_facets` at schema level. `takt eject` copies referenced pools alongside ejected workflows.
- `runtime.yaml`, a dedicated provider configuration layer (#1136). `~/.takt/runtime.yaml` and `<project>/.takt/runtime.yaml` (project wins) own provider, model, provider options, auto routing, and internal-agent assignment in one place, replacing the provider settings scattered across `config.yaml`. It replaces the `config.yaml` provider keys as the configuration-layer default — step-side overrides (`promotion`, step `provider` / `model`, `workflow_call`, `provider_routing`, auto routing) still apply above it, and provider and model resolve independently per field. Mixing it with the legacy provider keys is rejected with a diagnostic naming the offending file and the key to migrate to, rather than silently picking one. CLI and environment overrides (`TAKT_PROVIDER` / `TAKT_MODEL`) still win, including on the non-workflow and selector seams. `config.yaml` continues to work unchanged when no `runtime.yaml` is present.
- A `replan` step in `development-core` (#1206). `need_replan` used to restart the whole workflow from the beginning; it now routes to a dedicated replan step that revises the plan in place and continues, so a mid-run replan no longer discards completed work.
- Post-edit self-scan in the builtin implement and fix instructions (#1179). After editing, the agent re-reads what it changed and checks the edit against the stated contract before handing off.

### Changed

- OpenCode now supports isolated structured execution (#1198), so steps that need a structured result run on OpenCode the same way they do on the other providers.
- The `peer-review` reviewers-cycle loop monitor threshold dropped from 5 to 3 (#1211), so a review/fix cycle is caught earlier.

### Fixed

- Content deltas are excluded from OpenCode's structural event count (#1185), so streamed text no longer consumes the guard's budget.
- Repeated tool-input updates no longer double-count sensitive sources (#1184).

### Internal

- Test-suite consolidation and pool rebalancing, plus a fix for a quadratic sanitize path (#1176).
- Test timeout corrections: per-case budgets for the observability wiring tests that exceeded the shared 15s ceiling under 4-shard parallelism (#1212), a concurrent-CAS test that pinned one of two valid conflict paths (#1215), and a Windows-only 60s test timeout — three of the last four Windows CI failures were 15s timeouts (#1216).
- Documentation: `CLAUDE.md` rewritten against the current architecture (#1189), all manuals aligned with the implementation (#1177), and the TAKT logo added and refined (#1186, #1194, #1213).

## [0.55.1] - 2026-08-04

### Changed

- **BREAKING:** OpenCode guard v6 replaces the cumulative tool error/signature/success/stagnation budgets with mandatory bounded-resource and integrity guards plus a consecutive exact terminal-tuple detector. Calls now have a 60-minute wall-clock limit by default; calls that may exceed 60 minutes must set `provider_options.opencode.guards.call_timeout_ms` explicitly. The removed `TAKT_OPENCODE_TOOL_ERROR_BUDGET`, `TAKT_OPENCODE_TOOL_SIGNATURE_ABSOLUTE`, `TAKT_OPENCODE_TOOL_SIGNATURE_REPEATS`, `TAKT_OPENCODE_TOOL_SUCCESS_REPEATS`, and `TAKT_OPENCODE_TOOL_RESULT_STAGNATION_REPEATS` variables are ignored with a one-time warning. Use `provider_options.opencode.guards` for profiles, per-model selection, and supported limits.
- The long-standing ban on unsolicited backward compatibility was made precise and contract-enforced (#1172). An explicit compatibility requirement authorizes only its stated target and scope, and each target (schema migration, data backfill, event upcasting, read-model rebuild, API compatibility) needs its own authority. Migrating current consumers to a new contract is classified as normal replacement work rather than legacy support, and current code, existing tests, stored data, or released status count as impact-analysis evidence, not authority to keep a superseded path. Plans record the supported target and scope in the plan output contract, so reviewers verify compatibility as a contract instead of a prose guideline. Contract-replacement judgment now has one shared policy owner, while personas, phase instructions, and output contracts contain only their role-specific responsibilities.

### Fixed

- OpenCode's structural event-count guard now defaults to 500,000 instead of 10,000 and supports `provider_options.opencode.guards.event_limit` and `TAKT_OPENCODE_STREAM_EVENT_LIMIT`, preventing healthy long-reasoning reviews from being aborted.
- Fresh installs no longer break the ACP integration (#1171). `@agentclientprotocol/sdk` is bumped to `^1.3.0` and the ACP entrypoint follows its renamed MCP server id field and extended elicitation response contract; a lockfile-less install had resolved 1.3.0 against code written for 1.0.x.

## [0.55.0] - 2026-08-03

### Added

- Reusable workflow step fragments (#852, #1131). A step in any workflow can declare `uses: <name>` to expand a single-step fragment YAML at load time, looked up in `.takt/steps/`, `~/.takt/steps/`, bundled builtin `steps/`, or a repertoire package's `steps/` (scoped as `@owner/repo/name`). Fragments declare required typed `params` (`facet_ref`, `facet_ref[]` with a `facet_kind` of `policy` / `knowledge` / `instruction` / `persona` / `report_format`, or `workflow_ref`), callers bind them with `with:`, and fragment bodies reference them via `$param` — including splicing facet lists into `policy` / `knowledge`. Routing stays with the caller: fragments cannot declare `rules`, and parallel-fragment callers supply a rule tree for the sub-steps. Expansion happens before validation, so `takt workflow doctor`, previews, and prompts see plain steps. Repertoire packages can now ship a `steps/` directory, and `takt eject` copies referenced fragments alongside ejected workflows.
- Dynamic parallel steps (#1139). A `parallel` step can take an object form with `fixed` sub-steps that always run and a `pool` of candidates, each carrying a `description`. On step entry an internal read-only selector agent picks the pool members for the round from the task, in-scope reports, and the current diff, returning a strict `{ selected_ids, rationale }` structured output; invalid or unknown selections fail before any participant starts instead of falling back to the whole pool. `selection.mode: replace` (default) re-selects each round, `cumulative` keeps earlier selections, resuming a round restores its saved selection without re-running the selector, and `all()` / `any()` aggregate only the round's actual participants. `takt_providers.selector` assigns the selector a dedicated provider/model/provider options; Claude, Codex, and Mock satisfy the required read-only isolation and structured-output contract.
- Review adjudication before remediation (#1154). In the peer-review flow an adjudication step now sits between the reviewers and the fix loop: a review-adjudicator persona consolidates the parallel review reports into a single `review-resolution.md` verdict, and the remediation steps fix against that resolution instead of each raw report. The standalone final gate was folded into the merge-readiness supervisor.
- Retry/Requeue can now start from a step inside a nested subworkflow (#1129). The start-position prompt in `takt list` is a browsable, paginated tree: `Resume failed position` keeps the saved checkpoint (call stack, iteration counters, elapsed time), `Restart from` starts a new logical execution at the chosen path without inheriting them, and `Browse child workflow from` descends into a `workflow_call` to pick one of its steps, with fully qualified paths distinguishing duplicate step names. Selections are re-validated immediately before execution and rejected if the step or workflow identity changed; both immediate Execute and Save task carry the selection.
- `vars` on `workflow_call` steps (#1157). Scalar execution context (strings, finite numbers, booleans) is inherited through nested workflow calls, overridable per call, and read in instruction facets as `{var:name}`; a missing value renders as `unspecified`.
- `loop_monitors.ignore_steps` (#1158). Cycle monitors can exclude optional verification or retry steps from cycle matching, so a logical `review ↔ fix` cycle is still caught when an optional step sometimes runs between them.

### Changed

- **BREAKING:** `workflow_call` is now a non-counting control node, while the root workflow's `max_steps` is shared by executable steps across the complete descendant call tree (#1133). Callable workflows must no longer define `max_steps`; explicit values fail during loading, and direct root execution of a callable workflow is rejected. Call wrappers no longer resolve or report provider/model data. Session logs and traces expose provider-independent call lifecycle records keyed by call invocation and the complete call stack. The iteration limit is checked only before a counting step, so entering a `workflow_call` at the cap is allowed and the run stops at the child's first executable step; interactive limit extension and `--ignore-exceed` extend the single shared budget. Subworkflow report directories under `.takt/runs/*/reports/` switch from `iteration-N--step-X--workflow-Y` segments to `call-…` segments, and support for reading or resuming runs recorded in the older formats was removed entirely (#1170) — run state is self-contained per run, so no migration is provided. Consumers that parse iteration numbers, wrapper provider data, or report paths must update.
- **BREAKING:** Claude providers no longer inherit filesystem Skills by default (#1078). The new `provider_options.claude.skills.enabled` flag (plus the `TAKT_PROVIDER_OPTIONS_CLAUDE_SKILLS_ENABLED` env override) controls whether `claude-sdk`, `claude`, and `claude-terminal` discover Skills, and it defaults to `false`: `claude-sdk` receives `skills: []`, while the CLI-backed `claude` and `claude-terminal` are launched with `--disable-slash-commands`, which also disables custom Claude slash commands in those sessions. Set `enabled: true` to restore Claude's normal discovery. CLI-backed sessions verify the flag is supported before starting; Claude Code 2.1.220 is the verified minimum. This is a context filter, not a sandbox — Skill files remain reachable via Read or Bash.
- The builtin development workflows were recomposed onto shared step fragments (#1132, #1140, #1141, #1163). `takt-default`, `default`, `default-high`, the domain workflows, the `*-mini` family, and the `simple` family now share `development-core` / `mini-core` plan, test, implement, review, and remediation fragments, and a dedicated `fix-plan` step sits between the reviewers and the fix. `default-high` and `dual` now implement directly instead of delegating to a Team Leader — use `takt-default-team-high` for the leader flow.
- Builtin planning, test-writing, and implementation prompts now enforce contract traceability and requirement authority (#1162, #1164, #1165, #1166) — a prompt-tuning pass aligned with what current models can reliably carry. Plans assign a stable ID to every independently verifiable completion obligation, and those IDs flow append-only through the test report into a new `implementation-report.md` artifact with per-contract verification status; implementation may add IDs but never renumber or repurpose upstream ones. Every requirement and completion contract must cite its origin: current code, WIP diffs, tests, review reports, and knowledge/policy facets count as evidence and can no longer create requirements, and planners must keep the stated objective, constraints, and acceptance criteria fixed instead of reframing the task or promoting a reviewer's suggestion into a requirement. Phase 2 report generation for every step now receives the original workflow task as the authoritative requirement source, so reports no longer drift toward whatever Phase 1 happened to say.
- Review and remediation now converge by problem family (#1153, #1157, #1158, #1160). Reviewers scan for and report the whole defect family behind each finding, the initial review round is separated from bounded follow-up rounds, and incomplete fix verification routes to a dedicated `fix-retry` step instead of replanning from scratch.

### Removed

- **BREAKING:** The QA reviewer was removed from the builtin review workflows (#1153). The `qa-reviewer` persona, `qa` policy, and `qa-review` output contracts were deleted, with its distinct perspective folded into the coding policy. User workflows referencing them must switch to the remaining reviewer facets.

### Fixed

- OpenCode runs no longer abort with `OpenCode stream tracking limit exceeded` on reasoning-heavy steps (#1130). Reasoning deltas were tracked as response text and charged against the response-text byte budget; part types are now tracked, reasoning is routed to the thinking stream instead of response content, and tracking-limit failures report which guard tripped.
- Workflow progress is preserved across task requeues (#1156, #1159). Auto-requeued and retried tasks keep their nested resume checkpoint, retry iteration metadata, and step counters instead of restarting blind, and the step limit for restored iterations grows linearly by the workflow's `max_steps` per attempt rather than doubling.
- Projects whose path crosses a filesystem-root symlink (such as `/tmp` → `/private/tmp` on macOS) no longer fail private-artifact validation with a trusted-root symlink error (#1141); symlinks below the trusted boundary are still rejected.
- Workflow file references are canonicalized through symlinks (#1158), keeping trust and identity consistent when the same workflow is reached via different paths.
- Finding-ledger summaries shown to agents now reflect the committed ledger state instead of a pre-commit projection (#1157).

### Internal

- READMEs and the teaser site now lead with tutorial video previews (#1121).
- The prompt-eval harness under `eval/` gained cases and assertions covering the planning and remediation prompt changes (#1153, #1154, #1158, #1160, #1164).

## [0.54.1] - 2026-07-29

### Fixed

- Codex auto-routing no longer falls back for every routed step because of an invalid strict structured-output schema (#1123). Router output schemas are now validated when the estimator is created, so deterministic schema incompatibilities fail fast while runtime estimation failures continue to use the configured pool fallback. The shared Codex/Claude schema path is covered through the Claude Agent SDK query boundary.

## [0.54.0] - 2026-07-28

### Added

- The `simple` workflow family (#1117). Seven builtin workflows for capable models that trust the model's judgment and keep orchestration minimal: `simple` (plan → write tests → implement → code review → fix loop → final supervision), `simple-mini` (omits dedicated test writing and final supervision), and the domain variants `simple-frontend`, `simple-backend`, `simple-cqrs`, `simple-dual`, and `simple-dual-cqrs`, which inject the matching knowledge and policies into a shared internal `simple-core` subworkflow. The steps direct the model to select relevant available skills on its own, and on codex the family inherits repository and user Skills (`provider_options.codex.skills.repo/user: true`). The catalog gained a ✨ Simple category, and `simple` now leads the 🚀 Quick Start category.

### Internal

- Prose-coupled assertions were removed from the skill-docs tests, and the builtin-facet deployment test covers the new `use-relevant-skills` instruction partial (#1117).

## [0.53.0] - 2026-07-27

### Removed

- **BREAKING:** The `for-local-llm` workflow family was removed (#1070): `takt-default-for-local-llm`, `frontend-for-local-llm`, `backend-for-local-llm`, `backend-cqrs-for-local-llm`, `dual-for-local-llm`, and `peer-review-for-local-llm`. Use `takt-default`, `takt-default-high`, or the corresponding domain workflows instead. Saved tasks or runs that reference a removed workflow must switch workflows before retrying or resuming.
- **BREAKING:** The MCP tools `takt_create_issue_and_enqueue_task` and `takt_run_next_task` were removed (#1104). `takt_enqueue_task` is now the only MCP tool: pass `issue: { number }` to link an existing issue, or `issue: { title?, labels? }` to create one before enqueueing. Run queued tasks with `takt run` or `takt watch`.

### Added

- `takt-default-team-high` workflow (#1055). A Team Leader variant of `takt-default-high`: plan, tests, Team Leader-directed implementation, six compact specialist reviews, Team Leader-directed fixes, and a fail-closed final gate.
- Team Leader Finding Contract fix mode (#1089, #1090, #1091, #1100). `team_leader.mode: finding_contract_fix` turns a team_leader step into a Finding Contract repair step: every part is assigned to explicit actionable findings, `complete` requires successful verification plus `fixCoverage` for every actionable finding present at step start, and the decision routes via mechanical conditions such as `when(structured.fix.decision == "complete")`. Wildcard contract paths are rejected (#1090), and part `writePaths` document coordination between parallel parts rather than acting as a sandbox (#1100).
- The findings-manager now acts as an adjudicator (#1053): dismiss adjudication and duplicate consolidation actually take effect in the ledger, manager state is injected into the review-fix judge, and manager/interpreter LLM calls are recorded in usage events instead of being a token-accounting blind spot.
- Multi-select facet prompts (#1065). The exec facet editor now offers multi-select prompts, so facet references can be picked in one pass instead of one-at-a-time dialogs.
- Codex Skill inheritance control (#1081). New `provider_options.codex.skills.repo` / `.user` flags (plus `TAKT_PROVIDER_OPTIONS_CODEX_SKILLS_*` env overrides) control whether Codex discovers repository (`.agents/skills`) and user (`~/.agents/skills`, `$CODEX_HOME/skills`) Skills. Workflows now default to not inheriting either scope; `takt exec` defaults to inheriting and snapshots the resolved values into the generated workflow.
- Resumed runs inherit review reports (#1059). Resuming a run carries prior review reports over (best effort), so a resumed fix step no longer starts blind; same-run requeues skip the resume snapshot.
- Shared fix steps now persist a structured `fix-report` (#1116). The builtin workflows that use the shared fix instruction write addressed/unaddressed findings, verification results, and family coverage as a non-judging output contract, so the next iteration or a resumed run can pick up where the fix left off. Rules, transitions, and completion judgment are unchanged.

### Changed

- **BREAKING:** Node.js `>=24.15.0` is now required (#1111), up from `^20.20.0 || >=22.22.0`, because Finding Contract authority uses the built-in `node:sqlite` module.
- **BREAKING:** Auto-routing candidates were reworked around pools and tiers (#1103). `cost_tier` was renamed to `routing_tier` (`high` | `medium` | `low`), and `default_pool` plus `candidate_pools` (each with a pool-local `fallback`) are now required; optional `pool_rules` pin tags/steps/personas to a pool. The router now only estimates the required tier — from the normalized task, the raw step instruction, and current remaining work — and TAKT deterministically picks the candidate: `cost` and `balanced` take the lowest sufficient `routing_tier` in the selected pool, `performance` the highest. Existing configs must rename `cost_tier` and add `default_pool` / `candidate_pools`.
- High workflows are capped at 50 steps (#1061): `max_steps` dropped from 200 to 50 on `takt-default-high`, `review-fix-takt-default-high`, and `takt-default-team-high`.
- Merge-readiness now runs before final supervision in the high workflows (#1060), and the Finding Contract final gate was extracted into `merge-readiness-finding-contract-final-gate`.
- The stop-budget time cap is now opt-in (#1052). `stop_budget.max_minutes` no longer defaults to 90 minutes — churn shows up in round counts, not minutes, and the time default had falsely stopped healthy large runs; the round cap (default 40) remains the deterministic stop guarantee. Reviewers are also barred from filing demands for quality-gate execution evidence as findings; evaluating verification results is the final gate's job.
- The Team Leader total part limit was removed (#1084): the leader may keep adding batches until it judges the work complete, and `initial_max_parts` bounds only the first decomposition batch.

### Fixed

- Team Leader robustness: obsolete running parts are cancelled and completion judgment waits for still-running parts (#1105); invalid decompositions are regenerated with validation diagnostics instead of failing (#1113); the feedback fallback stops on abort (#1085); reviewer-anomaly invariants are passed to loop monitors (#1114); and the implementation judgment receives the agent's completion report (#1101).
- Finding Contract convergence and recovery hardening (#1056, #1058, #1063, #1067, #1069, #1072, #1074, #1086, #1087, #1092, #1093). The findings-manager no longer discards its entire output on dedup/evidence conflicts and degrades to mechanical classification instead of an empty result (#1056); convergence state survives retries (#1058) and finding context survives resumes (#1074); stalled Finding Contract workflows re-plan and final-gate `needs_fix` decisions are honored (#1069); review target snapshots are bound to the structured output contract (#1086); reviewer anomalies are kept after re-matching (#1087); invalid manager decisions are retried (#1092) with hardened recovery (#1093); explanatory adjudication evidence citations are accepted (#1063); post-fix loop monitor states are distinguished (#1067); and re-plans justified only by external blockers abort instead of looping (#1072).
- The fix loop now aborts with an explicit verdict when verification is impossible for environmental reasons (#1102), instead of spinning on unfixable findings.
- PR-derived tasks and Instruct now use the same diff basis (#1106), with PR diff refs materialized so review context matches what is actually being merged.
- Concurrent clone/worktree path collisions were fixed (#1110): clone directories get a unique random suffix, covering same-second task starts and PR-sync worktrees.
- Isolated temporary paths were shortened (#1071) to stay within platform path-length limits, with Windows temp-env precedence covered.
- `auto-improvement-loop` now completes a full issue → implement → PR → self-review → merge cycle on codex (#1045); it previously aborted at `plan_from_issue`.
- OpenCode runs on local models were stabilized (#1017): tool-call failures now log the offending arguments to the debug log, and Finding Contract freezes under weak models were resolved.

### Internal

- Finding Contract-only SQLite authority (#1111). Finding state is separated from run lifecycle artifacts and managed in `.takt/runs/<run>/finding-contract.sqlite`.
- Builtin TAKT workflows were unified on first-match rule semantics (#1083).
- The MCP stdio integration test now passes the isolated `TAKT_CONFIG_DIR` to the spawned server, so it no longer reads the operator's real `~/.takt/config.yaml`.
- Docs: reusable TAKT overview assets (#1108, #1109) and YouTube tutorial links (#1112).

## [0.52.0] - 2026-07-19

### Removed

- **BREAKING:** Removed the `{current_report}`, `{previous_report}`, `{peer_reports}`, and `{report_history}` instruction placeholders without backward compatibility. Use `{report:filename}` to inline the required report content instead.

### Added

- Auto-routing is now actually usable (#1040). The `provider: auto` switch announced in 0.51.0 did not work in practice; it has been replaced with a simpler activation model. Keep a concrete top-level `provider` and define effective `auto_routing` candidates — their presence enables automatic per-step provider/model routing. Operations without workflow-step context (such as AI task-slug generation) use the concrete top-level provider/model; `auto_routing.router` and candidates are never implicit defaults. `provider: auto` is no longer accepted — if you had set it, replace it with a concrete provider.
- `auto_requeue_max_attempts` and `ignore_exceed` config keys (#935, #937). `takt run` can now automatically requeue tasks whose workflow execution failed, up to the configured number of attempts (`0` disables it, the default). `ignore_exceed: true` applies the iteration-limit bypass to `takt run` and `takt watch` like the `--ignore-exceed` flag; an explicit CLI flag still takes precedence. Both keys work in global and project config.
- Kiro CLI provider `model` support (#1034). The `kiro` provider now forwards a configured `model` to the Kiro CLI via `--model`.
- Step metadata on phase usage events (#1033). Phase usage events now record the step name, step type, persona, and tags alongside provider/model, and `tools/token-usage.sh` distinguishes steps in its summary output, so per-step token accounting no longer requires correlating spans by hand.

### Changed

- CLI startup is lazy-loaded (#1035, #1047). Subcommand implementations and config/Git/log initialization now load on demand, cutting `--help` / `--version` startup by ~84% (196 ms → 32 ms). Update checking was split into a cheap synchronous cache read in the parent process, with a background worker refreshing the cache.
- Reviewer verification duties were divided (#1048). The review policy now directs reviewers to spend verification time reproducing their own findings and running risk-based targeted checks instead of re-running full test suites; whole-suite verification belongs to the step that carries it as a quality gate (such as a merge-readiness final gate).
- Review↔fix convergence hardening (#1038, #1039, #1046). Fixers must now fix all branches of the same finding family at once and report a family coverage table — partial fixes that leave sibling branches open count as non-productive loop iterations. Peer-review convergence gates judge progress by verified resolution, align review scope with blocking dependencies, and preserve genuinely productive loops.

### Fixed

- Codex safety-filter refusals no longer abort workflows as rule-evaluation failures (#1050). A refusal response (short body matching refusal patterns) is detected and retried on a fresh session up to twice; when retries are exhausted it surfaces as an explicit provider error instead of flowing into rule evaluation. Pure structured-output responses are never treated as refusals, and the review policy now states its defensive-audit premise up front to lower the refusal rate.
- `takt_providers.assistant` now applies to instruct and retry personas, not only interactive planning (#1011, #1018). The 0.51.0 notes listed this fix, but the change actually landed after the 0.51.0 tag; it ships in this release.
- OpenCode prompts no longer serialize globally (#1026). Prompt queuing is now scoped per session, so parallel steps running on different sessions execute concurrently; implicit retries still get fresh sessions.
- Kiro session continuity (#781, #1036). Kiro CLI output has ANSI escapes stripped, the session ID is resolved via `kiro-cli chat --list-sessions` after the first turn, and subsequent turns resume with `--resume-id`, so multi-turn workflows no longer lose conversation context. The session lookup also gained a timeout and abort-signal propagation.
- Auto-routing structured output now uses strict schemas (#1030), so router responses with unknown keys are rejected instead of silently accepted.
- `timeout_ms` on command quality gates now survives `workflow_call` resolution (#1021). Command gates in callable workflows dropped their timeout during config normalization.

### Internal

- The dogfood quality gates in `.takt/config.yaml` were tiered (#1048, #1049): in-loop fix/implement steps run lightweight gates (build, lint, per-file targeted tests, smoke E2E) and the full suites moved to the merge-readiness gate.
- OpenCode E2E now targets `ollama-cloud/qwen3.5:397b` after `qwen3-coder-next` was retired upstream; the stale model name was also removed from config examples.
- The `auto_routing` docs examples were refreshed to a production-style configuration with an explicit note on `assistant` routing.

## [0.51.0] - 2026-07-11

### Added

- Auto-routing: `provider: auto` (#921, #964). TAKT can now choose the provider/model per step. Configure an `auto_routing` block with a `strategy` (`cost`, `balanced`, or `performance`), a lightweight `router` model that classifies each step, and named `candidates` (provider + model + `cost_tier`); `rules.tags` can pin a step tag to a candidate deterministically. Routing decisions are recorded locally as NDJSON under `.takt/events/` — nothing is uploaded — and local recording can be controlled via `telemetry.routing_decisions` or `takt telemetry status|enable|disable`.
- Image attachments in exec input (#934, #936). While editing the exec input line, `/paste-image` or `Ctrl+V` attaches a clipboard image on macOS, and OSC 1337 inline images from compatible terminals are also accepted. TAKT inserts an `[Image #N]` placeholder; referencing it in an Assistant message or `/go` note sends the image with that request, and `/go` copies referenced images into the generated task spec. PNG, JPEG, GIF, and WebP are supported with a 10 MiB limit; providers without native image input receive the attachment as a local path reference in the prompt.
- `session: compact` mode (#994, #995). Steps and parallel sub-steps can now set `session: compact` to resume the saved persona session and ask the provider to compact it before Phase 1, keeping long-running personas within context limits. Compaction runs only before Phase 1; providers without a compaction capability continue unchanged, and a compaction failure logs a warning and continues with the uncompressed session.
- Finding Contract manager provider/model (#970, #1008). `finding_contract.manager` now accepts dedicated `provider` / `model` fields for the synthetic Finding Manager step. When set, they take priority over `provider_routing`, deprecated `persona_providers`, workflow defaults, and the resolved input provider/model.

### Changed

- Finding Manager mechanical classification (#1007). Decidable raw findings — resolution confirmations and exact location+familyTag matches against open findings — are now classified in code, so the manager LLM only sees the residual judgment calls (with a slimmed ledger). When there are no residuals and no dispute claims, the LLM call is skipped entirely. In live benches the manager had been the largest token consumer, carrying ~200 KB ledgers every round.
- `implement` dead ends now route to `plan` (re-planning) instead of ABORT in the `for-local-llm` family (#1009), matching what `write_tests` and `fix` already did. ABORT remains reserved for loop-monitor verdicts, unclear requirements, and review conflicts.
- Bundled SDKs updated: `@openai/codex-sdk` 0.144.1 and `@anthropic-ai/claude-agent-sdk` 0.3.206 (#1015). The bundled Codex CLI now knows the GPT-5.6 model family (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`), so these can be specified as `model` on the codex provider.

### Removed

- `takt-default-refresh-all` and `takt-default-refresh-fast` were removed. Use `takt-default` or `takt-default-high` instead. Saved tasks or runs that reference either removed workflow must switch workflows before retrying or resuming, or be recreated.

### Fixed

- `takt_providers.assistant` now applies to instruct and retry dialogue, not only interactive planning (#1011).
- OpenCode silent-timeout autopsy classifies provider 429s as `rate_limited` (#985, #1010). The OpenCode server retries provider 429s internally without emitting `session.error`, so a rate-limited session looked like a zero-progress stall and the idle watchdog aborted it without engaging the engine's rate-limit backoff. On an idle-timeout abort, TAKT now inspects the session's last assistant message (with a 5-second budget) and returns 429-class errors as `rate_limited`.
- The Finding Contract dispute route now works with `language: ja`, and index-state findings are prevented (#1012, #1014). The FC instructions were English-only, which starved the ja dispute entry point; prose is now localized while machine-matched tokens (`## Disputed Findings`, field names) stay English. The coder persona's "reviewer findings are absolute — never argue" stance, which suppressed legitimate disputes, was rewritten into an evidence discipline. Git rules now forbid treating index/staging state as evidence, preventing unsatisfiable "commit this file" findings in TAKT-managed runs.
- Stale findings are covered end to end in the dispute route (#993). Dispute guidance now covers findings that contradict the current code (verify against reality, dispute with fresh file:line evidence), and the review-fix loop judge treats fixes-landed-but-findings-persist as a findings-side deadlock that re-planning plus dispute can break, instead of aborting.
- Overnight hardening from live bench operations (#999). Partial `provider_profiles` in user config now overlay the per-provider defaults instead of replacing the whole map; `edit: true` supplies the `edit` permission floor so an editing step can never run with a read-only tool map; a per-call tool error budget (25, no resets) stops degenerate loops that rotate tool names; and a per-call cap on assistant message cycles stops pure text-fragment spin loops.

### Internal

- Facet guidance clarified: output contracts and boundaries (#1013), actor and auth knowledge (#1004), declarative validation (#1000), exception translation boundaries (#998), MCP worktree/autoPr descriptions (#997).

## [0.50.0] - 2026-07-06

### Added

- MCP server entrypoint `takt-mcp` (#938, #943). TAKT can now run as a stdio Model Context Protocol server, letting an MCP client (Codex, Claude Code, …) drive TAKT without shelling out to `takt add` / `takt run`. Three tools are exposed: `takt_enqueue_task` (save a pending task to `.takt/tasks.yaml`), `takt_create_issue_and_enqueue_task` (create an issue through the configured issue provider, then enqueue the task with the new issue number), and `takt_run_next_task` (claim and execute the next pending task). Every tool `cwd` is resolved with `realpath` and must stay inside the server's allowed project root. Register it in Codex with `codex mcp add takt -- takt-mcp` or a `[mcp_servers.takt]` block. See the CLI Reference for the full tool schemas.
- ACP agent entrypoint `takt-acp` (#913, #916). TAKT can now run as an Agent Client Protocol agent over stdio JSON-RPC, launched from an ACP-compatible client. `session/prompt` is enqueue-first by default: prompts such as "enqueue this task" add a pending task (with `worktree: true`) to `.takt/tasks.yaml` for later `takt run`, while explicit "run it now" / "execute now" prompts execute directly. TAKT supports `initialize`, `session/new`, `session/prompt`, `session/cancel`, and `session/update`; stdio MCP servers passed on `session/new` are forwarded to workflow execution.
- `for-local-llm` workflow family (#958, #974, #982). Five workflows tuned for local or weaker models — `takt-default-for-local-llm`, `frontend-for-local-llm`, `backend-for-local-llm`, `backend-cqrs-for-local-llm`, and `dual-for-local-llm` — each running four (five for dual) parallel deep reviewers backed by the Finding Contract (ledger, resolution confirmations, dispute adjudication) plus a flat merge-readiness final gate. A new `implementation-semantics` reviewer (persona, knowledge, instruction, and finding-contract output contract) catches behavioral defects that survive compilation. A review-only `peer-review-for-local-llm` workflow ships alongside them.
- `cli` workflow (#947). A CLI-development workflow: plan → write_tests → draft (implement + AI self-review) → peer-review (parallel reviewers + fix) → supervise → COMPLETE.
- Finding Contract dispute/waiver lifecycle (#969). A coder that cannot fix a valid finding can now state a dispute under a fixed `## Disputed Findings` heading (finding id / reason / file:line); the findings manager either waives the finding (removing it from the blocking set with a recorded reason and evidence) or rejects the dispute (it stays open and blocking). Gates keep their existing `findings.open.count == 0` condition, so this unblocks runs that previously deadlocked on a valid-but-unfixable finding.
- `when()` syntax for engine-evaluated conditions (#977). Deterministic state expressions in rule conditions are now declared explicitly with `when(...)`, matching the existing `ai()` / `all()` / `any()` family — e.g. `condition: when(findings.conflicts.count > 0)` or `approved && when(findings.open.count == 0)`. The rule-level `when:` key is sugar that wraps its expression automatically. See the BREAKING note below for custom workflows.
- Final-gate provider routing tag (#954). Builtin final-gate steps now carry a `final-gate` tag, so `provider_routing.tags.final-gate` can route the merge-readiness gate to a stronger provider/model independently of other review steps.
- Merge-readiness review gate (#949). Builtin development and maintenance workflows gained a parallel final merge-readiness gate (`merge-readiness-final-gate` / `merge-readiness-dual-final-gate`) that judges only whether the change is ready to merge.
- OpenCode native `json_schema` structured output (#965), with a one-shot corrective retry when a reviewer emits invalid structured output (#963). OpenCode reviewer steps now request structured output via OpenCode's native `format: json_schema`, which enforces key structure at the source instead of relying on hand-written JSON; when a reviewer still emits invalid JSON, TAKT asks the same session once to re-emit the corrected payload before failing.

### Changed

- **BREAKING:** deterministic rule conditions now require the explicit `when()` wrapper (#977). Bare comparison expressions (e.g. `findings.open.count == 0`) in a rule `condition` are treated as plain prose tag conditions, not engine-evaluated facts, and aggregate guards containing a bare expression fail configuration with a migration hint. This replaces a fragile comparison-operator heuristic that could silently turn prose like `coverage >= 80%` into an unmatchable dead rule. Custom workflows that relied on the old heuristic must wrap deterministic clauses in `when(...)` (or use the `when:` rule key); builtin workflows were migrated.
- **BREAKING:** the `-with-fc` workflow lineage was removed (#974). `takt-default-with-fc` and `peer-review-with-fc` (added in 0.47.0) are superseded by the new `for-local-llm` family, which is now the Finding Contract lineup. Update any references to the old workflow names.
- The fixer no longer aborts a run on "cannot proceed" (#986). When the fixer gives up on a blocker, the workflow now routes back to the planner to re-decompose it (the planner seat can be routed to a stronger model) instead of throwing away the whole run. A new replan-cycle loop monitor aborts only when consecutive replans repeat the same dead end, with a handoff summary for the human. Applies to the five development workflows.
- Codex `approval_policy` is pinned to `never`. Because TAKT runs Codex non-interactively there is no human to approve escalations, so the sandbox mode is now the sole write boundary: `readonly` hard-blocks writes and `edit`/`full` behave as before, instead of Codex's default approval policy auto-approving an escalation past a read-only sandbox.
- Codex model-capability checks are delegated to the provider (#983).

### Fixed

- OpenCode idle watchdog now fires on stalled sessions (#984). The 10-minute idle watchdog could sleep through a stall because its timer reset on any server-wide event (LSP, file watcher, sibling sessions); the reset is now scoped to the session's own events.
- OpenCode session is preserved across step phases via per-prompt tool restriction (#948), and out-of-workspace denial is kept effective but non-fatal (#957).
- OpenCode structured-output recovery: fall back to a formatless retry when native structured output is not produced (#967), recover when the gateway rejects `json_schema`, and treat empty or typo'd raw-finding location/suggestion fields as unset (#962).
- Finding-contract resolution is reachable and guarded tag rules are supported (#961); dispute guidance is injected only when open findings exist (#973).
- Cursor CLI config directory is preserved across runs (#960).
- Symlinked stdio entrypoints are resolved to their real path (#955), so `takt-mcp` / `takt-acp` work when launched via a symlink.
- Report-phase failures and empty Phase 1 output are now soft errors (#907, #911, #927). A report-generation failure continues to Phase 3 (status judgment) instead of aborting, empty Phase 1 output is detected as an error so later phases do not run on no content, and a report fallback path was added.
- Isolated clone fetch no longer fails when the parent repo HEAD is on the target branch (#924) — TAKT detaches HEAD before fetching.
- `bash` tool handling in OpenCode readonly and no-tools phases corrected (#918, #919).
- `takt list` instruct + requeue flow fixed (#942).
- Judgment, findings, and OpenCode handling hardened per a full-area audit (#981).

### Internal

- CQRS+ES knowledge and guidance strengthened (#925, #940, #941, #979, #988).
- Prompt-quality tooling: a promptfoo-based facet quality eval (#946) and a rescan-semantics eval suite for the implementation-semantics reviewer (#951, #952, #959).
- Reviewers must cite re-scan evidence in review reports (#951), were taught published-state immutability and family-level finding aggregation (#953), and no longer flag guarded Records (#968).
- Review / write-tests / test-policy facet contracts tightened (#915, #917, #932, #944, #966, #987).
- Codex: parallelized test gates (#920), MCP task workflow and auto-PR decisions (#972).
- `when()` helpers tightened per coding standards (#978).

## [0.49.0] - 2026-06-28

### Added

- `takt exec` — instant multi-agent exec mode (#880, #893, #908). Start an interactive session without writing workflow YAML by hand. An Assistant agent clarifies the request, `/go` turns the conversation into a generated workflow, Worker agent(s) implement the task, Review agent(s) review the result, a Replanning agent asks the user for direction when needed, and loop detection prevents repeated unproductive cycles. Four builtin presets ship out of the box (`backend`, `frontend`, `dual`, `research`). Use `/setup` during the conversation to edit agents, loop thresholds, presets, and referenced facets; changes persist to `~/.takt/exec.yaml` for the next session. Presets can be saved/deleted at project or global scope, and custom presets can be exported as standalone workflow YAML via the `/setup` menu.
- `session_key` workflow field. Normal agent steps, parallel sub-steps, and `loop_monitors.judge` now accept `session_key` to share or isolate persona sessions across steps. The runtime key is built as `session_key` plus the resolved provider suffix (e.g. `shared-coder:claude`). When omitted, TAKT uses the persona key or step name as before.
- External contract verification policies (#891). New policy rules prevent treating compile success or mock success as proof of external service contracts. Added to `existing-system-respect`, `review`, and `testing` policies.

### Fixed

- Team leader decomposition turn limit (#904, #906). The team leader's `decomposeTask` and `requestMoreParts` calls could fail with "Reached maximum number of turns (15)" on larger projects. The hardcoded turn limit has been removed from these read-only decomposition calls.
- OpenCode unavailable tool loop detection (#886). The `UnavailableToolLoopDetector` was being reset on every non-error tool state, including `running`. Since OpenCode emits `running → error` for each tool call, the running event reset the counter before errors could trigger the threshold. Now only `completed` states reset the counter.
- OpenCode tool handling in no-tools phases (#887). OpenCode no-tools phases now use wildcard deny, preventing tools from slipping through in tool-free execution phases.
- OpenCode runtime tool list polarity (#890). OpenCode runtime instructions now use positive tool lists instead of negative lists, reducing confusion about which tools are available.
- OpenCode non-existent tool calls (#892). Defined a custom TAKT agent for OpenCode to prevent the model from calling non-existent `list` and `task` tools referenced in OpenCode's default few-shot examples.

### Internal

- Product Hunt landing page added under `docs/index.html`.
- Documentation clarified: TAKT runtime asset boundaries, Headroom is optional, `--no-telemetry` option.
- `review-web` provider options removed (merged into `review-readonly`).

## [0.48.0] - 2026-06-21

### Added

- Provider `base_url` support (#867). Custom API endpoints can now be configured for Claude and Codex providers via `provider_options.claude.base_url` and `provider_options.codex.base_url` at global, project, or workflow level. Non-loopback URLs in project/workflow config are blocked for security; use global config or environment variables for external endpoints.
- Team leader `inspect_tools` (#857, #858). The `team_leader` block now accepts `inspect_tools` to limit which tools the leader agent can use during task decomposition. Supported values: `read`, `glob`, `grep`. Currently available on OpenCode and Claude providers.
- Team leader part tags (#855). Worker parts decomposed by the team leader now support `tags`, enabling `provider_routing.tags` to apply provider/model overrides at the part level.
- Nix flake packaging (#837). TAKT is now available as a Nix flake, providing reproducible builds across `x86_64-linux`, `aarch64-linux`, `x86_64-darwin`, and `aarch64-darwin`. Includes a dev shell with Node.js 22 and Bun.
- `backend-maintenance` builtin workflow. A strict workflow template for production system maintenance with multiple review phases (architecture, testing, security, QA, pure-review, coding-review), loop monitors for anti-pattern and reviewer cycles, and dual-supervisor final sign-off.
- `token-usage.sh` analytics tool. A shell script under `tools/` that aggregates token consumption across TAKT runs, displaying top-N runs by tokens with per-step breakdown, caching percentages, and CSV export.

### Fixed

- OpenCode tool guidance omitted for no-tools phases (#874). The OpenCode provider's tool naming guidance now respects `allowedTools` and returns `null` when the allowed tools list is empty, preventing unnecessary guidance in tool-free execution phases.
- `.takt/.gitignore` handling in worktree clones (#862, #864). The deny-by-default `.takt/.gitignore` template is now correctly created in worktree clones, ensuring runtime artifacts under `.takt/runs/` are not committed.
- E2E test stability. Prevented `git` authentication prompts from hanging mock E2E tests (`GIT_TERMINAL_PROMPT=0`), and inherited the GitHub credential helper into the isolated E2E gitconfig so provider tests can push.

### Internal

- Review and testing facets strengthened (#859, #868). Testing policy expanded with REJECT conditions for absence-only and non-inherited-value tests. E2E knowledge facet added. Review-test instructions updated.
- Workflow categories updated with `backend-maintenance` ordering.
- Codex faceted-prompting dependency updated (#863).

## [0.47.0] - 2026-06-18

### Added

- Finding Contract — structured finding lifecycle for review workflows (#816, #826, #839, #840, #842, #845). Review findings are now tracked in a formal ledger (`findings-ledger.json`) with lifecycle states (`new`, `persists`, `resolved`, `reopened`), severity levels, and deduplication. A dedicated `findings-manager` persona reconciles raw findings from multiple reviewers, allocating stable IDs (`F-0001`, `F-0002`, …) and detecting conflicts. New implementation under `src/core/workflow/findings/` (reconciler, store, manager-runner, validation), with finding-contract output contracts for all review types (coding, architecture, security, QA, frontend, testing, terraform, CQRS/ES, pure, AI antipattern). Two new workflows ship with finding contract support: `takt-default-with-fc` and `peer-review-with-fc`. Enable by adding a `finding_contract` section to a workflow YAML.
- `provider_routing` config for persona, tag, and step-based provider selection (#844, #846). A new `provider_routing` config section routes provider/model/provider_options by three dimensions: `personas` (by raw persona key), `tags` (by step tag), and `steps` (by step name). Resolution priority is step direct > `provider_routing.steps` > `provider_routing.tags` > `provider_routing.personas` > legacy `persona_providers` > workflow > CLI. Configurable in project (`.takt/config.yaml`) or global (`~/.takt/config.yaml`).
- Step tags on all builtin workflows (#851). Every builtin workflow step now carries a `tags` array (e.g. `plan`, `coding`, `review`, `implementation`, `edit`). Tags are the primary key for `provider_routing.tags`, letting you apply provider/model overrides by category rather than individual step name. Tags are also supported on parallel sub-steps.
- Trace discovery for OTel spans (#843, #847). New `traceDiscovery` module builds a structured `WorkflowTraceDiscovery` object (service name, runId, workflow name, task metadata, git branch/base info) and searchable query strings, enabling correlation of workflow runs with external observability tools like Grafana Tempo.
- Trace task metadata enrichment (#827, #829). Task metadata (source, issue/PR numbers, branch, slug, summary) is now extracted into structured `WorkflowTraceTaskMetadata` and propagated into OTel spans and trace discovery output.
- Named resource resolver for provider options and facets (#820, #824). A secure 3-layer resolver (`namedResourceResolver.ts`) searches `.takt/provider-options/` → `~/.takt/provider-options/` → builtin `provider-options/` directories by bare name with extension fallback (`.yaml`/`.yml`), validating against path traversal and verifying symlinks stay inside allowed directories. Used by the new `extends` keyword.

### Changed

- **BREAKING:** `provider_options.$ref` renamed to `provider_options.extends` (#820, #824). The `$ref` key in step/workflow `provider_options` that referenced shared YAML files has been renamed to `extends`. The value is now a bare name (e.g. `extends: edit`) resolved through the 3-layer named resource resolver, instead of a relative file path (e.g. `$ref: provider-options/edit.yaml`). Custom workflows using `$ref` must be updated. Builtin provider options files moved from `builtins/{lang}/workflows/provider-options/` to `builtins/{lang}/provider-options/`. User overrides go in `.takt/provider-options/` or `~/.takt/provider-options/`.
- **BREAKING:** `persona_providers` deprecated in favor of `provider_routing` (#844, #846). The `persona_providers` config key still works but is now deprecated. It matches on display name which is fragile; `provider_routing.personas` matches on the raw persona key instead. Migration: move entries from `persona_providers` to `provider_routing.personas`.
- Report phase tool call detection hardened. The report phase now actively detects and rejects provider tool calls (which are forbidden in this phase), returning a retryable error instead of silently producing broken output. Report file writing logic extracted to a shared `report-writer.ts` module.
- Review and coding policies strengthened. Review policy expanded with new REJECT conditions for contract coverage, contract consistency, specification completeness, requirement anchoring, and resolution judgment. Coding policy wired into review workflows that were previously missing it (#848).
- Supervisor instructions overhauled for both regular and maintenance modes, with clearer scoping and validation criteria.
- Knowledge facets expanded: architecture patterns, backend exception translation scope, CQRS/ES domain patterns.

### Fixed

- Cursor CLI config rename ENOENT on parallel execution (#802, #819). The Cursor CLI intermittently fails with ENOENT when its internal `cli-config.json.tmp` → `cli-config.json` rename races across parallel reviewer steps. TAKT now retries with exponential backoff (up to 8 attempts, 1–30 s delay) instead of treating it as a fatal provider error.
- OpenCode unavailable-tool loops (#822). The OpenCode provider could loop indefinitely when the agent repeatedly called unavailable tools. A new `UnavailableToolLoopDetector` breaks the session after 2 consecutive unavailable-tool errors, surfacing a clear failure message.
- Review findings anchored to original requirements (#830). Reviewers could drift from the original task requirements when evaluating findings. Instructions and output contracts now enforce anchoring review judgments against the plan and original task description.

### Internal

- AI antipattern review policy restructured as a standalone facet with finding-contract output contracts.
- Testing policy facet added with guidance against absence-only tests.
- README status badges added (#835).
- 20+ new test files covering finding contract, provider routing, trace discovery, trace task metadata, report phase retry, named resource resolver, workflow spans, and more.
- Configuration and workflow documentation updated for `provider_routing` and `extends`.
- `WorkflowEngineSetup` extracted for cleaner engine initialization.
- `WorkflowRunLoop` enhanced with failure metadata and command gate improvements.
- Repertoire pack-summary rewritten to support named resource resolution and `extends` references.

## [0.46.0] - 2026-06-13

### Added

- OTLP export with nested provider traces and in-progress trace discovery (#808, #812, #814). When `observability.enabled: true` and `OTEL_EXPORTER_OTLP_ENDPOINT` are both set, TAKT now sends spans and metrics over OTLP HTTP alongside the existing local exporters. `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` are supported as standard endpoint overrides, without adding TAKT-specific OTLP config keys. The 0.42.0 note that standard `OTEL_*` environment variables could connect to a user-managed collector stopped being true after #753 explicitly configured `spanProcessors` and `metricReaders`; this change restores actual OTLP delivery. TAKT now also propagates W3C trace context into spawned provider subprocesses, so each provider CLI's spans nest under the parent workflow trace instead of forming detached traces (#812), and emits a short-lived `workflow_start.<name>` span so an in-progress workflow is discoverable in Grafana Tempo before its long-lived root span closes (#814).
- OpenCode tool allowlist and shareable `provider_options` files (#804). `provider_options.opencode.allowed_tools` scopes the OpenCode tools a step or workflow may use, with lowercase OpenCode tool names (for example `read`, `glob`, `grep`, `bash`, `websearch`, `webfetch`). A `provider_options` block can now also reference a shared YAML file via `$ref` relative to the workflow file, with inline values overriding matching leaves, and builtin `provider-options/{edit,review-files,review-readonly,review-web}.yaml` presets ship for reuse.
- Kiro custom step agent (#796). `provider_options.kiro.agent` passes a Kiro CLI custom agent name (`kiro-cli chat --agent`) per step, workflow, persona, project, or global config, with `TAKT_PROVIDER_OPTIONS_KIRO_AGENT` as an env override. Steps without it use the Kiro CLI default agent.

### Changed

- `team_leader` scheduling now separates concurrency from initial decomposition (#799). `max_concurrency` (up to 3) caps how many worker parts run at the same time, while optional `initial_max_parts` limits only the first decomposition batch. The leader may add later batches until it decides the work is complete. The older `max_parts` key is still accepted as a compatibility alias for `max_concurrency`.
- Pure review pass added to the builtin review and development workflows. A new general-purpose `pure-reviewer` persona (with the `review-pure` instruction and `pure-review` output contract) judges only "can this change be merged now?" — flagging unmet requests, broken existing behavior, missing tests, and out-of-scope changes — and was wired into the peer-review, review, review-fix, backend(-cqrs), frontend, dual(-cqrs), terraform, and maintenance workflows. It replaces the former requirements reviewer (the `requirements-reviewer` persona and `requirements-review` output contract were removed).
- Builtin review and testing facets hardened. Reviewers and the test-writing guidance now guard against absence-only tests that merely assert a replaced specification is gone, and the behavior-verification, review-verification, and naming-policy guidance were strengthened across the coding, review, and testing policies.

### Fixed

- Rate-limit false positives reduced (#809). The rate-limit detection patterns matched too eagerly — a bare `429`, any passing `rate limit` mention, or a `resets H:MM` time in ordinary agent output could be misread as a provider rate-limit and trigger fallback. Detection now requires more specific phrasing (for example `429` near "too many requests", "rate limited" / "rate limit exceeded" / "rate limit error", or "exceeded/hit/reached rate limit") and drops the loose standalone-time stream marker.
- OpenCode permission handling corrected (#801, #803, #807). OpenCode `doom_loop` permission prompts are now auto-answered instead of being denied by the active permission mode, so non-interactive runs no longer stall on them (#803); permission requests and a resolved permission summary are now logged (#801, #807); and the OpenCode integration was reworked so edit-class tools map to the OpenCode edit permission and the shared OpenCode server pool is keyed per configuration with proper acquire / release and abort handling (#807).

## [0.45.0] - 2026-06-10

### Added

- Phase-level usage events and a usage analysis script (#785). With `observability.enabled: true` and `observability.usage_events_phase: true`, each run writes per-phase token usage events to `.takt/runs/<run>/logs/<session>-usage-events.phase.jsonl`, as a separate stream from the existing `logging.usage_events` output. Events are grouped by workflow phase (`phase1_execute`, `phase2_report`, and the status-judgment variants `phase3_structured` / `phase3_tag` / `phase3_fallback`), and calls whose usage is unavailable are recorded with `usage_missing: true` instead of being counted as zero tokens. A new `npm run analyze:usage` script aggregates one or more event files or run directories into a Markdown or CSV table keyed by step × phase × provider × model, with token totals and per-call statistics. Documented in the new [Observability guide](./docs/observability.md).
- Clipboard image paste in interactive mode (#791). Pressing Ctrl+V (or running the new `/paste-image` command) during interactive input now attaches an image directly from the OS clipboard; previously paste only worked for terminals that emit inline-image (OSC 1337) escape sequences. Attached images also flow through the provider abstraction now: `claude-sdk` and `codex` receive them as native image input, while the other providers get the attachment file paths referenced in the prompt so the agent can open them with its own tools.

### Changed

- **BREAKING:** Interrupted `running` tasks are no longer auto-requeued (#791). When `takt run` or `takt watch` was interrupted (process crash, kill), tasks left in `running` status used to be recovered to `pending` and re-executed on the next invocation. They are now marked `failed` with an explanatory error instead; requeue them explicitly to run them again.

### Fixed

- Worktree-isolated clones no longer fail with missing-object errors when branching off a fetched base-branch commit (#791). The isolated clone now fetches the base branch's commits from the main repository before running `git reset --hard`, so the reset target is always present in the clone.
- OpenCode readonly permission mode now allows read tools (#797). The `readonly` mode denied every tool — including `read`, `glob`, and `grep` — so read-only steps such as reviews could not inspect the codebase at all. Those three read tools are now allowed while edit, bash, and network tools stay denied.

### Internal

- Claude Agent SDK and Codex SDK dependency updates (#789, #795).
- Removed the `takt-quality-check` command gate from the implement-type steps in the repository's own `.takt/config.yaml`.

## [0.44.0] - 2026-06-03

### Added

- `kiro` provider added (#773). TAKT can now drive the Kiro CLI as an AI agent provider alongside Claude, Codex, OpenCode, Cursor, and Copilot. Select it with `--provider kiro` or in config. Authentication uses `kiro_api_key` in config (or the `TAKT_KIRO_API_KEY` env var), and the CLI binary can be overridden via `kiro_cli_path` / `TAKT_KIRO_CLI_PATH`.
- OpenTelemetry observability gained working exporters and richer spans (#753). Building on the span foundation shipped in 0.42.0, observability now emits a local `monitor.json` of per-run workflow metrics (enable with `observability.monitor: true`) and a shadow session log derived from OTel spans (`observability.sessionLogExporter: true`), and the span set was extended to cover phase execution and status-judgment (judge) phases. Exporters are routed per run id and the shadow session log keeps redaction parity with the canonical NDJSON session log, so sensitive agent output stays sanitized. Still off by default behind `observability.enabled: true`.

### Changed

- Coding review extended to all builtin review and development workflows. The coding-review parallel sub-step (the `coding-reviewer` persona with the `review-coding` instruction and `coding-review` output contract) — previously only on `default-peer-review` — is now appended to every builtin review / review-fix workflow and to the parallel reviewer waves of the development workflows (backend, frontend, dual, terraform, and their variants). It is a general-purpose, near-instruction-less pass that flags implementation bugs, regressions, security risks, and missing tests using the model's own coding judgment. The intentionally-minimal `*-mini` and `compound-eye` variants are left unchanged.

### Fixed

- Codex `Reconnecting...` events no longer abort the run (#775). A transient reconnect from the Codex SDK could surface as a fatal provider error and tear down the whole workflow; the Codex client now treats it as a recoverable reconnect and retries.
- Worktree-clone isolation hardened (#778). Fixes to the `git clone --shared` isolation path and clone execution, including normalized gitdir isolation handling, so worktree-isolated tasks stay properly isolated from the main repository.

### Internal

- Repository quality gates wired into TAKT's own `.takt/config.yaml` so the dogfooded review/dev steps run the build, lint, unit, and mock-E2E checks via a command gate.

## [0.43.0] - 2026-05-29

### Added

- Image attachments (experimental, #751). Images can now flow through TAKT end to end. In interactive mode you can paste an image straight into the prompt — TAKT decodes terminal inline-image (OSC 1337) sequences into a pending attachment — and `takt add` plus retries carry image attachments with the task spec, so the agent receives the images alongside the text instruction. Works in assistant / passthrough / quiet / retry input modes, with a 10 MB per-image limit. Still under verification — behavior may change.
- `takt resume` command for direct runs (#759). A direct (one-shot, non-queued) run that fails or aborts can now be resumed with `takt resume`, which finds the latest failed/aborted direct run and continues it instead of starting over. Resume reuses the existing run directory, and a dedicated scoring prompt decides how to re-enter the workflow.
- Command quality gates (#761). Step `quality_gates` now accept machine-executed `type: command` entries in addition to AI directive strings. A command gate runs after an agent step completes and passes only when the command exits with code `0`; on failure TAKT feeds the command metadata, cwd, exit code (or timeout / output-limit details), the output log path, and bounded sanitized stdout/stderr back into the same agent step for another attempt. Workflow-YAML command gates require `workflow_command_gates.custom_scripts: true` in config. `system` and `workflow_call` steps do not accept `quality_gates`.
- `frontend-maintenance` builtin workflow (experimental). A workflow for modifying existing frontend products rather than greenfield builds, shipping maintenance-scoped plan / implement / write-tests / fix / supervise instructions, an `existing-system` knowledge facet, an `existing-system-respect` policy that enforces respecting current conventions, and a `maintenance-scope` output contract. Experimental — it can currently be heavier-handed than intended, so treat it as a starting point for existing-product changes and tune to your codebase.
- Coding review added to the default peer review. The builtin `default-peer-review` workflow now includes a coding-review sub-step backed by a new `coding-reviewer` persona, a `review-coding` instruction, and a `coding-review` output contract, so general code quality is reviewed alongside the existing specialist reviewers.

### Changed

- Review facets hardened against scope creep across the fix ↔ review loop (en + ja). The review baseline is now anchored to the task's base — every reviewer evaluates the entire cumulative diff from the merge-base, not just the increment from the most recent iteration. This stops unrequested changes that slipped in during earlier iterations (unrelated comment deletions, renames, reformatting, weakened tests) from being missed once the diff narrows to the latest fix. The `ai-antipattern` scope-creep check was made cumulative-diff based, and review and React facet guidance was refined alongside.

### Fixed

- `claude-terminal` prompt detection now works with Claude Code v2.1 (#766, refs #765). The tail-line regex required the prompt row to be exactly `❯` / `❱` / `>`, but v2.1 renders it as `❯ Try "..."`, so `waitForClaudeInputReady` never matched and timed out after 60 s. The pattern was relaxed to accept any prompt character followed by whitespace or end-of-line, while the busy-state gate still prevents false positives.
- Codex `Reconnecting...` is no longer treated as a fatal error (#767). A transient `Reconnecting... N/5` event from the Codex SDK was surfaced as a final `provider_error` and aborted the whole workflow; it is now handled as a recoverable reconnect and retried.
- `team_leader` part timeouts no longer abort the run (#764). When a worker part hit `part_timeout` or a feedback failure, `TeamLeaderRunner` aborted immediately; a timeout fallback now keeps the run going, and the decomposition instructions and facets were tuned so the leader is less likely to create one oversized part.
- Parallel review aggregation no longer fails the whole step when a single reviewer errors (#770). A `provider_error` in one reviewer's Phase 1 during a parallel `reviewers` step previously broke aggregation even when the other reviewers completed; `ParallelRunner` terminal-status handling was fixed so the step aggregates correctly.
- `review-fix-takt-default` now routes supervisor findings correctly. Findings raised by the review-fix supervisor were not routed back into the fix loop as intended; the workflow rules were corrected.

### Internal

- Added a three-phase step model tutorial to the docs (#735).

## [0.42.0] - 2026-05-20

### Added

- `claude-terminal` provider added (#727). A new way to run Claude that drives an interactive Claude Code CLI session inside a tmux pane and reads results back from the session transcript, instead of calling the Anthropic SDK (`claude-sdk`) or the headless CLI (`claude`). Select it with `--provider claude-terminal` or in config. It supports structured output, MCP servers, and allowed-tools, and surfaces permission / ask-user-question prompts back through the terminal. Provider options live under `provider_options.claude_terminal` (`backend: tmux`, `timeout_ms`, `keep_session`, `transcript_poll_interval_ms`). Requires `tmux` to be installed; `maxTurns` is not supported, and API usage figures are unavailable because the terminal transcript does not expose them
- Opt-in OpenTelemetry observability added (#706, #745). Set `observability.enabled: true` in `~/.takt/config.yaml` (global) or `.takt/config.yaml` (project) — also overridable via the `TAKT_observability__enabled` env var — to emit OTel spans for workflow execution. Each run produces a `workflow.<name>` span with child `step.<name>` spans carrying attributes such as workflow / step name, step type, iteration counts, the resolved provider / model (and their config source), and final status (including abort kind). Spans are emitted as a non-blocking "shadow" alongside normal execution and never alter run behavior. The foundation initializes the OTel Node SDK (service name `takt`) but ships no exporter, so you wire up your own collector via the standard `OTEL_*` environment variables. Off by default
- `/accept` interactive command added (#733). In interactive assistant mode, `/accept` takes the most recent assistant response verbatim and runs it as the task, without re-summarizing through `/go`. If there is no assistant response yet, it asks you to describe the task first
- Assistant init files added (#734). List project context files under `assistant.init_files` in `.takt/config.yaml` and they are loaded automatically into every interactive assistant conversation as an "Assistant Init Context" section, so project-specific context (architecture notes, conventions, custom instructions) is included without manual setup. Paths must be relative and inside the project; sensitive files (`.env*`, `.pem`, `.key`, `.npmrc`, `.netrc`, `.git/`, etc.) are rejected, with limits of 16 files, 256 KB per file, and 1 MB total
- GitHub PR review threads are now classified by resolution state (#746). When TAKT feeds PR review comments into a task, threads are split into Active, Outdated-but-unresolved, and Resolved/Outdated sections, each annotated with who resolved it and whether it is outdated. A review policy directs the agent to focus on active threads, re-check outdated-unresolved ones for current relevance, and skip resolved threads unless the same issue still persists in the code — so already-handled feedback is not re-litigated
- Enqueue effect `base_branch` can create the branch on demand (#725). The system-workflow enqueue effect's `base_branch` now accepts an object form `{ name, create_if_missing: { from, push } }` in addition to a plain string. When the named base branch does not exist, TAKT creates it from `from` (and pushes it when `push: true`). The builtin `auto-improvement-loop` uses this to create its `improve` base branch from `main` automatically, so the loop runs without manual branch setup

### Changed

- Builtin review facets refined (en + ja). CQRS-ES knowledge gained guidance on event evolution and abstraction boundaries; the AI-antipattern, coding, QA, review, and testing policies tightened their REJECT / APPROVE criteria; and frontend knowledge plus the frontend-review output contract gained canonical-state guidance. These sharpen what the builtin reviewers enforce without changing workflow structure

### Fixed

- OpenCode responses no longer duplicate content when the SDK emits both incremental deltas and a full snapshot (#749). The two streams were previously concatenated, so the assistant text appeared twice in the response
- Provider rate-limit messages are now preserved instead of being flattened into a generic process error (#730). When a provider reports a rate limit, the original message survives through the response so the cause is visible

### Internal

- Configuration docs and validation error messages aligned to snake_case (#747). The config reference and error text used camelCase names (`workflowArpeggio`, `syncConflictResolver`, `taktProviders`, …) that never matched the actual snake_case YAML keys (`workflow_arpeggio`, `sync_conflict_resolver`, `takt_providers`, …) the parser expects. Documentation and messages now show the keys TAKT actually reads. No behavior or schema change
- CodeRabbit integration added for repository reviews — `.coderabbit.yaml` configuration, TAKT facets referenced as `code_guidelines`, probe-based config tuning, and a sponsor mention (#737, #738, #742, #744)
- CI consolidated and retriggered on `/review`. The four `issue_comment`-driven workflows were merged into a single `pr-comment-commands.yml`, and the takt-review comment trigger moved from `/takt-review` to `/review` (#726, #728, #736)
- Documentation reorganized: added a Design Philosophy page and an External Integrations page, refreshed the workflows guide (including `workflows.ja.md`), and removed stale internal docs (data-flow, provider-sandbox, report-phase-permissions, agents) (#723, #729, #739)
- Removed brittle non-executable asset tests (README terminology / instruction-template checks) and added testing-policy guidance discouraging such tests (#730)

## [0.41.0] - 2026-05-14

### Added

- Step-level `promotion` field added (#349). Per-step execution-count or AI-judgment escalation for `provider` / `model` / `provider_options`. Each entry can specify `at: <execution-count>` (matches from that execution onward) and/or `condition: ai("...")`, plus the override target (`provider`, `model`, or `provider_options.*` leaf). Multiple entries are evaluated in declaration order with last-match wins. Useful for cases like "use the faster cheap model up to attempt 2, then escalate to Opus when the reviewer keeps rejecting". Promotion is the highest-priority source in model/provider resolution (see CLAUDE.md Model resolution priority order). Promotion is not supported on parallel sub-steps
- Rate-limit fallback chain added (#716). New `rate_limit_fallback.switch_chain` config (workflow `workflow_config`, project `.takt/config.yaml`, and global `~/.takt/config.yaml`) lets a workflow continue across a Claude / Codex / OpenCode rate-limit hit by re-running the interrupted step on the next provider in the chain. The new session receives a fallback notice instruction (`facets/instructions/_system/fallback-notice.md`) describing why the previous session was interrupted, which step is being retried, and how to rebuild context from `report_dir` / commit diff. Attempts within a single fallback chain are tracked on workflow state and reset on successful step completion
- AI-generated GitHub Issue titles for `auto-improvement-loop` (#333). The follow-up-task / pr-followup-task structured output schema was extended with `title`, `type`, `scope`, `summary`, `goals`, `acceptance_criteria`, and `labels`. The planning instruction now requires the AI to emit a short, Issue-appropriate title (rejecting generic headings like `# タスク指示書` / `# Task Order`) plus structured task metadata that TAKT renders into the Issue body using `## Summary / ## Goals / ## Acceptance Criteria`. Title validation has fallback handling for missing / too-short / prohibited titles with a `fallback_reason` metric so degradations are observable
- OpenCode `provider_options.opencode.variant` added (#694). Pass-through string forwarded to the OpenCode `prompt` call as the model variant (e.g. `high` / `low`). Resolvable from step `provider_options`, workflow / persona / project / global config, and `TAKT_PROVIDER_OPTIONS_OPENCODE_VARIANT` env var
- `PromptBasedStructuredCaller` retry on malformed JSON output (#695). `decomposeTask` / `requestMoreParts` now wrap each call in `withRetry` (3 attempts, 1000 ms delay) so a transient `\`\`\`json ... \`\`\`` extraction failure, schema validation failure, or `status: 'error'` response from the provider no longer aborts the whole team-leader run. Retry attempts are logged via `log.info` with `attempt` / `maxAttempts` / `error` so retry frequency is observable. The final attempt's error still propagates if all attempts fail, and `phase:start` is deduped across retries so the `phase:start` / `phase:complete` event pair stays balanced

### Changed

- Review-instruction observation lists removed; reviewers now read policy / knowledge facets directly (#718). The nine review instructions (`review-arch` / `review-cqrs-es` / `review-frontend` / `review-qa` / `review-requirements` / `review-security` / `review-terraform` / `review-test` / `ai-antipattern-review`) plus `supervise` and `implement` / `implement-after-tests` no longer carry per-instruction "review observation" enumerations. Instead, every review now runs a three-step procedure: Read the bound Knowledge and Policy Source Paths, enumerate every `##` section in them, then check each section's criteria against the diff. Common review boilerplate (design-judgment lookup, prior-comment tracking, final-decision steps) is consolidated into `policies/review.md` as "Review basic procedure". This fixes the drift observed in #713 where ai-antipattern policy gained a dead-code detection chapter but the review instruction's observation list did not include it. `INSTRUCTION_STYLE_GUIDE.md` was updated to forbid observation enumeration in review-type instructions
- Phase 1 prompt template gains a "Judgment rules" section (en + ja). Two universal instructions are now injected into every step's main phase: do not infer or guess values that have not been confirmed, and do not trust "already-fixed" / "already-confirmed" memories from earlier iterations of the same session — re-verify against the current file/working tree immediately before judging. Targets context-rot on long-running sessions
- `cqrs-es` knowledge clarifies Aggregate decision boundaries. Adds a decision table that explicitly separates state recoverable by event replay (Aggregate responsibility) from format interpretation / ownership lookup of external identifiers (API / UseCase layer responsibility), with the principle that external-identifier interpretation does not belong inside the Aggregate
- Frontend / React knowledge reinforced (knowledge `frontend.md` / `react.md`, en + ja). Targeted additions to existing chapters to tighten review criteria

### Fixed

- `claude-sdk` provider no longer flags every step as rate-limited when the organization does not provide an overage allowance. `rate_limit_event` is emitted as an informational stream event each call, and `overageStatus = 'rejected'` is the steady state for organizations without overage. The previous OR-judgment treated a standalone `rejected` overage status as an active rate limit, so each step aborted immediately. `isRejectedRateLimitEvent` now requires the base `status === 'rejected'` (and falsely-fixed tests were corrected) so only an actual rate-limit event triggers fallback

### Internal

- `delay()` helper extracted to `shared/utils/delay.ts` and shared between `ArpeggioRunner` and `PromptBasedStructuredCaller`. Includes unit tests under `src/__tests__/delay.test.ts`

## [0.40.0] - 2026-05-10

### Added

- `takt list` failed-task action `Requeue` added (#435). Previously the only options were `Retry` (always conversation-driven) and `Delete`. `Requeue` directly returns the task to the pending queue without entering a conversation, useful for quickly resending a failed task while working on something else. The `retry_note` is auto-generated from the failure context (failed step name + error excerpt + a hint that the user has acknowledged the issue), so the next run still receives `## Requeue Notes` context. Existing `retry_note` values are accumulated rather than overwritten
- AI antipattern review now runs on every reviewers cycle. Added `ai-antipattern-review-2nd` to the parallel reviewers step in `default` / `default-mini` / `default-high` / `backend` / `backend-cqrs` / `dual` / `dual-cqrs` / `frontend` / `terraform` / `takt-default`, so over-defensive code or ghost comments introduced by a `fix` pass are caught on every review pass instead of only the initial one. Split workflows (`backend` / `dual` / `frontend` series) place it on `reviewers_1` only, since `fix` always returns to `reviewers_1`

### Changed

- **BREAKING:** AI antipattern review/fix facet names unified under `ai-antipattern-*` and split into 1st/2nd. `ai_review` (standalone) -> `ai-antipattern-review-1st`, `ai_review` (parallel sub-step) -> `ai-antipattern-review-2nd`, `ai_fix` / `ai_no_fix` -> `ai-antipattern-fix` / `ai-antipattern-no-fix`, `ai_fix_parallel` -> `ai-antipattern-fix-parallel`. `review-ai.md` is consolidated into `ai-antipattern-review.md` and removed. `loop-monitor-ai-fix.md` is renamed to `loop-monitor-ai-antipattern-fix.md`. Custom workflows that referenced any of these step names, instruction files, or report formats need to be updated
- Review policy treats CHANGELOG / RELEASE_NOTES / MIGRATION as point-in-time history (#710). Reviewers no longer REJECT past entries solely because their config keys, API names, or behaviors no longer match current code. Reviewers can still REJECT factual errors in newly added entries (relative to the target release) and Markdown / formatting issues. Targets are identified by file name (`CHANGELOG.md`, etc.) or conventional headings (`### Changed` / `### Added` / dated release headings)
- `default` / `default-mini` / `default-high` / `takt-default` workflows refactored to share two internal subworkflows: `default-draft` / `default-peer-review` (default series) and `draft` / `peer-review` (takt-default series). The four parent workflows are now `workflow_call`-based shells, and the subworkflows expose `params` (e.g. `impl_knowledge`, `fix_knowledge`, `arch_knowledge`) so each parent injects its own knowledge facets without duplicating step definitions. The subworkflows are `visibility: internal` and not selectable from the workflow UI. Observable behavior is unchanged
- Quiet / Passthrough mode show mode-specific intros (#593). Previously both modes printed the assistant-mode intro listing slash commands like `/go` / `/cancel` that those modes do not actually parse. Quiet mode now prints `interactive.ui.introQuiet` and Passthrough mode prints `interactive.ui.introPassthrough`, both English and Japanese, so the displayed instructions match what the mode actually does
- `auto-improvement-loop` structured-output schemas tightened for Codex compatibility. `task_markdown` and `issue` are now required on `followup-task`, and `task_markdown` is required on `pr-followup-task`. The planning instruction prompts now explicitly state how to populate these fields for each action (e.g. empty string for `wait_before_next_scan` / `prepare_merge` / `reject_pr`). Previously a Codex provider could produce a partial `agent_message` without these fields and the parent workflow had no schema enforcement

### Fixed

- Codex provider structured output extraction uses the final `agent_message` text instead of the concatenated stream content (#707). When a Codex session emitted multiple `agent_message` text events (typical when intermediate JSON drafts precede the final answer), the previous implementation concatenated all of them and tried to parse the resulting JSONL-like blob as a single JSON object, causing `Structured output response is missing` aborts on workflows like `auto-improvement-loop`. The last `agent_message.text` is now parsed independently when an `outputSchema` is configured, so older intermediate drafts are not incorrectly adopted and the run no longer aborts

### Internal

- CI: `takt-review` workflow now cancels stale runs when a new commit lands on the same PR (`concurrency.cancel-in-progress: true`), avoiding wasted reviewer runs against an outdated revision

## [0.39.0] - 2026-05-02

### Added

- Facet inheritance with `{extends:<parent>}` syntax added (#690). File-based facets can extend a parent facet of the same kind; the parent is resolved through the facet kind and layer order, with self-reference exclusion and circular detection both done by source path. Applies to instructions, policies, knowledge, output contracts, and loop monitor judge instructions. The parent name must be a bare facet name (no path or `@scope` references); persona facets do not support inheritance
- Step-level `allow_git_commit` field added (#587). Opt-in flag (default `false`) that removes the standard "do not run git add / commit / push" prohibition injected into Phase 1 / Phase 2 instructions. Useful for workflows that consume many issues per task and need to commit per work unit
- `default-mini` builtin workflow added: a lightweight variant of `default` with `write_tests` removed (`plan -> implement -> AI antipattern review -> parallel review -> complete`). Registered to both Quick Start and Mini categories and the builtin catalog
- Run checkpoint resume added (#568). `.takt/runs/<slug>/meta.json` now records `currentStep` / `phase` / `iterations` / `resumePoint` continuously during run execution, and `tasks.yaml` accepts `start_step` (with `start_movement` retained as a backward-compatible alias) so interrupted runs resume from the last known step on retry
- Agent failure categorization added (#678). Team leader part failures now distinguish `external_abort` / `part_timeout` / `provider_error` / `stream_idle_timeout` and surface the category in the trace report, session log, and aggregated error message instead of a generic "execution aborted". Codex client preserves abort cause (`timeout` / `external`) and propagates it through the failure detail

### Changed

- System-mode workflow execution is no longer restricted to the project workflows root (#691). `mode: system`, workflow-level `runtime.prepare`, and step `allow_git_commit: true` were previously rejected unless the workflow lived under `.takt/workflows/`. Builtin workflows (e.g. `auto-improvement-loop`) and user workflows under `~/.takt/workflows/` are now accepted, so reusable orchestration workflows can be installed globally and invoked by name. The previous workflow trust boundary that re-classified workflows by file path is removed in favour of the loader-confirmed `WorkflowTrustInfo`
- `auto-improvement-loop` PR-branch action set simplified (#676). Removed `comment_on_pr` and `noop`; added `reject_pr`. The PR branch now chooses among `enqueue_from_pr` / `prepare_merge` / `reject_pr`. `reject_pr` closes the PR via `close_pr` effect without leaving a comment, deleting the branch, or re-enqueueing the task. The `pr-followup-task` schema enum was updated accordingly
- `auto-improvement-loop` issue and fresh-planning paths tightened (#685). Removed `noop` from `plan_from_issue` and `plan_fresh_improvement`; planning instructions now explicitly reject low-value, cosmetic-only, ambiguous, or duplicate tasks and require concrete deliverables and completion conditions. The `followup-task` schema action enum is reduced to `enqueue_new_task` / `wait_before_next_scan`
- Rate-limit cause is preserved through workflow abort (#569). When a Claude rate limit is observed in provider events, downstream phase / parallel / workflow errors now surface as `Rate limit exceeded. Please try again later.` instead of the generic `Claude Code process exited with code 1`. `AgentResponse.errorKind` is normalized at the provider boundary so session resume / report-phase retry paths no longer flatten the cause

### Fixed

- OpenCode shared server processes no longer leak after takt exit (#550). The server kept running in the background after `takt` terminated, accumulating across runs. Cleanup now runs on takt exit so OpenCode provider sessions release their server processes deterministically
- Interactive `/go` works without prior conversation history (#680). `/go` could fail when there was no preceding dialog; the first input now flows directly into workflow execution while existing dialog-driven flows are preserved
- `takt watch` stdin handlers cleaned up after stop. The immediate-SIGINT-exit installer now returns a cleanup hook that runs after `parseAsync` and slash-fallback paths, so stdin handlers installed for watch are released and process termination is no longer blocked
- Interactive mode now shows progress feedback while the AI is responding. `Assistant is thinking...` is displayed after each user input is sent, and `Creating instruction...` is displayed while `/go` summarizes the conversation, so the user is no longer left wondering whether takt is hung. Stdin is paused for the duration of these calls. LF (`\n`) now submits the line in the multiline input editor in addition to CR (`\r`), so pasted text and `\n`-terminated inputs commit cleanly; `Shift+Enter` (CSI `13;2u`) remains the way to insert a literal newline

## [0.38.0] - 2026-04-25

### Added

- `persona_providers.<persona>.provider_options` added (#623). Persona-level `provider_options` (e.g. `claude.effort`, `codex.reasoning_effort`) can now be configured alongside `provider` / `model`, removing the need to repeat the same options across every step. Resolution priority: step > workflow > persona > project > global > default
- Report handles `{current_report}` / `{previous_report}` / `{report_history}` / `{peer_reports}` added to instruction template variables (#627). Facets can now reference self/peer report files abstractly without hardcoding filenames; usable in `reviewer` / `fix` / `supervise` style steps
- Standardized verification evidence section added to review output contracts (#628). `architecture-review`, `qa-review`, `testing-review`, `security-review`, `requirements-review` now emit a common build / test / behavior-check section with target, content, and result (or explicit "not verified") so supervisors can evaluate evidence consistently
- `default-high` workflow added: full-spec general-purpose workflow combining team-leader implementation, 5-parallel review, AI antipattern review with arbitration, and supervision (`plan -> write_tests -> team-leader implement -> AI review -> 5-parallel review -> fix -> supervise -> complete`). Quick Start categories reorganized into `default` / `default-high` / `frontend` / `backend` / `dual`
- `takt-default-refresh-all` / `takt-default-refresh-fast` workflows added: `session: refresh` variants of the TAKT development workflow. `refresh-all` refreshes every step for full conversation-carry-over comparison; `refresh-fast` refreshes only context-heavy steps (`write_tests`, `ai_review`, reviewers, `fix`)
- `takt watch --ignore-exceed` option added (#651). Same semantics as `takt run --ignore-exceed`: ignores workflow `max_steps` and continues running tasks instead of marking them `exceeded`
- `provider_options.*.effort` value and source surfaced in console / NDJSON (#647). Active provider's effort (`claude.effort`, `codex.reasoningEffort`, `copilot.effort`) is shown alongside `Provider:` / `Model:` in console output, with `(source: step|persona|global|...)` suffix in debug / verbose mode. NDJSON `step_start` records always include `providerOptions` and `providerOptionsSources` for the full tracked path set
- Task-based PRs without an Issue now use `order.md` content for the `## Summary` section of the PR body (#600). Previously the section was empty; now reviewers can read the full task instructions directly from the PR

### Changed

- `<!-- takt:managed -->` hidden marker is now opt-in, not a default (#665). Normal `--auto-pr` / `autoPr` no longer attaches the marker; only orchestration-driven task creation (e.g. `enqueue_task` from `auto-improvement-loop`) adds it. PRs created by ordinary pipeline / task execution are now indistinguishable from human-authored PRs
- Workflow `source` / `trust` resolution unified at the loader entry (#660). Parser / normalizer / doctor / `workflow_call` child loads now consume the `WorkflowTrustInfo` produced by the loader instead of re-classifying workflows by file path. Builtin privileged workflows (e.g. `auto-improvement-loop` with `kind: system` steps) are now treated consistently across discovery / runtime / doctor entrypoints
- Interactive mode `--pr` source context separated from conversation history (#656). PR review comments fetched by `--pr` are no longer pushed into `history` as a hidden user message; they are kept as a separate "Source Context" block. `/go` summaries no longer treat the full PR comment thread as the user's request, preventing instruction bloat
- `takt-default` `implement` step (team leader / part workers) now receives the parent `takt run` PID as a protected PID along with a short process-safety policy (#603). Prevents AI cleanup logic from killing the parent run via `pkill` / `killall` / name-based kill when stray child processes are present
- Retry / re-execution now syncs the project-local `.takt/` directory from the root repository before re-running on an existing worktree (#607). Root-side facet / workflow / output-contract updates now take effect on retry by default, matching first-run behavior
- PR sync system effects (`sync_with_root`, `resolve_conflicts_with_ai`) reorganized to operate on PR scope via a dedicated temporary worktree / checkout (#661). Effects no longer depend on the orchestration step's `cwd`, so `prepare_merge` from `auto-improvement-loop` succeeds deterministically regardless of where the orchestration runs

### Fixed

- `team_leader + output_contracts.report` no longer aborts when the root step has no session (#655). `runReportPhase()` now accepts the team leader's aggregated `lastResponse` as a fallback and only fails when both root session and `lastResponse` are absent
- Builtin workflow `source` / `trust` is preserved during discovery loading inside the takt repo itself (#659). Stop-gap fix that prevented `auto-improvement-loop` and other builtin privileged workflows from being reclassified as project workflows when discovered from the takt repository root (root cause addressed in #660)
- `provider_options.copilot.effort` round-trip persistence fixed (#626). `denormalizeProviderOptions()` now writes back `copilot.effort` instead of silently dropping it on config save
- Removed the dependency on the `takt-managed` GitHub label for managed-PR identification. The hidden body marker `<!-- takt:managed -->` is now the single identifier

### Internal

- SDK dependencies bumped: `@anthropic-ai/claude-agent-sdk` ^0.2.71 -> ^0.2.119, `@openai/codex-sdk` ^0.114.0 -> ^0.125.0 (bundled `@openai/codex` binary 0.114.0 -> 0.125.0), `@opencode-ai/sdk` >=1.2.10 <1.3.0 -> ^1.14.24 (v2 export retained)
- E2E test added for the `claude` provider verifying that `provider_options.allowed_tools` propagates to `claude --allowed-tools` so `Bash(python3 -m pytest:*)` runs without approval prompts in real claude provider runs
- Test policy updated: line count thresholds are no longer treated as test failures in the review workflow

### Experimental

The following features are still being tuned. Behavior, schema, and naming may change in subsequent releases. Use only if you are willing to follow breaking changes.

- `auto-improvement-loop` builtin workflow (#653). An infinite-loop orchestration workflow that scans the repository on a schedule and routes work by priority (PR -> Issue -> fresh improvement -> wait -> route)
- `max_steps: infinite` (no step cap, no `exceeded` status). Currently used by `auto-improvement-loop`
- `pr_list` system input (open PRs filtered by `author` / `base_branch` / `head_branch` / `draft`)
- `issue_list` / `issue_selection` system inputs (#662). Repo-wide open Issue observation from orchestration workflows
- `task_queue_context.items` (queue contents observable from `when:`)
- `when:` array references with `exists(list, item.field == "X")` function. Initial scope: `==` and `&&` only
- `followup-task` builtin structured-output schema with `enqueue_new_task` / `comment_on_pr` / `enqueue_from_pr` / `prepare_merge` / `noop` actions

## [0.37.0] - 2026-04-20

### Added

- callable subworkflow に `params` / `returns` / `visibility: internal` を追加 (#635)。親 `workflow_call.args` から子 workflow に引数を渡し、子は `return` で論理結果を親に返せるようになった。param の対応型は `facet_ref` / `facet_ref[]`、`facet_kind` は `knowledge` / `policy` / `instruction` / `report_format`。子 workflow 内では `$param:` で facet field を差し替え可能。`visibility: internal` で内部用 subworkflow をワークフロー選択 UI から隠せる
- provider / model の解決ソースを log に表示 (#370)。`cli` / `persona_providers` / `step` / `project` / `global` / `default` のどの層で確定したかを debug または verbose 時にコンソール表示し、NDJSON `step_start` イベントの `providerSource` / `modelSource` フィールドには常時記録。期待と異なる provider / model が選ばれたときの原因特定が容易になる
- `provider_options.claude.effort` に `xhigh` を追加。Opus 4.7 のみサポートされる reasoning level（`high` と `max` の中間）。Claude Agent SDK を 0.2.114 へバンプ。モデル能力テーブルで早期検証し、`claude-opus-4-6` + `xhigh` のような非互換組み合わせは具体的なエラーメッセージで弾く。alias (`opus` / `sonnet` / `haiku`) と未知モデルは permissive に SDK 側へ委ねる
- `takt run` に `--ignore-exceed` オプションを追加 (#629)。指定時は workflow の `max_steps` 超過を無視して最後まで実行継続する。未指定時は従来通り `exceeded` 扱いで requeue される

### Changed

- **BREAKING:** 旧用語 `piece` / `movement` のレガシー環境変数サポートを完全に削除 (#637)。`TAKT_PIECE_*` / `TAKT_MOVEMENT_*` 形式の環境変数はマッピングされなくなる。`TAKT_WORKFLOW_*` / `TAKT_STEP_*` など新名称の環境変数への移行が必須

### Fixed

- Codex プロバイダーでタイムアウト（`abortCause === 'timeout'`）発生時に workflow が停止していた問題を修正 (#640)。タイムアウトをリトライ対象に追加し、最大 2 回までリトライする。外部からの明示的な中止（`abortCause === 'external'`）はリトライ不可のまま維持

## [0.36.0] - 2026-04-15

### Added

- サブワークフロー呼び出し（`call:` ステップ）を追加: ステップに `call: <workflow-name>` を指定すると、別のワークフローをサブルーチンとして実行可能。呼び出し先ワークフローは `subworkflow: { callable: true }` 宣言が必要。`overrides:` でプロバイダ/モデルの上書きも可能。再帰呼び出し検知・最大ネスト深度 5 (#153, #624)
- システムステップ（`kind: system`）を追加: AI エージェントを介さずに実行されるステップ。`system_inputs:` でランタイムコンテキスト（タスク、ブランチ、PR、Issue、タスクキュー）をワークフロー状態にバインドし、`effects:` で副作用（`enqueue_task`, `comment_pr`, `sync_with_root`, `resolve_conflicts_with_ai`, `merge_pr`）を実行 (#586, #622)
- 決定論的 `when:` ルール条件を追加: ルールに `condition:` の代わりに `when:` を指定すると、比較演算子（`==`, `!=`, `>`, `<`, `>=`, `<=`）やブール論理（`&&`, `||`）、ワークフロー状態参照（`context.*`, `structured.*`, `effect.*`）で AI を介さずルーティング (#586, #622)
- ステップの構造化出力（`structured_output:`）を追加: `structured_output: { schema_ref: "<name>" }` でワークフロー定義の `schemas:` マップ内の JSON スキーマを参照し、エージェント出力をバリデーション・保存。他ステップから `{structured:step.field}` で参照可能 (#586, #622)
- インタラクティブモードにスラッシュコマンド補完メニューを追加: `/` 入力時にインライン補完ドロップダウンを表示。矢印キーで選択、Tab で適用、Enter で確定。コンテキストに応じて `/retry` `/replay` の表示を制御 (#580)
- Copilot プロバイダに `effort`（推論の深さ）設定を追加: `provider_options.copilot.effort` で `low` / `medium` / `high` / `xhigh` を指定可能 (#625)
- `takt workflow init <name>` コマンドを追加: ワークフローのスキャフォールドを生成。`--template minimal|faceted`、`--steps <count>`、`--description <text>`、`--global` オプション対応 (#597)
- `takt workflow doctor [targets]` コマンドを追加: ワークフロー YAML の定義を検証。ターゲット未指定時は `.takt/workflows/` 内の全ワークフローを検証。ワークフロー名またはファイルパスを指定可能 (#597)
- 画面専用 API ポリシー（`screen-api`）を追加: 画面単位の専用エンドポイント、サーバー主導のページネーション、サーバーサイド集約、スコープ付きタブ通信を強制。全 dual 系ワークフローに適用
- AI アンチパターンポリシーに早期キャッシュ戦略の禁止ルールを追加: 明示的な要求や計測なしにキャッシュレイヤー・localStorage キャッシュ・過度な memoization を導入することを REJECT

### Changed

- **BREAKING:** 旧用語 `piece` / `movement` を完全に廃止し、`workflow` / `step` に統一 (#602, #609)。ワークフロー YAML の `piece_config:` → `workflow_config:`、`movements:` → `steps:`、`initial_movement:` → `initial_step:`、`max_movements:` → `max_steps:` への移行が必須。ディレクトリも `~/.takt/pieces/` → `~/.takt/workflows/`、`.takt/pieces/` → `.takt/workflows/` に変更。レガシー環境変数（`TAKT_PIECE_*`）は引き続きマッピングされる
- 非対応プロバイダ向けの provider-specific オプション（`claude.allowed_tools`、`mcp_servers`、`team_leader.part_allowed_tools`）をサイレントドロップするよう変更。ワークフローをプロバイダ非依存に保てるように改善
- 全レビュー系インストラクションのエビデンスガイダンスを統一: `reopened` ステータスの追加、検証ターゲット・確認内容・観測結果の記録を必須化、オープン指摘事項の脱落防止ルールを追加

### Fixed

- 全 audit 系ワークフロー（7 種）で supervise ↔ review 間のデッドロックを修正。review ステップに `output_contracts` を追加し、ループモニターの閾値を 4→3 に調整、ジャッジの選択肢を 3 択（十分/進捗あり/停滞）に変更

### Internal

- `piece*` → `workflow*` のファイル名一括リネーム（84 ファイル、テスト・E2E フィクスチャ・ドキュメント含む）
- `WorkflowEngine` をリファクタリング: `WorkflowEngineSetup`、`WorkflowEngineStepCoordinator`、`WorkflowRunLoop` に責務を分離
- セッションロガーを `sessionLoggerPhaseTracker.ts`、`sessionLoggerRecordFactory.ts` に分割
- `CapabilityAwareStructuredCaller` を追加し、プロバイダの構造化出力対応可否に応じたルーティングを実装
- ルール評価を 10 段階フォールバックに拡張（`when:` 条件の評価ステージを追加）
- `workflow-state-access.ts` でテンプレート参照（`{context:*}`、`{structured:*}`、`{effect:*}`）の統一解決を実装

## [0.35.4] - 2026-04-11

### Changed

- レビューポリシーにツール出力の信頼性検証ルールを追加: ツール出力が正常に読めることを確認してから指摘すること、検索失敗だけでコード不在と断定しないことをルール化

### Fixed

- ターミナルの行数が少ない環境で選択メニューが正常に動作しない問題を修正。ビューポートベースのスクロールを追加 (#608)
- Windows で `.cmd` shim の spawn が失敗する問題を修正（Claude Headless、Cursor、Copilot プロバイダ）

### Internal

- 選択メニューを `select-menu.ts`、`select-viewport.ts` に分離し、純粋関数化とビューポートテストを追加
- ワークフロードキュメントの例で古いフィールド名を使っていた問題を修正 (#619)

## [0.35.3] - 2026-04-10

### Added

- `loop_monitors` の judge に `provider`/`model` フィールドを追加。ジャッジムーブメントのプロバイダーとモデルを明示的に指定可能に (#599)
- `takt list --action sync` を非インタラクティブモードでサポート

### Changed

- Codex プロバイダーのリトライ戦略を強化: 最大リトライ回数を 3→9 に増加、ベース遅延を 250ms→1000ms に変更、"at capacity" エラーを自動リトライ対象に追加 (#614)

### Fixed

- ループモニタージャッジが常にデフォルトプロバイダーで実行される問題を修正。トリガー元ムーブメントのプロバイダー/モデル設定を継承するよう変更 (#599)
- 完了済みタスクのブランチ操作（merge/try-merge/diff）でルートブランチが欠落している場合にエラーとなる問題を修正。クローンから自動復元するよう改善 (#616)
- Phase 2 エラーイベント（`phase:complete`）が `phase:start` より先に発火されることがある問題を修正

### Internal

- テストを多数追加（codex-client-retry, engine-loop-monitors, it-completed-task-root-branch, it-piece-loader, provider-resolution, taskBranchLifecycleActions 等）
- `providerModelCompatibility` をコアモジュール（`src/core/piece/`）に移動
- タスク実行後のプッシュ処理を簡素化（clone 内フォールバック push を廃止し、ルートリポジトリ経由に一本化）
- git コマンドのエラーメッセージに stderr 詳細を含めるよう改善

## [0.35.2] - 2026-04-09

### Added

- `takt list` でスタックした実行中タスクを強制失敗にできる「Mark as failed」アクションを追加 (#604)
- タスクレコードに `run_slug` を追加し、実行中タスクの現在のステップ情報を `meta.json` から取得可能に

### Changed

- `write_tests` ムーブメントの出力契約を `test-scope.md` + `test-decisions.md` の2ファイルから `test-report.md` の1ファイルに簡素化

### Internal

- CI auto-tag ワークフローから冗長な build・test ステップを削除
- `RunMeta` 型を `src/core/piece/run/run-meta.ts` に抽出し、`currentStep`/`currentIteration` トラッキングを追加

## [0.35.1] - 2026-04-09

### Added

- タスク実行中に常時スピナーを表示: TTY 環境でタスク実行中にアニメーションスピナーを表示し、処理中であることを可視化
- Claude Headless の thinking ストリーム表示: ヘッドレスモードで thinking トークンをリアルタイム表示。parallel モードでは色分け表示に対応

### Changed

- SIGINT（Ctrl+C）でクローン作成中でも即座にプロセスを終了できるよう改善: `run`/`watch` コマンドで raw mode による即時検知を導入し、git サブプロセスを AbortSignal で中断可能に

### Fixed

- Codex プロバイダが Git リポジトリ外での実行を拒否する問題を修正

### Internal

- StatusLine の wrapWrite をアロー関数にリファクタリング
- StreamDisplay のハンドラーをムーブメントごとにキャッシュするよう最適化
- クローン作成関連のテスト追加・更新

## [0.35.0] - 2026-04-07

### Added

- Claude Headless プロバイダを追加: Claude CLI のヘッドレスモード（`claude --print`）をサブプロセスとして実行する新プロバイダ。`claude` プロバイダ名で利用可能 (#584)
- trace ログレベルを追加: `poll_tick`/`no_new_tasks` などの高頻度ログを抑制し、デバッグログの可読性を向上。`logging.trace: true` で有効化
- レガシー設定キーの非推奨警告: `piece_*`/`movement*` 系の旧キー使用時に deprecation warning を表示し、新しい `workflow_*`/`step*` キーへの移行を促進 (#581, #594)
- Mock プロバイダで `delayMs` と AbortSignal をサポート: SIGINT テスト等で利用可能に (#595)

### Changed

- **BREAKING:** `claude` プロバイダがヘッドレス CLI モードをデフォルトに変更。従来の SDK ベースプロバイダは `claude-sdk` として引き続き利用可能 (#584)
- クローン環境からのプッシュに relay push パターンを導入: 一時 ref 経由でプッシュすることで、チェックアウト中のブランチへの直接プッシュによるデータ損失を防止 (#592)
- PR 由来タスクのメタデータ伝搬を改善: `shouldPublishBranchToOrigin` フラグにより、ローカルプッシュ失敗時にクローンから直接 origin へプッシュするフォールバックを追加 (#592)
- dual/backend ワークフローの `max_steps` を 60 に増加

### Fixed

- `pr_body_template` が `--task` オプション実行時に無視される問題を修正 (#538)
- 既存 PR ブランチ更新時にリモートを正として worktree を作成するよう修正 (#557)
- SIGINT（Ctrl+C）が AI レスポンス待機中に正しくアボートされない問題を修正 (#595)
- mise 等のバージョン管理ツール環境下で Claude SDK サブプロセスの PATH が安定しない問題を修正 (#591)
- ジャッジムーブメントのプロバイダフォールバック解決が正しく機能しない問題を修正 (#577)
- exceeded 時のワークツリーパスが正しく解決されない問題を修正 (#575)
- PR 作成時のエラー詳細が失われる問題を修正
- non-fast-forward プッシュ拒否時にヒントメッセージを表示するよう改善

### Internal

- `.takt/config.yaml` の非推奨キーをリネーム
- レガシーワークフローキー非推奨警告の重複排除 (#594)
- `AgentSetup` から `claudeAgent`/`claudeSkill` フィールドを削除（Headless プロバイダ移行に伴い不要に）
- 型定義ファイルから冗長な JSDoc コメントを整理
- review-fix-takt-default ワークフローの max_steps を増加

## [0.34.0] - 2026-04-03

### Added

- StructuredCaller インターフェースを導入: プロバイダーのネイティブ構造化出力（Structured Output）をサポートし、ステータス判定・条件評価・タスク分解でテキストパースに代わる JSON ベースの応答抽出が可能に (#570)
- Traced Config を導入: `traced-config` パッケージによる設定値の出所追跡（環境変数・設定ファイル・デフォルト値）をサポート (#558)
- 並列ステップに `concurrency` フィールドを追加: セマフォベースの同時実行数制御が可能に
- 無効なワークフロー YAML のロード時に警告を表示するようになった（スキーマバリデーションエラーの詳細を表示） (#540)
- 計画・レビュー用ファセットを強化: planner・requirements-reviewer・supervisor のペルソナ、plan・requirements-review・supervisor-validation の出力契約、coding ポリシーを新規追加
- `takt add` コマンドで `--workflow` オプションによるワークフロー指定に対応

### Changed

- **BREAKING:** ワークフロー YAML のキーをリネーム: `movements` → `steps`、`initial_movement` → `initial_step`、`max_movements` → `max_steps`、`piece_config` → `workflow_config`。旧キーは互換エイリアスとして引き続き使用可能 (#576)
- **BREAKING:** ビルトインワークフローのディレクトリを `builtins/{lang}/pieces/` から `builtins/{lang}/workflows/` に移動。設定キーも `piece_categories` → `workflow_categories`、`enable_builtin_pieces` → `enable_builtin_workflows` にリネーム。旧キーは互換エイリアスとして引き続き使用可能 (#571, #561)
- **BREAKING:** CLI オプション `-w, --piece` を `-w, --workflow` にリネーム。`--piece` はレガシーエイリアスとして使用可能 (#576)
- **BREAKING:** ワークフロー YAML の `instruction_template` フィールドを削除。`instruction` フィールドを使用すること (#539)
- `takt-default` ワークフローの `max_steps` を 50 に増加（`default` は 30 のまま）
- 設定キーのエイリアス解決時に旧キーと新キーの両方が異なる値で存在する場合はエラーを発生させるよう変更

### Fixed

- Claude SDK のエラーペイロードが正しく処理されない問題を修正
- ワークフロー用語の統一: CLI ヘルプ、エラーメッセージ、ドキュメントを `workflow` / `step` 用語に更新
- ワークツリーモードで PR の Issue 解決がプロジェクト cwd から正しく行われるよう修正
- Cursor Agent のヘッドレスワークツリー実行で `--trust` フラグが渡されるよう修正
- ワークツリー環境下で `runtime.prepare` が設定されている場合にセルフホスト GitLab の `glab` CLI 認証が失敗する問題を修正 (#563)
- ピースプロバイダー解決の統一化

### Internal

- Zod スキーマを `schemas.ts` から `schema-base.ts`・`workflow-schemas.ts`・`config-schemas.ts` に分割
- 環境変数オーバーライドを spec ベースの宣言的定義にリファクタリング
- レガシーの `step_provider`・`step_model` フィールドを削除
- TeamLeader のパートタイムアウト処理を簡素化
- `yaml` パッケージを v2.8.3 に更新
- ドキュメント（README、CLI リファレンス、設定ガイド等）をワークフロー用語に全面更新

## [0.33.2] - 2026-03-26

### Added

- 読み取り専用の監査ピースを追加: `audit-architecture`, `audit-architecture-frontend`, `audit-architecture-backend`, `audit-architecture-dual`, `audit-e2e`, `audit-unit`。コードを変更せずにモジュール境界やカバレッジギャップを列挙し、Issue 作成可能なレポートを出力

### Changed

- `security-audit` ピースを `audit-security` にリネーム（監査ピース群の命名規則を統一）
- ビルトインピースカテゴリを再構成: 🧪 Testing カテゴリを廃止し、監査ピースを 🔍 Review カテゴリに統合
- `fill-unit`, `fill-e2e` ピースを削除（`audit-unit`, `audit-e2e` に置き換え）

### Fixed

- GitLab セルフホスト環境で worktree（共有クローン）実行時に MR 作成が失敗するバグを修正。Git プロバイダーの `cwd` がクローンパスに正しく伝播するよう変更 (#552)

### Internal

- Git プロバイダーの `cwd` 伝播に関するテストカバレッジを追加
- 設定ドキュメントから `verbose` オプションの記載を削除し、`logging.level` による設定方法に統一 (#543)

## [0.33.1] - 2026-03-24

### Changed

- ファイナルレビューとセキュリティレビューのガードレールを強化: supervisor のファセット、セキュリティナレッジ、レビューポリシー・インストラクションを拡充

### Fixed

- GitLab セルフホスト環境で `gitlab.com` の認証がない場合にタスク完了後の MR 作成が必ず失敗するバグを修正。`glab auth status` がリモートのホスト名を指定して認証チェックするよう変更 (#545)

### Internal

- GitLab プロバイダーのテストカバレッジを拡充（セルフホスト環境の認証チェック、ホスト名ベースの CLI ステータス検証）

## [0.33.0] - 2026-03-22

### Added

- GitLab VCS プロバイダーを追加: `glab` CLI を使った Issue 取得・マージリクエスト作成・レビューコメント取得に対応。git リモート URL からの自動検出をサポートし、`vcs_provider: gitlab` による明示的な設定も可能 (#512)
- インタラクティブモード用プロバイダー設定 (`takt_providers.assistant`) を追加: ピース実行とは独立したプロバイダー/モデルをインタラクティブモードに指定可能 (#483)

### Changed

- BREAKING: ピース YAML の MCP サーバー設定をデフォルト拒否に変更。使用するには `piece_mcp_servers` でトランスポート別に明示的に許可が必要 (#524)
- BREAKING: ピース YAML の Arpeggio カスタムコード（カスタムデータソース、インライン JS、外部マージファイル）をデフォルト拒否に変更。使用するには `piece_arpeggio` で明示的に許可が必要 (#521)
- BREAKING: ピース YAML の runtime prepare カスタムスクリプトをデフォルト拒否に変更（ビルトインプリセットは常に許可）。使用するには `piece_runtime_prepare.custom_scripts: true` が必要 (#520)
- BREAKING: sync conflict resolver の自動ツール承認をデフォルト拒否に変更。使用するには `sync_conflict_resolver.auto_approve_tools: true` が必要 (#522)
- team leader のタスク分解における最大ターン数を 4 → 5 に引き上げ (#511)
- supervisor ファセットを強化: 要件カバレッジのエビデンスベース検証を追加
- ペルソナファセットからクロスエージェント参照を除去し、ピース横断での再利用性を向上

### Fixed

- パイプラインモードで auto-commit の push 失敗時に PR 作成が無診断で失敗する問題を修正 (#532)
- `.takt/.gitignore` のファセットパスが実際のディレクトリ構造と不一致だった問題を修正 (#535)
- レビューピースの gather モードでブランチ検出が不正確だった問題を修正（完全一致を要求するよう変更） (#523)
- レビューピースで reject findings のフォーマットが正しく処理されない問題を修正 (#528)
- パイプラインモードでタスクブランチが PR 作成前に push されず、PR 作成が失敗する問題を修正

### Internal

- GitLab プロバイダーのテストカバレッジを追加（issue, pr, provider, utils）
- VCS プロバイダーの自動検出・ファクトリ・フォーマットのテストカバレッジを追加
- MCP サーバー・Arpeggio・runtime prepare・conflict resolver のデフォルト拒否に関するテストカバレッジを追加
- ピースローダーのテストカバレッジを大幅に拡充
- プロジェクト設定・グローバル設定のテストカバレッジを追加
- MCP サーバーヘルパー、ポリシー正規化、conflict resolver ヘルパーのリファクタリング
- ドキュメント更新（レビューピース名の修正、ビルトインカタログ更新）
- ビルド/lint/テスト品質ゲートの追加と E2E テスト環境の CLAUDECODE 環境変数分離
- テスト契約チェックのビルトインファセット強化（review-test, write-tests-first, testing-review）
- タスク auto-PR の E2E テストを追加

## [0.32.2] - 2026-03-17

### Added

- 到達経路（Reachability）ファセットを追加: 新しい画面・機能を追加する際に、ルーティング・メニュー・ボタン等のエントリーポイントを同時に整備することを計画・実装・レビューの各段階で検証
- 再取得ループ防止ファセットを追加: `useEffect` の依存配列に不安定な Context/Provider 関数参照を含めることで起きる無限ループを検出・防止するナレッジとポリシー
- UIライブラリ統合ファセットを追加: サードパーティ UI コンポーネント（データグリッド、日付ピッカー等）導入時のバージョン互換性・実マウント検証のナレッジとポリシー
- React ナレッジファセット (`react.md`) を新規追加: Effects の再実行制御、Context/Provider の値安定性に関する判断基準テーブル付き
- デザイン計画ポリシー (`design-planning.md`) を新規追加: デザインリファレンスが存在する場合の要素インベントリ・スコープ決定の基準
- フロントエンド専用プランフォーマット (`plan-frontend.md`) を新規追加: デザイン要素の Keep/Change 判定テーブルを含むプラン出力契約

### Changed

- フロントエンド系ピース（`frontend`, `frontend-mini`, `dual`, `dual-mini`, `dual-cqrs`, `dual-cqrs-mini`）の plan ムーブメントに `design-planning` ポリシーと `react` ナレッジを統合
- フロントエンド系ピースのプランフォーマットを `plan` から `plan-frontend` に変更
- `frontend` ピースの全ムーブメント（テスト、レビュー、修正等）に `react` ナレッジを追加

### Internal

- `@openai/codex-sdk` を 0.112.0 → 0.114.0 に更新
- team leader worker pool の E2E テストを安定化

## [0.32.1] - 2026-03-14

### Fixed

- `--pr` 経由のタスクで `autoPr` が無効になっていたため origin push がスキップされる問題を修正
- PR レビューコメントの取得が `gh pr view` の `reviews.comments` に依存していたため、インラインコメントを取りこぼす問題を修正。GitHub REST API によるページネーション取得に変更 (#489)
- config のパス指定で `~` チルダ展開が効かない問題を修正（`worktree_dir`、`*_cli_path`、`analytics.events_path` 等） (#496)
- auto-commit 時に git hooks/filter がそのまま実行され、TAKT 管理下のコミットが意図しない hooks の影響を受ける問題を修正。デフォルトで無効化し、`allow_git_hooks` / `allow_git_filters` で opt-in に変更 (#503)
- インタラクティブモードで初回入力時に不要な AI 呼び出しが発生していた問題を修正 (#504)
- Cursor provider でプロンプト文字列が CLI オプションとして解釈される可能性がある問題を修正（`--` セパレータを追加） (#500)
- snapshot ファイル名にムーブメント名がそのまま使われ、パストラバーサルが可能だった問題を修正 (#498)
- `provider_options` の優先順位で、環境変数・プロジェクト設定がムーブメント定義より低くなっていた問題を修正（セキュリティ設定がムーブメントで上書きされないよう変更） (#497)
- worktree パスの再利用時に、クローンベースディレクトリ外のパスが受け入れられる問題を修正 (#502)
- terraform ピースから不要な強制 full パーミッションを削除 (#507)

### Internal

- テスト系ピース・ファセットの全面整備（e2e-test → audit-e2e、unit-test → audit-unit にリネーム、ナレッジ・ポリシー追加）
- デザイン忠実度ポリシーの追加とフロントエンド系ピースへの統合
- audit-security ピースの追加
- ファセットデプロイメントのリファクタリング（templates ディレクトリの廃止、facets ディレクトリへの統合） (#505)
- `isPathInside` ユーティリティを追加し、クローン削除・worktree 再利用のパス検証を強化
- ループモニターの閾値調整とレビューポリシーの改善

## [0.32.0] - 2026-03-09

### Added

- `takt export-codex` コマンド: ピース/ファセットを Codex スキルとしてエクスポート (`~/.agents/skills/takt/`) (#475)
- `frontend` / `backend` / `backend-cqrs` ピースにテストファースト（`write_tests`）ムーブメントを追加し、レビューを2段階化（Stage 1: 構造・実装品質 → Stage 2: 安全性・品質保証）
- セキュリティナレッジにログ・マスキングセクションを追加（パスワード露出、`toString()` によるフィールド漏洩の検出基準）
- CQRS+ES ナレッジにマスタデータと CRUD の使い分けセクションを追加（6つの判断基準テーブル付き）
- `/ci` コメントで PR の CI を手動トリガーするワークフローを追加
- devcontainer で worktree クローン先の親ディレクトリが書き込み不可の場合に `.takt/worktrees/` へフォールバック
- インタラクティブモードのアシスタントが設計判断を勝手にしないようポリシーを追加

### Changed

- BREAKING: ピース YAML の `instruction_template` フィールドを非推奨化。`instruction` に統一（後方互換あり、deprecated 警告を表示） (#476)
- レビュー系ピースの命名規則を `review-{variant}` / `review-fix-{variant}` に統一
- タスク分解の REJECT 基準をナレッジからポリシーに分離
- faceted-prompting を npm パッケージ (`@anthropic-ai/faceted-prompting`) に移行し、内蔵コードを削除

### Fixed

- `takt run` の Slack 通知が当該 run で実行したタスクのみを送信するよう修正（従来は全タスクを通知していた）
- `ProviderPermissionProfilesSchema` に `copilot` が欠落していた問題を修正 (#487)
- PR fix フローで既存ブランチ存在時に `baseBranch` 検証をスキップするよう修正
- `review-fix-takt-default` の fix 後フローを `takt-default` と統一
- `write-tests-first` インストラクションからビルド検証手順を削除
- `cc-resolve` ワークフローに `actions: write` パーミッションを追加

### Internal

- SDK 依存パッケージを最新化
- `deploySkill` のコア処理を `deploySkillInternal` に抽出し、`deploySkillCodex` と共有
- clone ブランチ解決をリモートブランチ対応に拡張（`localBranchExists` / `remoteBranchExists` に分離）
- README の起動フローを整理し「タスクにつむ」を通常フローとして記載

## [0.31.0] - 2026-03-06

### Changed

- `dual` ピースを大幅強化: テストファースト（`write_tests`）ムーブメント追加、`implement` を team_leader 化（FE/BE 分割）、レビューを2段階化（`reviewers_1`: arch/frontend/testing → `reviewers_2`: security/qa/requirements）
- `takt-default-team-leader` ピースを `takt-default` に統合し削除。`takt-default` の `implement` を team_leader 化
- `quality_gates` のペルソナ単位オーバーライドをサポート: `piece_overrides.personas.<name>.qualityGates` で特定ペルソナのムーブメントに品質ゲートを追加可能に (#472)
- Status 型を `done` / `blocked` / `error` の3値に整理し、ステータスハンドリングを厳格化。`blocked` / `error` 時は即座に ABORT するよう変更 (#477)

### Fixed

- `git check-ref-format` コマンドから不要な `--` を削除し、ブランチ名の検証が正しく動作するよう修正 (#481)
- `log_level` → `logging.level` の設定キー不整合を修正（E2E テスト全滅の原因）
- Phase 3 ステータス判定が失敗した際に Phase 1 のルール評価にフォールバックするよう修正（従来はエラーで中断していた） (#474)
- Parallel ムーブメントの Phase 3 判定失敗時も同様にフォールバック対応 (#474)
- タスクリトライ・追加指示時のピース名取得元を `runInfo?.piece` から `task.data?.piece` に変更（worktree 内で `runInfo` が常に null になる問題を修正）

### Internal

- config 3層モデルの整理: `PersistedGlobalConfig` → `GlobalConfig` にリネーム、マイグレーション用フォールバック処理を削除、`persisted-global-config.ts` → `config-types.ts` にリネーム
- supervisor ペルソナからインラインの知識・ポリシーをファセットファイルに分離
- team leader の分解品質を改善するナレッジ（`task-decomposition.md`）とインストラクション（`dual-team-leader-implement.md`）を追加
- `~/.takt/config.yaml` テンプレートに不足していた設定項目を追加
- Provider Sandbox & Permission ガイドのドキュメントを拡充

## [0.30.0] - 2026-03-05

### Added

- トレースレポートの自動生成: piece 実行完了時に movement の遷移・フェーズ・ルール評価結果を Markdown レポートとして `.takt/runs/` に自動出力。`logging.trace: true` で全文モード、デフォルトは redacted モード (#467)
- 使用量イベントログ: プロバイダー呼び出しごとのトークン使用量を NDJSON 形式で記録。`logging.usage_events: true` で有効化 (#470)
- タスクリトライ時のピース再利用確認: `takt list` からリトライ・追加指示する際に、前回と同じピースを使うか選び直すかを選択可能に (#468)

### Changed

- BREAKING: `takt switch` コマンドを削除。ピース選択はインタラクティブモード起動時（`takt`）に毎回行う方式に変更 (#465)
- Claude プロバイダーの `allowed_tools` をビルトインピースの YAML 定義からエグゼキューター側に移動し、ピース YAML の簡素化と保守性を向上 (#469)
- 設定構造をリファクタリング: `globalConfig.ts` を `globalConfigCore.ts`・`globalConfigAccessors.ts`・`globalConfigResolvers.ts`・`globalConfigSerializer.ts` に分割。プロジェクトローカル設定（`.takt/config.yaml`）のフォールバック優先度を明確化 (#460)
- observability モジュールを `core/logging/` に再編成: `providerEventLogger` と `usageEventLogger` を統一的なログ基盤として整理 (#466)
- レビュアー全体に `coder-decisions.md` の参照を追加し、コーダーの設計判断を考慮したレビューで誤検知を抑制
- レビュー↔修正ループの収束を支援: レポート履歴の参照、ループモニター、修正方針のガイドラインを整備

### Fixed

- runtime 環境の `XDG_CONFIG_HOME` 上書きで `gh` CLI の認証が失敗する問題を修正。`GH_CONFIG_DIR` を元の設定から保持するよう変更
- `.takt/config.yaml` に `runtime.prepare` を記述するとエラーになる問題を修正（プロジェクトレベルでの runtime 設定を許可） (#464)
- インタラクティブモードで iteration limit 到達時にプロンプトが表示されず、exceeded 状態が保持されない問題を修正
- PR 作成失敗時のタスクステータスを `failed` から `pr_failed` に分離し、実行成功だが PR 作成のみ失敗したケースを区別可能に
- リトライ時にタスクにピース情報が引き継がれるよう修正
- `.gitignore` の `.takt/` ディレクトリ ignore を削除し `.takt/.gitignore` に委譲（プロジェクト設定ファイルの追跡を可能に）
- CI: push トリガーから `takt/**` を削除し二重実行を防止
- `cc-resolve` ワークフローで push 後に CI を自動トリガーするよう修正

### Internal

- deprecated config マイグレーション処理を削除
- プロジェクトローカル設定の優先度に関する統合テストを追加
- テストヘルパーとテストセットアップの改善

## [0.29.0] - 2026-03-04

### Added

- レビュー＋修正ループピース群を追加: `review-fix`（多角レビュー）、`frontend-review-fix`、`backend-review-fix`、`dual-review-fix`、`dual-cqrs-review-fix`、`backend-cqrs-review-fix` および対応するレビュー専用ピース群を追加。コードレビューと自動修正を反復するワークフロー
- `takt-default-review-fix` ピースを追加: TAKT 自己開発向けのレビュー＋修正ループワークフロー
- `quality_gates` のグローバル/プロジェクトレベルオーバーライドをサポート: `~/.takt/config.yaml` および `.takt/config.yaml` の `piece_overrides.quality_gates` でビルトインピースの品質ゲートを上書き可能に (#384)
- タスクの `base_branch` 設定: `takt add` 時に現在のブランチを base_branch として記録し、タスク実行時にそのブランチから分岐するよう設定可能に (#455)
- プロバイダー設定の統一: `.takt/config.yaml` で `provider` ブロックに `type`/`model`/プロバイダー固有オプション（`network_access` 等）をまとめて記述可能に (#457)
- ワーカープール超過時のリキュー: タスク実行がワーカー上限を超えた場合、タスクを自動的に再キューイングするよう対応 (#366)
- `--pr` インタラクティブモードで `create_issue` アクションを除外し、`save_task` 時に PR のブランチ名を `base_branch` として自動設定
- team_leader の `decomposeTask`/`requestMoreParts`/Phase 3 ステータス判定のプロバイダーイベントをロギング: `provider-events.jsonl` に記録されるようになり、デバッグ・分析が可能に

### Fixed

- `export-cc` で `facets/` のサブディレクトリ構造（`personas/`、`policies/` 等）が出力先に再現されなかった問題を修正 (#8dcb23b)
- `cc-resolve` コマンドがコンフリクト解決後にマージコミットを生成するよう修正 (#1b1f758)
- グローバル設定 (`~/.takt/config.yaml`) の `piece` フィールドがピース解決チェーンで無視されるバグを修正 (#458)
- Codex プロバイダーでプロバイダー優先のパーミッションモード解決が機能しない問題と EPERM エラーの E2E テストを追加 (#d2b48fd)
- レビューコメントがない PR で `--pr` を使用した際にエラーになる問題を修正
- `--auto-pr`/`--draft` オプションをパイプラインモード専用に制限（インタラクティブモードでの誤用を防止）
- team_leader のストリーミングでバウンダリの先行フラッシュによる断片化を修正 (#769bd87, #bddb66f)
- team_leader のエラーメッセージが空文字列になるバグを修正 (#52968ac)
- `decomposeTask`/`requestMoreParts` の `maxTurns` を 2 から 4 に増加（複雑なタスク分解でタイムアウトしていた問題を緩和）
- Copilot プロバイダーのクライアント実装のバグを修正 (#434)

### Internal

- E2E プロバイダー別テストをコンフィグレベル（`vitest.config.e2e.provider.ts`）で振り分けるよう変更。テストファイル内の `skip` ロジックを廃止し、JSON レポート出力を追加
- 共有ノーマライザを `configNormalizers.ts` に抽出してプロバイダー設定解析を整理
- `agent-usecases`/`schema-loader` を移動し `pieceExecution` の責務を分割
- `check:release` で全プロバイダー（claude/codex/opencode）の E2E を実行するよう変更
- CI: PR と push の重複実行を concurrency グループで抑制
- CI: feature ブランチへの push と手動実行に対応

## [0.28.1] - 2026-03-02

### Changed

- BREAKING: `expert` / `expert-mini` / `expert-cqrs` / `expert-cqrs-mini` ピースを `dual` / `dual-mini` / `dual-cqrs` / `dual-cqrs-mini` にリネーム。カスタマイズしている場合はピース名の更新が必要
- `default-mini` / `default-test-first-mini` ピースを `default` に統合。`default` ピースが「テスト優先モード」を内包するよう拡張
- `coding-pitfalls` ナレッジの主要項目を `coding` ポリシーに移動し、ポリシーとして実際に適用されるよう強化
- `implement` / `plan` インストラクションにセルフチェック・コーダー指針を追加

### Removed

- `passthrough` ピースを削除
- `structural-reform` ピースを削除

### Internal

- `expert-supervisor` ペルソナを `dual-supervisor` にリネーム
- ビルトインカタログに不足していた `terraform`、`takt-default` 系、`deep-research` を追加
- カテゴリ設定に `deep-research` を追加
- 全ドキュメントに `copilot` プロバイダーの説明を追加し、Claude Code 寄りの記述をプロバイダー中立に修正

## [0.28.0] - 2026-03-02

### Added

- GitHub Copilot CLI プロバイダーを追加: `copilot` プロバイダーとして GitHub Copilot CLI を利用可能に。セッション継続、パーミッション制御（readonly/edit/full）に対応。`copilotCliPath` / `TAKT_COPILOT_CLI_PATH` で CLI パスを指定、`copilotGithubToken` / `TAKT_COPILOT_GITHUB_TOKEN` で認証トークンを設定 (#425)
- `--pr` オプションを追加: PR のレビューコメントを取得してタスクとして実行。パイプラインモードとインタラクティブモードの両方で利用可能 (#421)
- `takt add --pr N` で PR のレビューコメントをタスクとして追加可能に。PR のブランチ名で worktree を自動作成し、レビュー指摘の修正タスクとしてキューイング (#426)
- `takt list` に「Pull from remote」アクションを追加: リモートの変更を worktree に取り込み、再プッシュ可能に (#395)
- プロジェクト単位の CLI パス設定: `.takt/config.yaml` で `claudeCliPath` / `cursorCliPath` / `codexCliPath` / `copilotCliPath` をプロジェクトごとに設定可能に (#413)
- インタラクティブモードのスラッシュコマンドを行末でも認識可能に（例: `タスクの内容 /go`）(#406)
- takt-default / takt-default-team-leader ビルトインピースを追加（TAKT 自己開発用のワークフロー定義）
- TAKT ナレッジファセット（`takt.md`）を追加: TAKT のアーキテクチャとコード規約を体系化
- ai-antipattern ポリシーに冗長な条件分岐パターン検出を追加: 同一関数を if/else で呼び分けるコードを検出し、三項演算子やスプレッド構文での統一を促す

### Fixed

- 不正な `tasks.yaml` を検出した場合、ファイルを削除せず保持してエラーメッセージで停止するよう修正 (#418)
- shallow clone リポジトリで worktree 作成が失敗する問題を修正: `--reference` 付きクローンが失敗した場合に通常クローンへフォールバック (#376, #409)
- グローバル/プロジェクト設定の `model` がモデルログに反映されない不具合を修正 (#417)
- fork PR レビュー時に `GH_REPO` を設定して正しいリポジトリの issue を参照するよう修正
- takt-review ワークフローの PR コメント投稿ステップにも `GH_REPO` を設定

### Internal

- `resolveConfigValue` の不要な `defaultValue` 引数を削除し、設定解決ロジックを簡素化 (#391)
- PRコメント `/resolve` でコンフリクト解決・レビュー指摘修正を行う GitHub Actions ワークフロー（cc-resolve）を追加
- takt-review ワークフローを `pull_request_target` に変更し、fork PR でもシークレットを利用可能に
- CI に `ready_for_review` / `reopened` トリガーを追加
- CONTRIBUTING にレビューモードの例を追加、日本語版（`CONTRIBUTING.ja.md`）を追加

## [0.28.0-alpha.1] - 2026-02-28

### Added

- GitHub Copilot CLI プロバイダーを追加: `copilot` プロバイダーとして GitHub Copilot CLI を利用可能に。セッション継続、パーミッション制御（readonly/edit/full）に対応。`copilotCliPath` / `TAKT_COPILOT_CLI_PATH` で CLI パスを指定、`copilotGithubToken` / `TAKT_COPILOT_GITHUB_TOKEN` で認証トークンを設定 (#425)
- `--pr` オプションを追加: PR のレビューコメントを取得してタスクとして実行。パイプラインモードとインタラクティブモードの両方で利用可能 (#421)
- `takt add --pr N` で PR のレビューコメントをタスクとして追加可能に。PR のブランチ名で worktree を自動作成し、レビュー指摘の修正タスクとしてキューイング (#426)
- `takt list` に「Pull from remote」アクションを追加: リモートの変更を worktree に取り込み、再プッシュ可能に (#395)
- プロジェクト単位の CLI パス設定: `.takt/config.yaml` で `claudeCliPath` / `cursorCliPath` / `codexCliPath` / `copilotCliPath` をプロジェクトごとに設定可能に (#413)
- インタラクティブモードのスラッシュコマンドを行末でも認識可能に（例: `タスクの内容 /go`）(#406)
- takt-default / takt-default-team-leader ビルトインピースを追加（TAKT 自己開発用のワークフロー定義）
- TAKT ナレッジファセット（`takt.md`）を追加: TAKT のアーキテクチャとコード規約を体系化
- ai-antipattern ポリシーに冗長な条件分岐パターン検出を追加: 同一関数を if/else で呼び分けるコードを検出し、三項演算子やスプレッド構文での統一を促す

### Fixed

- 不正な `tasks.yaml` を検出した場合、ファイルを削除せず保持してエラーメッセージで停止するよう修正 (#418)
- shallow clone リポジトリで worktree 作成が失敗する問題を修正: `--reference` 付きクローンが失敗した場合に通常クローンへフォールバック (#376, #409)
- グローバル/プロジェクト設定の `model` がモデルログに反映されない不具合を修正 (#417)
- fork PR レビュー時に `GH_REPO` を設定して正しいリポジトリの issue を参照するよう修正
- takt-review ワークフローの PR コメント投稿ステップにも `GH_REPO` を設定

### Internal

- `resolveConfigValue` の不要な `defaultValue` 引数を削除し、設定解決ロジックを簡素化 (#391)
- PRコメント `/resolve` でコンフリクト解決・レビュー指摘修正を行う GitHub Actions ワークフロー（cc-resolve）を追加
- takt-review ワークフローを `pull_request_target` に変更し、fork PR でもシークレットを利用可能に
- CI に `ready_for_review` / `reopened` トリガーを追加
- CONTRIBUTING にレビューモードの例を追加、日本語版（`CONTRIBUTING.ja.md`）を追加

## [0.27.0] - 2026-02-28

### Added

- Cursor Agent CLI プロバイダーを追加: `cursor-agent` CLI を介して Cursor を AI プロバイダーとして利用可能に。API キー（`TAKT_CURSOR_API_KEY` / `cursor_api_key`）または `cursor-agent login` セッションで認証、JSON 出力解析、セッション継続（`--resume`）、モデル指定（`--model`）、パーミッション制御（`full` → `--force`）に対応 (#403)
- Cursor プロバイダーの E2E テスト設定を追加（`vitest.config.e2e.cursor.ts`、`npm run test:e2e:cursor`）

### Fixed

- Phase 1 が error または blocked を返した場合に Phase 2（レポート出力）をスキップするよう修正。Phase 1 失敗時に不要なレポート生成が実行される問題を解消
- Codex 互換性のため、runtime prepare で Gradle デーモンを無効化するよう修正

### Internal

- エージェント/カスタムペルソナのドキュメントを整合

## [0.26.0] - 2026-02-27

### Added

- TeamLeader に refill threshold と動的パート追加を導入: 実行中のパートが `refill_threshold` 以下になると、リーダーが完了済みパートの結果を評価して追加パートを動的に生成。`max_parts` は同時並行数、`refill_threshold` で追加計画のタイミングを制御（最大合計 20 パートまで）
- deep-research ピースの dig ムーブメントに `team_leader` 設定を追加し、リサーチの並列実行が可能に
- TeamLeader が Phase 2（レポート出力）/ Phase 3（ステータス判定）を通常ムーブメントと同様にサポート（`applyPostExecutionPhases` の共通化）
- ParallelLogger が動的なサブムーブメント追加に対応（`addSubMovement`）し、TeamLeader の動的パート追加時にもストリーミング出力を表示
- `LineTimeSliceBuffer` を導入し、並列ストリーミング出力のバッファリングを時間スライスベースで最適化
- プロジェクト設定（`.takt/config.yaml`）で `model` 指定をサポート

### Changed

- BREAKING: カスタムエージェント定義（`~/.takt/personas/*.md`）の `provider` / `model` を解釈しない方針とし、エージェントのプロバイダー・モデルはピース側の解決ロジック（CLI → persona_providers → ステップ → ローカル → グローバル）に統一 (#390)
- エージェントの provider/model 解決ロジックを `resolveAgentProviderModel` に一元化し、ムーブメント解決と同じ優先順位チェーンを使用するよう変更 (#386)
- `movement:start` イベントが `providerInfo` を含むよう変更し、表示側でのプロバイダー再解決を不要に (#390)
- `takt list` の「Sync with root」を「Merge from root」にリネーム (#394)
- インタラクティブモードの要約 AI がセッション非継承で実行されるよう修正し、会話コンテキストの汚染を防止 (#368)
- interactive policy のガイドラインを改善: ユーザーが「自分で調べて」と指示した場合と、ピースへの指示作成を区別するルールを明確化

### Fixed

- default / default-test-first-mini ピースの `write_tests` ムーブメントで、テスト対象が未実装の場合にスキップして implement へ進むルールを追加（従来は ABORT になっていた）(#396)
- `takt add` の GitHub Issue タイトル抽出を改善: Markdown 見出し（h1-h3）を優先的にタイトルとして使用するよう変更（従来は先頭行がそのまま使われていた）(#368)
- quiet モードの要約 AI がセッションを引き継がない問題を修正 (#368)
- `repertoire add` の `gh api` 呼び出しにバッファサイズ上限（100MB）を設定し、大きなリポジトリでのバッファオーバーフローを防止
- E2E テストで `gh` ユーザー検索が無効な場合にローカルリポジトリへフォールバックするよう修正

### Internal

- TeamLeaderRunner をリファクタリング: 実行ロジック（`team-leader-execution.ts`）、集約（`team-leader-aggregation.ts`）、共通ユーティリティ（`team-leader-common.ts`）、ストリーミング（`team-leader-streaming.ts`）に分離
- `more-parts.json` スキーマと `loadMorePartsSchema` ローダーを追加
- AGENTS.md を更新（プロジェクト構成とガイドラインの改訂）
- テスト拡充: provider/model 解決マトリクス、TeamLeader refill threshold / worker pool / aggregation / execution、OptionsBuilder、stream-buffer、conversationLoop resume、quietMode session、createIssueFromTask、schema-loader

## [0.25.0] - 2026-02-26

### Added

- Terraform/AWS ピース: IaC 開発用の完全なピースとファセット一式を追加。plan → implement → 並列3レビュー（architect/QA/security）→ supervise → complete の15ムーブメント構成（EN/JA）
- GitProvider 抽象化: Git/GitHub 操作を `GitProvider` インターフェースに統一し、将来の複数 Git プロバイダー対応の基盤を構築 (#375)
- プロジェクト設定で submodule の自動取得をサポート: `submodules: all` または `submodules: [path1, path2]` で指定可能に (#387)
- `takt add` で GitHub Issue 作成時にラベルをインタラクティブに選択可能に (#377, #111)
- deep-research ピースにデータ保存・レポート出力機能を追加（dig/analyze ムーブメントに Write・Bash ツール許可、supervise に research-report 出力契約）
- GitHub Discussions・Discord・X への一斉アナウンス GitHub Actions ワークフローを追加

### Changed

- default ピースをテスト先行開発構成に変更: plan の後に `write_tests` ムーブメントを追加し、テストを先に書いてから実装する流れに。並列レビューに testing-review を追加（3→4 レビュアー）。レポートファイル名をセマンティック命名に統一（`00-plan.md` → `plan.md` 等）
- sync with root をピースエンジン経由からプロバイダー抽象化を利用した単発エージェント呼び出しに簡素化。コンフリクト解決プロンプトをテンプレートファイル化（EN/JA 分離）

### Fixed

- lineEditor でサロゲートペア（絵文字等）のカーソル位置がずれる問題を修正。Ctrl+J による改行挿入を追加
- `--task` オプションでの直接実行時に tasks.yaml へ不要な記録がされる問題を修正
- `--task` でワークツリー作成時は tasks.yaml に記録するよう修正（`takt list` でのブランチ管理に必要）
- Provider resolution: removed implicit fallback to `claude` and switched to fail-fast when provider cannot be resolved (#386)
- Provider resolution: unified display and execution provider/model resolution via `movement:start` event providerInfo, ensuring displayed provider always matches execution provider (#390)
- E2E テスト config-priority の不安定性を修正 (#388)

### Internal

- GitProvider 抽象化に伴うテスト追加（github-provider, taskGit）と既存テストのインポート更新
- CLAUDE.md 更新

## [0.24.0] - 2026-02-24

### Added

- AskUserQuestion support: AI agents can now ask interactive questions during execution with single-select, multi-select, and free-text input via TTY UI; automatically denied during piece execution to maintain agent autonomy (#161, #369)
- `review` builtin piece with 3-mode auto-detection: automatically selects PR mode (by PR number), branch mode (by branch name), or working diff mode (by free text) for multi-perspective parallel review
- `testing-reviewer` and `requirements-reviewer` builtin personas for specialized review perspectives
- `testing` policy: integration test requirement criteria (3+ module data flow, state merging into workflows, option propagation through call chains)
- `gather-review` instruction and `review-gather` output contract for the new review piece gather movement
- `requirements-review` instruction and output contract for requirements-focused review
- `testing-review` output contract for testing-focused review
- `settingSources: ['project']` in SDK options: delegates CLAUDE.md loading to the Claude SDK for proper project-level settings resolution

### Changed

- **BREAKING:** `review-only` piece renamed to `review`; `review-fix-minimal` piece removed — users referencing these piece names must update to `review`
- `write-tests-first` instruction now includes integration test decision criteria instead of a generic "Write E2E tests if appropriate"

### Fixed

- Planner persona: added bug fix propagation check rule (grep for same pattern in related files) and prohibited deferring decidable questions to Open Questions

### Internal

- Docs: fixed music metaphor origin description, catalog gaps, broken links, orphaned documents, event names, API Key references, eject descriptions, removed stale personas section map from YAML example, aligned legacy terminology with current codebase
- New test suites: `StreamDisplay`, `ask-user-question-handler`, `pieceExecution-ask-user-question`, `review-piece`, `opencode-client-cleanup`
- Removed legacy `review-only-piece` test and `loadProjectContext` from session module (CLAUDE.md loading now delegated to SDK)

## [0.23.0] - 2026-02-23

### Added

- `default-test-first-mini` builtin piece for test-first development workflow
- `auto_fetch` global config: opt-in remote fetch before cloning to keep clones up-to-date (`default: false`)
- `base_branch` config (global/project): specify the base branch for clone creation (defaults to remote default branch)
- `model` project config: override model at the project level (`.takt/config.yaml`)
- `concurrency` project config: set parallel task count per project for `takt run`
- `--create-worktree` support in pipeline mode for worktree-based execution
- `skipTaskList` option: interactive "Execute" action skips adding to `tasks.yaml`
- `takt list` now displays GitHub Issue numbers alongside task names
- Retry failed tasks now offers to reuse the previous piece before prompting piece selection
- Pipeline mode Slack notifications: sends run summary with task details, duration, branch, and PR URL
- CI workflow: lint, test, and e2e:mock checks run automatically on PRs (#364)

### Changed

- Provider/model resolution unified via `resolveProviderModelCandidates()` — single resolution function used in both `AgentRunner` and `resolveMovementProviderModel`
- Pipeline execution refactored into thin orchestrator (`execute.ts`) + step implementations (`steps.ts`)
- Clone directory default changed from `takt-worktree` (singular) to `takt-worktrees` (plural) with auto-migration of legacy directory
- PR titles now include issue number prefix (e.g., `[#6] Fix the bug`)
- Task status now reflects PR creation failure — previously only piece execution success was tracked
- `auto-tag.yml` tags PR head SHA instead of merge commit for correct hotfix code publishing
- Session reader falls back to JSONL file scanning when `sessions-index.json` is missing or invalid
- `ProjectLocalConfig` type normalized to camelCase (`auto_pr`→`autoPr`, `draft_pr`→`draftPr`) — YAML snake_case preserved
- `getLocalLayerValue` simplified from switch-case to dynamic property lookup

### Fixed

- `repertoire add` pipe stdin: multiple `confirm()` calls failed when reading from piped stdin due to readline destroying buffered lines (#334)
- Movement provider override precedence in `AgentRunner`: step provider was incorrectly overridden by global config
- Project-level `model` config was silently ignored — `getLocalLayerValue` was missing the `model` case
- PR creation failure now properly propagated as task failure with error message (#345)
- Claude session resume candidates now fall back to JSONL file scanning when `sessions-index.json` is unavailable

### Internal

- CI: PR checks for lint, test, e2e:mock (`ci.yml`)
- Expanded e2e test coverage for repertoire (#364)
- New test suites: clone, config, postExecution, session-reader, selectAndExecute-skipTaskList, taskStatusLabel, pipelineExecution
- Refactored: project config case normalization (#358), clone manager (#359), pipeline steps extraction, confirm pipe reader singleton, provider resolution (#362)

## [0.22.0] - 2026-02-22

### Added

- **Repertoire package system** (`takt repertoire add/remove/list`): Import and manage external TAKT packages from GitHub — `takt repertoire add github:{owner}/{repo}@{ref}` downloads packages to `~/.takt/repertoire/` with atomic installation, version compatibility checks, lock files, and package content summary before confirmation
- **@scope references in piece YAML**: Facet references now support `@{owner}/{repo}/{facet-name}` syntax to reference facets from installed repertoire packages (e.g., `persona: @nrslib/takt-fullstack/expert-coder`)
- **4-layer facet resolution**: Upgraded from 3-layer (project → user → builtin) to 4-layer (package-local → project → user → builtin) — repertoire package pieces automatically resolve their own facets first
- **Repertoire category in piece selection**: Installed repertoire packages automatically appear as subcategories under a "repertoire" category in the piece selection UI
- **Build gate in implement/fix instructions**: `implement` and `fix` builtin instructions now require build (type check) verification before test execution
- **Repertoire package documentation**: Added comprehensive docs for the repertoire package system ([en](./docs/repertoire.md), [ja](./docs/repertoire.ja.md))

### Changed

- **BREAKING: Facets directory restructured**: Facet directories moved under a `facets/` subdirectory at all levels — `builtins/{lang}/{facetType}/` → `builtins/{lang}/facets/{facetType}/`, `~/.takt/{facetType}/` → `~/.takt/facets/{facetType}/`, `.takt/{facetType}/` → `.takt/facets/{facetType}/`. Migration: move your custom facet files into the new `facets/` subdirectory
- Contract string hardcoding prevention rule added to coding policy and architecture review instruction

### Fixed

- Override piece validation now includes repertoire scope via the resolver
- `takt export-cc` now reads facets from the new `builtins/{lang}/facets/` directory structure
- `confirm()` prompt now supports piped stdin (e.g., `echo "y" | takt repertoire add ...`)
- Suppressed `poll_tick` debug log flooding during iteration input wait
- Piece resolver `stat()` calls now catch errors gracefully instead of crashing on inaccessible entries

### Internal

- Comprehensive repertoire test suite: atomic-update, repertoire-paths, file-filter, github-ref-resolver, github-spec, list, lock-file, pack-summary, package-facet-resolution, remove-reference-check, remove, takt-repertoire-config, tar-parser, takt-repertoire-schema
- Added `src/faceted-prompting/scope.ts` for @scope reference parsing, validation, and resolution
- Added scope-ref tests for the faceted-prompting module
- Added `inputWait.ts` for shared input-wait state to suppress worker pool log noise
- Added piece-selection-branches and repertoire e2e tests

## [0.21.0] - 2026-02-20

### Added

- **Slack task notification enhancements**: Extended Slack webhook notifications with richer task context and formatting (#316)
- **`takt list --delete-all` option**: Delete all tasks at once from the task list (#322)
- **`--draft-pr` option**: Create pull requests as drafts via `--draft-pr` flag (#323)
- **`--sync-with-root` option**: Sync worktree branch with root repository changes (#325)
- **Model per persona-provider**: Allow specifying model overrides at the persona-provider level (#324)
- **Analytics project config and env override**: Analytics settings can now be configured per-project and overridden via environment variables
- **CI dependency health check**: Periodic CI check to detect broken dependency packages

### Changed

- **Config system overhaul**: Replaced `loadConfig()` bulk merge with per-key `resolveConfigValue()` resolution — global < piece < project < env priority with source tracking and `OptionsBuilder` merge direction control (#324)

### Fixed

- **Retry command scope and messaging**: Fixed retry command to show correct available range and guidance text
- **Retry task `completed_at` leak**: Clear `completed_at` when moving a failed task back to running via `startReExecution`, preventing Zod validation errors
- **OpenCode multi-turn hang**: Removed `streamAbortController.signal` from OpenCode server startup so subsequent turns no longer hang; restored `sessionId` carry-over for multi-turn conversations
- **Romaji conversion stack overflow**: Prevented stack overflow on long task names during romaji conversion

## [0.20.1] - 2026-02-20

### Fixed

- Pin `@opencode-ai/sdk` to `<1.2.7` to fix broken v2 exports that caused `Cannot find module` errors on `npm install -g takt` (#329)

## [0.20.0] - 2026-02-19

### Added

- **Faceted Prompting module** (`src/faceted-prompting/`): Standalone library for facet composition, resolution, template rendering, and truncation — zero dependencies on TAKT internals. Includes `DataEngine` interface with `FileDataEngine` and `CompositeDataEngine` implementations for pluggable facet storage
- **Analytics module** (`src/features/analytics/`): Local-only review quality metrics collection — event types (review findings, fix actions, movement results), JSONL writer with date-based rotation, report parser, and metrics computation
- **`takt metrics review` command**: Display review quality metrics (re-report counts, round-trip ratio, resolution iterations, REJECT counts by rule, rebuttal resolution ratio) with configurable time window (`--since`)
- **`takt purge` command**: Purge old analytics event files with configurable retention period (`--retention-days`)
- **`takt reset config` command**: Reset global config to builtin template with automatic backup of the existing config
- **PR duplicate prevention**: When a PR already exists for the current branch, push and comment on the existing PR instead of creating a duplicate (#304)
- Retry mode now positions the cursor on the failed movement when selecting which movement to retry
- E2E tests for run-recovery and config-priority scenarios

### Changed

- **README overhaul**: Compressed from ~950 lines to ~270 lines — details split into dedicated docs (`docs/configuration.md`, `docs/cli-reference.md`, `docs/task-management.md`, `docs/ci-cd.md`, `docs/builtin-catalog.md`) with Japanese equivalents. Redefined product concept around 4 value axes: batteries included, practical, reproducible, multi-agent
- **Config system refactored**: Unified configuration resolution to `resolveConfigValue()` and `loadConfig()`, eliminating scattered config access patterns across the codebase
- **`takt config` command removed**: Replaced by `takt reset config` for resetting to defaults
- Builtin config templates refreshed with updated comments and structure
- `@anthropic-ai/claude-agent-sdk` updated to v0.2.47
- Instruct mode prompt improvements for task re-instruction

### Fixed

- Fixed issue where builtin piece file references used absolute path instead of relative (#304)
- Removed unused imports and variables across multiple files

### Internal

- Unified `loadConfig`, `resolveConfigValue`, piece config resolution, and config priority paths
- Added E2E tests for config priority and run recovery scenarios
- Added `postExecution.test.ts` for PR creation flow testing
- Cleaned up unused imports and variables

## [0.19.0] - 2026-02-18

### Added

- Dedicated retry mode for failed tasks — conversation loop with failure context (error details, failed movement, last message), run session data, and piece structure injected into the system prompt
- Dedicated instruct system prompt for completed/failed task re-instruction — injects task name, content, branch changes, and retry notes directly into the prompt instead of using the generic interactive prompt
- Direct re-execution from `takt list` — "execute" action now runs the task immediately in the existing worktree instead of only requeuing to pending
- `startReExecution` atomic task transition — moves a completed/failed task directly to running status, avoiding the requeue → claim race condition
- Worktree reuse in task execution — reuses existing clone directory when it's still on disk, skipping branch name generation and clone creation
- Task history injection into interactive and summary system prompts — completed/failed/interrupted task summaries are included for context
- Previous run reference support in interactive and instruct system prompts — users can reference logs and reports from prior runs
- `findRunForTask` and `getRunPaths` helpers for automatic run session lookup by task content
- `isStaleRunningTask` process helper extracted from TaskLifecycleService for reuse

### Changed

- Interactive module split: `interactive.ts` refactored into `interactive-summary.ts`, `runSelector.ts`, `runSessionReader.ts`, and `selectorUtils.ts` for better cohesion
- `requeueTask` now accepts generic `allowedStatuses` parameter instead of only accepting `failed` tasks
- Instruct/retry actions in `takt list` use the worktree path for conversation and run data lookup instead of the project root
- `save_task` action now requeues the task (saves for later execution), while `execute` action runs immediately

### Internal

- Removed `DebugConfig` from models, schemas, and global config — simplified to verbose mode only
- Added stdin simulation test helpers (`stdinSimulator.ts`) for E2E conversation loop testing
- Added comprehensive E2E tests for retry mode, interactive routes, and run session injection
- Added `check:release` npm script for pre-release validation

## [0.18.2] - 2026-02-18

### Added

- Added `codex_cli_path` global config option and `TAKT_CODEX_CLI_PATH` environment variable to override the Codex CLI binary path used by the Codex SDK (#292)
  - Supports strict validation: absolute path, file existence, executable permission, no control characters
  - Priority: `TAKT_CODEX_CLI_PATH` env var > `codex_cli_path` in config.yaml > SDK vendored binary

## [0.18.1] - 2026-02-18

### Added

- Added multi-tenant data isolation section and authorization-resolver consistency code examples to security knowledge
- Added "prefer project scripts" rule to coding policy — detects direct tool invocation (e.g., `npx vitest`) when equivalent npm scripts exist

## [0.18.0] - 2026-02-17

### Added

- **`deep-research` builtin piece**: Multi-angle research workflow with four steps — plan, deep-dive, analyze, and synthesize
- Project-level `.takt/` facets (pieces, personas, policies, knowledge, instructions, output-contracts) are now version-controllable (#286)
- New research facets added: research policy, knowledge, comparative-analysis knowledge, dedicated persona, and instructions

### Changed

- Refactored the `research` piece — separated rules and knowledge embedded in the persona into policy, knowledge, and instruction files, conforming to the faceted design
- Added knowledge/policy references to existing pieces (expert, expert-cqrs, backend, backend-cqrs, frontend)

### Fixed

- Fixed a bug where facet directories were not tracked because `.takt/` path prefix was written with `.takt/` prefix in the `.takt/.gitignore` template (dotgitignore)

### Internal

- Created knowledge facet style guide (`KNOWLEDGE_STYLE_GUIDE.md`)
- Added regression tests for dotgitignore patterns

## [0.17.3] - 2026-02-16

### Added

- Added API client generation consistency rules to builtin AI anti-pattern policy and frontend knowledge — detects handwritten clients mixed into projects where generation tools (e.g., Orval) exist

### Fixed

- Fixed EPERM crash when releasing task store locks — replaced file-based locking with in-memory guard

### Internal

- Unified vitest configuration for e2e tests and added `forceExit` option to prevent zombie workers

## [0.17.2] - 2026-02-15

### Added

- **`expert-mini` and `expert-cqrs-mini` pieces**: Lightweight variants of Expert pieces — plan → implement → parallel review (AI anti-pattern + supervisor) → fix workflow
- Added new pieces to "Mini" and "Expert" piece categories

### Fixed

- Fixed an error being thrown when permission mode could not be resolved — now falls back to `readonly`

## [0.17.1] - 2026-02-15

### Changed

- Changed `.takt/.gitignore` template to allowlist approach — ignores all files by default and tracks only `config.yaml`. Prevents ignore gaps when new files are added

## [0.17.0] - 2026-02-15

### Added

- **Mini piece series**: Added `default-mini`, `frontend-mini`, `backend-mini`, `backend-cqrs-mini` — lightweight development pieces with parallel review (AI anti-pattern + supervisor) as successors to `coding`/`minimal`
- Added "Mini" category to piece categories
- **`supervisor-validation` output contract**: Requirements Fulfillment Check table format that presents code evidence per requirement
- **`getJudgmentReportFiles()`**: Phase 3 status judgment target reports can now be filtered via `use_judge` flag
- Added `finding_id` tracking to output contracts (new/persists/resolved sections for tracking findings across iterations)

### Changed

- **BREAKING: Removed `coding` and `minimal` pieces** — replaced by the mini piece series. Migration: `coding` → `default-mini`, `minimal` → `default-mini`
- **BREAKING: Unified output contract to item format** — `use_judge` (boolean) and `format` (string) fields are now required; `OutputContractLabelPath` (label:path format) is removed
- Moved runtime environment directory from `.runtime` to `.takt/.runtime`
- Enhanced supervisor requirements verification: extracts requirements individually and verifies one-by-one against code (file:line) — "roughly complete" is no longer valid grounds for APPROVE

### Fixed

- Added retry mechanism for deleting clone/worktree directories (`maxRetries: 3`, `retryDelay: 200`) — reduces transient deletion failures caused by file locks

### Internal

- Removed `review-summary` output contract (consolidated into `supervisor-validation`)
- Updated all builtin pieces, e2e fixtures, and tests to the new output contract format

## [0.16.0] - 2026-02-15

### Added

- **Provider-specific permission profiles (`provider_profiles`)**: Define default permission modes per provider and per-movement overrides in global (`~/.takt/config.yaml`) and project (`.takt/config.yaml`) config — 5-level priority resolution (project override → global override → project default → global default → `required_permission_mode` floor)

### Changed

- **BREAKING: `permission_mode` → `required_permission_mode`**: Renamed movement's `permission_mode` field to `required_permission_mode` — acts as a floor value; the actual permission mode is resolved via `provider_profiles`. Old `permission_mode` is rejected by `z.never()`, no backward compatibility
- Rewrote builtin `config.yaml` template: reorganized comments, added `provider_profiles` description and examples, added OpenCode-related settings

### Internal

- Added tests for provider profile resolution (global-provider-profiles, project-provider-profiles, permission-profile-resolution, options-builder)
- Added missing `loadProjectConfig` mock to parallel execution tests

## [0.15.0] - 2026-02-15

### Added

- **Runtime environment presets**: `piece_config.runtime.prepare` and global config `runtime.prepare` allow environment preparation scripts to run automatically before piece execution — builtin presets (`gradle`, `node`) isolate dependency resolution and cache setup to the `.runtime/` directory
- **Loop monitor judge instruction**: `loop_monitors` judge config now supports `instruction_template` field — externalizes loop judgment instructions as an instruction facet, applied to builtin pieces (expert, expert-cqrs)

### Internal

- Added runtime environment tests (runtime-environment, globalConfig-defaults, models, provider-options-piece-parser)
- Added provider e2e test (runtime-config-provider)

## [0.14.0] - 2026-02-14

### Added

- **`takt list` instruct mode (#267)**: Added instruct mode for issuing additional instructions to existing branches — refine requirements through a conversation loop before piece execution
- **`takt list` completed task actions (#271)**: Added diff view and branch operations (merge, delete) for completed tasks
- **Claude sandbox configuration**: `provider_options.claude.sandbox` supports `excluded_commands` and `allow_unsandboxed_commands`
- **`provider_options` global/project config**: `provider_options` can now be set in `~/.takt/config.yaml` (global) and `.takt/config.yaml` (project) — acts as lowest-priority fallback for piece-level settings

### Changed

- **Consolidated provider/model resolution into AgentRunner**: Fixed provider resolution to prioritize project config over custom agent config. Added step-level `stepModel`/`stepProvider` overrides
- **Unified post-execution flow**: Shared `postExecution.ts` for interactive mode and instruct mode (auto-commit, push, PR creation)
- **Added scope-narrowing prevention to instructions**: plan, ai-review, and supervise instructions now require detecting missed requirements — plan mandates per-requirement "change needed/not needed" judgments with rationale, supervise prohibits blindly trusting plan reports

### Fixed

- Fixed a bug where interactive mode options were displayed during async execution (#266)
- Fixed OpenCode session ID not being carried over during parallel execution — server singleton prevents race conditions in parallel runs
- Extended OpenCode SDK server startup timeout from 30 seconds to 60 seconds

### Internal

- Large-scale task management refactor: split `TaskRunner` responsibilities into `TaskLifecycleService`, `TaskDeletionService`, and `TaskQueryService`
- Split `taskActions.ts` by feature: `taskBranchLifecycleActions.ts`, `taskDiffActions.ts`, `taskInstructionActions.ts`, `taskDeleteActions.ts`
- Added `postExecution.ts`, `taskResultHandler.ts`, `instructMode.ts`, `taskActionTarget.ts`
- Consolidated piece selection logic into `pieceSelection/index.ts` (extracted from `selectAndExecute.ts`)
- Added/expanded tests: instructMode, listNonInteractive-completedActions, listTasksInteractiveStatusActions, option-resolution-order, taskInstructionActions, selectAndExecute-autoPr, etc.
- Added Claude Code sandbox option (`dangerouslyDisableSandbox`) to E2E tests
- Added `OPENCODE_CONFIG_CONTENT` to `.gitignore`

## [0.13.0] - 2026-02-13

### Added

- **Team Leader movement**: New movement type where a team leader agent dynamically decomposes a task into sub-tasks (Parts) and executes multiple part agents in parallel — supports `team_leader` config (persona, maxParts, timeoutMs, partPersona, partEdit, partPermissionMode) (#244)
- **Structured Output**: Introduced JSON Schema-based structured output for agent calls — three schemas for task decomposition, rule evaluation, and status judgment added to `builtins/schemas/`. Supported by both Claude and Codex providers (#257)
- **`provider_options` piece-level config**: Provider-specific options (`codex.network_access`, `opencode.network_access`) can now be set at piece level (`piece_config.provider_options`) and individual movements — Codex/OpenCode network access enabled in all builtin pieces
- **`backend` builtin piece**: New backend development piece — parallel specialist review by backend, security, and QA reviewers
- **`backend-cqrs` builtin piece**: New CQRS+ES backend development piece — parallel specialist review by CQRS+ES, security, and QA reviewers
- **AbortSignal for part timeouts**: Added timeout control and parent signal propagation via AbortSignal for Team Leader part execution
- **Agent usecase layer**: `agent-usecases.ts` consolidates agent call usecases (`decomposeTask`, `executeAgent`, `evaluateRules`) and centralizes structured output injection

### Changed

- **BREAKING: Public API cleanup**: Significantly narrowed the public API in `src/index.ts` — internal implementation details (session management, Claude/Codex client internals, utility functions, etc.) are no longer exported, reducing the API surface to a stable minimum (#257)
- **Revamped Phase 3 judgment logic**: Removed `JudgmentDetector`/`FallbackStrategy` and consolidated into `status-judgment-phase.ts` with structured output-based judgment. Improves stability and maintainability (#257)
- **Report phase retry improvement**: Report Phase (Phase 2) now automatically retries with a new session when it fails (#245)
- **Unified Ctrl+C shutdown**: Removed `sigintHandler.ts` and consolidated into `ShutdownManager` — graceful shutdown → timeout → force-kill in three stages, unified across all providers (#237)
- **Scope-deletion guardrails**: Added rules to coder persona prohibiting deletions and structural changes outside the task instruction scope. Added scope discipline and reference material priority rules to planner persona
- Added design token and theme scope guidance to frontend knowledge
- Improved architecture knowledge (both en/ja)

### Fixed

- Fixed checkout failure for existing branches during clone — now passes `--branch` to `git clone --shared` then removes the remote
- Removed `#` from issue-referenced branch names (`takt/#N/slug` → `takt/N/slug`)
- Resolved deprecated tool dependency in OpenCode report phase; migrated to permission-based control (#246)
- Removed unnecessary exports to ensure public API consistency

### Internal

- Added Team Leader tests (engine-team-leader, team-leader-schema-loader, task-decomposer)
- Added structured output tests (parseStructuredOutput, claude-executor-structured-output, codex-structured-output, provider-structured-output, structured-output E2E)
- Added unit tests for ShutdownManager
- Added unit tests for AbortSignal (abort-signal, claude-executor-abort-signal, claude-provider-abort-signal)
- Added unit tests for Report Phase retry (report-phase-retry)
- Added unit tests for public API exports (public-api-exports)
- Added tests for provider_options (provider-options-piece-parser, models, opencode-types)
- Significantly expanded E2E tests: cycle-detection, model-override, multi-step-sequential, pipeline-local-repo, report-file-output, run-sigint-graceful, session-log, structured-output, task-status-persistence
- Refactored E2E test helpers (extracted shared setup functions)
- Removed `judgment/` directory (JudgmentDetector, FallbackStrategy)
- Added `ruleIndex.ts` utility (1-based → 0-based index conversion)

## [0.12.1] - 2026-02-11

### Fixed

- Fixed silent fallthrough to a new session when the session was not found — now shows an info message when no session is detected

### Internal

- Set OpenCode provider report phase to deny (prevents unnecessary writes in Phase 2)
- Skip copying `tasks/` directory during project initialization (TASK-FORMAT is no longer needed)
- Added stream diagnostics utility (`streamDiagnostics.ts`)

## [0.12.0] - 2026-02-11

### Added

- **OpenCode provider**: Native support for OpenCode as a third provider — SDK integration via `@opencode-ai/sdk/v2`, permission mapping (readonly/edit/full → reject/once/always), SSE stream handling, retry mechanism (up to 3 times), and hang detection with 10-minute timeout (#236, #238)
- **Arpeggio movement**: New movement type for data-driven batch processing — CSV data source with batch splitting, template expansion (`{line:N}`, `{col:N:name}`, `{batch_index}`), concurrent LLM calls (Semaphore-controlled), and concat/custom merge strategies (#200)
- **`frontend` builtin piece**: Frontend development piece — React/Next.js knowledge injection, coding/testing policy, parallel architecture review
- **Slack Webhook notifications**: Automatic Slack notification on piece completion — configured via `TAKT_NOTIFY_WEBHOOK` env var, 10-second timeout, non-blocking on failure (#234)
- **Session selector UI**: On interactive mode startup, select a resumable session from past Claude Code sessions — shows latest 10 sessions with initial input and last response preview (#180)
- **Provider event logs**: Claude/Codex/OpenCode execution events written to NDJSON files — `.takt/logs/{sessionId}-provider-events.jsonl`, with automatic compression of large text (#236)
- **Provider/model name display**: Active provider and model name shown in console output at each movement execution

### Changed

- **Revamped `takt add`**: Auto-add to task on issue selection, removed interactive mode, added task stacking confirmation on issue creation (#193, #194)
- **`max_iteration` → `max_movement` unification**: Unified terminology for iteration limits; added `ostinato` for unlimited execution (#212)
- **Improved `previous_response` injection**: Implemented length control and always-inject Source Path (#207)
- **Task management improvements**: Redefined `.takt/tasks/` as storage for long-form task specs; `completeTask()` removes completed records from `tasks.yaml` (#201, #204)
- **Improved review output**: Updated review output format; moved past reports to history log (#209)
- **Simplified builtin pieces**: Further streamlined top-level declarations across all builtin pieces

### Fixed

- **Fixed Report Phase blocked behavior**: Report Phase (Phase 2) now retries with a new session when blocked (#163)
- **Fixed OpenCode hang and termination detection**: Suppressed prompt echo, suppressed question prompts, fixed hang issues, corrected termination detection (#238)
- **Fixed OpenCode permission and tool wiring**: Corrected permission and tool wiring during edit execution
- **Worktree task spec copy**: Fixed task spec not being correctly copied during worktree execution
- Fixed lint errors (merge/resolveTask/confirm)

### Internal

- Comprehensive OpenCode provider tests added (client-cleanup, config, provider, stream-handler, types)
- Comprehensive Arpeggio tests added (csv, data-source-factory, merge, schema, template, engine-arpeggio)
- Significantly expanded E2E tests: cli-catalog, cli-clear, cli-config, cli-export-cc, cli-help, cli-prompt, cli-reset-categories, cli-switch, error-handling, piece-error-handling, provider-error, quiet-mode, run-multiple-tasks, task-content-file (#192, #198)
- Added `providerEventLogger.ts`, `providerModel.ts`, `slackWebhook.ts`, `session-reader.ts`, `sessionSelector.ts`, `provider-resolution.ts`, `run-paths.ts`
- Added `ArpeggioRunner.ts` (data-driven batch processing engine)
- AI Judge now routes through provider system (Codex/OpenCode support)
- Added/expanded tests: report-phase-blocked, phase-runner-report-history, judgment-fallback, pieceExecution-session-loading, globalConfig-defaults, session-reader, sessionSelector, slackWebhook, providerEventLogger, provider-model, interactive, run-paths, engine-test-helpers

## [0.11.1] - 2026-02-10

### Fixed

- Fixed AI Judge to route through provider system — changed `callAiJudge` from a Claude-only implementation to provider-based (`runAgent`), enabling correct AI judgment with the Codex provider
- Reduced instruction bloat — set `pass_previous_response: false` in implement/fix movements, prioritizing reports in the Report Directory as primary information source (en/ja)

### Internal

- Improved CI workflow to automatically sync npm `next` dist-tag to `latest` on stable releases (with retry)

## [0.11.0] - 2026-02-10

### Added

- **`e2e-test` builtin piece**: E2E test focused piece — E2E analysis → E2E implementation → review → fix flow (for Vitest-based E2E tests)
- **`error` status**: Separated provider errors from `blocked`, enabling clear distinction of error states. Added retry mechanism to Codex
- **Centralized task YAML management**: Unified task file management into `tasks.yaml`. Structured task lifecycle management (pending/running/completed/failed) via `TaskRecordSchema`
- **Task spec documentation**: Documented the structure and purpose of task specs (#174)
- **Review policy**: Added shared review policy facet (`builtins/{lang}/policies/review.md`)
- **SIGINT graceful shutdown E2E test**: E2E test to verify Ctrl+C behavior during parallel execution

### Changed

- **Simplified builtin pieces**: Removed top-level `policies`/`personas`/`knowledge`/`instructions`/`report_formats` declarations from all builtin pieces, migrating to implicit name-based resolution. Piece YAML is now simpler
- **Updated piece category spec**: Improved category configuration and display logic. Enhanced category management in global config (#184)
- **Improved `takt list` priority and resolution**: Optimized branch resolution performance. Introduced base commit cache (#186, #195, #196)
- **Improved Ctrl+C signal handling**: Stabilized SIGINT handling during parallel execution
- **Strengthened loop prevention policy**: Enhanced policy to prevent agent infinite loops

### Fixed

- Fixed original instruction diff processing not working correctly (#181)
- Fixed task spec goal being inappropriately scope-expanded — goal is now always fixed to implementation and execution

### Internal

- Large-scale task management refactor: removed `parser.ts` and split into `store.ts`/`mapper.ts`/`schema.ts`/`naming.ts`. Split branch resolution into `branchGitResolver.ts`/`branchBaseCandidateResolver.ts`/`branchBaseRefCache.ts`/`branchEntryPointResolver.ts`
- Significantly expanded and refactored tests: added aggregate-evaluator, blocked-handler, branchGitResolver-performance, branchList-regression, buildListItems-performance, error-utils, escape, facet-resolution, getFilesChanged, global-pieceCategories, instruction-context, instruction-helpers, judgment-strategies, listTasksInteractivePendingLabel, loop-detector, naming, reportDir, resetCategories, rule-evaluator, rule-utils, slug, state-manager, switchPiece, task-schema, text, transitions, watchTasks, etc.
- Refactored Codex client
- Improved facet resolution logic in piece parser

## [0.10.0] - 2026-02-09

### Added

- **`structural-reform` builtin piece**: Full project review and structural reform — iterative codebase restructuring with staged file splits, powered by `loop_monitors`
- **`unit-test` builtin piece**: Unit test focused piece — test analysis → test implementation → review → fix, with `loop_monitors` for cycle control
- **`test-planner` persona**: Specialized persona for analyzing codebase and planning comprehensive test strategies
- **Interactive mode variants**: Four selectable modes after piece selection — `assistant` (default: AI-guided requirement refinement), `persona` (conversation with first movement's persona), `quiet` (generate instructions without questions), `passthrough` (user input used as-is)
- **`persona_providers` config**: Per-persona provider overrides (e.g., `{ coder: 'codex' }`) — route specific personas to different providers without creating hybrid pieces
- **`task_poll_interval_ms` config**: Configurable polling interval for `takt run` to detect new tasks during execution (default: 500ms, range: 100–5000ms)
- **`interactive_mode` piece field**: Piece-level default interactive mode override (e.g., set `passthrough` for pieces that don't benefit from AI planning)
- **Task-level output prefixing**: Colored `[taskName]` prefix on all output lines during parallel `takt run` execution, preventing mid-line interleaving between concurrent tasks
- **Review policy facet**: Shared review policy (`builtins/{lang}/policies/review.md`) for consistent review criteria across pieces

### Changed

- **BREAKING:** Removed all Hybrid Codex pieces (`*-hybrid-codex`) — replaced by `persona_providers` config which achieves the same result without duplicating piece files
- Removed `tools/generate-hybrid-codex.mjs` (no longer needed with `persona_providers`)
- Improved parallel execution output: movement-level prefix now includes task context and iteration info in concurrent runs
- Codex client now detects stream hangs (10-minute idle timeout) and distinguishes timeout vs external abort in error messages
- Parallel task execution (`takt run`) now polls for newly added tasks during execution instead of only checking between task completions
- Parallel task execution no longer enforces per-task time limits (previously had a timeout)
- Issue references now routed through interactive mode (as initial input) instead of skipping interactive mode entirely
- Builtin `config.yaml` updated to document all GlobalConfig fields
- Extracted `conversationLoop.ts` for shared conversation logic across interactive mode variants
- Line editor improvements: additional key bindings and edge case fixes

### Fixed

- Codex processes hanging indefinitely when stream becomes idle — now aborted after 10 minutes of inactivity, releasing worker pool slots

### Internal

- New test coverage: engine-persona-providers, interactive-mode (532 lines), task-prefix-writer, workerPool expansion, pieceResolver expansion, lineEditor expansion, parallel-logger expansion, globalConfig-defaults expansion, pieceExecution-debug-prompts expansion, it-piece-loader expansion, runAllTasks-concurrency expansion, engine-parallel
- Extracted `TaskPrefixWriter` for task-level parallel output management
- Extracted `modeSelection.ts`, `passthroughMode.ts`, `personaMode.ts`, `quietMode.ts` from interactive module
- `InteractiveMode` type model added (`src/core/models/interactive-mode.ts`)
- `PieceEngine` validates `taskPrefix`/`taskColorIndex` pair consistency at construction
- Implementation notes document added (`docs/implements/retry-and-session.ja.md`)

## [0.9.0] - 2026-02-08

### Added

- **`takt catalog` command**: List available facets (personas, policies, knowledge, instructions, output-contracts) across layers (builtin/user/project)
- **`compound-eye` builtin piece**: Multi-model review — sends the same instruction to Claude and Codex simultaneously, then synthesizes both responses
- **Parallel task execution**: `takt run` now uses a worker pool for concurrent task execution (controlled by `concurrency` config, default: 1)
- **Rich line editor in interactive mode**: Shift+Enter for multiline input, cursor movement (arrow keys, Home/End), Option+Arrow word movement, Ctrl+A/E/K/U/W editing, paste bracket mode support
- **Movement preview in interactive mode**: Injects piece movement structure (persona + instruction) into the AI planner for improved task analysis (`interactive_preview_movements` config, default: 3)
- **MCP server configuration**: Per-movement MCP (Model Context Protocol) server settings with stdio/SSE/HTTP transport support
- **Facet-level eject**: `takt eject persona coder` — eject individual facets by type and name for customization
- **3-layer facet resolution**: Personas, policies, and other facets resolved via project → user → builtin lookup (name-based references supported)
- **`pr-commenter` persona**: Specialized persona for posting review findings as GitHub PR comments
- **`notification_sound` config**: Enable/disable notification sounds (default: true)
- **Prompt log viewer**: `tools/prompt-log-viewer.html` for visualizing prompt-response pairs during debugging
- Auto-PR base branch now set to the current branch before branch creation

### Changed

- Unified planner and architect-planner: extracted design knowledge into knowledge facets, merged into planner. Removed architect movement from default/coding pieces (plan → implement direct transition)
- Replaced readline with raw-mode line editor in interactive mode (cursor management, inter-line movement, Kitty keyboard protocol)
- Unified interactive mode `save_task` with `takt add` worktree setup flow
- Added `-d` flag to caffeinate to prevent App Nap process freezing during display sleep
- Issue references now routed through interactive mode (previously executed directly, now used as initial input)
- SDK update: `@anthropic-ai/claude-agent-sdk` v0.2.34 → v0.2.37
- Enhanced interactive session scoring prompts with piece structure information

### Internal

- Extracted `resource-resolver.ts` for facet resolution logic (separated from `pieceParser.ts`)
- Extracted `parallelExecution.ts` (worker pool), `resolveTask.ts` (task resolution), `sigintHandler.ts` (shared SIGINT handler)
- Unified session key generation via `session-key.ts`
- New `lineEditor.ts` (raw-mode terminal input, escape sequence parsing, cursor management)
- Extensive test additions: catalog, facet-resolution, eject-facet, lineEditor, formatMovementPreviews, models, debug, strip-ansi, workerPool, runAllTasks-concurrency, session-key, interactive (major expansion), cli-routing-issue-resolve, parallel-logger, engine-parallel-failure, StreamDisplay, getCurrentBranch, globalConfig-defaults, pieceExecution-debug-prompts, selectAndExecute-autoPr, it-notification-sound, it-piece-loader, permission-mode (expansion)

## [0.8.0] - 2026-02-08

Formal release of 0.8.0-alpha.1 content. No functional changes.

## [0.8.0-alpha.1] - 2026-02-07

### Added

- **Faceted Prompting architecture**: Prompt components are managed as independent files and can be freely combined across pieces
  - `personas/` — persona prompts defining agent role and expertise
  - `policies/` — policies defining coding standards, quality criteria, and prohibitions
  - `knowledge/` — knowledge defining domain knowledge and architecture information
  - `instructions/` — instructions defining movement-specific procedures
  - `output-contracts/` — output contracts defining report output formats
  - Piece YAML section maps (`personas:`, `policies:`, `knowledge:`) associate keys with file paths; movements reference by key
- **Output Contracts and Quality Gates**: Structured definitions for report output and AI directives for quality criteria
  - `output_contracts` field defines reports (replaces `report` field)
  - `quality_gates` field specifies AI directives for movement completion requirements
- **Knowledge system**: Separates domain knowledge from personas, managed and injected at piece level
  - `knowledge:` section map in piece YAML defines knowledge files
  - Movements reference by key via `knowledge:` field
- **Faceted Prompting documentation**: Design philosophy and practical guide added to `docs/faceted-prompting.md` (en/ja)
- **Hybrid Codex piece generation tool**: `tools/generate-hybrid-codex.mjs` auto-generates Codex variants from Claude pieces
- Failed task re-queue: select failed task branches from `takt list` and re-execute (#110)
- Branch name generation strategy is now configurable (`branch_name_strategy` config)
- Added auto-PR feature and unified PR creation logic (#98)
- Piece selection now also applies for issue references (#97)
- Optional macOS idle sleep prevention during piece execution (#100)

### Changed

- **BREAKING:** Renamed `resources/global/` directory to `builtins/`
  - `resources/global/{lang}/` → `builtins/{lang}/`
  - Changed `files` field in package.json from `resources/` to `builtins/`
- **BREAKING:** Renamed `agent` field to `persona`
  - Piece YAML: `agent:` → `persona:`, `agent_name:` → `persona_name:`
  - Internal types: `agentPath` → `personaPath`, `agentDisplayName` → `personaDisplayName`, `agentSessions` → `personaSessions`
  - Directories: `agents/` → `personas/` (global, project, and builtin)
- **BREAKING:** Changed `report` field to `output_contracts`
  - Unified legacy `report: 00-plan.md` / `report: [{Scope: ...}]` / `report: {name, order, format}` formats to `output_contracts: {report: [...]}` format
- **BREAKING:** Renamed `stances` → `policies`, `report_formats` → `output_contracts`
- Migrated all builtin pieces to Faceted Prompting architecture (separated domain knowledge from old agent prompts into knowledge facets)
- SDK updates: `@anthropic-ai/claude-agent-sdk` v0.2.19 → v0.2.34, `@openai/codex-sdk` v0.91.0 → v0.98.0
- Added `policy`/`knowledge` fields to movements (referenced by section map keys)
- Added policy-based evaluation to interactive mode scoring
- Refreshed README: agent → persona, added section map description, clarified control/management classification
- Refreshed builtin skill (SKILL.md) for Faceted Prompting

### Fixed

- Fixed report directory path resolution bug
- Fixed PR issue number link not being set correctly
- Fixed gitignored files being committed in `stageAndCommit` (removed `git add -f .takt/reports/`)

### Internal

- Large-scale builtin resource restructuring: removed old `agents/` directory structure (`default/`, `expert/`, `expert-cqrs/`, `magi/`, `research/`, `templates/`) and migrated to flat `personas/`, `policies/`, `knowledge/`, `instructions/`, `output-contracts/` structure
- Added Faceted Prompting style guides and templates (`PERSONA_STYLE_GUIDE.md`, `POLICY_STYLE_GUIDE.md`, `INSTRUCTION_STYLE_GUIDE.md`, `OUTPUT_CONTRACT_STYLE_GUIDE.md`, etc. in `builtins/ja/`)
- Added policy, knowledge, and instruction resolution logic to `pieceParser.ts`
- Added/expanded tests: knowledge, policy-persona, deploySkill, StreamDisplay, globalConfig-defaults, sleep, task, taskExecution, taskRetryActions, addTask, saveTaskFile, parallel-logger, summarize
- Added policy and knowledge content injection to `InstructionBuilder`
- Added `taskRetryActions.ts` (failed task re-queue logic)
- Added `sleep.ts` utility
- Removed old prompt files (`interactive-summary.md`, `interactive-system.md`)
- Removed old agent templates (`templates/coder.md`, `templates/planner.md`, etc.)

## [0.7.1] - 2026-02-06

### Fixed

- Fixed Ctrl+C not working during piece execution: SIGINT handler now calls `interruptAllQueries()` to stop active SDK queries
- Fixed EPIPE crash after Ctrl+C: dual protection for EPIPE errors when SDK writes to stdin of a stopped child process (`uncaughtException` handler + `Promise.resolve().catch()`)
- Fixed terminal raw mode leaking when an exception occurs in the select menu's `onKeypress` handler

### Internal

- Added integration tests for SIGINT handler and EPIPE suppression (`it-sigint-interrupt.test.ts`)
- Added key input safety tests for select menu (`select-rawmode-safety.test.ts`)

## [0.7.0] - 2026-02-06

### Added

- Hybrid Codex pieces: Added Codex variants for all major pieces (default, minimal, expert, expert-cqrs, passthrough, review-fix-minimal, coding)
  - Hybrid configuration running the coder agent on the Codex provider
  - en/ja support
- `passthrough` piece: Minimal piece that passes the task directly to the coder
- `takt export-cc` command: Deploy builtin pieces and agents as Claude Code Skills
- Added delete action to `takt list`, separated non-interactive mode
- AI consultation action: `takt add` / interactive mode can now create GitHub Issues and save task files
- Cycle detection: Added `CycleDetector` to detect infinite loops between ai_review and ai_fix (#102)
  - Added arbitration step (`ai_no_fix`) to the default piece for when no fix is needed
- CI: Added workflow to auto-delete skipped TAKT Action runs weekly
- Added Hybrid Codex subcategory to piece categories (en/ja)

### Changed

- Simplified category configuration: merged `default-categories.yaml` into `piece-categories.yaml`, changed to auto-copy to user directory
- Fixed subcategory navigation in piece selection UI (recursive hierarchical display now works correctly)
- Refreshed Claude Code Skill to Agent Team-based design
- Unified `console.log` to `info()` (list command)

### Fixed

- Fixed YAML parse error caused by colons in Hybrid Codex piece descriptions
- Fixed invalid arguments passed to `selectPieceFromCategoryTree` on subcategory selection

### Internal

- Refactored `list` command: separated `listNonInteractive.ts`, `taskDeleteActions.ts`
- Added `cycle-detector.ts`, integrated cycle detection into `PieceEngine`
- Refactored piece category loader (`pieceCategories.ts`, `pieceSelection/index.ts`)
- Added tests: cycle-detector, engine-loop-monitors, piece-selection, listNonInteractive, taskDeleteActions, createIssue, saveTaskFile

## [0.6.0] - 2026-02-05

Formal release of RC1/RC2 content. No functional changes.

## [0.6.0-rc1] - 2026-02-05

### Fixed

- Fixed infinite loop between ai_review and ai_fix: resolved issue where ai_fix judging "no fix needed" caused a return to plan and restarted the full pipeline
  - Added `ai_no_fix` arbitration step (architecture-reviewer judges the ai_review vs ai_fix conflict)
  - Changed ai_fix "no fix needed" route from `plan` to `ai_no_fix`
  - Affected pieces: default, expert, expert-cqrs (en/ja)

### Changed

- Changed default piece parallel reviewer from security-review to qa-review (optimized for TAKT development)
- Moved qa-reviewer agent from `expert/` to `default/` and rewrote with focus on test coverage
- Added iteration awareness to ai_review instruction (first iteration: comprehensive review; subsequent: prioritize fix verification)

### Internal

- Restricted auto-tag workflow to merges from release/ branches only, unified publish job (resolves chained trigger failure due to GITHUB_TOKEN limitations)
- Removed postversion hook (conflicts with release branch flow)
- Updated tests: adapted to security-reviewer → qa-reviewer change

## [0.6.0-rc] - 2026-02-05

### Added

- **`coding` builtin piece**: Lightweight development piece — design → implement → parallel review → fix (fast feedback loop without plan/supervise steps)
- **`conductor` agent**: Dedicated agent for Phase 3 judgment. Reads reports and responses to output judgment tags
- **Phase 3 judgment fallback strategy**: 4-stage fallback (AutoSelect → ReportBased → ResponseBased → AgentConsult) to improve judgment accuracy (`src/core/piece/judgment/`)
- **Session state management**: Saves task execution results (success/error/interrupted) and displays previous result on next interactive mode startup (#89)
- TAKT meta information (piece structure, progress) injection mechanism for agents
- **`/play` command**: Immediately executes task in interactive mode
- E2E test infrastructure: mock/provider-compatible test infrastructure, 10 E2E test specs, test helpers (isolated-env, takt-runner, test-repo)
- Added detection rule for "logically unreachable defensive code" to review agents

### Changed

- Changed Phase 3 judgment logic from session-resume approach to conductor agent + fallback strategy (improved judgment stability)
- Refactored CLI routing as `executeDefaultAction()` function, reusable as fallback from slash commands (#32)
- Input starting with `/` or `#` is now accepted as task instruction when no command/issue is found (#32)
- Simplified `isDirectTask()`: only issue references execute directly, all others go to interactive mode
- Removed `pass_previous_response: true` from all builtin pieces (redundant as it is the default behavior)

### Internal

- Added E2E test config files (vitest.config.e2e.ts, vitest.config.e2e.mock.ts, vitest.config.e2e.provider.ts)
- Added `getReportFiles()`, `hasOnlyOneBranch()`, `getAutoSelectedTag()` to `rule-utils.ts`
- Added report content and response-based judgment instruction generation to `StatusJudgmentBuilder`
- Added piece meta information (structure, iteration counts) injection to `InstructionBuilder`
- Added tests: judgment-detector, judgment-fallback, sessionState, pieceResolver, cli-slash-hash, e2e-helpers

## [0.5.1] - 2026-02-04

### Fixed

- Windows environment file path handling and encoding issues (#90, #91)
  - Improved .git detection for Windows
  - Added mandatory .git check for Codex (error if not found)
  - Fixed character encoding issues
- Codex branch name summary processing bug

### Internal

- Test memory leak and hanging issues resolved
  - Added cleanup handlers for PieceEngine and TaskWatcher
  - Changed vitest to single-threaded execution for improved test stability

## [0.5.0] - 2026-02-04

### Changed

- **BREAKING:** Complete terminology migration from "workflow" to "piece" across entire codebase
  - All CLI commands, configuration files, and documentation now use "piece" terminology
  - `WorkflowEngine` → `PieceEngine`
  - `workflow_categories` → `piece_categories` in config files
  - `builtin_workflows_enabled` → `builtin_pieces_enabled`
  - `~/.takt/workflows/` → `~/.takt/pieces/` (user piece directory)
  - `.takt/workflows/` → `.takt/pieces/` (project piece directory)
  - All workflow-related file names and types renamed to piece-equivalents
  - Updated all documentation (README.md, CLAUDE.md, docs/*)

### Internal

- Complete directory structure refactoring:
  - `src/core/workflow/` → `src/core/piece/`
  - `src/features/workflowSelection/` → `src/features/pieceSelection/`
- File renames:
  - `workflow-types.ts` → `piece-types.ts`
  - `workflowExecution.ts` → `pieceExecution.ts`
  - `workflowLoader.ts` → `pieceLoader.ts`
  - `workflowParser.ts` → `pieceParser.ts`
  - `workflowResolver.ts` → `pieceResolver.ts`
  - `workflowCategories.ts` → `pieceCategories.ts`
  - `switchWorkflow.ts` → `switchPiece.ts`
- All test files updated to reflect new terminology (194 files changed, ~3,400 insertions, ~3,400 deletions)
- Resources directory updated:
  - `resources/global/*/pieces/*.yaml` updated with new terminology
  - All prompt files (`*.md`) updated
  - Configuration files (`config.yaml`, `default-categories.yaml`) updated

## [0.4.1] - 2026-02-04

### Fixed

- Workflow execution bug where previous step's response was incorrectly bound to subsequent steps
  - Fixed `MovementExecutor`, `ParallelRunner`, and `state-manager` to properly isolate step responses
  - Updated interactive summary prompts to prevent response leakage

## [0.4.0] - 2026-02-04

### Added

- Externalized prompt system: all internal prompts moved to versioned, translatable files (`src/shared/prompts/en/`, `src/shared/prompts/ja/`)
- i18n label system: UI labels extracted to separate YAML files (`labels_en.yaml`, `labels_ja.yaml`) with `src/shared/i18n/` module
- Prompt preview functionality (`src/features/prompt/preview.ts`)
- Phase system injection into agents for improved workflow phase awareness
- Enhanced debug capabilities with new debug log viewer (`tools/debug-log-viewer.html`)
- Comprehensive test coverage:
  - i18n system tests (`i18n.test.ts`)
  - Prompt system tests (`prompts.test.ts`)
  - Session management tests (`session.test.ts`)
  - Worktree integration tests (`it-worktree-delete.test.ts`, `it-worktree-sessions.test.ts`)

### Changed

- **BREAKING:** Internal terminology renamed: `WorkflowStep` → `WorkflowMovement`, `StepExecutor` → `MovementExecutor`, `ParallelSubStepRawSchema` → `ParallelSubMovementRawSchema`, `WorkflowStepRawSchema` → `WorkflowMovementRawSchema`
- **BREAKING:** Removed unnecessary backward compatibility code
- **BREAKING:** Disabled interactive prompt override feature
- Workflow resource directory renamed: `resources/global/*/workflows/` → `resources/global/*/pieces/`
- Prompts restructured for better readability and maintainability
- Removed unnecessary task requirement summarization from conversation flow
- Suppressed unnecessary report output during workflow execution

### Fixed

- `takt worktree` bug fix for worktree operations

### Internal

- Extracted prompt management into `src/shared/prompts/index.ts` with language-aware file loading
- Created `src/shared/i18n/index.ts` for centralized label management
- Enhanced `tools/jsonl-viewer.html` with additional features
- Major refactoring across 162 files (~5,800 insertions, ~2,900 deletions)

## [0.3.9] - 2026-02-03

### Added

- Workflow categorization support (#85)
  - Default category configuration in `resources/global/{lang}/default-categories.yaml`
  - User-defined categories via `workflow_categories` in `~/.takt/config.yaml`
  - Nested category support with unlimited depth
  - Category-based workflow filtering in workflow selection UI
  - `show_others_category` and `others_category_name` configuration options
  - Builtin workflow filtering via `builtin_workflows_enabled` and `disabled_builtins`
- Agent-less step execution: `agent` field is now optional (#71)
  - Steps can execute with `instruction_template` only (no system prompt)
  - Inline system prompts supported (agent string used as prompt if file doesn't exist)
- `takt add #N` automatically reflects issue number in branch name (#78)
  - Issue number embedded in branch name (e.g., `takt/issue-28-...`)

### Changed

- **BREAKING:** Permission mode values unified to provider-independent format (#87)
  - New values: `readonly`, `edit`, `full` (replaces `default`, `acceptEdits`, `bypassPermissions`)
  - TAKT translates to provider-specific flags (Claude: default/acceptEdits/bypassPermissions, Codex: read-only/workspace-write/danger-full-access)
  - All builtin workflows updated to use new values
- Workflow naming changes:
  - `simple` workflow replaced with `minimal` and `review-fix-minimal`
  - Added `review-only` workflow for read-only code review
- Agent prompts updated with legacy対応禁止ルール (no backward compatibility hacks)
- Documentation updates:
  - README.md and docs/README.ja.md updated with v0.3.8+ features
  - CLAUDE.md significantly expanded with architectural details and implementation notes

### Internal

- Created `src/infra/config/loaders/workflowCategories.ts` for category management
- Created `src/features/workflowSelection/index.ts` for workflow selection UI
- Enhanced `src/shared/prompt/select.ts` with category display support
- Added comprehensive tests for workflow categories (`workflow-categories.test.ts`, `workflow-category-config.test.ts`)

## [0.3.8] - 2026-02-02

### Added

- CLI option to specify workflow/config file paths: `--workflow <path>` and `--config <path>` (#81)
- CI-friendly quiet mode for minimal log output (#70)
- Mock scenario support for testing workflow execution
- Comprehensive integration tests (7 test files, ~3000 lines of test coverage)

### Changed

- Rule evaluation improved: `detectRuleIndex` now uses last match instead of first match (#25)
- `ai_fix` step significantly improved:
  - Added `{step_iteration}` counter to show retry attempt number
  - Explicit fix procedure defined (Read → Grep → Edit → Test → Report)
  - Coder agent now prioritizes reviewer feedback over assumptions
- README and docs updated with clearer CLI usage and CI/CD examples

### Fixed

- Workflow loading priority corrected (user workflows now take precedence over builtins)
- Test stability improvements (flaky tests skipped, ai_fix test updated)
- Slack notification configuration fixed

### Internal

- Refactored instruction builder: extracted context assembly and status rules logic (#44)
- Introduced `src/infra/task/git.ts` for DRY git commit operations
- Unified error handling with `getErrorMessage()`
- Made `projectCwd` required throughout codebase
- Removed deprecated `sacrificeMode`
- 35 files updated for consistency (`console.log` → `blankLine()`, etc.)

## [0.3.7] - 2026-02-01

### Added

- `--pipeline` flag for explicit pipeline/non-interactive mode execution (#28)
- Pipeline mode can be used with both `--task` and `--issue` options

### Changed

- Log file naming changed from base36 to human-readable `YYYYMMDD-HHmmss-random` format (#28)
- `--task` option description updated to clarify it's an alternative to GitHub issue

## [0.3.6] - 2026-01-31

### Fixed

- `ai_review` workflow step now correctly includes `pass_previous_request` setting

## [0.3.5] - 2026-01-31

### Added

- `--create-worktree <yes|no>` option to skip worktree confirmation prompt

### Fixed

- Various CI/CD improvements and fixes (#66, #67, #68, #69)

## [0.3.4] - 2026-01-31

### Added

- Review-only workflow for code review without modifications (#60)
- Various bug fixes and improvements (#14, #23, #35, #38, #45, #50, #51, #52, #59)

## [0.3.3] - 2026-01-31

### Fixed

- Fixed `takt add #N` passing issue content through AI summarization and corrupting task content (#46)
  - Changed to use `resolveIssueTask` result directly as the task when referencing issues

## [0.3.1] - 2026-01-31

### Added

- Interactive task planning mode: `takt` (no args) starts AI conversation to refine task requirements before execution (#47, #5)
  - Session persistence across takt restarts
  - Read-only tools (Read, Glob, Grep, Bash, WebSearch, WebFetch) for codebase investigation
  - Planning-only system prompt prevents code changes during conversation
  - `/go` to confirm and execute, `/cancel` to exit
- Boy Scout Rule enforcement in reviewer/supervisor agent templates

### Changed

- CLI migrated from slash commands (`takt /run-tasks`) to subcommands (`takt run`) (#47)
- `/help` and `/refresh-builtin` commands removed; `eject` simplified
- SDK options builder only includes defined values to prevent hangs

### Fixed

- Claude Agent SDK hanging when `model: undefined` or other undefined options were passed as keys

## [0.3.0] - 2026-01-30

### Added

- Rule-based workflow transitions with 5-stage fallback evaluation (#30)
  - Tag-based conditions: agent outputs `[STEP:N]` tags matched by index
  - `ai()` conditions: AI evaluates free-text conditions against agent output (#9)
  - `all()`/`any()` aggregate conditions for parallel step results (#20)
  - 5-stage evaluation order: aggregate → Phase 3 tag → Phase 1 tag → AI judge → AI fallback
- 3-phase step execution model (#33)
  - Phase 1: Main work (coding, review, etc.)
  - Phase 2: Report output (when `step.report` defined)
  - Phase 3: Status judgment (when tag-based rules exist)
  - Session resumed across phases for context continuity
- Parallel step execution with concurrent sub-steps via `Promise.all()` (#20)
- GitHub Issue integration: execute/add tasks by issue number, e.g. `takt #6` (#10, #34)
- NDJSON session logging with real-time streaming writes (#27, #36)
- Builtin resources embedded in npm package with `/eject` command for customization (#4, #40)
- `edit` property for per-step file edit control
- Rule match method visualization and logging
- Report output auto-generation from YAML `report.format`
- Parallel review support in builtin workflows with spec compliance checking (#31)
- WorkflowEngine mock integration tests (#17, #41)

### Changed

- Report format unified to auto-generation; manual `order`/`instruction_template` for reports removed
- `gitdiff` report type removed in favor of format-based reports

### Fixed

- Report directory correctly includes `.takt/reports/` prefix (#37, #42)
- Unused import in eject.ts (#43)

## [0.2.3] - 2026-01-29

### Added

- `/list-tasks` command for branch management (try merge, merge & cleanup, delete)

### Changed

- Isolated execution migrated from `git worktree` to `git clone --shared` to prevent Claude Code SDK from traversing back to main repository
- Clone lifecycle: auto-deletion after task completion removed; use `/list-tasks` for cleanup
- `worktree.ts` split into `clone.ts` + `branchReview.ts`
- Origin remote removed from clones to block SDK traversal
- All workflow report steps granted Write permission
- `git clone --shared` changed to `--reference --dissociate`

### Fixed

- Version read from `package.json` instead of hardcoded `0.1.0` (#3)

## [0.2.2] - 2026-01-29

### Added

- `/review` instruct action for executing instructions on task branches
- AI-powered task name summarization to English slugs for branch names
- Worktree session inheritance
- Execution Rules metadata (git commit prohibition, cd prohibition)

### Changed

- Status output rule headers auto-generated
- Instructions auto-include worktree change context
- Try Merge changed to squash merge
- `expert-review` renamed to `expert-cqrs`; common reviewers consolidated under `expert/`

### Fixed

- Tasks incorrectly progressing to `completed` on abnormal termination

## [0.2.1] - 2026-01-28

### Added

- Language setting (`ja`/`en`)
- Multiline input support for `/add-task`
- `/review-tasks` command
- Cursor-based (arrow key) menu selection replacing numeric input
- `answer` status, `autoCommit`, `permission_mode`, verbose logging options

### Fixed

- Multiple worktree-related bugs (directory resolution, session handling, creation flow)
- ESC key cancels workflow/task selection

## [0.2.0] - 2026-01-27

### Added

- `/watch` command for file system polling and auto-executing tasks from `.takt/tasks/`
- `/refresh-builtin` command for updating builtin resources
- `/add-task` command for interactive task creation
- Enhanced default workflows

## [0.1.7] - 2026-01-27

### Added

- Schema permission support for workflow validation

## [0.1.6] - 2026-01-27

### Added

- Mock execution mode for testing

### Changed

- `-r` option omitted; default changed to conversation continuation mode

## [0.1.5] - 2026-01-27

### Added

- Total execution time output

### Fixed

- Workflow unintentionally stopping during execution

## [0.1.4] - 2026-01-27

### Changed

- Workflow prompts strengthened
- Transition prompts consolidated into workflow definitions

## [0.1.3] - 2026-01-26

### Fixed

- Iteration stalling issue

## [0.1.2] - 2026-01-26

### Added

- Codex provider support
- Model selection per step/agent
- Permission mode configuration
- Worktree support for isolated task execution
- Project `.gitignore` initialization

### Changed

- Agent prompts refined

## [0.1.1] - 2026-01-25

### Added

- GitHub Actions workflow for npm publish

### Changed

- Interactive mode removed; CLI simplified
