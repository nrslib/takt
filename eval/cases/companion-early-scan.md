Review this cumulative work-in-progress diff without tools.

Task contract: move request-token normalization to `normalizeRequestToken` and migrate every current producer and consumer that applies the same trim-and-lowercase invariant. Telemetry label formatting is a separate behavior and must remain unchanged.

```diff
diff --git a/src/token-normalization.ts b/src/token-normalization.ts
index 1111111..2222222 100644
--- a/src/token-normalization.ts
+++ b/src/token-normalization.ts
@@ -1,3 +1,7 @@
+export function normalizeRequestToken(value: string): string {
+  return value.trim().toLowerCase();
+}
+
 export function normalizeTelemetryLabel(value: string): string {
   return value.trim().replaceAll(' ', '_');
 }
diff --git a/src/web-request.ts b/src/web-request.ts
index 3333333..4444444 100644
--- a/src/web-request.ts
+++ b/src/web-request.ts
@@ -1,5 +1,5 @@
+import { normalizeRequestToken } from './token-normalization.js';
 export function webToken(raw: string): string {
-  return raw.trim().toLowerCase();
+  return normalizeRequestToken(raw);
 }
diff --git a/src/cli-request.ts b/src/cli-request.ts
index 5555555..5555555 100644
--- a/src/cli-request.ts
+++ b/src/cli-request.ts
@@ -1,3 +1,3 @@
 export function cliToken(raw: string): string {
   return raw.trim().toLowerCase();
 }
diff --git a/src/telemetry.ts b/src/telemetry.ts
index 6666666..6666666 100644
--- a/src/telemetry.ts
+++ b/src/telemetry.ts
@@ -1,3 +1,3 @@
 export function telemetryLabel(raw: string): string {
   return raw.trim().replaceAll(' ', '_');
 }
```

A note mentions a possible mobile consumer, but no mobile file or diff is supplied.
