/**
 * Tests for Markdown template loader (src/shared/prompts/index.ts)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { loadTemplate, renderTemplate, _resetCache } from '../shared/prompts/index.js';

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

  it('loads score_slug_system_prompt with explicit lang', () => {
    const result = loadTemplate('score_slug_system_prompt', 'en');
    expect(result).toContain('You are a slug generator');
  });

  it('throws for a non-existent template with language', () => {
    expect(() => loadTemplate('nonexistent_template', 'en')).toThrow('Template not found: nonexistent_template (lang: en)');
  });
});

describe('variable substitution', () => {
  it('replaces {{variableName}} placeholders with provided values', () => {
    const result = loadTemplate('perform_builtin_agent_system_prompt', 'en', { agentName: 'test-agent' });
    expect(result).toContain('You are the test-agent agent');
    expect(result).toContain('Follow the standard test-agent piece');
  });

  it('replaces undefined variables with empty string', () => {
    const result = loadTemplate('perform_builtin_agent_system_prompt', 'en', {});
    expect(result).not.toContain('{{agentName}}');
    expect(result).toContain('You are the  agent');
  });

  it('replaces multiple different variables', () => {
    const result = loadTemplate('perform_judge_message', 'en', {
      agentOutput: 'test output',
      conditionList: '| 1 | Success |',
    });
    expect(result).toContain('test output');
    expect(result).toContain('| 1 | Success |');
  });

  it('interactive prompt does not contain piece info', () => {
    const result = loadTemplate('score_interactive_system_prompt', 'en', {
      pieceInfo: true,
      pieceName: 'my-piece',
      pieceDescription: 'Test description',
    });
    // ピース情報はインタラクティブプロンプトには含まれない（要約プロンプトにのみ含まれる）
    expect(result).not.toContain('"my-piece"');
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
    'perform_builtin_agent_system_prompt',
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
    expect(en).toContain('Strict Requirements');

    const ja = loadTemplate('score_interactive_policy', 'ja');
    expect(ja).toContain('対話モードポリシー');
    expect(ja).toContain('原則');
    expect(ja).toContain('厳守事項');
  });

  it('score_slug_system_prompt contains format specification', () => {
    const result = loadTemplate('score_slug_system_prompt', 'en');
    expect(result).toContain('verb-noun');
    expect(result).toContain('max 30 chars');
  });

  it('perform_builtin_agent_system_prompt contains {{agentName}} placeholder', () => {
    const result = loadTemplate('perform_builtin_agent_system_prompt', 'en');
    expect(result).toContain('{{agentName}}');
  });

  it('perform_agent_system_prompt contains {{agentDefinition}} placeholder', () => {
    const result = loadTemplate('perform_agent_system_prompt', 'en');
    expect(result).toContain('{{agentDefinition}}');
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
    expect(en).toContain('## Piece Context');
    expect(en).toContain('## Instructions');
  });

  it('perform_phase1_message contains piece context variables', () => {
    const en = loadTemplate('perform_phase1_message', 'en');
    expect(en).toContain('{{iteration}}');
    expect(en).toContain('{{movement}}');
    expect(en).toContain('{{workingDirectory}}');
  });

  it('perform_phase2_message contains report-specific rules', () => {
    const en = loadTemplate('perform_phase2_message', 'en');
    expect(en).toContain('Do NOT modify project source files');
    expect(en).toContain('## Instructions');

    const ja = loadTemplate('perform_phase2_message', 'ja');
    expect(ja).toContain('プロジェクトのソースファイルを変更しないでください');
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
