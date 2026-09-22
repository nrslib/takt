import type { KeyboardEvent } from 'react';
import { formatDateTime } from '../domain/inquiry';
import type { SaveOutcome } from '../screens/inquiryDeskMachine';

type ReplyEditorProps = {
  subject: string;
  draft: string;
  savedAt: string;
  saving: boolean;
  hasUnsavedChanges: boolean;
  outcome: SaveOutcome;
  rejectionMessage: string | null;
  onDraftChange: (text: string) => void;
  onSave: () => void;
  onRevert: () => void;
  onOpenHelp: (opener: HTMLElement) => void;
};

function statusText({ saving, hasUnsavedChanges, outcome, savedAt }: ReplyEditorProps): string {
  if (saving) {
    return '保存中です…（約1秒）';
  }
  if (hasUnsavedChanges) {
    return '未保存の変更があります。';
  }
  if (outcome.kind === 'saved') {
    return `保存しました（${formatDateTime(savedAt)}）。一覧と保存済みの返信に反映しています。`;
  }
  return '保存済みの内容と同じです。';
}

export function ReplyEditor(props: ReplyEditorProps) {
  const { subject, draft, saving, hasUnsavedChanges, outcome, rejectionMessage, onDraftChange, onSave, onRevert, onOpenHelp } =
    props;
  const invalid = outcome.kind === 'invalid';

  // Ctrl+Enter / ⌘+Enter はフォーム送信に変換し、保存の入口を onSubmit の一つにまとめる
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  return (
    <form
      className="reply-editor"
      aria-labelledby="reply-editor-heading"
      aria-busy={saving}
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <div className="reply-editor-header">
        <h3 id="reply-editor-heading">返信を編集</h3>
        <button type="button" className="button button-small" onClick={(event) => onOpenHelp(event.currentTarget)}>
          操作説明
        </button>
      </div>

      <label htmlFor="reply-draft">「{subject}」への返信</label>
      <textarea
        id="reply-draft"
        value={draft}
        rows={8}
        aria-required="true"
        readOnly={saving}
        aria-invalid={invalid}
        aria-describedby={invalid ? 'reply-draft-error reply-draft-hint' : 'reply-draft-hint'}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <p id="reply-draft-hint" className="hint">
        Enterで改行、Ctrl+Enter（Macは⌘+Enter）で保存します。
      </p>
      {invalid && (
        <p id="reply-draft-error" className="field-error" role="alert">
          返信が空白だけのため保存できません。返信内容を入力してください。
        </p>
      )}

      {outcome.kind === 'failed' && !saving && (
        <div className="save-error" role="alert">
          <p>
            {outcome.message}
            入力した内容は残っています。
          </p>
          <button type="submit" className="button button-small">
            もう一度保存する
          </button>
        </div>
      )}

      <p className="save-status" role="status">
        {statusText(props)}
      </p>
      <p className="rejection" role="status">
        {rejectionMessage}
      </p>

      <div className="reply-editor-actions">
        <button type="button" className="button" aria-disabled={saving || !hasUnsavedChanges} onClick={onRevert}>
          保存済みの内容へ戻す
        </button>
        <button type="submit" className="button button-primary" aria-disabled={saving}>
          {saving ? '保存中…' : '返信を保存'}
        </button>
      </div>
    </form>
  );
}
