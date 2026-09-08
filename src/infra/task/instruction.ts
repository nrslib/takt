export function buildTaskInstruction(taskDir: string, orderFile: string): string {
  return [
    `Implement using only the files in \`${taskDir}\`.`,
    `Primary spec: \`${orderFile}\`.`,
    'Use report files in Report Directory as primary execution history.',
  ].join('\n');
}
