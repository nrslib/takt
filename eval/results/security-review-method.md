# Security review method eval result

- Date: 2026-08-15
- Eval ID: `eval-PsS-2026-08-15T04:08:11`
- Command: `npm run eval:prompts:security-review-method`
- Prompt: generated from the current initial `security-review` facets by `eval/scripts/prepare.mjs`
- Result: 21 passed, 0 failed, 0 errors

| Provider | No boundary change | Bound SQL | SQL concatenation | Resource scope | Credential log | Helper command | Repository size |
|----------|--------------------|-----------|-------------------|----------------|----------------|----------------|-----------------|
| `claude-opus-5` | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| `gpt-5.6-luna` (`max`) | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| `gpt-5.6-sol` (`high`) | PASS | PASS | PASS | PASS | PASS | PASS | PASS |

## Facet adjustments

None after measurement. The first complete three-provider run passed every case.
