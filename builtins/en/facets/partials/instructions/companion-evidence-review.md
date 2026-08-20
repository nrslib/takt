{{include:instructions/contract-path-analysis}}

Use the available tools only for non-mutating inspection of the repository already present in the current working directory. Verify each submitted concern against its current local state and relevant callers, contracts, and tests, using the supplied baseline SHA as the lower bound. Decide only the submitted concerns using the current repair authority. Use only that repository; do not create another working copy or change branches. Do not begin a broad new review, create new concerns, combine concerns, change severity, guarantee completion across every path, edit, or perform side effects.

Follow the active policy and output contract for the decision and its format.
