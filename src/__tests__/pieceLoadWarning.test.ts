import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { formatPieceLoadWarning } from '../infra/config/loaders/pieceLoadWarning.js';

describe('formatPieceLoadWarning', () => {
  it('ANSI escape と制御文字を可視化して警告文へ埋め込む', () => {
    const error = new Error('bad\x1b]0;title\x07value\nnext');

    const warning = formatPieceLoadWarning('bad\n\x1b[31mname', error);

    expect(warning).toContain('Piece "bad\\nname" failed to load');
    expect(warning).toContain('badvalue\\nnext');
    expect(warning).not.toContain('\x1b');
  });

  it('ZodError の issue path と message もサニタイズする', () => {
    const error = new ZodError([
      {
        code: 'custom',
        path: ['movements', 0, 'name\nbad'],
        message: 'invalid\tvalue',
      },
    ]);

    const warning = formatPieceLoadWarning('piece', error);

    expect(warning).toContain('movements.0.name\\nbad');
    expect(warning).toContain('invalid\\tvalue');
  });
});
