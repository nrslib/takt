Review the following change. The full changed file is available at `src/report-path.ts`.

Task intent: accept a report path supplied by a user and resolve it under the current workspace.

```diff
diff --git a/src/report-path.ts b/src/report-path.ts
new file mode 100644
--- /dev/null
+++ b/src/report-path.ts
@@ -0,0 +1,5 @@
+import { resolve } from 'node:path';
+
+export function resolveReportPath(workspace: string, input: string): string {
+  return resolve(workspace, input);
+}
```

For evaluation telemetry, append exactly one `<scope-eval>` block after the review. The block must contain valid JSON with this shape:

```json
{
  "boundaryFamilies": [
    {
      "members": ["repository-relative implementation paths"],
      "sameObservedFailure": true,
      "sharedOwnerCandidate": true,
      "behaviorEvidence": ["repository-relative test or executable evidence paths"]
    }
  ],
  "findingPaths": ["repository-relative paths that participate in a finding"],
  "structureProxyFindings": false
}
```

Include only classifications supported by files or executable evidence you inspected. Use an empty array when no boundary family or finding path is confirmed. `structureProxyFindings` is true only when the review promotes source wording, line count, imports, helper names, or file layout to a finding without an observable contract.
