Output all rows defined as completion contracts in the planning or upstream records supplied for this task, together with any contract rows actually added as new discoveries during later testing or implementation. Use the supplied content, whether in reports or conversation, as the source; do not assume a particular filename, storage format, or separate contract ledger. If no rows were added, output only the completion-contract rows defined in the planning or upstream records; do not treat the absence of a separate ledger or discoveries that never occurred as missing work, an incomplete contract, or a warning.

If later user inputs modify or withdraw obligations, apply those revisions and record the rows that remain in the current requirements. Do not revive obligations from an old plan or mark withdrawn obligations as Incomplete. For changed rows, record the source of the revision and the current completion conditions. The ID and meaning preservation below applies to rows that remain in the current requirements.

For rows with existing IDs, preserve the ID, origin, and upstream completion conditions and meaning. Do not reassign IDs according to implementation, test, or evidence order. For rows without IDs, do not invent a contract ID: fill the Contract ID / Source column with the actual source and relevant location (such as a report heading or line, or the relevant requirement in conversation). Use that same source and location in the impact-path table. Do not replace existing IDs with display sequence numbers.

Select status in this order:
- A row with incomplete implementation or failed verification showing an unmet contract is Incomplete. Give this priority even when environmental limitations also exist.
- When implementation is not incomplete and no unmet contract is observed, use Environment-limited only if every remaining unconfirmed item is explained by a confirmed, concrete environmental constraint and the verification it prevented. Distinguish execution stopped by an environmental constraint from executed verification that observed an unmet contract.
- Other missing information or evidence makes the row Incomplete. Missing information in the report alone is not an environmental cause; label unknown causes as unknown.
- Use Verified only when all applicable contract and impact-path evidence succeeded.

When implementation status or location is unconfirmed, record it as unknown. Missing information or verification alone does not establish absent implementation; record "not implemented" only when absence has been confirmed.

Do not guess missing information. Record every failed, unexecuted, or unconfirmed item under Unverified Scope with its reason, deterministic alternative verification, and remaining risk.
