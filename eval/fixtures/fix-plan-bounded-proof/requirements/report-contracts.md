# Final report contract

Completed run artifacts under `artifacts/recorded-runs/` are the authoritative
examples for supported report names and localized section headings. A report
kind is supported when it recurs in the recorded English and Japanese runs.

The lifecycle priority is validation, then review decision, then final summary.
The first recognized report at that priority is the sole primary; unrelated
files are not merged into it. A Markdown findings table contributes one finding
per data row, so a header-only table represents zero findings.

One structured summary from that primary report must reach both the failed-task
provider context and the pull-request body.
