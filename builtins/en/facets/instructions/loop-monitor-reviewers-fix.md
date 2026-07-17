The review and fix loop has repeated {cycle_count} times.

When a Finding Contract ledger summary / `findings-ledger.json` is available, use the consolidated ledger as the primary source.
When no ledger is available, review the latest review reports in the Report Directory and determine whether this loop is healthy (converging) or unproductive (diverging or oscillating).

**Judgment criteria:**
- When a parseable Finding Contract ledger / `findings-ledger.json` exists, treat tracked ledger `findings` / `conflicts` as authoritative and individual reports as supporting evidence.
- When the ledger exists but is incomplete, follow the ledger for mapped findings and treat unmapped raw findings as potential new entries awaiting findings-manager reconciliation.
- When the ledger is absent, unreadable, or unparseable, use the latest review reports in the Report Directory as primary evidence.
- Compare persistent identical finding_ids, the total number of open findings, and changes in new / reopened findings across multiple cycles.
- Prior findings becoming resolved while different findings become new is not enough by itself to judge the loop healthy.
- If findings with the same `family_tag` keep moving to different files, treat that as unproductive rediscovery caused by failure to exhaust the family initially.
- If new findings continue to appear late in areas untouched by fixes and open findings do not decrease overall, treat the loop as unproductive.
- Judge the loop healthy when fixes have landed in code, open findings decrease overall, and any new issues are caused by the latest fix.
- If findings no longer match the fixed code, consider replanning or dispute a viable escape only when that route is actually configured.

Maintain strict quality standards. Do not treat unresolved issues as complete; judge repeated exploration without progress as unproductive.
