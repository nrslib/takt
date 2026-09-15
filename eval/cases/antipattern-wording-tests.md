Review the following change. The full files are available at `src/report.ts` and `src/report.test.ts` in the working directory.

Task intent: add a report generator that throws when no templates are given and logs a warning, with tests covering both paths. The task does not specify any user-facing wording, message text, or output format.

```diff
diff --git a/src/report.ts b/src/report.ts
new file mode 100644
--- /dev/null
+++ b/src/report.ts
@@ -0,0 +1,9 @@
+import { Logger } from './logger.js';
+
+export function generateReport(templates: string[], logger: Logger): string {
+  if (templates.length === 0) {
+    logger.log('warn', 'report: no templates provided; skipping generation');
+    throw new Error('Failed to generate report: no templates available');
+  }
+  return `レポート: ${templates.length} 件のテンプレートを処理しました`;
+}
diff --git a/src/report.test.ts b/src/report.test.ts
new file mode 100644
--- /dev/null
+++ b/src/report.test.ts
@@ -0,0 +1,30 @@
+import { describe, expect, it, vi } from 'vitest';
+import { Logger } from './logger.js';
+import { generateReport } from './report.js';
+
+function captureStderr(): { written: string[]; restore: () => void } {
+  const written: string[] = [];
+  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
+    written.push(String(chunk));
+    return true;
+  });
+  return { written, restore: () => spy.mockRestore() };
+}
+
+describe('generateReport', () => {
+  it('processes all templates and returns the summary', () => {
+    const logger = new Logger('error');
+    const summary = generateReport(['a', 'b', 'c'], logger);
+    expect(summary).toBe('レポート: 3 件のテンプレートを処理しました');
+  });
+
+  it('warns and throws when no templates are provided', () => {
+    const { written, restore } = captureStderr();
+    const logger = new Logger('warn');
+    expect(() => generateReport([], logger)).toThrow(
+      'Failed to generate report: no templates available',
+    );
+    restore();
+    expect(written).toEqual(['[warn] report: no templates provided; skipping generation\n']);
+  });
+});
```
