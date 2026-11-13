import { useRef, useState } from 'react';
import type { Key } from 'ink';
import type { EpicSnapshot } from '../../infra/epics/projection.js';
import { snapshotItemKey } from './snapshotChanges.js';

export type EpicNavigation = { kind: 'list'; key: string | null }
  | { kind: 'detail'; key: string; offset: number };

export function useManagerEpics(epics: readonly EpicSnapshot[]) {
  const [navigation, setNavigation] = useState<EpicNavigation | null>(null);
  const current = useRef<EpicNavigation | null>(null);
  const update = (next: EpicNavigation | null): void => {
    current.current = next;
    setNavigation(next);
  };
  const index = Math.max(0, epics.findIndex((item) => snapshotItemKey(item) === navigation?.key));
  const selected = epics.find((item) => snapshotItemKey(item) === navigation?.key);
  const open = (): void => update({ kind: 'list', key: epics[0] === undefined ? null : snapshotItemKey(epics[0]) });
  const close = (): void => update(null);
  const handleInput = (key: Key, lastDetailOffset: number, pageRows: number): void => {
    const target = current.current;
    if (target === null) return;
    if (key.escape) {
      update(target.kind === 'detail' ? { kind: 'list', key: target.key } : null);
      return;
    }
    if (target.kind === 'detail') {
      const offset = Math.min(target.offset, lastDetailOffset);
      const delta = key.upArrow ? -1 : key.downArrow ? 1 : key.pageUp ? -pageRows : key.pageDown ? pageRows : 0;
      if (key.home) update({ ...target, offset: 0 });
      else if (key.end) update({ ...target, offset: lastDetailOffset });
      else if (delta !== 0) update({ ...target, offset: Math.max(0, Math.min(lastDetailOffset, offset + delta)) });
      return;
    }
    const selectedIndex = Math.max(0, epics.findIndex((item) => snapshotItemKey(item) === target.key));
    if (key.upArrow || key.downArrow) {
      const next = epics[Math.max(0, Math.min(epics.length - 1, selectedIndex + (key.upArrow ? -1 : 1)))];
      if (next !== undefined) update({ kind: 'list', key: snapshotItemKey(next) });
    } else if (key.return) {
      const next = epics[selectedIndex];
      if (next !== undefined) update({ kind: 'detail', key: snapshotItemKey(next), offset: 0 });
    }
  };
  return { navigation, index, selected, open, close, handleInput };
}
