package example.account

class AccountTable {
    private val balances = mutableMapOf<String, Long>()

    fun update(accountId: String, balance: Long) {
        balances[accountId] = balance
    }

    fun balanceOf(accountId: String): Long = balances[accountId] ?: 0
}

data class DepositCommand(val accountId: String, val amount: Long)

class DepositHandler(private val table: AccountTable) {
    fun handle(command: DepositCommand) {
        val current = table.balanceOf(command.accountId)
        table.update(command.accountId, current + command.amount)
    }
}
