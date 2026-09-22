import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type SVGProps,
} from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Inquiry = {
  id: string;
  subject: string;
  customer: string;
  email: string;
  receivedAt: string;
  category: string;
  initials: string;
  accent: "blue" | "coral" | "green" | "purple" | "gold";
  body: string;
  reply: string;
};

type FeedbackTone = "neutral" | "warning" | "loading" | "success" | "error";

type SaveFeedback = {
  tone: FeedbackTone;
  text: string;
};

const INITIAL_INQUIRIES: Inquiry[] = [
  {
    id: "inquiry-1042",
    subject: "請求書の宛名を変更したい",
    customer: "田中 麻衣",
    email: "mai.tanaka@example.jp",
    receivedAt: "今日 09:42",
    category: "請求・契約",
    initials: "TM",
    accent: "blue",
    body: "いつもお世話になっております。\n次回の請求書から、宛名を「株式会社たなか企画」へ変更したいです。\n今月分の請求書はすでに発行済みでしょうか。手続き方法も教えてください。",
    reply: "田中様\n\nお問い合わせありがとうございます。\n宛名の変更は、次回の請求書から反映できます。アカウント設定の「請求先情報」より変更をお願いいたします。\n\n今月分についても確認が必要な場合は、請求書番号をお知らせください。",
  },
  {
    id: "inquiry-1038",
    subject: "ログイン用の認証コードが届きません",
    customer: "鈴木 恒一",
    email: "koichi.suzuki@example.jp",
    receivedAt: "今日 08:15",
    category: "アカウント",
    initials: "SK",
    accent: "coral",
    body: "ログインしようとしていますが、認証コードのメールが届きません。\n迷惑メールフォルダも確認しました。別の方法でログインできますか？",
    reply: "鈴木様\n\nご不便をおかけして申し訳ありません。\n認証コードを再送信しましたので、5分ほどお待ちください。届かない場合は、受信設定で support@example.jp を許可リストへ追加してから再度お試しください。",
  },
  {
    id: "inquiry-1031",
    subject: "プラン変更の反映タイミングについて",
    customer: "佐藤 健太",
    email: "kenta.sato@example.jp",
    receivedAt: "昨日 17:28",
    category: "プラン変更",
    initials: "SK",
    accent: "green",
    body: "スタンダードプランからプロプランへの変更を検討しています。\n申し込み後、いつから新しい機能を使えるようになりますか？また日割り計算についても知りたいです。",
    reply: "佐藤様\n\nお問い合わせありがとうございます。\nプラン変更はお申し込み完了後、すぐに反映されます。料金は変更日を基準に日割りで計算され、次回の請求に合算されます。",
  },
  {
    id: "inquiry-1024",
    subject: "チームメンバーを追加する方法",
    customer: "高橋 直子",
    email: "naoko.takahashi@example.jp",
    receivedAt: "昨日 14:06",
    category: "使い方",
    initials: "TN",
    accent: "purple",
    body: "新しいメンバーをプロジェクトへ招待したいです。\n管理者権限は持っていますが、どの画面から招待を送ればよいか分かりません。",
    reply: "高橋様\n\nご連絡ありがとうございます。\nワークスペース設定の「メンバー」から「メンバーを招待」を選択し、メールアドレスを入力してください。招待メールのリンクから参加できます。",
  },
  {
    id: "inquiry-1017",
    subject: "領収書を再発行できますか",
    customer: "伊藤 恒一",
    email: "koichi.ito@example.jp",
    receivedAt: "9月21日 11:50",
    category: "請求・契約",
    initials: "IK",
    accent: "gold",
    body: "先月の支払い分の領収書を紛失してしまいました。\n管理画面から再発行する手順を教えてください。",
    reply: "伊藤様\n\nお問い合わせありがとうございます。\n請求履歴から該当するお支払いを開き、「領収書をダウンロード」を選択してください。再発行した領収書にも同じ発行日が記載されます。",
  },
];

function SearchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <circle cx="10.8" cy="10.8" r="6.8" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="m16 16 4.5 4.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  );
}

function HelpIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M9.7 9.2a2.4 2.4 0 1 1 4.2 1.6c-.9 1-1.9 1.2-1.9 2.7" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      <circle cx="12" cy="16.4" r=".9" fill="currentColor" />
    </svg>
  );
}

function ChevronIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  );
}

function RefreshIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path d="M19.2 8.7A7.5 7.5 0 0 0 5.5 6.6L4 8.1M4 4.8v3.4h3.4M4.8 15.3a7.5 7.5 0 0 0 13.7 2.1l1.5-1.5m0 3.3v-3.4h-3.4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  );
}

function CheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path d="m5.2 12.4 4.4 4.4 9.3-9.3" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
    </svg>
  );
}

function LockIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <rect x="5.5" y="10" width="13" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8.5 10V7.8a3.5 3.5 0 0 1 7 0V10" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  );
}

function InboxIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path d="M4.2 5.5h15.6l1.3 8.1v3.1a2 2 0 0 1-2 2H4.9a2 2 0 0 1-2-2v-3.1l1.3-8.1Z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.7" />
      <path d="M3.2 13.6h4.1l1.3 2h6.8l1.3-2h4.1" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.7" />
    </svg>
  );
}

function MessageIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path d="M5.2 5.2h13.6a1.8 1.8 0 0 1 1.8 1.8v8a1.8 1.8 0 0 1-1.8 1.8H10l-4.7 2.7.8-2.7H5.2a1.8 1.8 0 0 1-1.8-1.8V7a1.8 1.8 0 0 1 1.8-1.8Z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.7" />
    </svg>
  );
}

function useInquiryDesk(initialInquiries: Inquiry[]) {
  const [inquiries, setInquiries] = useState(initialInquiries);
  const [selectedId, setSelectedId] = useState(initialInquiries[0].id);
  const [draft, setDraft] = useState(initialInquiries[0].reply);
  const [isSaving, setIsSaving] = useState(false);
  const [lastSaveResult, setLastSaveResult] = useState<"success" | "error" | null>(null);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [interactionNotice, setInteractionNotice] = useState<string | null>(null);
  const [acceptedSaveCount, setAcceptedSaveCount] = useState(0);
  const [failNextSave, setFailNextSave] = useState(false);
  const [switchTargetId, setSwitchTargetId] = useState<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const savingRef = useRef(false);

  const selectedInquiry = inquiries.find((inquiry) => inquiry.id === selectedId) ?? inquiries[0];
  const isDirty = draft !== selectedInquiry.reply;

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  const feedback: SaveFeedback = isSaving
    ? { tone: "loading", text: "保存中です。完了まで約1秒かかります。" }
    : validationMessage
      ? { tone: "error", text: "入力内容を確認してください。" }
      : lastSaveResult === "error"
        ? { tone: "error", text: "保存に失敗しました。編集内容は保持されています。" }
        : lastSaveResult === "success" && !isDirty
          ? { tone: "success", text: "返信を保存しました。" }
          : isDirty
            ? { tone: "warning", text: "未保存の変更があります。" }
            : { tone: "neutral", text: "保存済みの返信です。" };

  const switchToInquiry = useCallback(
    (id: string) => {
      const nextInquiry = inquiries.find((inquiry) => inquiry.id === id);
      if (!nextInquiry) {
        return;
      }

      setSelectedId(nextInquiry.id);
      setDraft(nextInquiry.reply);
      setLastSaveResult(null);
      setValidationMessage(null);
      setInteractionNotice(null);
      setSwitchTargetId(null);
    },
    [inquiries],
  );

  const requestSelectInquiry = useCallback(
    (id: string) => {
      if (isSaving || savingRef.current) {
        setInteractionNotice("保存中のため、問い合わせの切替を受け付けていません。保存が完了してからお試しください。");
        return;
      }

      if (id === selectedId) {
        setInteractionNotice(null);
        return;
      }

      if (isDirty) {
        setSwitchTargetId(id);
        setInteractionNotice(null);
        return;
      }

      switchToInquiry(id);
    },
    [isDirty, isSaving, selectedId, switchToInquiry],
  );

  const cancelInquirySwitch = useCallback(() => {
    setSwitchTargetId(null);
  }, []);

  const confirmInquirySwitch = useCallback(() => {
    if (isSaving || savingRef.current) {
      setInteractionNotice("保存中のため、問い合わせの切替を受け付けていません。保存が完了してからお試しください。");
      return;
    }

    if (switchTargetId) {
      switchToInquiry(switchTargetId);
    }
  }, [isSaving, switchTargetId, switchToInquiry]);

  const updateDraft = useCallback(
    (value: string) => {
      if (isSaving || savingRef.current) {
        setInteractionNotice("保存中は編集内容を固定しています。保存が完了してから編集できます。");
        return;
      }

      setDraft(value);
      setValidationMessage(null);
      setLastSaveResult(null);
      setInteractionNotice(null);
    },
    [isSaving],
  );

  const requestSave = useCallback(() => {
    if (isSaving || savingRef.current) {
      setInteractionNotice("保存中のため、追加の保存操作は受け付けていません。完了をお待ちください。");
      return;
    }

    if (draft.trim().length === 0) {
      setValidationMessage("返信を入力してください。空白だけの返信は保存できません。");
      setLastSaveResult(null);
      setInteractionNotice(null);
      return;
    }

    if (!isDirty) {
      setInteractionNotice("変更がないため、保存処理は開始していません。");
      return;
    }

    const targetId = selectedId;
    const contentToSave = draft;
    const shouldFail = failNextSave;

    savingRef.current = true;
    setIsSaving(true);
    setLastSaveResult(null);
    setValidationMessage(null);
    setInteractionNotice(null);
    setAcceptedSaveCount((count) => count + 1);
    setFailNextSave(false);

    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      savingRef.current = false;
      setIsSaving(false);

      if (shouldFail) {
        setLastSaveResult("error");
        setInteractionNotice("保存に失敗しました。編集内容はそのままです。「返信を保存」をもう一度押して再試行できます。");
        return;
      }

      setInquiries((currentInquiries) =>
        currentInquiries.map((inquiry) =>
          inquiry.id === targetId ? { ...inquiry, reply: contentToSave } : inquiry,
        ),
      );
      setLastSaveResult("success");
      setInteractionNotice(null);
    }, 1000);
  }, [draft, failNextSave, isDirty, isSaving, selectedId]);

  const resetDraft = useCallback(() => {
    if (isSaving || savingRef.current) {
      setInteractionNotice("保存中のため、返信を戻す操作を受け付けていません。保存が完了してからお試しください。");
      return;
    }

    if (!isDirty) {
      setInteractionNotice("返信はすでに保存済みの内容です。");
      return;
    }

    setDraft(selectedInquiry.reply);
    setValidationMessage(null);
    setLastSaveResult(null);
    setInteractionNotice("保存済みの返信へ戻しました。");
  }, [isDirty, isSaving, selectedInquiry.reply]);

  const toggleFailNextSave = useCallback(() => {
    setFailNextSave((enabled) => !enabled);
  }, []);

  const switchTargetInquiry = switchTargetId
    ? inquiries.find((inquiry) => inquiry.id === switchTargetId) ?? null
    : null;

  return {
    acceptedSaveCount,
    draft,
    failNextSave,
    feedback,
    inquiries,
    interactionNotice,
    isDirty,
    isSaving,
    requestSave,
    requestSelectInquiry,
    resetDraft,
    selectedId,
    selectedInquiry,
    switchTargetInquiry,
    cancelInquirySwitch,
    confirmInquirySwitch,
    toggleFailNextSave,
    updateDraft,
    validationMessage,
  };
}

type HeaderProps = {
  onOpenHelp: (trigger: HTMLElement) => void;
};

function Header({ onOpenHelp }: HeaderProps) {
  return (
    <header className="topbar">
      <div className="brand-lockup">
        <span className="brand-mark" aria-hidden="true">
          r
        </span>
        <span className="brand-copy">
          <strong>Reply Desk</strong>
          <span>問い合わせ対応ワークスペース</span>
        </span>
      </div>
      <div className="topbar-actions">
        <span className="local-chip">
          <span className="local-chip-dot" aria-hidden="true" />
          ローカルデモ
        </span>
        <button className="topbar-help" type="button" onClick={(event) => onOpenHelp(event.currentTarget)}>
          <HelpIcon />
          <span>操作説明</span>
        </button>
      </div>
    </header>
  );
}

type InquiryListProps = {
  inquiries: Inquiry[];
  selectedId: string;
  isSaving: boolean;
  onSelect: (id: string, trigger: HTMLButtonElement) => void;
};

function getPreview(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function InquiryList({ inquiries, selectedId, isSaving, onSelect }: InquiryListProps) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredInquiries = inquiries.filter((inquiry) => {
    if (!normalizedQuery) {
      return true;
    }

    return [inquiry.subject, inquiry.customer, inquiry.body, inquiry.reply, inquiry.category]
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  });

  return (
    <aside className="inbox-panel panel" aria-labelledby="inbox-title">
      <div className="panel-heading">
        <div>
          <div className="section-kicker">
            <InboxIcon />
            <span>受信トレイ</span>
          </div>
          <h2 id="inbox-title">問い合わせ</h2>
        </div>
        <span className="inbox-count">{inquiries.length}件</span>
      </div>

      <div className="search-box">
        <SearchIcon />
        <label className="sr-only" htmlFor="inquiry-search">
          問い合わせを検索
        </label>
        <input
          id="inquiry-search"
          type="search"
          placeholder="件名・本文・顧客名で検索"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query ? (
          <button className="clear-search" type="button" aria-label="検索をクリア" onClick={() => setQuery("")}>
            ×
          </button>
        ) : null}
      </div>

      {isSaving ? (
        <div className="inbox-lock-note" role="status">
          <LockIcon />
          <span>保存中は問い合わせを切り替えられません</span>
        </div>
      ) : null}

      <div className="list-meta">
        <span>{normalizedQuery ? "検索結果" : "すべての問い合わせ"}</span>
        <span>{filteredInquiries.length}件</span>
      </div>

      {filteredInquiries.length > 0 ? (
        <ul className="inquiry-list">
          {filteredInquiries.map((inquiry) => {
            const isSelected = inquiry.id === selectedId;
            return (
              <li key={inquiry.id}>
                <button
                  className={`inquiry-row${isSelected ? " is-selected" : ""}`}
                  type="button"
                  aria-current={isSelected ? "true" : undefined}
                  aria-label={`${inquiry.subject}、${inquiry.customer}${isSelected ? "、選択中" : ""}`}
                  onClick={(event) => onSelect(inquiry.id, event.currentTarget)}
                >
                  <span className={`avatar avatar-${inquiry.accent}`} aria-hidden="true">
                    {inquiry.initials}
                  </span>
                  <span className="inquiry-row-content">
                    <span className="inquiry-row-topline">
                      <strong>{inquiry.customer}</strong>
                      <time>{inquiry.receivedAt}</time>
                    </span>
                    <span className="inquiry-subject">{inquiry.subject}</span>
                    <span className="inquiry-preview">
                      <span className="preview-label">返信</span>
                      {getPreview(inquiry.reply)}
                    </span>
                    <span className="inquiry-row-footer">
                      <span className="category-label">{inquiry.category}</span>
                      <ChevronIcon />
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="empty-search" role="status">
          <span className="empty-search-icon" aria-hidden="true">
            <SearchIcon />
          </span>
          <strong>該当する問い合わせがありません</strong>
          <p>検索語を変えて、もう一度お試しください。</p>
        </div>
      )}
    </aside>
  );
}

type ReplyEditorProps = {
  draft: string;
  feedback: SaveFeedback;
  interactionNotice: string | null;
  isDirty: boolean;
  isSaving: boolean;
  validationMessage: string | null;
  failNextSave: boolean;
  acceptedSaveCount: number;
  onDraftChange: (value: string) => void;
  onSave: () => void;
  onReset: () => void;
  onToggleFailNextSave: () => void;
  onOpenHelp: (trigger: HTMLElement) => void;
};

function ReplyEditor({
  draft,
  feedback,
  interactionNotice,
  isDirty,
  isSaving,
  validationMessage,
  failNextSave,
  acceptedSaveCount,
  onDraftChange,
  onSave,
  onReset,
  onToggleFailNextSave,
  onOpenHelp,
}: ReplyEditorProps) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSave();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onSave();
    }
  };

  return (
    <section className="reply-editor panel" aria-labelledby="reply-title">
      <div className="editor-heading">
        <div>
          <div className="section-kicker">
            <MessageIcon />
            <span>返信エディター</span>
          </div>
          <h2 id="reply-title">返信を作成</h2>
        </div>
        <span className={`editor-mode${isDirty ? " is-dirty" : ""}`}>
          <span className="editor-mode-dot" aria-hidden="true" />
          {isDirty ? "編集中" : "保存済み"}
        </span>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="textarea-wrap">
          <label htmlFor="reply-content">返信内容</label>
          <textarea
            id="reply-content"
            value={draft}
            readOnly={isSaving}
            aria-required="true"
            aria-invalid={validationMessage ? "true" : "false"}
            aria-describedby={
              validationMessage
                ? "reply-editor-hint reply-editor-status reply-editor-error"
                : "reply-editor-hint reply-editor-status"
            }
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="textarea-footer">
            <span id="reply-editor-hint" className="editor-hint">
              Enterで改行&nbsp; · &nbsp;Ctrl / ⌘ + Enterで保存
            </span>
            <span className="character-count">{draft.length.toLocaleString("ja-JP")}文字</span>
          </div>
        </div>

        {validationMessage ? (
          <p className="field-error" id="reply-editor-error" role="alert">
            {validationMessage}
          </p>
        ) : null}

        <div className="save-feedback-area">
          <div
            className={`save-feedback save-feedback-${feedback.tone}`}
            id="reply-editor-status"
            role={feedback.tone === "error" ? "alert" : "status"}
            aria-live="polite"
          >
            <span className="feedback-icon" aria-hidden="true">
              {feedback.tone === "success" ? <CheckIcon /> : feedback.tone === "loading" ? <span className="loading-spinner" /> : null}
            </span>
            <span>{feedback.text}</span>
          </div>
          {interactionNotice ? (
            <p className="interaction-notice" role="status" aria-live="polite">
              {interactionNotice}
            </p>
          ) : null}
        </div>

        <div className="editor-actions">
          <div className="secondary-actions">
            <button className="text-button" type="button" onClick={onReset}>
              <RefreshIcon />
              保存済みに戻す
            </button>
            <button className="text-button" type="button" onClick={(event) => onOpenHelp(event.currentTarget)}>
              <HelpIcon />
              操作説明
            </button>
          </div>
          <button className="save-button" type="submit" aria-busy={isSaving ? "true" : "false"}>
            {isSaving ? <span className="button-spinner" aria-hidden="true" /> : <CheckIcon />}
            <span>{isSaving ? "保存中…" : "返信を保存"}</span>
          </button>
        </div>
      </form>

      <div className="demo-strip">
        <div className="demo-strip-copy">
          <span className="demo-label">実演用コントロール</span>
          <span className="demo-description">保存の成功・失敗と連打時の動作を確認できます。</span>
        </div>
        <div className="demo-strip-actions">
          <button
            className={`failure-toggle${failNextSave ? " is-on" : ""}`}
            type="button"
            aria-pressed={failNextSave}
            onClick={onToggleFailNextSave}
          >
            <span className="toggle-indicator" aria-hidden="true" />
            次の保存を失敗させる
            <span className="toggle-state">{failNextSave ? "有効" : "無効"}</span>
          </button>
          <span className="save-counter" aria-label={`受け付けた保存処理、累計${acceptedSaveCount}回`}>
            受付済み保存 <strong>{acceptedSaveCount}</strong>回
          </span>
        </div>
      </div>
    </section>
  );
}

type InquiryDetailProps = {
  inquiry: Inquiry;
  draft: string;
  feedback: SaveFeedback;
  interactionNotice: string | null;
  isDirty: boolean;
  isSaving: boolean;
  validationMessage: string | null;
  failNextSave: boolean;
  acceptedSaveCount: number;
  onDraftChange: (value: string) => void;
  onSave: () => void;
  onReset: () => void;
  onToggleFailNextSave: () => void;
  onOpenHelp: (trigger: HTMLElement) => void;
};

function InquiryDetail({
  inquiry,
  draft,
  feedback,
  interactionNotice,
  isDirty,
  isSaving,
  validationMessage,
  failNextSave,
  acceptedSaveCount,
  onDraftChange,
  onSave,
  onReset,
  onToggleFailNextSave,
  onOpenHelp,
}: InquiryDetailProps) {
  return (
    <section className="detail-column" aria-labelledby="detail-title">
      <div className="detail-heading">
        <div className="breadcrumb">
          <span>受信トレイ</span>
          <ChevronIcon />
          <span>問い合わせ詳細</span>
        </div>
        <div className="detail-heading-row">
          <div>
            <span className="detail-label">選択中の問い合わせ</span>
            <h1 id="detail-title">{inquiry.subject}</h1>
          </div>
          <span className={`detail-status${isDirty ? " has-draft" : ""}`}>
            <span aria-hidden="true" />
            {isDirty ? "未保存" : "対応中"}
          </span>
        </div>
        <div className="customer-meta">
          <span className={`avatar avatar-small avatar-${inquiry.accent}`} aria-hidden="true">
            {inquiry.initials}
          </span>
          <span className="customer-name">{inquiry.customer}</span>
          <span className="meta-separator" aria-hidden="true" />
          <span>{inquiry.email}</span>
          <span className="meta-separator" aria-hidden="true" />
          <time>{inquiry.receivedAt}</time>
        </div>
      </div>

      <article className="message-card panel" aria-labelledby="message-title">
        <div className="message-card-heading">
          <div>
            <span className="section-kicker">問い合わせ本文</span>
            <h2 id="message-title">{inquiry.subject}</h2>
          </div>
          <span className="category-pill">{inquiry.category}</span>
        </div>
        <p className="message-body">{inquiry.body}</p>
      </article>

      <ReplyEditor
        acceptedSaveCount={acceptedSaveCount}
        draft={draft}
        failNextSave={failNextSave}
        feedback={feedback}
        interactionNotice={interactionNotice}
        isDirty={isDirty}
        isSaving={isSaving}
        validationMessage={validationMessage}
        onDraftChange={onDraftChange}
        onOpenHelp={onOpenHelp}
        onReset={onReset}
        onSave={onSave}
        onToggleFailNextSave={onToggleFailNextSave}
      />
    </section>
  );
}

type ModalDialogProps = {
  open: boolean;
  title: string;
  titleId: string;
  describedBy?: string;
  initialFocusRef: RefObject<HTMLElement | null>;
  returnFocusRef: RefObject<HTMLElement | null>;
  closeOnBackdrop?: boolean;
  onClose: () => void;
  children: ReactNode;
};

function ModalDialog({
  open,
  title,
  titleId,
  describedBy,
  initialFocusRef,
  returnFocusRef,
  closeOnBackdrop = false,
  onClose,
  children,
}: ModalDialogProps) {
  useEffect(() => {
    if (!open) {
      return;
    }

    initialFocusRef.current?.focus();

    return () => {
      returnFocusRef.current?.focus();
    };
  }, [initialFocusRef, open, returnFocusRef]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <div className="modal-heading">
          <div>
            <span className="modal-eyebrow">Reply Desk</span>
            <h2 id={titleId}>{title}</h2>
          </div>
          <button className="modal-close" type="button" aria-label={`${title}を閉じる`} onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

type HelpDialogProps = {
  open: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
};

function HelpDialog({ open, returnFocusRef, onClose }: HelpDialogProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <ModalDialog
      describedBy="help-dialog-description"
      initialFocusRef={closeButtonRef}
      onClose={onClose}
      open={open}
      returnFocusRef={returnFocusRef}
      title="操作説明"
      titleId="help-dialog-title"
      closeOnBackdrop
    >
      <div className="help-dialog-body" id="help-dialog-description">
        <p className="modal-intro">問い合わせを選び、返信を整えてから保存してください。画面内だけで操作を完結できます。</p>
        <ol className="help-steps">
          <li>
            <span className="step-number">01</span>
            <span>
              <strong>問い合わせを選ぶ</strong>
              <small>左の一覧を検索し、返信したい問い合わせを選択します。</small>
            </span>
          </li>
          <li>
            <span className="step-number">02</span>
            <span>
              <strong>返信を編集する</strong>
              <small>Enterで改行、Ctrl + Enterまたは⌘ + Enterで保存できます。</small>
            </span>
          </li>
          <li>
            <span className="step-number">03</span>
            <span>
              <strong>保存結果を確認する</strong>
              <small>保存中は約1秒待ちます。失敗した場合も内容は残るので再試行できます。</small>
            </span>
          </li>
        </ol>
        <div className="help-note">
          <span className="help-note-icon" aria-hidden="true">
            <LockIcon />
          </span>
          <span>未保存の編集があるときに別の問い合わせを選ぶと、破棄して切り替えるか確認します。</span>
        </div>
      </div>
      <div className="modal-footer">
        <button ref={closeButtonRef} className="primary-modal-button" type="button" onClick={onClose}>
          閉じる
        </button>
      </div>
    </ModalDialog>
  );
}

type SwitchDialogProps = {
  open: boolean;
  target: Inquiry | null;
  returnFocusRef: RefObject<HTMLElement | null>;
  onCancel: () => void;
  onConfirm: () => void;
};

function SwitchDialog({ open, target, returnFocusRef, onCancel, onConfirm }: SwitchDialogProps) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  if (!target && open) {
    return null;
  }

  return (
    <ModalDialog
      describedBy="switch-dialog-description"
      initialFocusRef={cancelButtonRef}
      onClose={onCancel}
      open={open}
      returnFocusRef={returnFocusRef}
      title="編集内容を確認"
      titleId="switch-dialog-title"
    >
      <div className="switch-dialog-body" id="switch-dialog-description">
        <p>
          <strong>{target?.subject}</strong>へ切り替えますか？
        </p>
        <p className="modal-muted-text">現在の返信には未保存の編集があります。切り替えると、この編集内容は破棄されます。</p>
      </div>
      <div className="modal-footer modal-footer-split">
        <button ref={cancelButtonRef} className="secondary-modal-button" type="button" onClick={onCancel}>
          編集を続ける
        </button>
        <button className="danger-modal-button" type="button" onClick={onConfirm}>
          編集を破棄して切り替える
        </button>
      </div>
    </ModalDialog>
  );
}

function App() {
  const desk = useInquiryDesk(INITIAL_INQUIRIES);
  const [helpOpen, setHelpOpen] = useState(false);
  const helpReturnFocusRef = useRef<HTMLElement | null>(null);
  const switchReturnFocusRef = useRef<HTMLElement | null>(null);

  const openHelp = useCallback((trigger: HTMLElement) => {
    helpReturnFocusRef.current = trigger;
    setHelpOpen(true);
  }, []);

  const closeHelp = useCallback(() => {
    setHelpOpen(false);
  }, []);

  const handleSelectInquiry = useCallback(
    (id: string, trigger: HTMLButtonElement) => {
      switchReturnFocusRef.current = trigger;
      desk.requestSelectInquiry(id);
    },
    [desk.requestSelectInquiry],
  );

  return (
    <div className="app-shell">
      <Header onOpenHelp={openHelp} />

      <main className="workspace">
        <div className="page-intro">
          <div>
            <span className="page-eyebrow">CUSTOMER SUPPORT DESK</span>
            <h1>問い合わせ対応</h1>
            <p>受信した問い合わせを確認し、丁寧な返信を届けましょう。</p>
          </div>
          <div className="page-summary" aria-label="受信トレイの概要">
            <span className="summary-number">{desk.inquiries.length}</span>
            <span>
              <strong>件の問い合わせ</strong>
              <small>ローカルデータ</small>
            </span>
          </div>
        </div>

        <div className="workspace-grid">
          <InquiryList
            inquiries={desk.inquiries}
            isSaving={desk.isSaving}
            onSelect={handleSelectInquiry}
            selectedId={desk.selectedId}
          />
          <InquiryDetail
            acceptedSaveCount={desk.acceptedSaveCount}
            draft={desk.draft}
            failNextSave={desk.failNextSave}
            feedback={desk.feedback}
            inquiry={desk.selectedInquiry}
            interactionNotice={desk.interactionNotice}
            isDirty={desk.isDirty}
            isSaving={desk.isSaving}
            validationMessage={desk.validationMessage}
            onDraftChange={desk.updateDraft}
            onOpenHelp={openHelp}
            onReset={desk.resetDraft}
            onSave={desk.requestSave}
            onToggleFailNextSave={desk.toggleFailNextSave}
          />
        </div>

        <footer className="workspace-footer">
          <span className="footer-mark" aria-hidden="true">
            r
          </span>
          <span>Reply Desk · ローカル非同期デモ</span>
          <span className="footer-separator" aria-hidden="true" />
          <span>返信内容はこの画面の状態だけで管理されます</span>
        </footer>
      </main>

      <HelpDialog open={helpOpen} onClose={closeHelp} returnFocusRef={helpReturnFocusRef} />
      <SwitchDialog
        open={desk.switchTargetInquiry !== null}
        onCancel={desk.cancelInquirySwitch}
        onConfirm={desk.confirmInquirySwitch}
        returnFocusRef={switchReturnFocusRef}
        target={desk.switchTargetInquiry}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
