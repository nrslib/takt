import { describe, expect, it } from 'vitest';
import { buildSummaryPrompt } from '../features/interactive/interactive-summary.js';
import { buildInteractiveSystemPrompt } from '../features/interactive/conversationPlan.js';
import { getLabel } from '../shared/i18n/index.js';
import {
  buildFormalSpecGenerationPrompt,
  buildFormalSpecGenerationSystemPrompt,
  buildFormalSpecInterpretationPrompt,
  buildFormalSpecInterpretationSystemPrompt,
  getFormalSpecVerificationArtifactPaths,
  getFormalSpecRetainedArtifactsMessage,
} from '../features/interactive/formalSpecPrompts.js';

describe('verification artifact retention guidance', () => {
  it.each(['en', 'ja'] as const)('selects confirmed retention or manual recovery instructions for %s', (lang) => {
    const retained = buildFormalSpecInterpretationSystemPrompt(lang, 'passed');
    const unconfirmed = buildFormalSpecInterpretationSystemPrompt(lang, 'error');
    const retentionClaim = lang === 'ja' ? /成果物は保持されています/ : /artifacts are retained/;

    expect(retained).toMatch(retentionClaim);
    expect(retained).toMatch(lang === 'ja' ? /手動で削除/ : /remove them manually/);
    expect(unconfirmed).toMatch(lang === 'ja' ? /保持は確定できません/ : /could not be confirmed/);
    expect(unconfirmed).toMatch(lang === 'ja' ? /手動で退避/ : /copy any needed artifacts manually/);
    expect(unconfirmed).not.toMatch(retentionClaim);
  });

  it.each(['en', 'ja'] as const)('does not infer retention when no status is reported for %s', (lang) => {
    const prompt = buildFormalSpecInterpretationSystemPrompt(lang, undefined);

    expect(prompt).toMatch(lang === 'ja' ? /保持状態は報告されていません/ : /No retention status was reported/);
    expect(prompt).not.toMatch(lang === 'ja' ? /成果物は保持されています/ : /artifacts are retained/);
    expect(prompt).toMatch(lang === 'ja' ? /成功時の成果物は解釈後に削除/ : /Successful verification artifacts are removed after interpretation/);
  });
});

describe('retained verification artifact notice', () => {
  it.each(['en', 'ja'] as const)('reports failed and error artifact paths in %s', (lang) => {
    for (const verdict of ['failed', 'error'] as const) {
      const result = {
        verdict, verificationStarted: true,
        artifactRetention: { status: 'passed' as const },
        quint: { status: verdict }, alloy: { status: 'skipped' as const },
        artifacts: { runDirectory: '/repo/.takt/runs/verify-test', specifications: {}, logs: {} },
      };
      expect(getFormalSpecRetainedArtifactsMessage(result, lang)).toContain(result.artifacts.runDirectory);
      expect(getFormalSpecRetainedArtifactsMessage({ ...result, verdict: 'passed' }, lang)).toBeUndefined();
      expect(getFormalSpecRetainedArtifactsMessage({ ...result, artifacts: undefined }, lang)).toBeUndefined();
    }
  });

  it.each(['en', 'ja'] as const)('reports retention diagnostics and distinguishes unconfirmed retention in %s', (lang) => {
    const path = '/repo/.takt/runs/verify-retention-error';
    const writeError = 'retention marker write failed';
    const moveError = 'retention marker move failed';
    for (const status of ['passed', 'error'] as const) {
      const result = {
        verdict: 'failed' as const, verificationStarted: true,
        quint: { status: 'skipped' as const }, alloy: { status: 'failed' as const },
        artifacts: { runDirectory: path, specifications: {}, logs: {} },
        artifactRetention: { status, message: status === 'passed' ? writeError : `${writeError}\n${moveError}` },
      };
      const notice = getFormalSpecRetainedArtifactsMessage(result, lang)!;
      expect(notice).toContain(path);
      expect(notice).toContain(writeError);
      const heading = notice.split('\n')[0]!;
      if (status === 'error') {
        expect(notice).toContain(moveError);
        expect(heading).toMatch(lang === 'ja' ? /確定できません/ : /could not be confirmed/);
      } else {
        expect(heading).toMatch(lang === 'ja' ? /保持しました/ : /retained at/);
      }
    }
  });
});

function renderInteractivePrompt(
  lang: 'en' | 'ja',
  formalSpec: boolean,
  grillMe = false,
  formalSpecComments = true,
): string {
  return buildInteractiveSystemPrompt(lang, {
    formalSpec,
    formalSpecComments,
    grillMe,
  });
}

function renderAssistantRetryPrompt(lang: 'en' | 'ja', enabled: boolean): string {
  const input = {
    grillMe: false,
    enableTellCommand: false,
    enableAssistantRetryCommands: enabled,
  };
  return buildInteractiveSystemPrompt(
    lang,
    input as unknown as Parameters<typeof buildInteractiveSystemPrompt>[1],
  );
}

function renderJapaneseSummaryPrompt(formalSpec: boolean, formalSpecComments = true): string {
  return buildSummaryPrompt(
    [{ role: 'user', content: '状態を更新する機能を追加する' }],
    false,
    'ja',
    '会話記録なし',
    '会話:',
    undefined,
    undefined,
    undefined,
    formalSpec,
    false,
    formalSpecComments,
  );
}

function renderEnglishSummaryPrompt(formalSpec: boolean, formalSpecComments = true): string {
  return buildSummaryPrompt(
    [{ role: 'user', content: 'Add a stateful feature' }],
    false,
    'en',
    'No transcript',
    'Conversation:',
    undefined,
    undefined,
    undefined,
    formalSpec,
    false,
    formalSpecComments,
  );
}

function expectNoUnexpandedTemplateVariables(prompt: string): void {
  expect(prompt).not.toMatch(/\{\{|\}\}/u);
}

describe('interactive formal specification prompt template wiring', () => {
  it.each(['en', 'ja'] as const)(
    'applies formal specification and comment switches independently for %s',
    (lang) => {
      const withoutFormalSpec = renderInteractivePrompt(lang, false, false, false);
      const withoutFormalSpecButCommentsEnabled = renderInteractivePrompt(lang, false, false, true);
      const withoutComments = renderInteractivePrompt(lang, true, false, false);
      const withComments = renderInteractivePrompt(lang, true, false, true);
      const withDefaultComments = renderInteractivePrompt(lang, true);

      expect(withoutFormalSpecButCommentsEnabled).toBe(withoutFormalSpec);
      expect(withoutComments).not.toBe(withoutFormalSpec);
      expect(withComments).not.toBe(withoutComments);
      expect(withComments.length).toBeGreaterThan(withoutComments.length);
      expect(withDefaultComments).toBe(withComments);
    },
  );
});

describe('assistant task retry prompt guidance', () => {
  it.each(['en', 'ja'] as const)(
    'describes task and run artifact locations and gates command guidance for %s',
    (lang) => {
      const available = renderAssistantRetryPrompt(lang, true);
      const unavailable = renderAssistantRetryPrompt(lang, false);

      for (const artifact of [
        '.takt/tasks.yaml',
        '.takt/runs/',
        'logs/*.jsonl',
        'meta.json',
        'logs/',
        'reports/',
        'subworkflows/',
        'trace.md',
        'interventions.jsonl',
        'order.md',
        'UTC',
        'status',
        'failure',
        'worktree_path',
        'task_dir',
        'source_run_slug',
        'run_slug',
        'start_step',
        'resume_mode',
        'resume_point',
        'restart_point',
        'retry_note',
        'exceeded_',
        'step_complete',
        'phase_complete',
      ]) {
        expect(available).toContain(artifact);
      }
      expect(available).toContain('/requeue');
      expect(available).toContain('/retry');
      expect(available).toContain(lang === 'en'
        ? 'Both commands ask for confirmation and leave the workflow pending.'
        : 'どちらも確認後は pending に戻り、workflow はその場で開始しません。');
      expect(unavailable).toContain(getLabel(
        'interactive.ui.assistantRetryUnavailableGuidance',
        lang,
      ));
      if (lang === 'en') {
        expect(unavailable).not.toContain('Web UI cannot change task state');
      } else {
        expect(unavailable).not.toContain('Web UI からタスク状態を変更できない');
      }
      expectNoUnexpandedTemplateVariables(available);
      expectNoUnexpandedTemplateVariables(unavailable);
    },
  );
});

describe('formal specification generation context wiring', () => {
  it.each(['en', 'ja'] as const)('preserves the unique initial agreement inside its stable delimiter for %s', (lang) => {
    const initialAgreement = `unique-initial-agreement-${lang}-8b7e2d`;
    const prompt = buildFormalSpecGenerationPrompt(lang, initialAgreement);

    expect(prompt).toContain(`<initial-user-input>\n${initialAgreement}\n</initial-user-input>`);
  });
});

describe.each(['en', 'ja'] as const)('Quint scenario system prompt contract (%s)', (lang) => {
  describe.each(['generation', 'interpretation'] as const)('%s', (purpose) => {
    const prompt = purpose === 'generation'
      ? buildFormalSpecGenerationSystemPrompt(lang)
      : buildFormalSpecInterpretationSystemPrompt(lang, undefined);

    it('explains execution of main-module run declarations and failure of unsatisfied expectations', () => {
      const execution = lang === 'ja'
        ? /シナリオの\s*`run`\s*宣言[^。\n]*。\s*main module[^。\n]*`quint test`\s*で実行/u
        : /Scenario\s+`run`\s+declarations[^.\n]*\.\s*When[^.\n]*main module[^.\n]*executes them with\s+`quint test`/u;
      const failure = lang === 'ja'
        ? /`expect`\s*が成り立たなければ\s*不合格/u
        : /unsatisfied\s+`expect`\s+fails verification/u;

      expect(prompt).toMatch(execution);
      expect(prompt).toMatch(failure);

      const withoutExecution = prompt.replace(lang === 'ja'
        ? /`quint test`\s*で実行し、/u
        : /TAKT executes them with\s+`quint test`\s+after\s+`quint run`\s+passes;/u, '');
      const withoutFailure = prompt.replace(lang === 'ja'
        ? /`expect`\s*が成り立たなければ不合格にする。/u
        : /an unsatisfied\s+`expect`\s+fails verification\./u, '');
      const reversedFailure = prompt.replace(lang === 'ja'
        ? /不合格にする/u
        : /fails verification/u, lang === 'ja' ? '合格にする' : 'passes verification');

      expect(withoutExecution).not.toMatch(execution);
      expect(withoutFailure).not.toMatch(failure);
      expect(reversedFailure).not.toMatch(failure);
    });

    it('shows parameterized initialization called by init with a nondeterministic value and by run with a concrete value', () => {
      const examples = [...prompt.matchAll(/```quint\s*\n([\s\S]*?)```/gu)].map((match) => match[1]!);
      const example = examples.find((code) => /action\s+initWith\s*\(/u.test(code));
      expect(example).toBeDefined();
      const code = example!;
      const parameterizedAction = /\baction\s+initWith\s*\(\s*\w+\s*:\s*\w+\s*\)/u;
      const initCall = /\baction\s+init\s*=\s*\{\s*nondet\s+(\w+)\s*=[^{}]*?\.oneOf\(\)\s+initWith\(\s*\1\s*\)\s*\}/u;
      const runCall = /\brun\s+\w+\s*=\s*initWith\(\s*"[^"\n]+"\s*\)\s*\.then\(/u;

      expect(code).toMatch(parameterizedAction);
      expect(code).toMatch(initCall);
      expect(code).toMatch(runCall);

      const withoutParameter = code.replace(/initWith\([^)]*:\s*\w+\s*\)/u, 'initWith()');
      const withoutInitCall = code.replace(/action\s+init\s*=\s*\{[^{}]*\}/u,
        'action init = all { mode\' = "a", n\' = 0 }');
      const withoutRunCall = code.replace(/(\brun\s+\w+\s*=\s*)initWith\("[^"\n]+"\)/u, '$1init');

      expect(withoutParameter).not.toMatch(parameterizedAction);
      expect(withoutInitCall).not.toMatch(initCall);
      expect(withoutInitCall).toMatch(runCall);
      expect(withoutRunCall).not.toMatch(runCall);
      expect(withoutRunCall).toMatch(initCall);
    });

    it('explains init.then as a transition to the next state without overriding initial values', () => {
      const transition = lang === 'ja'
        ? /`init\.then\(\.\.\.\)`\s*は[^。\n]*次の状態への遷移/u
        : /`init\.then\(\.\.\.\)`\s+transitions to the state after init/u;
      const noOverride = lang === 'ja'
        ? /`init\.then\(\.\.\.\)`[^。\n]*初期値の上書きではない/u
        : /`init\.then\(\.\.\.\)`[^.\n]*does not override initial values/u;

      expect(prompt).toMatch(transition);
      expect(prompt).toMatch(noOverride);

      const withoutTransition = prompt.replace(lang === 'ja'
        ? /init の次の状態への遷移であり、/u
        : /transitions to the state after init;/u, '');
      const reversedOverride = prompt.replace(lang === 'ja'
        ? /上書きではない/u
        : /does not override/u, lang === 'ja' ? '上書きである' : 'does override');

      expect(withoutTransition).not.toMatch(transition);
      expect(withoutTransition).toMatch(noOverride);
      expect(reversedOverride).not.toMatch(noOverride);
      expect(reversedOverride).toMatch(transition);
    });
  });
});

describe('Quint scenario result interpretation', () => {
  it.each(['en', 'ja'] as const)('transfers the test stage and its diagnostic artifact paths for %s', (lang) => {
    const test = { status: 'failed' as const, message: 'runBad: expectation failed' };
    const result = {
      verdict: 'failed' as const, verificationStarted: true,
      quint: { status: 'failed' as const, test },
      alloy: { status: 'skipped' as const },
      artifacts: {
        runDirectory: '/verify', specifications: { quint: '/verify/specs/spec.qnt' },
        logs: { 'quint-test': { stdout: '/verify/logs/quint-test.stdout.log', stderr: '/verify/logs/quint-test.stderr.log' } },
      },
    };

    const prompt = buildFormalSpecInterpretationPrompt(result, 'generated model', lang);
    const json = prompt.split('<verification-result>')[1]!.split('</verification-result>')[0]!;
    const paths = prompt.split('<verification-artifact-paths>')[1]!.split('</verification-artifact-paths>')[0]!.trim().split('\n');

    expect(JSON.parse(json).quint.test).toEqual(test);
    expect(paths).toEqual(expect.arrayContaining(Object.values(result.artifacts.logs['quint-test'])));
  });
});

describe('task instruction formal specification prompt template wiring', () => {
  it.each([
    ['en', renderEnglishSummaryPrompt],
    ['ja', renderJapaneseSummaryPrompt],
  ] as const)(
    'applies formal specification and comment switches independently for %s',
    (_lang, renderPrompt) => {
      const withoutFormalSpec = renderPrompt(false, false);
      const withoutFormalSpecButCommentsEnabled = renderPrompt(false, true);
      const withoutComments = renderPrompt(true, false);
      const withComments = renderPrompt(true, true);
      const withDefaultComments = renderPrompt(true);

      expect(withoutFormalSpecButCommentsEnabled).toBe(withoutFormalSpec);
      expect(withoutComments).not.toBe(withoutFormalSpec);
      expect(withComments).not.toBe(withoutComments);
      expect(withComments.length).toBeGreaterThan(withoutComments.length);
      expect(withDefaultComments).toBe(withComments);
    },
  );
});

describe('Alloy run/check generation and interpretation contract', () => {
  it.each(['en', 'ja'] as const)('requires consistency runs and exposes both command kinds for %s', (lang) => {
    const prompt = buildFormalSpecGenerationSystemPrompt(lang);
    const policyJson = prompt.split('<takt-formal-spec-generation-policy>')[1]!.split('</takt-formal-spec-generation-policy>')[0]!;
    expect(JSON.parse(policyJson).alloy).toEqual({ targetCommands: ['run', 'check'], consistencyRunRequired: true });
  });

  it.each(['en', 'ja'] as const)('passes each command result and its receipt/trace artifacts to interpretation for %s', (lang) => {
    const commandResults = [
      { number: 0, type: 'run', label: 'Scenario', status: 'failed' as const, message: 'UNSAT' },
      { number: 1, type: 'check', label: 'Safety', status: 'passed' as const },
      { number: 2, type: 'check', label: 'Slow', status: 'error' as const, timedOut: true },
    ];
    const result = {
      verdict: 'failed' as const, verificationStarted: true,
      quint: { status: 'skipped' as const },
      alloy: { status: 'failed' as const, checks: [1], commandResults },
      artifacts: {
        runDirectory: '/verify', specifications: { alloy: '/verify/specs/spec.als' },
        alloyOutputs: ['/verify/alloy-run-0/receipt.json', '/verify/alloy-check-1/Safety-solution-0.txt'],
        logs: { 'alloy-run-0': { stdout: '/verify/logs/run.stdout', stderr: '/verify/logs/run.stderr' } },
      },
    };
    const prompt = buildFormalSpecInterpretationPrompt(result, 'generated model', lang);
    for (const path of getFormalSpecVerificationArtifactPaths(result)) expect(prompt).toContain(path);
    const json = prompt.split('<verification-result>')[1]!.split('</verification-result>')[0]!;
    expect(JSON.parse(json).alloy.commandResults).toEqual(commandResults);
    expect(JSON.parse(json).alloy.checks).toEqual([1]);
  });
});
