import { renderToString } from 'ink';
import chalk from 'chalk';
import { describe, expect, it } from 'vitest';
import { ToolActivityView } from '../features/tui/ToolActivityView.js';
import { createToolActivityViewState, toggleToolActivityView } from '../features/tui/toolActivityViewState.js';
import { stripAnsi } from '../shared/utils/text.js';

describe('ToolActivityView', () => {
  const state = createToolActivityViewState();
  const labels = { compact: 'Ctrl+O expand', expanded: 'Ctrl+O collapse', more: 'more', end: 'end', completion: 'completion', running: 'running' };
  const page = { rows: ['safe result'], heads: [], next: state.position, hasMore: true };

  it('should render safe rows with expansion and continuation instructions', () => {
    expect(renderToString(<ToolActivityView page={page} state={state} labels={labels} height={3} />, { columns: 80 }))
      .toContain('  safe result\nmore Ctrl+O expand');
    expect(renderToString(<ToolActivityView page={{ ...page, hasMore: false }} state={toggleToolActivityView(state)} labels={labels} height={3} />, { columns: 80 }))
      .toContain('end Ctrl+O collapse');
  });

  it('should put the tool marker only before the rows that open a tool and dim every row', () => {
    const level = chalk.level;
    try {
      chalk.level = 3;
      const output = renderToString(<ToolActivityView
        page={{ ...page, rows: ['Bash Ran npm test … running', 'partial output'], heads: [0] }}
        state={state} labels={labels} height={3} />, { columns: 80 });
      const rows = output.split('\n');
      expect(rows.map(stripAnsi)).toEqual(['◆ Bash Ran npm test … running', '  partial output', 'more Ctrl+O expand']);
      for (const row of rows) expect(row).toContain('\x1b[2m');
    } finally { chalk.level = level; }
  });

  it('should render nothing when the input and status consume the available height', () => {
    expect(renderToString(<ToolActivityView page={page} state={state} labels={labels} height={0} />, { columns: 80 })).toBe('');
  });
});
