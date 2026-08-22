Plan complete.

- Add `MoneyWithdrawn` to `AccountEvents.kt` following the existing sealed interface conventions.
- Extend `Account.apply` with a `MoneyWithdrawn` branch that only restores state (decrease balance).
- Add `WithdrawCommand` and a decide/handle path that validates the withdrawal (positive amount, sufficient balance) before emitting `MoneyWithdrawn`; on validation failure no event is produced.
- The command path must not update `AccountTable` directly; events are the only output of a command decision.
