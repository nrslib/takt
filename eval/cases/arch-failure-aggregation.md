Review the following change. The full file is available at `src/failure-aggregation.ts` in the working directory.

Task intent: expose one parent outcome for a batch of concurrent operations.

```diff
diff --git a/src/failure-aggregation.ts b/src/failure-aggregation.ts
new file mode 100644
--- /dev/null
+++ b/src/failure-aggregation.ts
@@ -0,0 +1,24 @@
+export interface Failure {
+  category: 'rate_limited' | 'parse_error' | 'provider_error';
+  detail: string;
+  retryable: boolean;
+}
+
+export interface AggregateFailure {
+  status: 'retry' | 'failed';
+  category: Failure['category'];
+  abortReason: string;
+}
+
+export function aggregateFailures(
+  failures: readonly [Failure, ...Failure[]],
+): AggregateFailure {
+  const retryable = failures.find((failure) => failure.retryable);
+  const fatal = failures.find((failure) => !failure.retryable);
+
+  return {
+    status: retryable ? 'retry' : 'failed',
+    category: (fatal ?? failures[0]).category,
+    abortReason: (retryable ?? failures[0]).detail,
+  };
+}
```
