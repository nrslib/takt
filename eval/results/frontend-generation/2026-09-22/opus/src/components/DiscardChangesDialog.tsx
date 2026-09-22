import { useRef, type RefObject } from 'react';
import { ModalDialog } from './ModalDialog';

type DiscardChangesDialogProps = {
  open: boolean;
  currentSubject: string;
  targetSubject: string;
  onDiscard: () => void;
  onCancel: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
};

export function DiscardChangesDialog({
  open,
  currentSubject,
  targetSubject,
  onDiscard,
  onCancel,
  returnFocusRef,
}: DiscardChangesDialogProps) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <ModalDialog
      open={open}
      titleId="discard-dialog-title"
      onDismiss={onCancel}
      initialFocusRef={cancelButtonRef}
      returnFocusRef={returnFocusRef}
    >
      <h2 id="discard-dialog-title">未保存の返信があります</h2>
      <p>
        「{currentSubject}」の返信に保存していない変更があります。
        「{targetSubject}」へ切り替えると、この変更は失われます。
      </p>
      <div className="dialog-actions">
        <button ref={cancelButtonRef} type="button" className="button" onClick={onCancel}>
          切り替えをやめる
        </button>
        <button type="button" className="button button-danger" onClick={onDiscard}>
          変更を破棄して切り替える
        </button>
      </div>
    </ModalDialog>
  );
}
