import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from '../../dist/agents/runner.js';
import { Phase1ExecutionLog } from '../../dist/core/workflow/phase1-execution-log.js';
import { ReportInstructionBuilder } from '../../dist/core/workflow/instruction/ReportInstructionBuilder.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifactPath = join(root, 'eval/results/phase1-execution-log-handoff/live-helper-chain-20261028.json');
const model = 'gpt-6.1-terra';
const reasoningEffort = 'medium';
const cwd = mkdtempSync(join(tmpdir(), 'takt-phase1-log-live-'));
const sample = 'export function add(a: number, b: number) { return a + b; }\n';
const task = 'sample.ts を実際に読み、加算関数のコードレビューをしてください。最後は構造化出力の result に APPROVE または REJECT だけ返してください。';
const format = '# コーディングレビュー\n## 結果\n## 実際に確認した範囲\n## 指摘\n## 未確認事項';
const common = {
  cwd,
  resolvedExecution: {
    provider: 'codex', model,
    providerOptions: { codex: { reasoningEffort } },
    permissionMode: 'readonly',
  },
  language: 'ja',
  mcpServers: {},
};

try {
  writeFileSync(join(cwd, 'sample.ts'), sample);
  const log = new Phase1ExecutionLog();
  const phase1 = await runAgent('コードレビュアー。確認した内容だけに基づいて判断してください。', task, {
    ...common,
    executionPhase: 1,
    outputSchema: {
      type: 'object',
      properties: { result: { type: 'string', enum: ['APPROVE', 'REJECT'] } },
      required: ['result'],
      additionalProperties: false,
    },
    onPromptResolved: (prompt) => log.recordInstruction('initial', prompt),
    onDispatch: () => log.markDispatched(),
    onStream: (event) => log.recordEvent(event),
  });
  log.recordResult(phase1);
  if (phase1.status !== 'done') throw new Error(`Phase 1 failed: ${phase1.error ?? phase1.content}`);

  const step = {
    name: 'review', persona: 'coding-reviewer', personaDisplayName: 'Coding Reviewer',
    instruction: task, outputContracts: [{ name: 'review.md', format }],
  };
  const phase2Prompt = new ReportInstructionBuilder(step, {
    cwd, task, reportDir: join(cwd, '.takt/reports'), stepIteration: 1,
    language: 'ja', targetFile: 'review.md', lastResponse: phase1.content,
    phase1ExecutionLog: log.toReportInput(),
  }).build();
  let resolvedPhase2Prompt;
  const phase2 = await runAgent('レポート担当。今回の記録だけに基づいて回答してください。', phase2Prompt, {
    ...common, executionPhase: 2, allowedTools: [],
    onPromptResolved: (prompt) => { resolvedPhase2Prompt = prompt; },
  });
  if (phase2.status !== 'done') throw new Error(`Phase 2 failed: ${phase2.error ?? phase2.content}`);

  const artifact = {
    evaluationKind: 'SDK/helper chain, not a full WorkflowEngine run',
    fixture: { file: 'sample.ts', content: sample },
    provider: { name: 'codex', model, reasoningEffort },
    phase1: {
      task, status: phase1.status, content: phase1.content,
      structuredOutput: phase1.structuredOutput,
      executionLog: JSON.parse(log.toReportInput()),
    },
    phase2: {
      prompt: resolvedPhase2Prompt ?? { userInstruction: phase2Prompt },
      status: phase2.status, content: phase2.content,
    },
  };
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  const entries = artifact.phase1.executionLog;
  console.log(JSON.stringify({ artifactPath, model, reasoningEffort, phase1Status: phase1.status,
    phase2Status: phase2.status, toolUse: entries.filter((entry) => entry.kind === 'provider_event' && entry.event.type === 'tool_use').length,
    toolResult: entries.filter((entry) => entry.kind === 'provider_event' && entry.event.type === 'tool_result').length }, null, 2));
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
