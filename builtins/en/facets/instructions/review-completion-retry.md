Close only the investigation paths missing from the preceding review, then update the review result.

**Review mode:** `{review_mode}`

**Actions:**
1. Verify the missing obligations below against actual code and executable evidence.
2. For `initial`, sweep the changed targets and acceptance criteria again, then close every vertical lifecycle path for each discovered contract family: definition, producer, normalizer/validator, every consumer, retry/fallback/parallel, persistence/restoration, and terminal/API.
3. For `follow_up`, do not restart general horizontal exploration. Close only gaps classified as an unvisited consumer in an accepted family, a remediation regression, a direct acceptance-criterion violation, or a required consumer migration.
4. Restate the findings and verified paths under the original output contract.
