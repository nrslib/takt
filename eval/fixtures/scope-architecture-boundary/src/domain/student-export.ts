import { writeFileSync } from 'node:fs';

export interface StudentGrade {
  studentId: string;
  grade: string;
}

export function exportStudentGrade(student: StudentGrade, destination: string): void {
  const summary = `${student.studentId},${student.grade}\n`;
  writeFileSync(destination, summary, 'utf8');
}
