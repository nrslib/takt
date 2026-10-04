Review the following change. The full files are available at `src/shared/format.ts`, `src/infra/file-writer.ts`, and `src/index.ts` in the working directory.

Task intent: add a shared formatting utility module and expose the library's public API from `src/index.ts`.

```diff
diff --git a/src/infra/file-writer.ts b/src/infra/file-writer.ts
new file mode 100644
--- /dev/null
+++ b/src/infra/file-writer.ts
@@ -0,0 +1,5 @@
+import { writeFileSync } from 'node:fs';
+
+export function writeRawFile(path: string, content: string): void {
+  writeFileSync(path, content, 'utf8');
+}
diff --git a/src/shared/format.ts b/src/shared/format.ts
new file mode 100644
--- /dev/null
+++ b/src/shared/format.ts
@@ -0,0 +1,15 @@
+import type { User } from '../user-store.js';
+import { writeRawFile } from '../infra/file-writer.js';
+
+export function formatUserLabel(user: User): string {
+  return user.email ? `${user.name} <${user.email}>` : user.name;
+}
+
+export function parseCsvLine(line: string): string[] {
+  return line.split(',').map((cell) => cell.trim());
+}
+
+export function writeUserCsv(path: string, users: User[]): void {
+  const lines = users.map((u) => [u.id, u.name, u.email ?? ''].join(','));
+  writeRawFile(path, lines.join('\n'));
+}
diff --git a/src/index.ts b/src/index.ts
new file mode 100644
--- /dev/null
+++ b/src/index.ts
@@ -0,0 +1,5 @@
+export { UserStore } from './user-store.js';
+export type { User } from './user-store.js';
+export { Logger } from './logger.js';
+export { writeRawFile } from './infra/file-writer.js';
+export { parseCsvLine } from './shared/format.js';
```
