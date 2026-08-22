package example.account

import java.time.Instant

sealed interface AccountEvent {
    val accountId: String
    val occurredAt: Instant
}

data class OpenAccount(
    override val accountId: String,
    val ownerName: String,
    override val occurredAt: Instant,
) : AccountEvent

data class MoneyDeposited(
    override val accountId: String,
    val amount: Long,
    override val occurredAt: Instant,
) : AccountEvent
