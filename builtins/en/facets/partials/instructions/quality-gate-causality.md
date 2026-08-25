Before using a failed quality check as a reason for incompleteness or another repair, verify from the diff, reference paths, recorded reproduction results, or comparison with the baseline that it has a causal connection to at least one of the following:

- an acceptance criterion in the repair plan is not satisfied
- the current diff introduced a regression
- the current change broke an existing condition that it must preserve

Treat a failure with one of these verified connections as incomplete even when a broad quality check found it or it appears in a file outside the plan. Record a failure with no verified connection as a separate problem; do not use it to mark a planned repair unit incomplete or select it for another repair. A recorded result showing the same failure in the baseline, or the absence of a reference path to the changed code, may support a finding that no causal connection exists, but do not decide from names or assumptions alone.
