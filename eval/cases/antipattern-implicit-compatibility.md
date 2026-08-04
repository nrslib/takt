Review the following change. The full file is available at `src/resume-codec.ts` in the working directory.

Task intent: replace iteration-based resume namespaces with the canonical workflow-call path. New resume records must use `call-path:<path>`, and resume after the change must restore the same logical call instance.

```diff
diff --git a/src/resume-codec.ts b/src/resume-codec.ts
new file mode 100644
--- /dev/null
+++ b/src/resume-codec.ts
@@ -0,0 +1,22 @@
+export interface ResumeRecord {
+  namespace: string;
+}
+
+const LEGACY_NAMESPACE = /^iteration-(\d+)--step-(.+)$/;
+
+export function serializeResumeNamespace(callPath: string): string {
+  return `call-path:${callPath}`;
+}
+
+export function parseResumeNamespace(record: ResumeRecord): string {
+  if (record.namespace.startsWith('call-path:')) {
+    return record.namespace.slice('call-path:'.length);
+  }
+
+  const legacy = LEGACY_NAMESPACE.exec(record.namespace);
+  if (legacy !== null) {
+    return `root/${legacy[2]}`;
+  }
+
+  throw new Error(`Invalid resume namespace: ${record.namespace}`);
+}
```
