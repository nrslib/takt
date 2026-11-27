import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getLabel } from '../../shared/i18n/index.js';
import { toolActivityGroupSummary } from '../../shared/tool-activity/presentation.js';
import type { ToolActivityEntry } from '../../shared/tool-activity/types.js';
import { MARKER_WIDTH } from '../tui/transcriptOutput.js';
import {
  completedToolTranscript, createToolActivityViewState, moveToolActivityView, toggleToolActivityView, toolActivityViewPage,
  type ToolActivityViewState,
} from '../tui/toolActivityViewState.js';
import type { ConversationClientSnapshot, ConversationIpcClient } from './conversationIpcClient.js';
import { ToolActivityDisplayStore, toolTurnKey } from './toolActivityDisplayStore.js';

export function useConversationToolHistory(
  client: Pick<ConversationIpcClient, 'subscribe' | 'getSnapshot' | 'onOutput'>,
  running: NonNullable<ConversationClientSnapshot['state']>['running'] | undefined,
  lang: 'ja' | 'en',
  columns: number,
) {
  const [store] = useState(() => new ToolActivityDisplayStore(client));
  const { display, ready } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [navigation, setNavigation] = useState(createToolActivityViewState);
  const previousTurn = useRef<string | undefined>(undefined);
  const context = display.history.entries().at(-1)?.context;
  const turn = running != null ? toolTurnKey(running) : context?.operationId === undefined ? undefined
    : toolTurnKey({ operationId: context.operationId, generation: context.generation });
  const state = previousTurn.current === turn ? navigation : createToolActivityViewState();
  useEffect(() => {
    if (previousTurn.current === turn) return;
    previousTurn.current = turn;
    setNavigation(createToolActivityViewState());
  }, [turn]);

  const allGroups = ready ? display.groups() : [];
  const compactGroups = allGroups.flatMap((group) => {
    const entries = group.entries.filter((entry) => entry.status === 'running');
    return entries.length === 0 ? [] : [{ ...group, summary: toolActivityGroupSummary(entries[0]!, entries.length), entries }];
  });
  const labels = {
    compact: getLabel('tui.ui.toolHistoryCompact', lang), expanded: getLabel('tui.ui.toolHistoryExpanded', lang),
    more: getLabel('tui.ui.toolHistoryMore', lang), end: getLabel('tui.ui.toolHistoryEnd', lang),
    completion: getLabel('tui.ui.toolHistoryCompletion', lang), running: getLabel('tui.ui.toolHistoryRunning', lang),
  };
  const groupsFor = (view: ToolActivityViewState) => view.expanded ? allGroups : compactGroups;
  const page = (height: number, view = state) => toolActivityViewPage(display, groupsFor(view), view, columns - MARKER_WIDTH,
    Math.max(0, height - 1), labels);
  const height = (availableRows: number): number => allGroups.length === 0 ? 0
    : groupsFor(state).length === 0 ? Math.min(1, availableRows) : availableRows;

  const committed = useRef(new Set<string>());
  const transcriptLayout = useRef({ columns, labels });
  transcriptLayout.current = { columns, labels };
  const transcript = (entry: ToolActivityEntry): string | undefined => {
    const key = JSON.stringify([entry.context?.operationId, entry.context?.generation, entry.key]);
    if (entry.status === 'running' || committed.current.has(key)) return;
    committed.current.add(key);
    return completedToolTranscript(entry, transcriptLayout.current.columns, transcriptLayout.current.labels);
  };
  return {
    liveReady: () => store.getSnapshot().ready, state, labels, page, height, transcript,
    browse(direction: 'toggle' | 'previous' | 'next', height: number): void {
      if (height <= 0) return;
      setNavigation((current) => direction === 'toggle' ? toggleToolActivityView(current)
        : moveToolActivityView(current, page(height, current), direction));
    },
  };
}
