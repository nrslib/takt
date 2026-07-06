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
import { pathToFileURL } from 'node:url';
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
  // 完了宣言だけの空振りを弾く: 成果物は形ではなく挙動で検証する。
  // リポジトリの typescript devDep でトランスパイルして import 実行し、
  // 要求仕様どおりの戻り値かを直接確認する（正規表現による形の検査は
  // バイパス可能だった。Node の型ストリップは engines 下限の Node 20 に
  // 存在しないため使わない）。
  const artifactPath = join(workDir, 'greet.ts');
  let artifactOk = false;
  if (existsSync(artifactPath)) {
    const { default: ts } = await import('typescript');
    const transpiled = ts.transpileModule(readFileSync(artifactPath, 'utf-8'), {
      compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const probePath = join(workDir, 'greet.probe.mjs');
    writeFileSync(probePath, transpiled);
    try {
      const { greet } = await import(pathToFileURL(probePath).href);
      artifactOk = typeof greet === 'function' && greet('Takt') === 'Hello, Takt!';
    } catch (error) {
      console.error(`artifact probe failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

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
