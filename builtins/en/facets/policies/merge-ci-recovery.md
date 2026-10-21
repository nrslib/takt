Investigate every completed CI failure using the failed check, run, attempt, job and log contents, the PR's cumulative diff against its base, and related code. Record the cause, evidence, location, and whether a root fix is justified. Logs alone do not establish the location of a defect.

Treat flaky tests, including timing and scheduling assumptions, as repository test defects. A matching failure on main does not excuse the defect: fix it in this PR's working tree. Only an evidenced cause that repository changes cannot repair is external, such as an Actions outage, unavailable runners, or missing external secrets.

Missing permissions, unsupported checks, empty logs, and unavailable evidence do not prove an external cause. Report insufficient_evidence and stop without speculative edits, reruns or merge. Do not invent failed test names or assertions if infrastructure failed before tests started.

A fix must address the demonstrated cause. Reject changes made solely to turn CI green: disabling or deleting tests, weakening assertions, increasing timeouts, removing test classification, or disabling gates without causal justification. Do not prohibit a justified root fix merely because it touches a test or CI file. Apply the same standard when implementing and reviewing.

Investigation and review are read-only. Only the coder edits the current PR clone. Do not commit, push, rerun, comment or merge using agent tools: system effects own these operations. The workflow permits at most two fix/push/CI rounds and one independent external-cause rerun. After that rerun fails, stop even if the later verdict changes to defect. Recovery success must still pass Caccia, matching-HEAD CI, and the existing merge conditions.
