Adjudicate the concerns submitted in the immediately preceding review round and determine which repairs are authorized now.

{{include:instructions/review-adjudication-check}}

Do not start a new broad review. Treat only review reports published by the current review process under the Report Directory as submissions. Search recursively, including subdirectories, and exclude artifacts explicitly marked for internal processing or history. Inspect current code, requirements, plans, and execution evidence only as needed to decide those submissions.

To establish the submission set, inspect every participating reviewer's public report and relative path, and first form the union of every finding ID recorded in those reports. A later report supersedes only the same finding ID in an older report from the same reviewer, or an item explicitly identified as a continuation of the same finding. If the later report omits an older finding ID and does not explicitly resolve, withdraw, or replace it, keep that older finding and report in the submission set. Never discard an entire older report merely because its reviewer also produced a later report, and do not remove reports from other reviewers in the same round. Do not treat one file as the whole round merely because of its timestamp or name.

For each concern, evaluate the technical claim, concrete failure condition, evidence, and basis for repair authority separately, then apply the current policy. For every authorized repair, record its authority basis, violated invariant, affected contract paths, observable acceptance criteria, and repair boundary.

Use earlier decisions and history only to match problems governed by the same invariant and responsible source and to carry forward required records. Do not treat them as current submissions or recreate repair work when the latest reports do not submit a current problem.

Record a complete decision for every submitted concern and the consolidation target for concerns with the same cause, following the output contract. Base the result on current evidence and policy rather than reviewer vote counts. When a concern cannot be decided, state the unresolved premise instead of excluding it by assumption.

Even when a later phase will generate the report automatically, enumerate every submitted finding ID exactly once in the current Phase 1 response and associate it with technical validity, disposition, actionable family or none, the exact Authorization Basis or none, and evidence. If the task requests an additional final judgment line, do not return only that line or a summary and omit the complete adjudication.

When any unresolved `actionable` or `duplicate` remains, explicitly state the current Phase 1 result as `ACTIONABLE FINDINGS` or its localized equivalent and record that the result is blocking. Do not treat prior recording, initial versus follow-up timing, finding count, or severity as a reason for completion.
