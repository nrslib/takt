/**
 * Tests for Markdown template loader (src/shared/prompts/index.ts)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { loadTemplate, renderTemplate, _resetCache } from '../shared/prompts/index.js';
import { findDeprecatedTerms } from '../../test/helpers/deprecated-terminology.js';

beforeEach(() => {
  _resetCache();
});

describe('loadTemplate', () => {
  it('loads an English template', () => {
    const result = loadTemplate('score_slug_system_prompt', 'en');
    expect(result).toContain('You are a slug generator');
  });

  it('loads an English interactive template', () => {
    const result = loadTemplate('score_interactive_system_prompt', 'en');
    expect(result).toContain('Interactive Mode Assistant');
  });

  it('loads an English interactive policy template', () => {
    const result = loadTemplate('score_interactive_policy', 'en');
    expect(result).toContain('Interactive Mode Policy');
  });

  it('loads a Japanese template', () => {
    const result = loadTemplate('score_interactive_system_prompt', 'ja');
    expect(result).toContain('対話モードアシスタント');
  });

  it('loads a Japanese interactive policy template', () => {
    const result = loadTemplate('score_interactive_policy', 'ja');
    expect(result).toContain('対話モードポリシー');
  });

  it('loads an English retry system prompt template', () => {
    const result = loadTemplate('score_retry_system_prompt', 'en');
    expect(result).toContain('Retry Assistant');
  });

  it('loads a Japanese retry system prompt template', () => {
    const result = loadTemplate('score_retry_system_prompt', 'ja');
    expect(result).toContain('リトライアシスタント');
  });

  it('loads score_slug_system_prompt with explicit lang', () => {
    const result = loadTemplate('score_slug_system_prompt', 'en');
    expect(result).toContain('You are a slug generator');
  });

  it('throws for a non-existent template with language', () => {
    expect(() => loadTemplate('nonexistent_template', 'en')).toThrow('Template not found: nonexistent_template (lang: en)');
  });
});

describe('variable substitution', () => {
  it('replaces taskHistory variable in score_summary_system_prompt', () => {
    const result = loadTemplate('score_summary_system_prompt', 'en', {
      hasWorkflowPreview: true,
      workflowName: 'workflow',
      workflowDescription: 'desc',
      stepDetails: '',
      conversation: 'Conversation: User: test',
      taskHistory: '## Task execution history\n- Worktree ID: wt-1',
    });
    expect(result).toContain('## Task execution history');
    expect(result).toContain('Worktree ID: wt-1');
  });

  it('replaces sourceContext variable in score_summary_system_prompt', () => {
    const result = loadTemplate('score_summary_system_prompt', 'en', {
      hasWorkflowPreview: false,
      workflowName: '',
      workflowDescription: '',
      stepDetails: '',
      conversation: 'Conversation: User: test',
      taskHistory: '',
      sourceContext: '## Source Context\nPR context',
    });
    expect(result).toContain('## Source Context');
    expect(result).toContain('PR context');
  });

  it('replaces multiple different variables', () => {
    const result = loadTemplate('perform_judge_message', 'en', {
      agentOutput: 'test output',
      conditionList: '| 1 | Success |',
    });
    expect(result).toContain('test output');
    expect(result).toContain('| 1 | Success |');
  });

  it('interactive prompt does not contain workflow info', () => {
    const result = loadTemplate('score_interactive_system_prompt', 'en', {
      hasWorkflowPreview: true,
      workflowName: 'my-workflow',
      workflowDescription: 'Test description',
    });
    // ワークフロー情報はインタラクティブプロンプトには含まれない（要約プロンプトにのみ含まれる）
    expect(result).not.toContain('"my-workflow"');
    expect(result).not.toContain('Test description');
  });
});

describe('renderTemplate', () => {
  it('processes {{#if}} blocks with truthy value', () => {
    const template = 'before{{#if show}}visible{{/if}}after';
    const result = renderTemplate(template, { show: true });
    expect(result).toBe('beforevisibleafter');
  });

  it('processes {{#if}} blocks with falsy value', () => {
    const template = 'before{{#if show}}visible{{/if}}after';
    const result = renderTemplate(template, { show: false });
    expect(result).toBe('beforeafter');
  });

  it('processes {{#if}}...{{else}}...{{/if}} blocks', () => {
    const template = '{{#if flag}}yes{{else}}no{{/if}}';
    expect(renderTemplate(template, { flag: true })).toBe('yes');
    expect(renderTemplate(template, { flag: false })).toBe('no');
  });

  it('treats empty string as falsy', () => {
    const template = '{{#if value}}has value{{else}}empty{{/if}}';
    expect(renderTemplate(template, { value: '' })).toBe('empty');
  });

  it('treats non-empty string as truthy', () => {
    const template = '{{#if value}}has value{{else}}empty{{/if}}';
    expect(renderTemplate(template, { value: 'hello' })).toBe('has value');
  });

  it('handles undefined variable in condition as falsy', () => {
    const template = '{{#if missing}}yes{{else}}no{{/if}}';
    expect(renderTemplate(template, {})).toBe('no');
  });

  it('replaces boolean true with "true" string', () => {
    const template = 'value is {{flag}}';
    expect(renderTemplate(template, { flag: true })).toBe('value is true');
  });

  it('replaces boolean false with empty string', () => {
    const template = 'value is [{{flag}}]';
    expect(renderTemplate(template, { flag: false })).toBe('value is []');
  });
});

describe('template file existence', () => {
  const allTemplates = [
    'score_interactive_system_prompt',
    'score_interactive_policy',
    'score_summary_system_prompt',
    'score_slug_system_prompt',
    'score_slug_user_prompt',
    'perform_phase1_message',
    'perform_phase2_message',
    'perform_phase3_message',
    'perform_agent_system_prompt',
    'perform_judge_message',
  ];

  for (const name of allTemplates) {
    it(`en/${name}.md exists and is loadable`, () => {
      expect(() => loadTemplate(name, 'en')).not.toThrow();
    });

    it(`ja/${name}.md exists and is loadable`, () => {
      expect(() => loadTemplate(name, 'ja')).not.toThrow();
    });
  }
});

describe('caching', () => {
  it('returns consistent results on repeated calls', () => {
    const first = loadTemplate('score_slug_system_prompt', 'en');
    const second = loadTemplate('score_slug_system_prompt', 'en');
    expect(first).toBe(second);
  });

  it('reloads after cache reset', () => {
    const first = loadTemplate('score_slug_system_prompt', 'en');
    _resetCache();
    const second = loadTemplate('score_slug_system_prompt', 'en');
    expect(first).toBe(second);
  });
});

describe('template content integrity', () => {
  it('score_interactive_system_prompt contains persona definition', () => {
    const en = loadTemplate('score_interactive_system_prompt', 'en');
    expect(en).toContain('Interactive Mode Assistant');
    expect(en).toContain('Role Boundaries');

    const ja = loadTemplate('score_interactive_system_prompt', 'ja');
    expect(ja).toContain('対話モードアシスタント');
    expect(ja).toContain('役割の境界');
  });

  it('score_interactive_policy contains behavioral guidelines', () => {
    const en = loadTemplate('score_interactive_policy', 'en');
    expect(en).toContain('Interactive Mode Policy');
    expect(en).toContain('Principles');
    expect(en).toContain('Source Context Handling');
    expect(en).toContain('Strict Requirements');

    const ja = loadTemplate('score_interactive_policy', 'ja');
    expect(ja).toContain('対話モードポリシー');
    expect(ja).toContain('原則');
    expect(ja).toContain('Source Context の扱い');
    expect(ja).toContain('厳守事項');
  });

  it('score prompts use workflow/step terminology in both languages', () => {
    const interactiveEn = loadTemplate('score_interactive_system_prompt', 'en');
    expect(interactiveEn).toContain('workflow execution');
    expect(interactiveEn).toContain('## Workflow Structure');
    expect(interactiveEn).toContain('## Source Context Handling');
    expect(interactiveEn).toContain('**Workflow:** {{runWorkflow}}');
    expect(interactiveEn).toContain('### Step Logs');
    expect(findDeprecatedTerms(interactiveEn)).toEqual([]);

    const interactiveJa = loadTemplate('score_interactive_system_prompt', 'ja');
    expect(interactiveJa).toContain('ワークフロー実行用の指示書');
    expect(interactiveJa).toContain('## ワークフロー構成');
    expect(interactiveJa).toContain('## Source Context の扱い');
    expect(interactiveJa).toContain('**ワークフロー:** {{runWorkflow}}');
    expect(interactiveJa).toContain('### ステップログ');
    expect(findDeprecatedTerms(interactiveJa)).toEqual([]);

    const policyEn = loadTemplate('score_interactive_policy', 'en');
    expect(policyEn).toContain('instructions for the workflow');
    expect(policyEn).toContain('workflow agents');
    expect(findDeprecatedTerms(policyEn)).toEqual([]);

    const policyJa = loadTemplate('score_interactive_policy', 'ja');
    expect(policyJa).toContain('ワークフローへの指示書作成');
    expect(policyJa).toContain('ワークフローのエージェント');
    expect(findDeprecatedTerms(policyJa)).toEqual([]);

    const retryEn = loadTemplate('score_retry_system_prompt', 'en');
    expect(retryEn).toContain('Workflow Execution');
    expect(retryEn).toContain('**Failed step:** {{failedStep}}');
    expect(retryEn).toContain('### Step Logs');
    expect(findDeprecatedTerms(retryEn)).toEqual([]);

    const retryJa = loadTemplate('score_retry_system_prompt', 'ja');
    expect(retryJa).toContain('ワークフロー実行');
    expect(retryJa).toContain('**失敗ステップ:** {{failedStep}}');
    expect(retryJa).toContain('### ステップログ');
    expect(findDeprecatedTerms(retryJa)).toEqual([]);

    const instructEn = loadTemplate('score_instruct_system_prompt', 'en');
    expect(instructEn).toContain('Workflow Execution');
    expect(instructEn).toContain('**Workflow:** {{runWorkflow}}');
    expect(findDeprecatedTerms(instructEn)).toEqual([]);

    const instructJa = loadTemplate('score_instruct_system_prompt', 'ja');
    expect(instructJa).toContain('ワークフロー実行');
    expect(instructJa).toContain('**ワークフロー:** {{runWorkflow}}');
    expect(findDeprecatedTerms(instructJa)).toEqual([]);

    const summaryEn = loadTemplate('score_summary_system_prompt', 'en');
    expect(summaryEn).toContain('passed to a workflow');
    expect(summaryEn).toContain('Workflow description: {{workflowDescription}}');
    expect(findDeprecatedTerms(summaryEn)).toEqual([]);

    const summaryJa = loadTemplate('score_summary_system_prompt', 'ja');
    expect(summaryJa).toContain('ワークフロー実行用の具体的なタスク指示書');
    expect(summaryJa).toContain('ワークフローの内容: {{workflowDescription}}');
    expect(findDeprecatedTerms(summaryJa)).toEqual([]);
  });

  it('score_slug_system_prompt contains format specification', () => {
    const result = loadTemplate('score_slug_system_prompt', 'en');
    expect(result).toContain('verb-noun');
    expect(result).toContain('max 30 chars');
  });

  it('perform_agent_system_prompt contains {{agentDefinition}} placeholder', () => {
    const result = loadTemplate('perform_agent_system_prompt', 'en');
    expect(result).toContain('{{agentDefinition}}');
  });

  it('perform_agent_system_prompt uses workflow/step terminology in both languages', () => {
    const en = loadTemplate('perform_agent_system_prompt', 'en');
    expect(en).toContain('**Workflow**: A processing flow combining multiple steps');
    expect(en).toContain('- Workflow: {{workflowName}}');
    expect(en).toContain('- Current Step: {{currentStep}}');
    expect(en).toContain('preceding and following steps');
    expect(findDeprecatedTerms(en)).toEqual([]);

    const ja = loadTemplate('perform_agent_system_prompt', 'ja');
    expect(ja).toContain('**ワークフロー**: 複数のステップを組み合わせた処理フロー');
    expect(ja).toContain('- ワークフロー: {{workflowName}}');
    expect(ja).toContain('- 現在のステップ: {{currentStep}}');
    expect(ja).toContain('前後のステップとの連携');
    expect(findDeprecatedTerms(ja)).toEqual([]);
  });

  it('perform_agent_system_prompt renders full process safety guidance in both languages', () => {
    const en = loadTemplate('perform_agent_system_prompt', 'en', {
      agentDefinition: 'agent',
      workflowName: 'takt-default',
      currentStep: 'implement',
      stepsList: '1. implement',
      currentPosition: '1/1',
      hasProcessSafety: true,
      protectedParentRunPid: '4242',
    });
    expect(en).toContain('protected PID');
    expect(en).toContain('pkill');
    expect(en).toContain('killall');
    expect(en).toContain('name-based kill');
    expect(en).toContain('clearly own them');

    const ja = loadTemplate('perform_agent_system_prompt', 'ja', {
      agentDefinition: 'agent',
      workflowName: 'takt-default',
      currentStep: 'implement',
      stepsList: '1. implement',
      currentPosition: '1/1',
      hasProcessSafety: true,
      protectedParentRunPid: '4242',
    });
    expect(ja).toContain('protected PID');
    expect(ja).toContain('pkill');
    expect(ja).toContain('killall');
    expect(ja).toContain('プロセス名ベースの kill');
    expect(ja).toContain('自分が所有していると明確に分かるプロセス以外は停止してはいけません');
  });

  it('perform_judge_message contains {{agentOutput}} and {{conditionList}} placeholders', () => {
    const result = loadTemplate('perform_judge_message', 'en');
    expect(result).toContain('{{agentOutput}}');
    expect(result).toContain('{{conditionList}}');
  });

  it('perform_phase1_message contains execution context and rules sections', () => {
    const en = loadTemplate('perform_phase1_message', 'en');
    expect(en).toContain('## Execution Context');
    expect(en).toContain('## Execution Rules');
    expect(en).toContain('Do NOT run git commit');
    expect(en).toContain('Do NOT use `cd`');
    expect(en).toContain('## Workflow Context');
    expect(findDeprecatedTerms(en)).toEqual([]);
    expect(en).toContain('## Instructions');
  });

  it('perform_phase1_message uses workflow/step terminology in both languages', () => {
    const en = loadTemplate('perform_phase1_message', 'en');
    expect(en).toContain('after workflow completion');
    expect(en).toContain('- Workflow: {{workflowName}}');
    expect(en).toContain('- Step Iteration: {{stepIteration}}');
    expect(en).toContain('- Step: {{stepName}}');
    expect(en).toContain('Before completing this step');
    expect(findDeprecatedTerms(en)).toEqual([]);

    const ja = loadTemplate('perform_phase1_message', 'ja');
    expect(ja).toContain('ワークフロー完了後');
    expect(ja).toContain('- ワークフロー: {{workflowName}}');
    expect(ja).toContain('- Step Iteration: {{stepIteration}}');
    expect(ja).toContain('- Step: {{stepName}}');
    expect(ja).toContain('このステップを完了する前に');
    expect(findDeprecatedTerms(ja)).toEqual([]);
  });

  it('perform_phase1_message contains workflow context variables', () => {
    const en = loadTemplate('perform_phase1_message', 'en');
    expect(en).toContain('{{iteration}}');
    expect(en).toContain('{{stepName}}');
    expect(en).toContain('{{workingDirectory}}');
  });

  it('perform_phase2_message contains report-specific rules', () => {
    const en = loadTemplate('perform_phase2_message', 'en');
    expect(en).toContain('after workflow completion');
    expect(en).toContain('Do NOT modify project source files');
    expect(en).toContain('## Workflow Context');
    expect(findDeprecatedTerms(en)).toEqual([]);
    expect(en).toContain('## Instructions');

    const ja = loadTemplate('perform_phase2_message', 'ja');
    expect(ja).toContain('ワークフロー完了後');
    expect(ja).toContain('プロジェクトのソースファイルを変更しないでください');
    expect(ja).toContain('## Workflow Context');
    expect(findDeprecatedTerms(ja)).toEqual([]);
  });

  it('perform_phase2_message does not reintroduce workflow terminology regressions', () => {
    const en = loadTemplate('perform_phase2_message', 'en');
    expect(findDeprecatedTerms(en)).toEqual([]);

    const ja = loadTemplate('perform_phase2_message', 'ja');
    expect(findDeprecatedTerms(ja)).toEqual([]);
  });

  it('perform_phase3_message contains criteria and output variables', () => {
    const en = loadTemplate('perform_phase3_message', 'en');
    expect(en).toContain('{{criteriaTable}}');
    expect(en).toContain('{{outputList}}');
  });

  it('MD files contain only prompt body (no front matter)', () => {
    const templates = [
      'score_interactive_system_prompt',
      'score_summary_system_prompt',
      'perform_phase1_message',
      'perform_phase2_message',
    ];
    for (const name of templates) {
      const content = loadTemplate(name, 'en');
      expect(content).not.toMatch(/^---\n/);
    }
  });
});
