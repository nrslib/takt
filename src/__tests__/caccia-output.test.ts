import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCacciaOutput } from '../features/caccia/output.js';
import { stripAnsi } from '../shared/utils/text.js';

afterEach(() => vi.restoreAllMocks());

describe('Caccia output', () => {
  it.each(['ja', 'en'] as const)('sanitizes external identifiers and errors in the %s prefixed display', (language) => {
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    const out = createCacciaOutput({
      outputMode: 'terminal', taskPrefix: 'parent', taskColorIndex: 1, taskDisplayLabel: 'parent-label',
    }, language);

    out.pushed('commit\n\x1b[31mred\r');
    out.resolved('thread\t\x1b[2Jid');
    out.result({ outcome: 'skipped', unresolvedCount: 0, reason: 'reason\n\x1b[2Jtext' });
    out.failed('failure\r\x1b[2Jtext');

    expect(lines).toHaveLength(4);
    const clean = lines.map(stripAnsi);
    expect(clean[0]).toContain('commit\\nred\\r');
    expect(clean[1]).toContain('thread\\tid');
    expect(clean[2]).toContain('reason\\ntext');
    expect(clean[3]).toContain('failure\\rtext');
    for (const line of clean) {
      expect(line).toMatch(/^\[parent-label\]/u);
      expect(line.split('\n')).toHaveLength(2);
    }
  });

  it('rejects incomplete parent prefix information', () => {
    expect(() => createCacciaOutput({ outputMode: 'terminal', taskPrefix: 'parent' }, 'en')).toThrow();
    expect(() => createCacciaOutput({ outputMode: 'terminal', taskColorIndex: 1 }, 'en')).toThrow();
  });

  it('rejects a skipped result without its required reason', () => {
    const out = createCacciaOutput({ outputMode: 'silent' }, 'en');
    expect(() => out.result({ outcome: 'skipped', unresolvedCount: 0 })).toThrow();
  });
});
