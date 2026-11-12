import stringWidth from 'string-width';
import { segmentGraphemes } from '../../shared/utils/grapheme.js';
import { COMPACT_RESULT_LINES } from '../../shared/tool-activity/presentation.js';
import type { ToolActivityGroup, ToolActivityProjection } from '../../shared/tool-activity/types.js';
import type { ToolActivityDisplay } from '../../shared/ui/ToolActivityDisplay.js';

interface ToolActivityPosition {
  group: number;
  entry: number;
  section: 'group' | 'groupResult' | 'groupOmission' | 'header' | 'time' | 'input' | 'result' | 'omission';
  offset: number;
}

export interface ToolActivityViewState {
  expanded: boolean;
  position: ToolActivityPosition;
  previous: readonly ToolActivityPosition[];
}

export interface ToolActivityViewLabels {
  compact: string;
  expanded: string;
  more: string;
  end: string;
  completion: string;
}

export interface ToolActivityViewPage {
  rows: readonly string[];
  next: ToolActivityPosition;
  hasMore: boolean;
}

export function createToolActivityViewState(): ToolActivityViewState {
  return { expanded: false, position: { group: 0, entry: 0, section: 'group', offset: 0 }, previous: [] };
}

export function toggleToolActivityView(state: ToolActivityViewState): ToolActivityViewState {
  return { ...createToolActivityViewState(), expanded: !state.expanded };
}

export function moveToolActivityView(
  state: ToolActivityViewState,
  page: ToolActivityViewPage,
  direction: 'previous' | 'next',
): ToolActivityViewState {
  if (direction === 'next') {
    return page.hasMore
      ? { ...state, position: page.next, previous: [...state.previous, state.position] }
      : state;
  }
  const position = state.previous.at(-1);
  return position === undefined ? state : { ...state, position, previous: state.previous.slice(0, -1) };
}

function textRow(text: string, columns: number): { text: string; consumed: number } {
  let row = '';
  let consumed = 0;
  let width = 0;
  for (const grapheme of segmentGraphemes(text)) {
    if (grapheme === '\n') return { text: row, consumed: consumed + 1 };
    const display = grapheme === '\t' ? ' ' : grapheme;
    const size = stringWidth(display);
    if (width + size > columns) {
      if (consumed === 0) return { text: '…', consumed: grapheme.length };
      break;
    }
    row += display;
    width += size;
    consumed += grapheme.length;
  }
  return { text: row, consumed };
}

function singleRow(text: string, columns: number): string {
  const row = textRow(text, columns);
  if (row.consumed === text.length) return row.text;
  if (columns <= 1) return '…';
  return textRow(row.text, Math.max(0, columns - 1)).text + '…';
}

function compactResultText(text: string, columns: number): string {
  let end = 0;
  for (let row = 0; row < COMPACT_RESULT_LINES && end < text.length; row += 1) {
    end += textRow(text.slice(end), columns).consumed;
  }
  return text.slice(0, end);
}

function symbol(entry: ToolActivityProjection): string {
  return entry.status === 'failure' ? '✗' : entry.status === 'success' ? '✓' : '…';
}

function nextEntry(groups: readonly ToolActivityGroup[], position: ToolActivityPosition): ToolActivityPosition {
  const group = groups[position.group]!;
  return position.entry + 1 < group.entries.length
    ? { ...position, entry: position.entry + 1, section: 'header', offset: 0 }
    : { group: position.group + 1, entry: 0, section: 'group', offset: 0 };
}

export function toolActivityViewPage(
  reader: Pick<ToolActivityDisplay, 'detail'>,
  groups: readonly ToolActivityGroup[],
  state: ToolActivityViewState,
  columns: number,
  maxRows: number,
  labels: ToolActivityViewLabels,
): ToolActivityViewPage {
  const rows: string[] = [];
  const width = Math.max(1, columns);
  let position = state.position;
  while (rows.length < maxRows && position.group < groups.length) {
    const group = groups[position.group]!;
    const entry = group.entries[position.entry]!;
    const advance = (section: ToolActivityPosition['section']): ToolActivityPosition => ({ ...position, section, offset: 0 });
    switch (position.section) {
      case 'group':
        if (group.entries.length > 1) {
          const counts = { running: 0, success: 0, failure: 0 };
          for (const item of group.entries) counts[item.status] += 1;
          const status = counts.failure > 0 ? '✗' : counts.running > 0 ? '…' : '✓';
          const statuses = [counts.success > 0 ? `✓${counts.success}` : '', counts.failure > 0 ? `✗${counts.failure}` : '', counts.running > 0 ? `…${counts.running}` : ''].filter(Boolean).join(' ');
          rows.push(singleRow(`${status} ${group.summary} ${statuses}`, width));
          position = advance(state.expanded ? 'header' : 'groupResult');
        } else position = advance('header');
        break;
      case 'groupResult': {
        const preview: string[] = [];
        for (const item of group.entries) {
          if (item.result.text !== '') preview.push(...item.result.text.split('\n').slice(0, COMPACT_RESULT_LINES - preview.length));
          if (preview.length === COMPACT_RESULT_LINES) break;
        }
        const text = compactResultText(preview.join('\n'), width);
        if (position.offset >= text.length) {
          position = advance('groupOmission');
          break;
        }
        const row = textRow(text.slice(position.offset), width);
        rows.push(row.text);
        position = { ...position, offset: position.offset + row.consumed };
        break;
      }
      case 'groupOmission':
        rows.push(singleRow(labels.more, width));
        position = { group: position.group + 1, entry: 0, section: 'group', offset: 0 };
        break;
      case 'header':
        rows.push(singleRow(`${symbol(entry)} ${entry.tool}${state.expanded || entry.input === '' ? '' : ` ${entry.input}`}`, width));
        position = advance('time');
        break;
      case 'time': {
        const timing = [entry.status,
          ...(entry.startedAt === undefined ? [] : [`@${entry.startedAt}`]),
          ...(entry.completedAt === undefined ? [] : [`→ @${entry.completedAt}`]),
          ...(entry.durationMs === undefined ? [] : [`(${entry.durationMs} ms)`]),
          ...(entry.completionSequence === undefined ? [] : [`${labels.completion} #${entry.completionSequence}`]),
        ].join(' ');
        if (state.expanded) {
          const row = textRow(timing.slice(position.offset), width);
          rows.push(row.text);
          position = position.offset + row.consumed < timing.length
            ? { ...position, offset: position.offset + row.consumed } : advance('input');
        } else {
          rows.push(singleRow(timing, width));
          position = advance('result');
        }
        break;
      }
      case 'input': {
        const input = reader.detail(entry.key, 0).input;
        if (position.offset >= input.length) {
          position = advance('result');
          break;
        }
        const row = textRow(input.slice(position.offset), width);
        rows.push(row.text);
        position = { ...position, offset: position.offset + row.consumed };
        break;
      }
      case 'result': {
        const compact = state.expanded ? '' : compactResultText(entry.result.text, width);
        const result = state.expanded
          ? reader.detail(entry.key, position.offset).result
          : { ...entry.result, text: compact.slice(position.offset), nextOffset: compact.length,
            hasMore: entry.result.hasMore || compact.length < entry.result.text.length };
        if (result.text === '') {
          position = result.hasMore && !state.expanded ? advance('omission') : nextEntry(groups, position);
          break;
        }
        const row = textRow(result.text, width);
        rows.push(row.text);
        const exhausted = row.consumed >= result.text.length;
        const offset = exhausted ? result.nextOffset : position.offset + row.consumed;
        position = exhausted && !result.hasMore
          ? nextEntry(groups, position)
          : exhausted && !state.expanded ? advance('omission') : { ...position, offset };
        break;
      }
      case 'omission':
        rows.push(singleRow(labels.more, width));
        position = nextEntry(groups, position);
        break;
    }
  }
  return { rows, next: position, hasMore: position.group < groups.length };
}
