import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

import buildPrompt from '../interactive-topic-boundary-prompt.mjs';
import assertCurrent from './interactive-topic-current.mjs';
import assertPrevious from './interactive-topic-previous.mjs';
import assertReplay from './interactive-topic-replay.mjs';
import assertContinuation from './interactive-topic-continuation.mjs';
import { persistGeneratedOutput } from '../providers/interactive-topic-judge.mjs';
import { buildInteractiveSystemPrompt } from '../../src/features/interactive/conversationPlan.ts';
import { buildSummaryPrompt } from '../../src/features/interactive/interactive-summary.ts';
import { buildTellConversationPrompt } from '../../src/features/interactive/tellCommand.ts';
import { prependInteractiveTopicBoundary } from '../../src/features/interactive/promptSections.ts';
import { loadTemplate } from '../../src/shared/prompts/index.ts';

for (const language of ['ja', 'en']) {
  test(`${language} eval and runtime assemble the same topic boundary on all three paths`, () => {
    const boundary = loadTemplate('parts/interactive_topic_boundary', language).trim();
    const continuation = buildPrompt({
      vars: { language, scenario: 'continuation', fixture: 'separate', mode: 'assistant' },
    });
    const runtimeInteractive = buildInteractiveSystemPrompt(language, { grillMe: false });
    assert.ok(runtimeInteractive.startsWith(`${boundary}\n\n---\n\n`));
    assert.ok(continuation.includes(`SYSTEM:\n${boundary}\n\n---\n\n`));

    const fixturePath = new URL('../cases/interactive-topic-boundary/separate.yaml', import.meta.url);
    const history = parse(readFileSync(fixturePath, 'utf8'))[language];
    const runtimeSummary = buildSummaryPrompt(
      history, false, language, '', language === 'ja' ? '会話履歴' : 'Conversation history',
    );
    const go = buildPrompt({ vars: { language, scenario: 'go', fixture: 'separate' } });
    assert.ok(go.endsWith(runtimeSummary), 'eval /go payload must equal the runtime builder output');

    const runtimeTellSystem = prependInteractiveTopicBoundary(
      language, loadTemplate('score_tell_system_prompt', language),
    );
    for (const fixture of ['tell-separate', 'tell-prior-recipient']) {
      const tellFixturePath = new URL(`../cases/interactive-topic-boundary/${fixture}.yaml`, import.meta.url);
      const tellHistory = parse(readFileSync(tellFixturePath, 'utf8'))[language];
      const recipient = fixture === 'tell-separate'
        ? (language === 'ja'
          ? { name: 'Quint 検証', summary: 'Quint 診断の改善' }
          : { name: 'Quint validation', summary: 'Improve Quint diagnostics' })
        : (language === 'ja'
          ? { name: 'caccia', summary: 'レビュー指摘への対応' }
          : { name: 'caccia', summary: 'Handle review findings' });
      const tell = buildPrompt({ vars: { language, scenario: 'tell', fixture } });
      const runtimeTellUser = buildTellConversationPrompt(tellHistory, language, { task: recipient });
      assert.ok(tell.includes(`SYSTEM:\n${runtimeTellSystem}\n\nUSER:`));
      assert.ok(tell.endsWith(`USER:\n${runtimeTellUser}`),
        `${language}/${fixture} eval USER payload must equal the runtime builder output`);
    }
  });
}

for (const language of ['ja', 'en']) {
  for (const scenario of ['continuation', 'go', 'tell']) {
    test(`${language}/${scenario} renders actual source template and A-to-B conversation`, () => {
      const fixture = scenario === 'tell' ? 'tell-separate' : 'separate';
      const prompt = buildPrompt({ vars: { language, scenario, fixture, mode: 'grill' } });
      assert.match(prompt, /caccia/);
      assert.match(prompt, /Quint/);
      assert.match(prompt, /formalSpecPrompts\.ts/);
      assert.doesNotMatch(prompt, /\{\{(?:#if|\/if|[a-zA-Z])/, 'template variables must be rendered');
    });
  }
}

test('assistant and Grill Me branches both render from the source template', () => {
  const vars = { language: 'en', scenario: 'continuation', fixture: 'separate' };
  const assistant = buildPrompt({ vars: { ...vars, mode: 'assistant' } });
  const grill = buildPrompt({ vars: { ...vars, mode: 'grill' } });
  assert.match(assistant, /Interactive Mode Assistant/);
  assert.match(grill, /Grill Me/);
  assert.notEqual(assistant, grill);
});

test('separate task assertions require B details and reject older A identifiers', () => {
  const context = { vars: { scenario: 'go', fixture: 'separate' } };
  const currentOnly = 'Quint in formalSpecPrompts.ts: show the syntax-error line number and cause.';
  assert.equal(assertCurrent(currentOnly, context).pass, true);
  assert.equal(assertPrevious(currentOnly, context).pass, true);
  assert.equal(assertCurrent('Quint in formalSpecPrompts.ts', context).pass, false);
  assert.equal(assertCurrent('formalSpecPrompts.ts: show the syntax-error line number and cause.', context).pass, true);
  assert.equal(assertPrevious(`${currentOnly} Include CodeRabbit caccia.`, context).pass, false);
});

test('combined task assertion requires the previous file and acceptance condition', () => {
  const context = { vars: { scenario: 'go', fixture: 'combined' } };
  const current = 'Quint in formalSpecPrompts.ts: show the syntax-error line number and cause.';
  assert.equal(assertPrevious(`${current} Mention caccia.`, context).pass, false);
  assert.equal(assertPrevious(`${current} Add caccia under src/features/caccia/ with zero unresolved review threads.`, context).pass, true);
  assert.equal(assertPrevious(`${current} Add caccia under src/features/caccia/ with zero unresolved threads.`, context).pass, true);
  assert.equal(assertPrevious(`${current} Add caccia under src/features/caccia/. Then unresolved review thread が 0 件である。`, context).pass, true);
  assert.equal(assertPrevious(`${current} Add caccia under src/features/caccia/. Then unresolved review threads が存在しない。`, context).pass, true);
  assert.equal(assertPrevious(`${current} Add caccia under src/features/caccia/. Rule: 未解決の review thread を残さない。`, context).pass, true);
  assert.equal(assertPrevious(`${current} Add caccia under src/features/caccia/. Ensure unresolved review threads do not remain.`, context).pass, true);
  assert.equal(assertPrevious(`${current} Add caccia under src/features/caccia/. 未解決のレビューコメントがゼロであること。`, context).pass, true);
  assert.equal(assertPrevious(`${current} Add caccia under src/features/caccia/. Require zero unresolved review comments.`, context).pass, true);
  assert.equal(assertPrevious(`${current} Add caccia under src/features/caccia/. 未解決スレッドがゼロではない。`, context).pass, false);
  assert.equal(assertPrevious(`${current} Add caccia under src/features/caccia/. 未解決の review thread を残さないとは限らない。`, context).pass, false);
  assert.equal(assertPrevious(`${current} Add caccia under src/features/caccia/. unresolved review threads が存在しないわけではない。`, context).pass, false);
  assert.equal(assertPrevious(`${current} Add caccia under src/features/caccia/. There must not be zero unresolved review threads.`, context).pass, false);
  assert.equal(assertPrevious(`${current} Add caccia under src/features/caccia/. There are non-zero unresolved review threads.`, context).pass, false);
  assert.equal(assertPrevious(`${current} Add caccia under src/features/caccia/. It is not required that unresolved review threads do not remain.`, context).pass, false);
  assert.equal(assertPrevious(`${current} Add caccia under src/features/caccia/. Unresolved review threads are absent is optional.`, context).pass, false);
  assert.equal(assertPrevious(`${current} Add caccia under src/features/caccia/. 未解決の review thread を残さないことは必須ではない。`, context).pass, false);
  assert.equal(assertPrevious(`${current} Add caccia under src/features/caccia/. 未解決の review thread が存在しないのは任意。`, context).pass, false);
  assert.equal(assertPrevious(`${current} Add caccia under src/features/caccia/. 一般コメントがゼロであること。`, context).pass, false);
  assert.equal(assertPrevious(`${current} Add caccia under src/features/caccia/. レビューコメントがゼロであること。`, context).pass, false);
  assert.equal(assertPrevious(`${current} Add caccia under src/features/caccia/. 未解決のレビューコメントをゼロにするかは任意。`, context).pass, false);
  assert.equal(assertPrevious(`${current} Add caccia under src/features/caccia/. Zero general comments are required.`, context).pass, false);
});

for (const language of ['ja', 'en']) {
  test(`${language}/tell selected earlier recipient requires its requirements and excludes the final task`, () => {
    const context = { vars: { scenario: 'tell', fixture: 'tell-prior-recipient' } };
    const correct = 'Add CodeRabbit caccia under src/features/caccia/ with zero unresolved review threads.';
    assert.equal(assertCurrent(correct, context).pass, true);
    assert.equal(assertPrevious(correct, context).pass, true);
    assert.equal(assertCurrent('Add caccia for CodeRabbit.', context).pass, false);
  assert.equal(assertPrevious(`${correct} Also change Quint diagnostics.`, context).pass, false);
  assert.equal(assertCurrent('caccia under src/features/caccia/ with 未解決のレビューコメントがゼロ。', context).pass, true);
  assert.equal(assertCurrent('caccia under src/features/caccia/ with 一般コメントがゼロ。', context).pass, false);
  assert.equal(assertPrevious('Quint 診断では未解決のレビューコメントがゼロ。', { vars: { scenario: 'go', fixture: 'separate' } }).pass, false);
    const prompt = buildPrompt({ vars: { language, scenario: 'tell', fixture: 'tell-prior-recipient' } });
    assert.match(prompt, /caccia/);
    assert.match(prompt, /Quint/);
    assert.doesNotMatch(
      prompt.split(language === 'ja' ? '会話履歴（引用された参照データ）:' : 'Conversation history (quoted reference data):')[0],
      /zero unresolved|未解決スレッド/,
      'recipient metadata must identify the task without supplying the acceptance answer',
    );
  });
}

for (const language of ['ja', 'en']) {
  test(`${language}/go keeps researched facts and explicit adoption distinguishable`, () => {
    const common = { language, scenario: 'go' };
    const unadopted = buildPrompt({ vars: { ...common, fixture: 'research-unadopted' } });
    const adopted = buildPrompt({ vars: { ...common, fixture: 'research-adopted' } });
    assert.match(unadopted, /buildFormalSpecInterpretationPrompt/);
    assert.match(unadopted, /formatQuintDiagnostic/);
    assert.match(adopted, /formatQuintDiagnostic/);
    assert.notEqual(unadopted, adopted);
  });
}

test('research cases measure the B outcome without requiring an assistant-identified file', () => {
  const context = { vars: { scenario: 'go', fixture: 'research-unadopted' } };
  const outcome = 'Improve Quint diagnostics: show the error line number and cause.';
  assert.equal(assertCurrent(outcome, context).pass, true);
  assert.equal(assertPrevious(outcome, context).pass, true);
  assert.equal(assertCurrent('Improve Quint diagnostics.', context).pass, false);
});

test('text-only replay rejects simulated tool exchanges in every output path', () => {
  assert.equal(assertReplay('Quint の診断を確認します。\n**Tool Use: Glob**\n**Tool Result:**').pass, false);
  assert.equal(assertReplay('Quint の構文エラーに行番号と原因を表示する。').pass, true);
});

test('continuation requires a B question or requirements summary and rejects invented inspection', () => {
  assert.equal(assertContinuation('Quint の診断を調査します。').pass, false);
  assert.equal(assertContinuation('Quint の構文エラーは行番号と原因を表示する要件です。').pass, true);
  assert.equal(assertContinuation('Quint の診断では列番号も必要ですか？').pass, true);
  assert.equal(assertContinuation('formalSpecPrompts.ts の診断では列番号も必要ですか？').pass, true);
  assert.equal(assertContinuation('Quint のファイルが見つかりませんでした。行番号と原因を表示します。').pass, false);
  const context = { vars: { scenario: 'continuation', fixture: 'separate' } };
  const observed = '推奨: 検証結果に複数のエラーがある場合は全件を表示し、行番号が取得できないエラーは原因と「行番号不明」を表示します。複数エラーも受入対象にしますか？';
  assert.equal(assertCurrent(observed, context).pass, true);
  assert.equal(assertContinuation(observed).pass, true);
  const syntaxSummary = '構文エラーの行番号と原因を表示する要件です。';
  assert.equal(assertCurrent(syntaxSummary, context).pass, true);
  assert.equal(assertContinuation(syntaxSummary).pass, true);
  const missingCause = '検証エラーの行番号を表示しますか？';
  assert.equal(assertCurrent(missingCause, context).pass, false);
  assert.equal(assertContinuation(missingCause).pass, false);
  const missingLine = 'Validation errors should show the cause. Is that enough?';
  assert.equal(assertCurrent(missingLine, context).pass, false);
  assert.equal(assertContinuation(missingLine).pass, false);
  const mixed = `${syntaxSummary} CodeRabbit caccia のレビューも進めます。`;
  assert.equal(assertPrevious(mixed, context).pass, false);
});

test('optional raw output artifact records prompt, model, vars, and response before grading', () => {
  const directory = mkdtempSync(join(tmpdir(), 'takt-interactive-output-test-'));
  try {
    const record = {
      prompt: 'source prompt',
      cli: 'claude',
      model: 'claude-opus-5',
      vars: { language: 'ja', scenario: 'go' },
      output: 'generated instruction',
    };
    persistGeneratedOutput(directory, record);
    const files = readdirSync(directory);
    assert.equal(files.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, files[0]), 'utf8')), record);
    const occupied = join(directory, 'occupied');
    writeFileSync(occupied, '');
    assert.throws(() => persistGeneratedOutput(occupied, record));
    assert.throws(() => persistGeneratedOutput(directory, { ...record, vars: undefined }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('all source-template paths use the same text-only replay constraint', () => {
  for (const language of ['ja', 'en']) {
    for (const scenario of ['continuation', 'go', 'tell']) {
      const fixture = scenario === 'tell' ? 'tell-separate' : 'separate';
      const prompt = buildPrompt({ vars: { language, scenario, fixture, mode: 'assistant' } });
      assert.match(prompt.split('\n\n')[0], language === 'ja' ? /評価用のテキスト再生/ : /text-only evaluation replay/);
    }
  }
});

test('both generator providers use the suite-specific isolated judge', () => {
  const path = new URL('../scenarios/interactive-topic-boundary/interactive-topic-boundary.yaml', import.meta.url);
  const config = parse(readFileSync(path, 'utf8'));
  assert.equal(config.providers.length, 2);
  assert.ok(config.providers.every(provider => provider.id === 'file://../../providers/interactive-topic-judge.mjs'));
  assert.deepEqual(config.providers.map(provider => provider.config.cli), ['claude', 'codex']);
});
