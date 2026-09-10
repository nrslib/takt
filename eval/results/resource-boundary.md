# Resource boundary generalization

Date: 2026-09-10. Pre-generalization baseline: `a31af0495cacb75b645c4a5acaaf7d8a63efab17`.
This follows the [initial pagination experiment](db-pagination.md).

## Failure reproduced beyond DB pagination

Architecture review missed the uncapped full download in `preview` in one of two
baseline trials. It correctly rejected `deliver`, which buffers everything before
its first write, but explicitly found no required repair in `preview`:

> `preview`、`summarize`、`readManifest` については、提示された契約から追加の修正必須条件を確認できませんでした。

The task asks for an 80-character prefix of an uncapped remote object. The source
provides a lazy chunk API, while `preview` calls the full-materialization API.
Independent execution confirms that a fixed 80-character response downloads
3,200 or 128,000 characters for 50 or 2,000 blocks respectively. This is a missed
architecture finding, not an evaluator error or a generated implementation defect.
The review fixture contains no seeded findings to hint at the expected answer.

## Facet responsibilities

| Facet | Responsibility |
|---|---|
| Architecture policy, Japanese and English | Judge acquisition and retention boundaries from current contracts and input bounds; reject fixes that truncate required full output or exact aggregation |
| Architecture knowledge, Japanese and English | Explain acquired, processed, retained, outstanding, and emitted volume; distinguish necessary full scans from simultaneous retention |
| Adjudication policy, Japanese and English | Do not waive a confirmed defect solely because numeric targets or observed outages are absent; keep unknown applicability separate from a confirmed defect |

The architecture policy is consumed by the architecture reviewer and adjudicator.
The standard implementation workflow consumes the architecture knowledge, rather
than this policy by default. Prepared snapshots were checked for the new content
at all three actual destinations. No workflow-specific wiring was added.

The policy contains no DB, SQL, pagination, fixture function names, or numeric
example thresholds. The knowledge keeps pagination as an explanatory example and
also explains buffering, backpressure, item size, and necessary full-data work.

## Cases and inverse controls

| Path | Required judgment | Independent fixture evidence |
|---|---|---|
| `preview` | Repair full download before prefix selection | Same 80-character output despite input-proportional acquisition |
| `deliver` | Repair buffering before delivery while preserving the full output | First write occurs after all 50 / 2,000 pulls |
| `relay` | Preserve incremental full delivery | Same complete output, first write after one pull, each write awaited |
| `summarize` | Preserve the complete scan for an exact total | Correct total requires all input blocks; source uses a scalar accumulator |
| `readManifest` | Preserve the bounded whole-manifest result | Enforced 16-entry, 64-byte-per-entry source bound |

The adjudication fixture adds synthetic findings for all five paths. Three are
deliberate false positives: truncating the complete relay, truncating the exact
aggregate, and imposing pagination on the bounded manifest. The implementation
report defends the two defects using correct outputs and absent numeric SLOs.
Both ordinary response test suites pass before any repair. Independent fixture
checks establish acquisition and ordering; they do not measure process RSS.

## Results

Actor: `gpt-5.6-luna`, reasoning effort `max`; no cache. New resource-flow suites
disable user/repository skill inheritance and use independent fixture copies.
This does not remove every source of Codex context, including memory instructions.

| Suite | Baseline passed / failed / errors | After generalization |
|---|---|---|
| Resource-flow architecture review | 1 / 1 / 0 | 3 / 0 / 0 |
| Resource-flow adjudication | 2 / 0 / 0 | 3 / 0 / 0 |
| Original pagination adjudication, both skill profiles | See initial report | 6 / 0 / 0 |
| Original pagination backend review | See initial report | 3 / 0 / 0 |
| Original pagination implementation | See initial report | 3 / 0 / 0 |

Baseline evaluation IDs:

- Architecture review: `eval-H0w-2026-09-10T04:49:23`
- Adjudication: `eval-eKC-2026-09-10T04:49:24`

Post-change architecture review: `eval-uuq-2026-09-10T04:58:51`. All three final
responses were inspected directly: each identifies both defects separately and
preserves all three healthy paths.
Post-change adjudication: `eval-Aok-2026-09-10T04:58:51`. Direct inspection also
confirmed that every response retains FLOW-01/02 and excludes FLOW-03/04/05.

Post-change pagination backend review: `eval-qDu-2026-09-10T05:06:42`. All three
responses identify the unbounded history query and preserve the bounded SQL
query and fixed-category controls. One response separately requests a regression
test for the history acquisition defect.

Post-change pagination implementation: `eval-jpg-2026-09-10T05:05:50`. Each of
the three independently generated projects fetched at most 21 rows per page for
45- and 2,000-record inputs and exported all 45 / 2,000 records. Direct reruns of
the generated tests passed 6, 7, and 4 tests respectively. This is a regression
check; no implementation-generation RED was reproduced.

Post-change pagination adjudication: `eval-yBv-2026-09-10T04:58:52`. Both skill
profiles passed all three trials. Direct response inspection confirmed that all
six retain PAGINATION-001 while preserving the bounded query and fixed-category
controls. Across the five suites, all 18 post-change actor trials passed with
zero evaluation errors.

The scenario, code, reports, rubric, actor model, and effort were fixed before
editing the production facets. The architecture review provides the new RED;
the adjudication baseline already passed and is a regression control. Small
sample counts do not establish a general failure rate or universal prevention.

## Reproduction and verification

```sh
npm run build
npm run eval:prompts:resource-boundary:contracts
npm run eval:prompts:resource-boundary -- --repeat 3 --max-concurrency 3
npm run eval:prompts:db-pagination -- --repeat 3 --max-concurrency 3
```

Ignored local evidence is retained under `.tmp/resource-flow-baseline/`, with
full baseline snapshots and response hashes. Raw baseline/green JSON uses
`.tmp/resource-flow-*-baseline.json`, `.tmp/resource-flow-*-green.json`, and
`.tmp/resource-boundary-pagination-*-green.json`. The committed table and failure
excerpt preserve the conclusion without requiring access to those local files.

The pagination assertion also now classifies malformed generated `items` as a
failed result rather than throwing. Its measurement tests execute module adapters
in memory, removing temporary-directory cleanup concerns without signal handlers.

Local gates passed: build, lint, fast unit (401 files / 6,081 tests), light IT
(159 files / 2,460 tests), 28 evaluation contracts, mock E2E smoke (19 passed /
1 skipped), and OpenCode smoke (11 passed with the installed CLI's directory
first in PATH). The existing CLI provider suite passed 21 tests on rerun without
code changes; its first run alongside the unit shards failed one 500ms startup
timeout test.
