import { ReportInstructionBuilder } from '../dist/core/workflow/instruction/ReportInstructionBuilder.js';

const format = [
  '# コーディングレビュー',
  '## 結果',
  '判定とその根拠を記載する。',
  '## 実際に確認した範囲',
  '確認したファイル、コマンドと結果を記載する。',
  '## 指摘',
  '確認できた問題だけを記載する。',
  '## 未確認事項',
  '実行記録から確認できない範囲を記載する。',
].join('\n');

export default function buildPhase1ExecutionLogPrompt({ vars }) {
  const log = JSON.parse(vars.phase1_log);
  if (!Array.isArray(log)) throw new Error('phase1_log must be a JSON array');
  const step = {
    name: 'review',
    persona: 'coding-reviewer',
    personaDisplayName: 'Coding Reviewer',
    instruction: vars.task,
    outputContracts: [{ name: 'coding-review.md', format }],
  };
  return new ReportInstructionBuilder(step, {
    cwd: '/fixture',
    task: vars.task,
    reportDir: '/fixture/.takt/reports',
    stepIteration: 1,
    language: 'ja',
    targetFile: 'coding-review.md',
    lastResponse: vars.last_response,
    phase1ExecutionLog: JSON.stringify(log),
  }).build();
}
