# Review adjudication binding eval result

- Date: 2026-08-15
- Eval ID: `eval-aHg-2026-08-15T01:31:23`
- Command: `npm run eval:prompts:review-adjudication-binding`
- Prompt: generated from the current follow-up `security-review` facets by `eval/scripts/prepare.mjs`
- Result: 15 passed, 0 failed, 0 errors

| Provider | A: disposition binding | B: remeasurement | B control: remediation reintroduction | C: evidence threshold | C control: OSC effect |
|----------|------------------------|------------------|---------------------------------------|-----------------------|-----------------------|
| `claude-opus-5` | PASS | PASS | PASS | PASS | PASS |
| `gpt-5.6-luna` (`max`) | PASS | PASS | PASS | PASS | PASS |
| `gpt-5.6-sol` (`high`) | PASS | PASS | PASS | PASS | PASS |

## Facet adjustments

None. The first complete three-provider run passed every case, so the English and Japanese facets from d1510960 were not changed.
