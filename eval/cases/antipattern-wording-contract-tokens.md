Review the following change. The full files are available at `src/cli-exit.ts` and `src/cli-exit.test.ts` in the working directory.

Task intent: the CLI contract requires exit code 3 and the machine-readable error code `REPORT_TEMPLATE_MISSING` when no template is given; add the implementation and tests for this contract. The human-readable message text is not part of the contract.

```diff
diff --git a/src/cli-exit.ts b/src/cli-exit.ts
new file mode 100644
--- /dev/null
+++ b/src/cli-exit.ts
@@ -0,0 +1,25 @@
+export const EXIT_NO_TEMPLATE = 3;
+export const ERR_NO_TEMPLATE = 'REPORT_TEMPLATE_MISSING';
+
+export class ReportError extends Error {
+  constructor(
+    public readonly code: string,
+    message: string,
+  ) {
+    super(message);
+    this.name = 'ReportError';
+  }
+}
+
+export function ensureTemplates(templates: string[]): void {
+  if (templates.length === 0) {
+    throw new ReportError(ERR_NO_TEMPLATE, 'no templates available');
+  }
+}
+
+export function resolveExitCode(templates: string[]): number {
+  if (templates.length === 0) {
+    return EXIT_NO_TEMPLATE;
+  }
+  return 0;
+}
diff --git a/src/cli-exit.test.ts b/src/cli-exit.test.ts
new file mode 100644
--- /dev/null
+++ b/src/cli-exit.test.ts
@@ -0,0 +1,36 @@
+import { describe, expect, it } from 'vitest';
+import {
+  ERR_NO_TEMPLATE,
+  EXIT_NO_TEMPLATE,
+  ReportError,
+  ensureTemplates,
+  resolveExitCode,
+} from './cli-exit.js';
+
+describe('ensureTemplates', () => {
+  it('throws a ReportError carrying the machine-readable code when no templates exist', () => {
+    let caught: unknown;
+    try {
+      ensureTemplates([]);
+    } catch (error) {
+      caught = error;
+    }
+    expect(caught).toBeInstanceOf(ReportError);
+    expect((caught as ReportError).code).toBe(ERR_NO_TEMPLATE);
+  });
+
+  it('accepts a non-empty template list', () => {
+    expect(() => ensureTemplates(['base'])).not.toThrow();
+  });
+});
+
+describe('resolveExitCode', () => {
+  it('returns the documented exit code 3 when no templates exist', () => {
+    expect(resolveExitCode([])).toBe(EXIT_NO_TEMPLATE);
+    expect(EXIT_NO_TEMPLATE).toBe(3);
+  });
+
+  it('returns 0 when templates exist', () => {
+    expect(resolveExitCode(['base'])).toBe(0);
+  });
+});
```
