import type { RefObject } from 'react';
import { ModalDialog } from './ModalDialog';

type HelpDialogProps = {
  open: boolean;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
};

export function HelpDialog({ open, onClose, returnFocusRef }: HelpDialogProps) {
  return (
    <ModalDialog open={open} titleId="help-dialog-title" onDismiss={onClose} returnFocusRef={returnFocusRef}>
      <h2 id="help-dialog-title">操作説明</h2>
      <dl className="help-list">
        <dt>問い合わせを選ぶ</dt>
        <dd>左の一覧から問い合わせを選ぶと、本文と返信の編集欄が表示されます。検索欄で件名・お客様名・本文・返信を絞り込めます。</dd>
        <dt>返信を保存する</dt>
        <dd>
          「返信を保存」ボタン、または入力欄で <kbd>Ctrl</kbd>+<kbd>Enter</kbd>（Macは <kbd>⌘</kbd>+<kbd>Enter</kbd>）で保存します。
          <kbd>Enter</kbd> だけを押すと改行します。空白だけの返信は保存できません。
        </dd>
        <dt>保存中</dt>
        <dd>保存には約1秒かかります。保存中は重ねて保存したり、他の問い合わせへ切り替えたりできません。</dd>
        <dt>保存済みの内容へ戻す</dt>
        <dd>「保存済みの内容へ戻す」で、編集中の変更を取り消します。</dd>
        <dt>未保存のまま切り替える</dt>
        <dd>未保存の変更がある状態で他の問い合わせを選ぶと、変更を破棄して切り替えるか、切り替えをやめるかを確認します。</dd>
        <dt>保存に失敗したとき</dt>
        <dd>入力した内容はそのまま残ります。もう一度保存すると再試行できます。</dd>
      </dl>
      <div className="dialog-actions">
        <button type="button" className="button button-primary" onClick={onClose}>
          閉じる
        </button>
      </div>
    </ModalDialog>
  );
}
