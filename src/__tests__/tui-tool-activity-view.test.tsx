import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';
import { ToolActivityView } from '../features/tui/ToolActivityView.js';
import { createToolActivityViewState, toggleToolActivityView } from '../features/tui/toolActivityViewState.js';

describe('ToolActivityView', () => {
  const state = createToolActivityViewState();
  const labels = { compact: 'Ctrl+O expand', expanded: 'Ctrl+O collapse', more: 'more', end: 'end', completion: 'completion' };
  const page = { rows: ['safe result'], next: state.position, hasMore: true };

  it('should render safe rows with expansion and continuation instructions', () => {
    expect(renderToString(<ToolActivityView page={page} state={state} labels={labels} height={3} />, { columns: 80 }))
      .toContain('safe result\nmore Ctrl+O expand');
    expect(renderToString(<ToolActivityView page={{ ...page, hasMore: false }} state={toggleToolActivityView(state)} labels={labels} height={3} />, { columns: 80 }))
      .toContain('end Ctrl+O collapse');
  });

  it('should render nothing when the input and status consume the available height', () => {
    expect(renderToString(<ToolActivityView page={page} state={state} labels={labels} height={0} />, { columns: 80 })).toBe('');
  });
});
