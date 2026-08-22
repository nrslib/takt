Review the following change. The full files are available at `src/retry.ts` and `src/sync.ts` in the working directory.

Task intent: retry the user-sync fetch up to 3 times with a 100ms delay, and log the sync result.

```diff
diff --git a/src/retry.ts b/src/retry.ts
new file mode 100644
--- /dev/null
+++ b/src/retry.ts
@@ -0,0 +1,29 @@
+export interface RetryStrategy {
+  delayMs(attempt: number): number;
+}
+
+export class FixedDelayStrategy implements RetryStrategy {
+  constructor(private readonly ms: number) {}
+
+  delayMs(): number {
+    return this.ms;
+  }
+}
+
+export async function withRetry<T>(
+  fn: () => Promise<T>,
+  options?: { retries?: number; strategy?: RetryStrategy },
+): Promise<T> {
+  const retries = options?.retries ?? 3;
+  const strategy = options?.strategy ?? new FixedDelayStrategy(100);
+  let lastError: unknown;
+  for (let attempt = 0; attempt < retries; attempt++) {
+    try {
+      return await fn();
+    } catch (error) {
+      lastError = error;
+      await new Promise((resolveDelay) => setTimeout(resolveDelay, strategy.delayMs(attempt)));
+    }
+  }
+  throw lastError;
+}
diff --git a/src/sync.ts b/src/sync.ts
new file mode 100644
--- /dev/null
+++ b/src/sync.ts
@@ -0,0 +1,19 @@
+import { withRetry } from './retry.js';
+import { UserStore } from './user-store.js';
+import { Logger } from './logger.js';
+
+export async function syncUsers(
+  store: UserStore,
+  fetchJson: () => Promise<string>,
+): Promise<number> {
+  const json = await withRetry(() => fetchJson());
+  return store.loadFromJson(json).length;
+}
+
+export function logSyncResult(logger: Logger, count: number): void {
+  if (count > 0) {
+    logger.log('info', `synced ${count} users`);
+  } else {
+    logger.log('info', `synced ${count} users`);
+  }
+}
```
