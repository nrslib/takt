#!/usr/bin/env node
/**
 * coder canary: facet / instruction 変更が弱いモデルのツール呼び出しを
 * 不安定化させていないかを、実プロバイダでの小さな implement 1走で確認する。
 *
 * 使い方:
 *   npm run build && node scripts/canary-coder.mjs --provider opencode --model ollama-cloud/qwen3-coder-next
 *
 * PR ゲートではない（実プロバイダのコストがかかる）。InstructionBuilder や
 * builtins/{lang}/facets/instructions を変更したときの推奨手順。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
function argOf(flag) {
  const index = args.indexOf(flag);
  return index !== -1 ? args[index + 1] : undefined;
}
const provider = argOf('--provider');
const model = argOf('--model');
if (!provider || !model) {
  console.error('usage: node scripts/canary-coder.mjs --provider <provider> --model <model>');
  process.exit(2);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const workDir = mkdtempSync(join(tmpdir(), 'takt-canary-'));
const workflowDir = join(workDir, '.takt', 'workflows');
mkdirSync(workflowDir, { recursive: true });

// 単一 implement ステップの最小ワークフロー。現行の InstructionBuilder /
// builtins の組み立てをそのまま通す。
writeFileSync(join(workflowDir, 'canary.yaml'), [
  'name: canary',
  'max_steps: 1',
  'initial_step: implement',
  'steps:',
  '  - name: implement',
  '    persona: coder',
  `    provider: ${provider}`,
  `    model: ${model}`,
  '    instruction: |',
  '      タスクの内容を実装してください。実装が完了したら [STEP:1] を出力してください。',
  '    edit: true',
  '    rules:',
  '      - condition: 実装が完了した',
  '        next: COMPLETE',
  '      - condition: 実装を進められない',
  '        next: ABORT',
].join('\n'));

const task = 'greet.ts を作成し、greet(name: string): string 関数（"Hello, <name>!" を返す）を export してください。既存ファイルの変更は不要です。';

console.log(`canary: ${provider}/${model} @ ${workDir}`);
const result = spawnSync('node', [join(repoRoot, 'bin', 'takt'), '-t', task, '-w', 'canary', '--pipeline', '--skip-git', '-q'], {
  cwd: workDir,
  encoding: 'utf-8',
  timeout: 10 * 60 * 1000,
});

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
const toolErrors = (output.match(/✗ Tool/g) ?? []).length;
const completed = result.status === 0 && !/aborted/i.test(output);

console.log(output.split('\n').slice(-15).join('\n'));
console.log(`---\ncanary result: completed=${completed} toolErrors=${toolErrors}`);

rmSync(workDir, { recursive: true, force: true });

const TOOL_ERROR_BUDGET = 5;
if (!completed || toolErrors > TOOL_ERROR_BUDGET) {
  console.error(`canary FAILED (completed=${completed}, toolErrors=${toolErrors} > budget ${TOOL_ERROR_BUDGET})`);
  process.exit(1);
}
console.log('canary OK');
