Review the following change. The full files are available under `src/main/kotlin/example/account/` in the working directory.

Task intent: add an event-sourced `Account` aggregate with open/deposit support and a deposit command handler.

```diff
diff --git a/src/main/kotlin/example/account/AccountEvents.kt b/src/main/kotlin/example/account/AccountEvents.kt
new file mode 100644
--- /dev/null
+++ b/src/main/kotlin/example/account/AccountEvents.kt
@@ -0,0 +1,20 @@
+package example.account
+
+import java.time.Instant
+
+sealed interface AccountEvent {
+    val accountId: String
+    val occurredAt: Instant
+}
+
+data class OpenAccount(
+    override val accountId: String,
+    val ownerName: String,
+    override val occurredAt: Instant,
+) : AccountEvent
+
+data class MoneyDeposited(
+    override val accountId: String,
+    val amount: Long,
+    override val occurredAt: Instant,
+) : AccountEvent
diff --git a/src/main/kotlin/example/account/Account.kt b/src/main/kotlin/example/account/Account.kt
new file mode 100644
--- /dev/null
+++ b/src/main/kotlin/example/account/Account.kt
@@ -0,0 +1,31 @@
+package example.account
+
+class Account private constructor(val accountId: String) {
+    var balance: Long = 0
+        private set
+    var ownerName: String = ""
+        private set
+
+    fun apply(event: AccountEvent) {
+        when (event) {
+            is OpenAccount -> {
+                require(event.ownerName.isNotBlank()) { "owner name must not be blank" }
+                ownerName = event.ownerName
+            }
+            is MoneyDeposited -> {
+                if (event.amount < 0) {
+                    throw IllegalArgumentException("amount must be positive")
+                }
+                balance += event.amount
+            }
+        }
+    }
+
+    companion object {
+        fun from(accountId: String, events: List<AccountEvent>): Account {
+            val account = Account(accountId)
+            events.forEach { account.apply(it) }
+            return account
+        }
+    }
+}
diff --git a/src/main/kotlin/example/account/DepositHandler.kt b/src/main/kotlin/example/account/DepositHandler.kt
new file mode 100644
--- /dev/null
+++ b/src/main/kotlin/example/account/DepositHandler.kt
@@ -0,0 +1,20 @@
+package example.account
+
+class AccountTable {
+    private val balances = mutableMapOf<String, Long>()
+
+    fun update(accountId: String, balance: Long) {
+        balances[accountId] = balance
+    }
+
+    fun balanceOf(accountId: String): Long = balances[accountId] ?: 0
+}
+
+data class DepositCommand(val accountId: String, val amount: Long)
+
+class DepositHandler(private val table: AccountTable) {
+    fun handle(command: DepositCommand) {
+        val current = table.balanceOf(command.accountId)
+        table.update(command.accountId, current + command.amount)
+    }
+}
```
