# Database pagination evaluation

Date: 2026-09-10. Base: `3778c4c8b5c5904a2661953cd99962b5b28ff445`.
Actor: Codex CLI / SDK, `gpt-5.6-luna`, reasoning effort `max`, cache disabled.

## What reproduced

The inherited-skill adjudication trial accepted the observation that every row
was fetched, but discarded `PAGINATION-001` as `out_of_scope`. Its stated reason
was that response correctness was satisfied and DB fetch limits were an
additional internal performance contract without numeric requirements or
measurements. This was a completed model decision, not an evaluator error.

Exact excerpts from that response:

> 判定: `out_of_scope`

> DB取得件数をページ相当へ制限することは妥当な性能改善だが、現在の要件・公開契約・実測証跡から必須条件とは確定できない。

This is a fixed-report adjudication reproduction. The reviewer report describes
an actual all-rows-then-slice implementation; the implementation report defending
it is a synthetic adversarial input. It does not establish that a full TAKT run
created the implementation or generated that defense spontaneously.

## Baseline results

| Stage / skill inheritance | Passed | Failed | Errors | Evaluation ID |
|---|---:|---:|---:|---|
| Implementation / disabled | 3 | 0 | 0 | `eval-68w-2026-09-10T03:12:15` |
| Backend review / disabled | 3 | 0 | 0 | `eval-YLl-2026-09-10T03:24:06` |
| Adjudication / disabled | 1 | 0 | 0 | `eval-foJ-2026-09-10T03:24:06` |
| Adjudication / disabled, two more trials | 2 | 0 | 0 | `eval-kCY-2026-09-10T03:27:07` |
| Adjudication / inherited | 0 | 1 | 0 | `eval-1sR-2026-09-10T03:18:10` |

The three implementation trials all used SQL-bounded reads, with at most 21 rows
returned to the application per request. Correct page contents, `hasMore`, empty
and out-of-range pages, tenant separation, and the existing full export passed
independent SQLite measurements at 45 and 2,000 records. The generation failure
was **not reproduced**. The normal response tests on the deliberately defective
review fixture pass; independent instrumentation still observes 45 / 2,000 rows
fetched for it versus at most 21 for its bounded control.

The inherited profile uses the local Codex configuration and is not hermetic or
portable across machines. The disabled profile disables user/repository skills,
not all Codex context: memory instructions may still be supplied. Results from
these profiles must not be merged into a single before/after claim. A one-failure
baseline and three post-change trials cannot establish a statistical failure
rate or universal prevention.

## Change and follow-up

Only the Japanese and English `review-adjudication` policy was changed. Numeric
performance targets and observed outages are not prerequisites for retaining a
confirmed unbounded materialization defect in a newly changed paginated read.
The rule limits the repair to that boundary and excludes already bounded fetches,
fixed small collections, and explicitly required full exports from blanket limits.
Implementation and backend-review facets were not changed.

Post-change adjudication completed: **6 passed, 0 failed, 0 errors**, exit code 0
(`eval-QMg-2026-09-10T03:35:25`). All six final responses were also inspected
directly: they retained `PAGINATION-001` and left the two healthy paths unchanged.

| Skill inheritance | Baseline | After policy change |
|---|---|---|
| Inherited | 0/1 passed (RED) | 3/3 passed (GREEN) |
| Disabled | 3/3 passed | 3/3 passed |

The inherited profile provides the RED-to-GREEN comparison. The disabled profile
is a regression control that already passed before the change, not a second RED.

Japanese policy source SHA-256:

- Before: `ad8fd27cfb338218713ffeae19c44f86f51bfb12cd68db1449dcceff9f8d2498`
- After: `45dfa38a041ccc36f9f3d778af2ee6b69cb94b5d6cd303d0f7cd3f338384331b`

The fixture, task, reviewer finding, adversarial defense, grader rubric, model,
and effort remain fixed. The suite now runs both inheritance profiles explicitly;
compare each with its own baseline. Positive controls require the adjudicator to
leave SQL `LIMIT` plus lookahead/slicing and the fixed local vocabulary alone.

## Reproduction and artifacts

```sh
npm run build
npm run eval:prompts:db-pagination:contracts
node eval/scripts/run-evals.mjs --prepare db-pagination-adjudication --no-cache --repeat 3 --max-concurrency 2
```

`npm run eval:prompts:db-pagination -- --repeat 3` also runs implementation and
backend review. Prepared artifacts live under `eval/prompts/` and each fixture's
`.takt/eval-snapshots/`; implementation calls retain their independent project,
prompt, model output, and measurements under `eval/.results/db-pagination-implement/`.

This experiment's raw local results are `.tmp/pagination-*-baseline*.json` and
`.tmp/pagination-adjudication-green.json`. Baseline prompt/policy copies are in
`.tmp/pagination-baseline-context/`; `.tmp/pagination-baseline-evidence.json`
records result IDs and response hashes. These ignored local artifacts are not
shipped with the repository. The table and exact failure excerpt above preserve
the outcome for reviewers without those local artifacts.

Verification: build, lint, fast unit gate (401 files / 6,081 tests), light IT (159 files / 2,460 tests),
18 pagination/registry contracts, and 21 existing CLI provider tests passed.
Rows returned to the application are measured; DB-internal scan counts, process
RSS, old TAKT versions, and end-to-end workflow convergence are not measured.
