import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { useInquiryEditor } from "./useInquiryEditor";
import type { Feedback, Inquiry, SaveState } from "./types";
import "./styles.css";

function App() {
  const editor = useInquiryEditor();
  const [helpOpen, setHelpOpen] = useState(false);
  const activeModal = helpOpen || editor.pendingSelectionId !== null;
  const pendingInquiry = editor.inquiries.find((inquiry) => inquiry.id === editor.pendingSelectionId);

  const openHelp = useCallback(() => setHelpOpen(true), []);
  const closeHelp = useCallback(() => setHelpOpen(false), []);

  return (
    <div className="app-shell">
      <div className="app-content" aria-hidden={activeModal || undefined} inert={activeModal || undefined}>
        <Header onOpenHelp={openHelp} />
        <div className="workspace-grid">
          <InquiryList
            inquiries={editor.inquiries}
            selectedId={editor.selectedId}
            onSelect={editor.selectInquiry}
          />
          {editor.selectedInquiry ? (
            <InquiryDetail
              inquiry={editor.selectedInquiry}
              draft={editor.draft}
              saveState={editor.saveState}
              feedback={editor.feedback}
              hasUnsavedChanges={editor.hasUnsavedChanges}
              saveCount={editor.saveCount}
              failNextSave={editor.failNextSave}
              onDraftChange={editor.updateDraft}
              onSave={editor.requestSave}
              onReset={editor.resetDraft}
              onToggleFailNextSave={editor.toggleFailNextSave}
              onOpenHelp={openHelp}
            />
          ) : (
            <main className="detail-panel empty-detail">
              <p>表示できる問い合わせがありません。</p>
            </main>
          )}
        </div>
      </div>

      <HelpDialog open={helpOpen} onClose={closeHelp} />
      {pendingInquiry ? (
        <DiscardDialog
          open
          subject={pendingInquiry.subject}
          onCancel={editor.cancelSelection}
          onConfirm={editor.confirmDiscard}
        />
      ) : null}
    </div>
  );
}

type HeaderProps = {
  onOpenHelp: () => void;
};

function Header({ onOpenHelp }: HeaderProps) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">
            r
          </div>
          <div>
            <p className="brand-name">replydesk</p>
            <p className="brand-caption">サポートワークスペース</p>
          </div>
        </div>
        <div className="topbar-title">問い合わせ対応</div>
        <div className="topbar-actions">
          <span className="environment-pill">
            <span className="environment-dot" aria-hidden="true" />
            ローカルデモ
          </span>
          <button type="button" className="help-trigger" onClick={onOpenHelp}>
            <HelpIcon />
            操作ガイド
          </button>
        </div>
      </div>
    </header>
  );
}

type InquiryListProps = {
  inquiries: Inquiry[];
  selectedId: string;
  onSelect: (id: string) => void;
};

function InquiryList({ inquiries, selectedId, onSelect }: InquiryListProps) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase("ja-JP");
  const filteredInquiries = useMemo(() => {
    if (!normalizedQuery) {
      return inquiries;
    }

    return inquiries.filter((inquiry) =>
      [inquiry.subject, inquiry.customerName, inquiry.customerEmail, inquiry.body, inquiry.savedReply]
        .join(" ")
        .toLocaleLowerCase("ja-JP")
        .includes(normalizedQuery),
    );
  }, [inquiries, normalizedQuery]);

  return (
    <aside className="inquiry-list-panel" aria-label="問い合わせ一覧">
      <div className="list-header">
        <div className="list-heading-row">
          <div>
            <p className="section-kicker">受信トレイ</p>
            <h1>問い合わせ</h1>
          </div>
          <span className="total-count">{inquiries.length}件</span>
        </div>
        <div className="search-field">
          <SearchIcon />
          <label className="sr-only" htmlFor="inquiry-search">
            問い合わせを検索
          </label>
          <input
            id="inquiry-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="件名・名前で検索"
          />
          {query ? (
            <button type="button" className="clear-search" onClick={() => setQuery("")} aria-label="検索条件をクリア">
              ×
            </button>
          ) : null}
        </div>
        <p className="result-summary" aria-live="polite">
          {normalizedQuery ? `${filteredInquiries.length}件が見つかりました` : "すべての問い合わせ"}
        </p>
      </div>

      <div className="inquiry-list-scroll">
        {filteredInquiries.length > 0 ? (
          <ul className="inquiry-list">
            {filteredInquiries.map((inquiry) => {
              const isSelected = inquiry.id === selectedId;
              return (
                <li key={inquiry.id}>
                  <button
                    type="button"
                    className={`inquiry-row${isSelected ? " is-selected" : ""}`}
                    aria-current={isSelected ? "true" : undefined}
                    aria-label={`${inquiry.subject}、${inquiry.customerName}、返信済み${isSelected ? "、選択中" : ""}`}
                    onClick={() => onSelect(inquiry.id)}
                  >
                    <span className="inquiry-row-topline">
                      <span className="status-dot" aria-hidden="true" />
                      <span className="inquiry-customer">{inquiry.customerName}</span>
                      <time dateTime={inquiry.receivedDateTime}>{inquiry.receivedLabel}</time>
                    </span>
                    <strong>{inquiry.subject}</strong>
                    <span className="inquiry-preview">
                      返信: {inquiry.savedReply.replace(/\s+/g, " ").slice(0, 60)}
                    </span>
                    <span className="inquiry-row-footer">
                      <span className="reply-status">
                        <CheckIcon />
                        返信済み
                      </span>
                      <span className="row-chevron" aria-hidden="true">
                        ›
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="no-results" role="status">
            <div className="no-results-icon" aria-hidden="true">
              <SearchIcon />
            </div>
            <h2>該当する問い合わせがありません</h2>
            <p>検索語を変えるか、検索条件をクリアしてください。</p>
            <button type="button" className="text-button" onClick={() => setQuery("")}>
              検索条件をクリア
            </button>
          </div>
        )}
      </div>
      <div className="list-footer">
        <span className="online-indicator" aria-hidden="true" />
        ローカルデータで動作中
      </div>
    </aside>
  );
}

type InquiryDetailProps = {
  inquiry: Inquiry;
  draft: string;
  saveState: SaveState;
  feedback: Feedback | null;
  hasUnsavedChanges: boolean;
  saveCount: number;
  failNextSave: boolean;
  onDraftChange: (value: string) => void;
  onSave: () => void;
  onReset: () => void;
  onToggleFailNextSave: () => void;
  onOpenHelp: () => void;
};

function InquiryDetail({
  inquiry,
  draft,
  saveState,
  feedback,
  hasUnsavedChanges,
  saveCount,
  failNextSave,
  onDraftChange,
  onSave,
  onReset,
  onToggleFailNextSave,
  onOpenHelp,
}: InquiryDetailProps) {
  return (
    <main className="detail-panel">
      <div className="detail-scroll">
        <div className="detail-header">
          <div className="detail-kicker-row">
            <p className="section-kicker">問い合わせ詳細</p>
            <span className="case-id">ID {inquiry.id.replace("inquiry-", "#")}</span>
          </div>
          <h2>{inquiry.subject}</h2>
          <div className="customer-line">
            <span className="customer-avatar" aria-hidden="true">
              {getInitials(inquiry.customerName)}
            </span>
            <span className="customer-name">{inquiry.customerName}</span>
            <span className="customer-separator" aria-hidden="true">
              •
            </span>
            <span>{inquiry.customerEmail}</span>
            <span className="customer-separator" aria-hidden="true">
              •
            </span>
            <time dateTime={inquiry.receivedDateTime}>{inquiry.receivedLabel}に受信</time>
          </div>
        </div>

        <section className="message-card" aria-labelledby="message-heading">
          <div className="card-heading-row">
            <div>
              <p className="section-kicker">CUSTOMER MESSAGE</p>
              <h3 id="message-heading">問い合わせ内容</h3>
            </div>
            <span className="message-badge">受信済み</span>
          </div>
          <p className="message-body">{inquiry.body}</p>
        </section>

        <ReplyEditor
          draft={draft}
          saveState={saveState}
          feedback={feedback}
          hasUnsavedChanges={hasUnsavedChanges}
          onDraftChange={onDraftChange}
          onSave={onSave}
          onReset={onReset}
          onOpenHelp={onOpenHelp}
        />

        <DemoPanel
          saveCount={saveCount}
          failNextSave={failNextSave}
          onToggleFailNextSave={onToggleFailNextSave}
        />
      </div>
    </main>
  );
}

type ReplyEditorProps = {
  draft: string;
  saveState: SaveState;
  feedback: Feedback | null;
  hasUnsavedChanges: boolean;
  onDraftChange: (value: string) => void;
  onSave: () => void;
  onReset: () => void;
  onOpenHelp: () => void;
};

function ReplyEditor({
  draft,
  saveState,
  feedback,
  hasUnsavedChanges,
  onDraftChange,
  onSave,
  onReset,
  onOpenHelp,
}: ReplyEditorProps) {
  const isSaving = saveState === "saving";
  const statusLabel = getEditorStatusLabel(saveState, hasUnsavedChanges);
  const statusTone = getEditorStatusTone(saveState, hasUnsavedChanges);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      onSave();
    }
  };

  return (
    <section className="reply-card" aria-labelledby="reply-heading">
      <div className="reply-card-heading">
        <div>
          <div className="reply-title-line">
            <p className="section-kicker">YOUR REPLY</p>
            <span className={`save-status status-${statusTone}`}>
              <span className="save-status-dot" aria-hidden="true" />
              {statusLabel}
            </span>
          </div>
          <h3 id="reply-heading">返信を編集</h3>
        </div>
        <button type="button" className="icon-text-button" onClick={onOpenHelp}>
          <HelpIcon />
          操作ガイド
        </button>
      </div>

      <form className="reply-form" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
        <label className="sr-only" htmlFor="reply-draft">
          返信内容
        </label>
        <p id="reply-description" className="field-description">
          お客様への返信を入力してください。内容はこの問い合わせにだけ保存されます。
        </p>
        <div className={`textarea-wrap${feedback?.kind === "error" && !draft.trim() ? " has-error" : ""}`}>
          <textarea
            id="reply-draft"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={handleKeyDown}
            readOnly={isSaving}
            aria-readonly={isSaving}
            aria-invalid={feedback?.kind === "error" && !draft.trim()}
            aria-describedby="reply-description reply-feedback"
            placeholder="返信を入力してください"
            rows={10}
          />
          <span className="character-count">{draft.length.toLocaleString("ja-JP")}文字</span>
        </div>

        <div className="reply-form-footer">
          <div className="shortcut-hint">
            <KeyboardIcon />
            <span>
              <kbd>⌘</kbd> / <kbd>Ctrl</kbd> + <kbd>Enter</kbd> で保存
            </span>
          </div>
          <div className="reply-actions">
            <button type="button" className="reset-button" onClick={onReset}>
              <ResetIcon />
              保存済みに戻す
            </button>
            <button type="submit" className="save-button" disabled={isSaving}>
              {isSaving ? <SpinnerIcon /> : <SaveIcon />}
              {isSaving ? "保存中…" : "返信を保存"}
            </button>
          </div>
        </div>
        <div id="reply-feedback" className="feedback-slot" aria-live="polite" aria-atomic="true">
          {feedback ? (
            <div className={`feedback feedback-${feedback.kind}`} role={feedback.kind === "error" ? "alert" : "status"}>
              <FeedbackIcon kind={feedback.kind} />
              <span>{feedback.message}</span>
            </div>
          ) : null}
        </div>
      </form>
    </section>
  );
}

type DemoPanelProps = {
  saveCount: number;
  failNextSave: boolean;
  onToggleFailNextSave: () => void;
};

function DemoPanel({ saveCount, failNextSave, onToggleFailNextSave }: DemoPanelProps) {
  return (
    <aside className="demo-panel" aria-label="実演用の保存状態">
      <div className="demo-copy">
        <p className="section-kicker">DEMO CONTROLS</p>
        <h3>実演用モニター</h3>
        <p>保存の非同期処理と失敗時の再試行を確認できます。</p>
      </div>
      <div className="save-counter">
        <span>受け付けた保存</span>
        <strong>
          {saveCount}
          <small>回</small>
        </strong>
      </div>
      <button
        type="button"
        className={`failure-toggle${failNextSave ? " is-enabled" : ""}`}
        aria-pressed={failNextSave}
        onClick={onToggleFailNextSave}
      >
        <span className="toggle-icon" aria-hidden="true">
          {failNextSave ? "!" : "×"}
        </span>
        <span>
          次の保存を失敗させる
          <small>{failNextSave ? "設定中" : "オフ"}</small>
        </span>
      </button>
    </aside>
  );
}

type ModalDialogProps = {
  open: boolean;
  title: string;
  titleId: string;
  onClose: () => void;
  children: ReactNode;
  actions: ReactNode;
};

function ModalDialog({ open, title, titleId, onClose, children, actions }: ModalDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusableSelector =
      "button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex=\"-1\"])";
    const focusFirstElement = () => {
      const first = dialog?.querySelector<HTMLElement>("[data-autofocus], button:not([disabled])");
      first?.focus();
    };
    const animationFrame = window.requestAnimationFrame(focusFirstElement);

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab" || !dialog) {
        return;
      }

      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(
        (element) => element.getAttribute("aria-hidden") !== "true",
      );

      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;

      if (!dialog.contains(activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      document.removeEventListener("keydown", handleKeyDown);
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
    };
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-topline">
          <span className="modal-label">GUIDE</span>
          <button type="button" className="modal-close" onClick={onClose} aria-label="ダイアログを閉じる">
            ×
          </button>
        </div>
        <h2 id={titleId}>{title}</h2>
        <div className="modal-content">{children}</div>
        <div className="modal-actions">{actions}</div>
      </div>
    </div>
  );
}

type HelpDialogProps = {
  open: boolean;
  onClose: () => void;
};

function HelpDialog({ open, onClose }: HelpDialogProps) {
  return (
    <ModalDialog
      open={open}
      title="操作ガイド"
      titleId="help-dialog-title"
      onClose={onClose}
      actions={
        <button type="button" className="primary-modal-button" data-autofocus="true" onClick={onClose}>
          閉じる
        </button>
      }
    >
      <p className="modal-lead">返信の編集と保存は、次の操作で行えます。</p>
      <div className="guide-list">
        <div className="guide-item">
          <span className="guide-number">01</span>
          <div>
            <strong>返信を入力する</strong>
            <p>Enterで改行できます。入力欄の右下に現在の文字数を表示します。</p>
          </div>
        </div>
        <div className="guide-item">
          <span className="guide-number">02</span>
          <div>
            <strong>保存する</strong>
            <p>「返信を保存」または ⌘ / Ctrl + Enter で保存します。保存には約1秒かかります。</p>
          </div>
        </div>
        <div className="guide-item">
          <span className="guide-number">03</span>
          <div>
            <strong>問い合わせを切り替える</strong>
            <p>未保存の変更がある場合は、破棄して切り替えるか、操作を取り消せます。</p>
          </div>
        </div>
      </div>
    </ModalDialog>
  );
}

type DiscardDialogProps = {
  open: boolean;
  subject: string;
  onCancel: () => void;
  onConfirm: () => void;
};

function DiscardDialog({ open, subject, onCancel, onConfirm }: DiscardDialogProps) {
  return (
    <ModalDialog
      open={open}
      title="未保存の変更があります"
      titleId="discard-dialog-title"
      onClose={onCancel}
      actions={
        <>
          <button type="button" className="secondary-modal-button" data-autofocus="true" onClick={onCancel}>
            切り替えをやめる
          </button>
          <button type="button" className="danger-modal-button" onClick={onConfirm}>
            変更を破棄して切り替える
          </button>
        </>
      }
    >
      <p className="modal-lead">現在の返信を保存せずに、次の問い合わせへ移動しますか？</p>
      <div className="pending-inquiry-box">
        <span className="pending-box-label">切り替え先</span>
        <strong>{subject}</strong>
      </div>
      <p className="modal-note">「切り替えをやめる」を選ぶと、編集中の返信はそのまま残ります。</p>
    </ModalDialog>
  );
}

function getInitials(name: string) {
  return name.replace(" ", "").slice(0, 2);
}

function getEditorStatusLabel(saveState: SaveState, hasUnsavedChanges: boolean) {
  if (saveState === "saving") return "保存中";
  if (saveState === "error") return "保存に失敗";
  if (hasUnsavedChanges) return "未保存の変更";
  return "保存済み";
}

function getEditorStatusTone(saveState: SaveState, hasUnsavedChanges: boolean) {
  if (saveState === "saving") return "saving";
  if (saveState === "error") return "error";
  if (hasUnsavedChanges) return "dirty";
  return "saved";
}

function FeedbackIcon({ kind }: { kind: Feedback["kind"] }) {
  if (kind === "success") return <CheckIcon />;
  if (kind === "error") return <AlertIcon />;
  if (kind === "warning") return <AlertIcon />;
  return <InfoIcon />;
}

function HelpIcon() {
  return (
    <svg className="icon" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8.35 7.5a1.8 1.8 0 0 1 3.4.85c0 1.5-1.75 1.65-1.75 2.8" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
      <circle cx="10" cy="14.45" r=".85" fill="currentColor" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg className="icon" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="8.75" cy="8.75" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="m12.7 12.7 4 4" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="m4.2 10.2 3.6 3.6 8-8" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  );
}

function SaveIcon() {
  return (
    <svg className="icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4.2 3.5h9.1l2.5 2.5v10.5H4.2z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.5" />
      <path d="M7 3.8v4h5.4v-4M7.1 16.3v-4.4h5.8v4.4" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.5" />
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg className="icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4.3 8.1A6 6 0 1 1 5.7 14" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
      <path d="M4.1 4.9v3.5h3.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
    </svg>
  );
}

function KeyboardIcon() {
  return (
    <svg className="icon" viewBox="0 0 20 20" aria-hidden="true">
      <rect x="2.5" y="5.2" width="15" height="9.6" rx="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.2 8.3h.01M8 8.3h.01M10.8 8.3h.01M13.6 8.3h.01M5.2 11.6h.01M8 11.6h4.8" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
    </svg>
  );
}

function SpinnerIcon() {
  return <span className="spinner" aria-hidden="true" />;
}

function AlertIcon() {
  return (
    <svg className="icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 3.1 17 16H3z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.5" />
      <path d="M10 7.2v4.1M10 13.7v.1" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg className="icon" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 9.2v4M10 6.7v.1" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
    </svg>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
