The review and repair loop has repeated {cycle_count} times.

Inspect the latest review reports, decision record, repair reports, verification reports, and current code in the Report Directory. Determine whether the loop is converging, stalled, or diverging.

{{include:instructions/fix-plan-validity}}

First establish the observation point from report chronology. Determine whether verification or review ran after the latest repair. If neither ran, use the repair report's completion conditions and remaining work to distinguish waiting for verification from unfinished implementation.

Across iterations, compare acceptance criteria newly satisfied, the same root causes that remain, code and evidence that changed, and newly confirmed structural or contract problems. Do not infer progress from counts or identifier changes alone; verify that implementation or evidence materially changed.

Treat the loop as stalled or diverging when the same cause and evidence repeat, post-repair reports disagree with current code, or structural problems continue to appear without reducing the uninspected area. When required repairs are progressing and the remaining work is concrete and executable, the loop may still be converging even though it is not complete.

Require replanning only when evidence shows that the plan's assumptions, repair boundary, method, or verification capability are insufficient or inconsistent and a plan change can address the problem. Implementation or evidence gaps alone do not justify replanning.

Choose the supplied outcome that matches the current evidence. Do not report convergence while completion conditions remain unmet. When evidence shows that repeating the same review or repair cannot resolve the loop, choose the outcome that stops that repetition.
