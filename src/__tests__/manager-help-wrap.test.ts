import { renderToString } from 'ink';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { ManagerHelp } from '../features/manager/ManagerHelp.js';
import { getLabel } from '../shared/i18n/index.js';
import { measureWidth } from '../shared/utils/grapheme.js';
import { stripAnsi } from '../shared/utils/text.js';

describe('manager experimental notice wrapping', () => {
  describe.each(['ja', 'en'] as const)('%s', (lang) => {
    it.each([80, 40, 42])('keeps the first line readable and the full notice within %i columns', (columns) => {
      const output = stripAnsi(renderToString(createElement(ManagerHelp, { lang }), { columns }));
      const lines = output.split('\n');

      expect(lines[0]).toMatch(lang === 'ja' ? /^manager\sは実験的機能です/u : /^manager is experimental\./u);
      for (const line of lines) {
        expect(measureWidth(line)).toBeLessThanOrEqual(columns);
      }
      expect(lines.join('').replace(/\s+/gu, '')).toBe(
        getLabel('manager.experimentalNotice', lang).replace(/\s+/gu, ''),
      );
    });
  });
});
