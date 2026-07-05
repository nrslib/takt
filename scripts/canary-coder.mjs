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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
try {
  const result = spawnSync('node', [join(repoRoot, 'bin', 'takt'), '-t', task, '-w', 'canary', '--pipeline', '--skip-git', '-q'], {
    cwd: workDir,
    encoding: 'utf-8',
    timeout: 10 * 60 * 1000,
  });

  if (result.error) {
    console.error(`spawn failed: ${result.error.message}`);
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  // ツール失敗行（✗ <ツール名>:）を数える。ストリーム表示の文言に結合して
  // いるのは既知の制約: セッションログは現状 step/phase イベントのみで
  // ツール粒度を持たないため、構造化カウントには takt 側の拡張が要る。
  const toolErrors = (output.match(/^\s*✗ \S+:/gm) ?? []).length;
  const runCompleted = result.status === 0 && !/aborted/i.test(output);
  // 完了宣言だけの空振りを弾く: 成果物の実在と内容まで確認する
  const artifactPath = join(workDir, 'greet.ts');
  const artifactOk = existsSync(artifactPath)
    && /export\s+(function\s+greet|const\s+greet)/.test(readFileSync(artifactPath, 'utf-8'));

  console.log(output.split('\n').slice(-15).join('\n'));
  console.log(`---\ncanary result: completed=${runCompleted} artifact=${artifactOk} toolErrors=${toolErrors}`);

  const TOOL_ERROR_BUDGET = 5;
  if (!runCompleted || !artifactOk || toolErrors > TOOL_ERROR_BUDGET) {
    console.error(`canary FAILED (completed=${runCompleted}, artifact=${artifactOk}, toolErrors=${toolErrors} > budget ${TOOL_ERROR_BUDGET})`);
    // process.exit は finally を飛ばすため、exitCode で自然終了させる
    process.exitCode = 1;
  } else {
    console.log('canary OK');
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
