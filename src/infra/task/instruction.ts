export function buildTaskInstruction(taskDir: string, orderFile: string): string {
  return [
    `Implement using only the files in \`${taskDir}\`.`,
    `Primary spec: \`${orderFile}\`.`,
    'Use report files in Report Directory as primary execution history.',
    'Do not rely on previous response or conversation summary.',
  ].join('\n');
}
