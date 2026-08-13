Review the following change. The full file is available at `src/failure-aggregation-policy.ts` in the working directory.

Task intent: expose one parent outcome for a batch of concurrent operations. This boundary's explicit policy prioritizes the first retryable outcome, because the caller owns retry scheduling and must preserve that opportunity. If none is retryable, it selects the first outcome.

```diff
diff --git a/src/failure-aggregation-policy.ts b/src/failure-aggregation-policy.ts
new file mode 100644
--- /dev/null
+++ b/src/failure-aggregation-policy.ts
@@ -0,0 +1,25 @@
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
+  const primary = failures.find((failure) => failure.retryable) ?? failures[0];
+
+  return {
+    status: primary.retryable ? 'retry' : 'failed',
+    category: primary.category,
+    abortReason: primary.detail,
+  };
+}
```
