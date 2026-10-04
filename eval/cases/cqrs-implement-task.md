Add withdrawal support to the account domain.

Requirements:

- Add a `MoneyWithdrawn` event (past-tense name, same shape conventions as the existing events).
- `Account.apply` must handle `MoneyWithdrawn` by decreasing the balance. Keep `apply` as pure state restoration: no validation, no exceptions, no side effects in the new branch.
- Add a `WithdrawCommand` and a decision path (on the aggregate or a handler) that validates the amount (positive, not exceeding the balance) BEFORE producing the event. Validation failures must not produce an event.
- Do not write to `AccountTable` directly from the new command path; the outcome of a command is an event.
