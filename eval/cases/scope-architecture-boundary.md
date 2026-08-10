Review the following change. The full changed file is available at `src/domain/student-export.ts`.

Task intent: export a student's current grade summary to a destination selected by a trusted local caller.

```diff
diff --git a/src/domain/student-export.ts b/src/domain/student-export.ts
new file mode 100644
--- /dev/null
+++ b/src/domain/student-export.ts
@@ -0,0 +1,12 @@
+import { writeFileSync } from 'node:fs';
+
+export interface StudentGrade {
+  studentId: string;
+  grade: string;
+}
+
+export function exportStudentGrade(student: StudentGrade, destination: string): void {
+  const summary = `${student.studentId},${student.grade}\n`;
+  writeFileSync(destination, summary, 'utf8');
+}
```
