import { useCallback, useMemo, useRef, useState } from 'react';
import { listInquiries, saveReply } from '../api/fakeInquiryServer';
import { createInitialState, deskReducer, type DeskEvent, type DeskState } from './inquiryDeskMachine';

/**
 * 画面のMediator。表示部品からの操作通知を受け、状態機械で受理・拒否と次の状態を決め、
 * 受理された保存だけ通信を開始する。
 *
 * 同じイベントループ内で連続して届いた操作（連打・Ctrl+Enterの押し続け）でも
 * 最新の状態で判断できるよう、状態は ref に同期的に反映してから描画用の state に渡す。
 */
export function useInquiryDesk() {
  const [state, setState] = useState<DeskState>(() => createInitialState(listInquiries()));
  const stateRef = useRef(state);
  /** ダイアログを閉じたときにフォーカスを戻す操作要素 */
  const dialogReturnFocusRef = useRef<HTMLElement | null>(null);

  const dispatch = useCallback((event: DeskEvent): { before: DeskState; after: DeskState } => {
    const before = stateRef.current;
    const after = deskReducer(before, event);
    stateRef.current = after;
    setState(after);
    return { before, after };
  }, []);

  const handlers = useMemo(
    () => ({
      selectInquiry(inquiryId: string, opener: HTMLElement) {
        const { after } = dispatch({ type: 'inquirySelected', inquiryId });
        if (after.phase.kind === 'confirmingSwitch') {
          dialogReturnFocusRef.current = opener;
        }
      },
      confirmSwitch() {
        dispatch({ type: 'switchConfirmed' });
      },
      cancelSwitch() {
        dispatch({ type: 'switchCancelled' });
      },
      changeDraft(text: string) {
        dispatch({ type: 'draftChanged', text });
      },
      requestSave() {
        const { before, after } = dispatch({ type: 'saveRequested' });
        if (after.acceptedSaveCount === before.acceptedSaveCount || after.phase.kind !== 'saving') {
          return;
        }
        const { requestId, inquiryId, reply, simulateFailure } = after.phase;
        saveReply(inquiryId, reply, { simulateFailure }).then(
          (inquiry) => {
            dispatch({ type: 'saveSucceeded', requestId, inquiry });
          },
          (error: unknown) => {
            const message = error instanceof Error ? error.message : '保存に失敗しました。';
            dispatch({ type: 'saveFailed', requestId, message });
          },
        );
      },
      revert() {
        dispatch({ type: 'revertRequested' });
      },
      openHelp(opener: HTMLElement) {
        const { after } = dispatch({ type: 'helpOpened' });
        if (after.helpOpen) {
          dialogReturnFocusRef.current = opener;
        }
      },
      closeHelp() {
        dispatch({ type: 'helpClosed' });
      },
      setFailNextSave(enabled: boolean) {
        dispatch({ type: 'failNextSaveChanged', enabled });
      },
    }),
    [dispatch],
  );

  return { state, handlers, dialogReturnFocusRef };
}
