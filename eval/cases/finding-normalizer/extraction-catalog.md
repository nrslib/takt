# Finding report normalizer extraction catalog

This catalog evaluates extraction only. Each `Candidate report` is normalized
in a separate model call. The model receives no task text, repository content,
or other review report. It runs from an empty temporary working directory.
Claude/OpenCode are requested with `allowedTools: []`; Codex CLI retains its
tool layer, including a read-only shell. Codex therefore has no physical
no-tools guarantee, and strict scoring requires an observed `toolUseCount` of
zero.

Model execution sends the selected report text to the configured provider.
`pr-attachments-six-reviews` contains local review material, so the runner
refuses to send it unless explicit approval has been obtained and
`--allow-external-review-data` is supplied. Render-only and score-only do not
call a model.

| Case | Reports | Coverage |
|---|---:|---|
| `pr-attachments-six-reviews` | 6 | Real multilingual reviews, APPROVE/empty reports, multiple claims, code paths, and missing-test structure |
| `summary-only-review-report` | 1 | A finding stated only under a summary heading |
| `broad-target-review-reports` | 7 | Line-independent code, structure, absence, file quote, explicit ledger persistence/resolution fields, ordinary approval exclusion, and ambiguous provisional input |

Scoring axes:

- stored invocation prompt SHA-256 matches the current rendered prompt
- schema conformance to `RawFindingsOutputJsonSchema`
- explicit-claim recall
- exact verbatim `rawExcerpt` source binding
- non-fabrication and exact candidate field extraction
- preservation of null/empty ambiguity
- exact finding order within each report
- no cross-report mixing
- zero observed tool calls

Run the local scorer adversarial fixture without calling a model:

```sh
node eval/scripts/run-finding-report-normalizer-eval.mjs \
  --self-test \
  --result-set scorer-self-test
```

Render and validate every prompt and gold record without calling a model:

```sh
node eval/scripts/run-finding-report-normalizer-eval.mjs --render-only
```

Run only the non-sensitive synthetic reports independently:

```sh
node eval/scripts/run-finding-report-normalizer-eval.mjs \
  --cases summary-only-review-report,broad-target-review-reports \
  --models gemma4,luna,haiku,terra,sonnet \
  --result-set synthetic-comparison-1
```

Run the six local review reports only after explicit external-send approval:

```sh
node eval/scripts/run-finding-report-normalizer-eval.mjs \
  --cases pr-attachments-six-reviews \
  --models gemma4,luna,haiku,terra,sonnet \
  --allow-external-review-data \
  --result-set pr-six-1
```

Re-score stored outputs without another provider call:

```sh
node eval/scripts/run-finding-report-normalizer-eval.mjs \
  --cases pr-attachments-six-reviews \
  --models gemma4,luna,haiku,terra,sonnet \
  --result-set pr-six-1 \
  --score-only
```

## Measurement state

The measurement state is recorded in
`eval/baselines/finding-report-normalizer-2026-07-29.md`.

- The current prompt SHA-256 is
  `0513c7536b96235e151c9d4478d568a54a58b877aeba0c915bbadae8df18b983`.
- This prompt revision has not yet been measured against external models.
- The following Luna/Terra results belong to the previous prompt hash
  `a3b25caddd72cbb6e1a1545781359eff6fb5c02a5511605c52c11f7dd0c65d2d`;
  they are retained as tuning history, not current-prompt results.
- Terra passed 3/3 summary-only repetitions and all 6/6 broad-target reports.
- Luna passed both completed outputs in the initial summary-only run; one
  additional attempt ended with provider capacity before model output. Its
  fresh retry passed 1/1.
- Luna passed 5/6 broad-target reports. Report 3 omitted the explicit
  `authoritative_quote` request, so candidate exactness failed even though
  schema, recall, source binding, non-fabrication, ambiguity, order, and tool
  use all passed.
- Terra is the first candidate for this fixture. Luna is the second candidate
  because of the typed evidence-request omission. Gemma4 remains outside the
  candidate set because its recorded extraction output was schema-invalid; it
  is not included in any current-prompt result.
- The six local review reports were rendered and gold-scored locally, but were
  not sent to an external provider because approval was not granted.

Previous-prompt result artifacts:

- `eval/.work/finding-report-normalizer/results/final-summary-luna-terra-r3-20260729/summary.json`
- `eval/.work/finding-report-normalizer/results/final-summary-luna-retry1-20260729/summary.json`
- `eval/.work/finding-report-normalizer/results/final-broad-luna-terra-20260729/summary.json`

Historical results under `eval/.work/finding-normalizer-intake/` use an older
free-form contract with generated summaries and classifications. They are not
scores for this catalog and must not be combined with the current result.
Artifacts generated from earlier revisions of the extraction prompt are also
tuning history only.
