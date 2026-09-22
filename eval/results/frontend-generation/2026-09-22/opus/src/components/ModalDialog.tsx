import { useEffect, useRef, type ReactNode, type RefObject } from 'react';

type ModalDialogProps = {
  open: boolean;
  titleId: string;
  /** Escキーなど、ダイアログを閉じる意図を上位へ通知する */
  onDismiss: () => void;
  /** 開いたときにフォーカスする要素。未指定ならダイアログ内の最初の操作要素 */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** 閉じたときにフォーカスを戻す要素 */
  returnFocusRef: RefObject<HTMLElement | null>;
  children: ReactNode;
};

/**
 * ネイティブの <dialog> を showModal() で開くモーダル。
 * showModal() は背景を inert にするため、Tab/Shift+Tab、クリック、キーボード操作が背景へ届かない。
 * 開閉は上位の state に従い、この部品は DOM の開閉とフォーカス移動だけを同期する。
 */
export function ModalDialog({ open, titleId, onDismiss, initialFocusRef, returnFocusRef, children }: ModalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    if (open) {
      if (!dialog.open) {
        dialog.showModal();
      }
      initialFocusRef?.current?.focus();
    } else {
      if (dialog.open) {
        dialog.close();
      }
      if (wasOpenRef.current) {
        returnFocusRef.current?.focus();
      }
    }
    wasOpenRef.current = open;
  }, [open, initialFocusRef, returnFocusRef]);

  return (
    <dialog
      ref={dialogRef}
      className="modal"
      aria-labelledby={titleId}
      onCancel={(event) => {
        // Escでの閉じる操作も上位の状態判断を通す
        event.preventDefault();
        onDismiss();
      }}
      onClose={() => {
        // ブラウザが強制的に閉じた場合も状態を揃える（閉じ済みなら上位で無視される）
        if (open) {
          onDismiss();
        }
      }}
    >
      {children}
    </dialog>
  );
}
