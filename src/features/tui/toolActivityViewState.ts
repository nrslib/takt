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
  transcript?: readonly ToolActivityTranscriptRange[];
  next: ToolActivityPosition;
  hasMore: boolean;
}

export interface ToolActivityTranscriptRange {
  key: string;
  offset: number;
  text: string;
  omitted: boolean;
}

export function mergeToolActivityTranscript(
  previous: readonly ToolActivityTranscriptRange[], incoming: readonly ToolActivityTranscriptRange[],
): ToolActivityTranscriptRange[] {
  const fields = new Map<string, ToolActivityTranscriptRange[]>();
  for (const range of [...previous, ...incoming]) {
    const ranges = fields.get(range.key) ?? [];
    ranges.push(range);
    fields.set(range.key, ranges);
  }
  return [...fields.values()].flatMap((ranges) => {
    const merged: ToolActivityTranscriptRange[] = [];
    for (const range of ranges.sort((left, right) => left.offset - right.offset)) {
      const last = merged.at(-1);
      if (last === undefined || last.offset + last.text.length < range.offset) merged.push({ ...range });
      else {
        const previousEnd = last.offset + last.text.length;
        const end = range.offset + range.text.length;
        if (end > previousEnd) {
          last.text += range.text.slice(previousEnd - range.offset);
          last.omitted = range.omitted;
        } else if (end === previousEnd) last.omitted &&= range.omitted;
      }
    }
    return merged;
  });
}

export function excludeToolActivityTranscript(
  incoming: readonly ToolActivityTranscriptRange[],
  committed: readonly ToolActivityTranscriptRange[],
): ToolActivityTranscriptRange[] {
  const committedByKey = new Map<string, ToolActivityTranscriptRange[]>();
  for (const range of committed) {
    const ranges = committedByKey.get(range.key) ?? [];
    ranges.push(range);
    committedByKey.set(range.key, ranges);
  }
  const remaining: ToolActivityTranscriptRange[] = [];
  for (const range of incoming) {
    let fragments = [{ ...range }];
    for (const existing of committedByKey.get(range.key) ?? []) {
      const existingStart = existing.offset;
      const existingEnd = existing.offset + existing.text.length;
      fragments = fragments.flatMap((fragment) => {
        const fragmentEnd = fragment.offset + fragment.text.length;
        if (existingEnd <= fragment.offset || existingStart >= fragmentEnd) return [fragment];
        const overlapStart = Math.max(fragment.offset, existingStart);
        const overlapEnd = Math.min(fragmentEnd, existingEnd);
        const fragmentOverlap = fragment.text.slice(overlapStart - fragment.offset, overlapEnd - fragment.offset);
        const existingOverlap = existing.text.slice(overlapStart - existingStart, overlapEnd - existingStart);
        if (fragmentOverlap !== existingOverlap) return [fragment];
        const left = overlapStart > fragment.offset ? [{ ...fragment,
          text: fragment.text.slice(0, overlapStart - fragment.offset), omitted: false }] : [];
        const right = overlapEnd < fragmentEnd ? [{ ...fragment,
          offset: overlapEnd, text: fragment.text.slice(overlapEnd - fragment.offset) }] : [];
        return [...left, ...right];
      });
      if (fragments.length === 0) break;
    }
    remaining.push(...fragments);
  }
  return remaining;
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

function textRow(text: string, columns: number): { text: string; consumed: number; source: string; omitted: boolean } {
  let row = '';
  let consumed = 0;
  let width = 0;
  for (const grapheme of segmentGraphemes(text)) {
    if (grapheme === '\n') return { text: row, consumed: consumed + 1, source: text.slice(0, consumed + 1), omitted: false };
    const display = grapheme === '\t' ? ' ' : grapheme;
    const size = stringWidth(display);
    if (width + size > columns) {
      if (consumed === 0) return { text: '…', consumed: grapheme.length, source: '', omitted: true };
      break;
    }
    row += display;
    width += size;
    consumed += grapheme.length;
  }
  return { text: row, consumed, source: text.slice(0, consumed), omitted: false };
}

function singleRow(text: string, columns: number): { text: string; source: string; omitted: boolean } {
  const row = textRow(text, columns);
  if (row.consumed === text.length) return { text: row.text, source: row.omitted ? '' : row.text, omitted: row.omitted };
  if (columns <= 1) return { text: '…', source: '', omitted: true };
  const prefix = textRow(row.text, columns - 1);
  return { text: prefix.text + '…', source: prefix.omitted ? '' : prefix.text, omitted: true };
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
  const transcript: ToolActivityTranscriptRange[] = [];
  const width = Math.max(1, columns);
  let position = state.position;
  while (rows.length < maxRows && position.group < groups.length) {
    const group = groups[position.group]!;
    const entry = group.entries[position.entry];
    if (entry === undefined) {
      position = { group: position.group + 1, entry: 0, section: 'group', offset: 0 };
      continue;
    }
    const before = position;
    let completedRow = entry.status !== 'running';
    let transcriptRow: ToolActivityTranscriptRange | undefined;
    const addSingleRow = (text: string): void => {
      const row = singleRow(text, width);
      rows.push(row.text);
      transcriptRow = { key: JSON.stringify([
        before.section === 'group' || before.section === 'groupOmission' ? group.entries.map((item) => item.key) : entry.key,
        before.section,
      ]), offset: before.offset, text: row.source, omitted: row.omitted };
    };
    const advance = (section: ToolActivityPosition['section']): ToolActivityPosition => ({ ...position, section, offset: 0 });
    switch (position.section) {
      case 'group':
        completedRow = group.entries.every((item) => item.status !== 'running');
        if (group.entries.length > 1) {
          const counts = { running: 0, success: 0, failure: 0 };
          for (const item of group.entries) counts[item.status] += 1;
          const status = counts.failure > 0 ? '✗' : counts.running > 0 ? '…' : '✓';
          const statuses = [counts.success > 0 ? `✓${counts.success}` : '', counts.failure > 0 ? `✗${counts.failure}` : '', counts.running > 0 ? `…${counts.running}` : ''].filter(Boolean).join(' ');
          addSingleRow(`${status} ${group.summary} ${statuses}`);
          position = advance(state.expanded ? 'header' : 'groupResult');
        } else position = advance('header');
        break;
      case 'groupResult': {
        const preview: { entry: ToolActivityProjection; offset: number; text: string }[] = [];
        for (const item of group.entries) {
          if (item.result.text !== '') {
            const lines = item.result.text.split('\n').slice(0, COMPACT_RESULT_LINES - preview.length);
            let offset = 0;
            for (const text of lines) {
              preview.push({ entry: item, offset, text });
              offset += text.length + 1;
            }
          }
          if (preview.length === COMPACT_RESULT_LINES) break;
        }
        const text = compactResultText(preview.map((line) => line.text).join('\n'), width);
        if (position.offset >= text.length) {
          position = advance('groupOmission');
          break;
        }
        const row = textRow(text.slice(position.offset), width);
        const startLine = text.slice(0, position.offset).split('\n').length - 1;
        const line = preview[startLine]!;
        completedRow = line.entry.status !== 'running';
        transcriptRow = { key: JSON.stringify([line.entry.key, 'result']),
          offset: line.offset + position.offset - (text.slice(0, position.offset).lastIndexOf('\n') + 1),
          text: row.source, omitted: row.omitted };
        rows.push(row.text);
        position = { ...position, offset: position.offset + row.consumed };
        break;
      }
      case 'groupOmission':
        completedRow = group.entries.every((item) => item.status !== 'running');
        addSingleRow(labels.more);
        position = { group: position.group + 1, entry: 0, section: 'group', offset: 0 };
        break;
      case 'header': {
        const title = entry.tool === entry.action ? entry.tool : `${entry.tool} ${entry.action}`;
        addSingleRow(`${symbol(entry)} ${title}${state.expanded || entry.input === '' ? '' : ` ${entry.input}`}`);
        position = advance('time');
        break;
      }
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
          transcriptRow = { key: JSON.stringify([entry.key, 'time']), offset: position.offset,
            text: row.source, omitted: row.omitted };
          position = position.offset + row.consumed < timing.length
            ? { ...position, offset: position.offset + row.consumed } : advance('input');
        } else {
          addSingleRow(timing);
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
        transcriptRow = { key: JSON.stringify([entry.key, 'input']), offset: position.offset,
          text: row.source, omitted: row.omitted };
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
        transcriptRow = { key: JSON.stringify([entry.key, 'result']), offset: position.offset,
          text: row.source
            + (row.consumed >= result.text.length && result.nextOffset > position.offset + result.text.length ? '\n' : ''),
          omitted: row.omitted };
        const exhausted = row.consumed >= result.text.length;
        const offset = exhausted ? result.nextOffset : position.offset + row.consumed;
        position = exhausted && !result.hasMore
          ? nextEntry(groups, position)
          : exhausted && !state.expanded ? advance('omission') : { ...position, offset };
        break;
      }
      case 'omission':
        addSingleRow(labels.more);
        position = nextEntry(groups, position);
        break;
    }
    if (completedRow && transcriptRow !== undefined) transcript.push(transcriptRow);
  }
  return { rows, transcript, next: position, hasMore: position.group < groups.length };
}
