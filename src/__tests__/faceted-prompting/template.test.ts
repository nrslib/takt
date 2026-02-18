/**
 * Unit tests for faceted-prompting template engine.
 */

import { describe, it, expect } from 'vitest';
import { renderTemplate } from '../../faceted-prompting/index.js';
import {
  processConditionals,
  substituteVariables,
} from '../../faceted-prompting/template.js';

describe('processConditionals', () => {
  it('should include truthy block content', () => {
    const template = '{{#if showGreeting}}Hello!{{/if}}';
    const result = processConditionals(template, { showGreeting: true });
    expect(result).toBe('Hello!');
  });

  it('should exclude falsy block content', () => {
    const template = '{{#if showGreeting}}Hello!{{/if}}';
    const result = processConditionals(template, { showGreeting: false });
    expect(result).toBe('');
  });

  it('should handle else branch when truthy', () => {
    const template = '{{#if isAdmin}}Admin panel{{else}}User panel{{/if}}';
    const result = processConditionals(template, { isAdmin: true });
    expect(result).toBe('Admin panel');
  });

  it('should handle else branch when falsy', () => {
    const template = '{{#if isAdmin}}Admin panel{{else}}User panel{{/if}}';
    const result = processConditionals(template, { isAdmin: false });
    expect(result).toBe('User panel');
  });

  it('should treat non-empty string as truthy', () => {
    const template = '{{#if name}}Name: provided{{/if}}';
    const result = processConditionals(template, { name: 'Alice' });
    expect(result).toBe('Name: provided');
  });

  it('should treat empty string as falsy', () => {
    const template = '{{#if name}}Name: provided{{/if}}';
    const result = processConditionals(template, { name: '' });
    expect(result).toBe('');
  });

  it('should treat undefined variable as falsy', () => {
    const template = '{{#if missing}}exists{{else}}missing{{/if}}';
    const result = processConditionals(template, {});
    expect(result).toBe('missing');
  });

  it('should handle multiline content in blocks', () => {
    const template = '{{#if hasContent}}line1\nline2\nline3{{/if}}';
    const result = processConditionals(template, { hasContent: true });
    expect(result).toBe('line1\nline2\nline3');
  });
});

describe('substituteVariables', () => {
  it('should replace variable with string value', () => {
    const result = substituteVariables('Hello {{name}}!', { name: 'World' });
    expect(result).toBe('Hello World!');
  });

  it('should replace true with string "true"', () => {
    const result = substituteVariables('Value: {{flag}}', { flag: true });
    expect(result).toBe('Value: true');
  });

  it('should replace false with empty string', () => {
    const result = substituteVariables('Value: {{flag}}', { flag: false });
    expect(result).toBe('Value: ');
  });

  it('should replace undefined variable with empty string', () => {
    const result = substituteVariables('Value: {{missing}}', {});
    expect(result).toBe('Value: ');
  });

  it('should handle multiple variables', () => {
    const result = substituteVariables('{{greeting}} {{name}}!', {
      greeting: 'Hello',
      name: 'World',
    });
    expect(result).toBe('Hello World!');
  });
});

describe('renderTemplate', () => {
  it('should process conditionals and then substitute variables', () => {
    const template = '{{#if hasName}}Name: {{name}}{{else}}Anonymous{{/if}}';
    const result = renderTemplate(template, { hasName: true, name: 'Alice' });
    expect(result).toBe('Name: Alice');
  });

  it('should handle template with no conditionals', () => {
    const result = renderTemplate('Hello {{name}}!', { name: 'World' });
    expect(result).toBe('Hello World!');
  });

  it('should handle template with no variables', () => {
    const result = renderTemplate('Static text', {});
    expect(result).toBe('Static text');
  });
});
