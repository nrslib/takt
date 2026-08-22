package example.account

class Account private constructor(val accountId: String) {
    var balance: Long = 0
        private set
    var ownerName: String = ""
        private set

    fun apply(event: AccountEvent) {
        when (event) {
            is OpenAccount -> {
                require(event.ownerName.isNotBlank()) { "owner name must not be blank" }
                ownerName = event.ownerName
            }
            is MoneyDeposited -> {
                if (event.amount < 0) {
                    throw IllegalArgumentException("amount must be positive")
                }
                balance += event.amount
            }
        }
    }

    companion object {
        fun from(accountId: String, events: List<AccountEvent>): Account {
            val account = Account(accountId)
            events.forEach { account.apply(it) }
            return account
        }
    }
}
