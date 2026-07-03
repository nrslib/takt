Review the following change. The full files are available at `src/logger.ts` and `src/logger.test.ts` in the working directory.

Task intent: add a minimal leveled `Logger` that writes to stderr and filters messages below a configured minimum level, with unit tests.

```diff
diff --git a/src/logger.ts b/src/logger.ts
new file mode 100644
--- /dev/null
+++ b/src/logger.ts
@@ -0,0 +1,28 @@
+export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
+
+const LEVEL_ORDER: Record<LogLevel, number> = {
+  debug: 0,
+  info: 1,
+  warn: 2,
+  error: 3,
+};
+
+export class Logger {
+  constructor(private readonly minLevel: LogLevel) {}
+
+  log(level: LogLevel, message: string): void {
+    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) {
+      return;
+    }
+    process.stderr.write(`[${level}] ${message}\n`);
+  }
+
+  debug(message: string): void {
+    this.log('debug', message);
+  }
+
+  error(message: string): void {
+    this.log('error', message);
+  }
+}
diff --git a/src/logger.test.ts b/src/logger.test.ts
new file mode 100644
--- /dev/null
+++ b/src/logger.test.ts
@@ -0,0 +1,50 @@
+import { describe, expect, it, vi } from 'vitest';
+import { Logger, type LogLevel } from './logger.js';
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
+describe('Logger', () => {
+  it('writes messages at or above the minimum level', () => {
+    const { written, restore } = captureStderr();
+    const logger = new Logger('info');
+    logger.log('warn', 'disk almost full');
+    restore();
+    expect(written).toEqual(['[warn] disk almost full\n']);
+  });
+
+  it('filters messages below the minimum level', () => {
+    const { written, restore } = captureStderr();
+    const logger = new Logger('warn');
+    logger.log('info', 'started');
+    logger.debug('noise');
+    restore();
+    expect(written).toEqual([]);
+  });
+
+  it.each<LogLevel>(['debug', 'info', 'warn', 'error'])(
+    'writes %s messages when minimum level is debug',
+    (level) => {
+      const { written, restore } = captureStderr();
+      const logger = new Logger('debug');
+      logger.log(level, 'msg');
+      restore();
+      expect(written).toEqual([`[${level}] msg\n`]);
+    },
+  );
+
+  it('exposes level shorthands that delegate to log', () => {
+    const { written, restore } = captureStderr();
+    const logger = new Logger('debug');
+    logger.debug('a');
+    logger.error('b');
+    restore();
+    expect(written).toEqual(['[debug] a\n', '[error] b\n']);
+  });
+});
```
