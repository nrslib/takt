# AI antipattern review

## Result: APPROVE

| finding ID | evidence | observation | reviewer disposition |
|------------|----------|-------------|----------------------|
| AIP-PRIMARY-1 | `src/retry-menu.js:15` | When the saved checkpoint and failed leaf coexist, the checkpoint receives the default. The manual Requeue path therefore does not choose the failed leaf before pending storage and normal-runner claim. | Non-finding: the checkpoint is a safer default, so the primary-path mismatch is minor. |
