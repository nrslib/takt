import { describe, expect, it } from 'vitest';
import { SystemInputRawSchema, WorkflowEffectRawSchema } from '../core/models/workflow-system-schemas.js';

describe('command system input schema', () => {
  const input = {
    type: 'command',
    as: 'approval',
    command: "printf '%s' '{previous_response}'",
    timeout_ms: 1000,
  };

  it.each([1, 2147483647])('accepts timeout_ms %s without changing the command', (timeout_ms) => {
    const raw = { ...input, timeout_ms };
    expect(SystemInputRawSchema.parse(raw)).toEqual(raw);
  });

  it('accepts explicit JSON output', () => {
    const raw = { ...input, output: 'json' };
    expect(SystemInputRawSchema.parse(raw)).toEqual(raw);
  });

  it('requires an explicit timeout', () => {
    const { timeout_ms: _timeout, ...raw } = input;
    expect(SystemInputRawSchema.safeParse(raw).success).toBe(false);
  });

  it.each([0, -1, 2147483648, 1.5, '1000', 'infinite', null])('rejects invalid timeout_ms %s', (timeout_ms) => {
    expect(SystemInputRawSchema.safeParse({ ...input, timeout_ms }).success).toBe(false);
  });

  it('requires a binding name', () => {
    const { as: _binding, ...raw } = input;
    expect(SystemInputRawSchema.safeParse(raw).success).toBe(false);
    expect(SystemInputRawSchema.safeParse({ ...input, as: '' }).success).toBe(false);
  });

  it('requires a command string', () => {
    const { command: _command, ...raw } = input;
    expect(SystemInputRawSchema.safeParse(raw).success).toBe(false);
  });

  it('rejects a cwd override', () => {
    expect(SystemInputRawSchema.safeParse({ ...input, cwd: '/other' }).success).toBe(false);
  });

  it('rejects unsupported output formats', () => {
    expect(SystemInputRawSchema.safeParse({ ...input, output: 'text' }).success).toBe(false);
  });

  it('does not accept commands as effects', () => {
    expect(WorkflowEffectRawSchema.safeParse(input).success).toBe(false);
  });
});
