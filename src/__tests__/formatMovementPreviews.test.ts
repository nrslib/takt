/**
 * Tests for formatMovementPreviews
 */

import { describe, it, expect } from 'vitest';
import type { MovementPreview } from '../infra/config/loaders/pieceResolver.js';
import { formatMovementPreviews } from '../features/interactive/interactive.js';

describe('formatMovementPreviews', () => {
  const basePreviews: MovementPreview[] = [
    {
      name: 'plan',
      personaDisplayName: 'Planner',
      personaContent: 'You are a planner.',
      instructionContent: 'Create a plan for {task}',
      allowedTools: ['Read', 'Glob', 'Grep'],
      canEdit: false,
    },
    {
      name: 'implement',
      personaDisplayName: 'Coder',
      personaContent: 'You are a coder.',
      instructionContent: 'Implement the plan.',
      allowedTools: ['Read', 'Edit', 'Bash'],
      canEdit: true,
    },
  ];

  it('should format previews with English labels', () => {
    const result = formatMovementPreviews(basePreviews, 'en');

    expect(result).toContain('### 1. plan (Planner)');
    expect(result).toContain('**Persona:**');
    expect(result).toContain('You are a planner.');
    expect(result).toContain('**Instruction:**');
    expect(result).toContain('Create a plan for {task}');
    expect(result).toContain('**Tools:** Read, Glob, Grep');
    expect(result).toContain('**Edit:** No');

    expect(result).toContain('### 2. implement (Coder)');
    expect(result).toContain('**Tools:** Read, Edit, Bash');
    expect(result).toContain('**Edit:** Yes');
  });

  it('should format previews with Japanese labels', () => {
    const result = formatMovementPreviews(basePreviews, 'ja');

    expect(result).toContain('### 1. plan (Planner)');
    expect(result).toContain('**ペルソナ:**');
    expect(result).toContain('**インストラクション:**');
    expect(result).toContain('**ツール:** Read, Glob, Grep');
    expect(result).toContain('**編集:** 不可');
    expect(result).toContain('**編集:** 可');
  });

  it('should show "None" when no tools are allowed (English)', () => {
    const previews: MovementPreview[] = [
      {
        name: 'step',
        personaDisplayName: 'Agent',
        personaContent: 'Agent persona',
        instructionContent: 'Do something',
        allowedTools: [],
        canEdit: false,
      },
    ];

    const result = formatMovementPreviews(previews, 'en');

    expect(result).toContain('**Tools:** None');
  });

  it('should show "なし" when no tools are allowed (Japanese)', () => {
    const previews: MovementPreview[] = [
      {
        name: 'step',
        personaDisplayName: 'Agent',
        personaContent: 'Agent persona',
        instructionContent: 'Do something',
        allowedTools: [],
        canEdit: false,
      },
    ];

    const result = formatMovementPreviews(previews, 'ja');

    expect(result).toContain('**ツール:** なし');
  });

  it('should skip empty persona content', () => {
    const previews: MovementPreview[] = [
      {
        name: 'step',
        personaDisplayName: 'Agent',
        personaContent: '',
        instructionContent: 'Do something',
        allowedTools: [],
        canEdit: false,
      },
    ];

    const result = formatMovementPreviews(previews, 'en');

    expect(result).not.toContain('**Persona:**');
    expect(result).toContain('**Instruction:**');
  });

  it('should skip empty instruction content', () => {
    const previews: MovementPreview[] = [
      {
        name: 'step',
        personaDisplayName: 'Agent',
        personaContent: 'Some persona',
        instructionContent: '',
        allowedTools: [],
        canEdit: false,
      },
    ];

    const result = formatMovementPreviews(previews, 'en');

    expect(result).toContain('**Persona:**');
    expect(result).not.toContain('**Instruction:**');
  });

  it('should return empty string for empty array', () => {
    const result = formatMovementPreviews([], 'en');

    expect(result).toBe('');
  });

  it('should separate multiple previews with double newline', () => {
    const result = formatMovementPreviews(basePreviews, 'en');

    // Two movements should be separated by \n\n
    const parts = result.split('\n\n### ');
    expect(parts.length).toBe(2);
  });
});
