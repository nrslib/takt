# AI antipattern review

## Result: APPROVE

| finding ID | evidence | observation | reviewer disposition |
|------------|----------|-------------|----------------------|
| AIP-DEFAULT-1 | `src/retry-menu.js:2` | When Resume and the failed leaf coexist, Resume receives the default even though `requirements.md` assigns it to the failed leaf. The actions have different state semantics. | Non-finding: Resume is a safer default, so the documentation mismatch is minor. |
