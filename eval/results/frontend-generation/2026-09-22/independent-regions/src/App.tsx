import { useEffect, useReducer, useRef } from "react";
import type {
  FormEvent,
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import "./styles.css";

const DESTINATION_DEFINITIONS = [
  {
    id: "project",
    name: "プロジェクトチーム",
    description: "社内の進行共有",
    initials: "PT",
    tone: "violet",
  },
  {
    id: "support",
    name: "顧客サポート",
    description: "お客さまへの連絡窓口",
    initials: "CS",
    tone: "aqua",
  },
] as const;

type DestinationId = (typeof DESTINATION_DEFINITIONS)[number]["id"];
type DestinationDefinition = (typeof DESTINATION_DEFINITIONS)[number];
type SendStatus = "idle" | "sending" | "success" | "error";

type SendResult = {
  kind: "success" | "error";
  body: string;
};

type DestinationState = {
  draft: string;
  status: SendStatus;
  confirmClear: boolean;
  validationMessage: string | null;
  result: SendResult | null;
  acceptedCount: number;
  failNext: boolean;
};

type AppState = {
  destinations: Record<DestinationId, DestinationState>;
  guideOpen: boolean;
};

type AppAction =
  | { type: "draftChanged"; id: DestinationId; value: string }
  | { type: "validationFailed"; id: DestinationId }
  | { type: "clearConfirmationOpened"; id: DestinationId }
  | { type: "clearConfirmationCancelled"; id: DestinationId }
  | { type: "draftCleared"; id: DestinationId }
  | { type: "failureToggled"; id: DestinationId }
  | { type: "sendStarted"; id: DestinationId; willFail: boolean }
  | { type: "sendSucceeded"; id: DestinationId; body: string }
  | { type: "sendFailed"; id: DestinationId; body: string }
  | { type: "guideOpened" }
  | { type: "guideClosed" };

const createDestinationState = (): DestinationState => ({
  draft: "",
  status: "idle",
  confirmClear: false,
  validationMessage: null,
  result: null,
  acceptedCount: 0,
  failNext: false,
});

const initialState: AppState = {
  destinations: {
    project: createDestinationState(),
    support: createDestinationState(),
  },
  guideOpen: false,
};

function replaceDestination(
  state: AppState,
  id: DestinationId,
  changes: Partial<DestinationState>,
): AppState {
  return {
    ...state,
    destinations: {
      ...state.destinations,
      [id]: {
        ...state.destinations[id],
        ...changes,
      },
    },
  };
}

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "draftChanged": {
      const destination = state.destinations[action.id];

      if (destination.status === "sending" || destination.confirmClear) {
        return state;
      }

      return replaceDestination(state, action.id, {
        draft: action.value,
        validationMessage: null,
      });
    }

    case "validationFailed": {
      const destination = state.destinations[action.id];

      if (destination.status === "sending" || destination.confirmClear) {
        return state;
      }

      return replaceDestination(state, action.id, {
        validationMessage: "空白だけのメッセージは送信できません。本文を入力してください。",
      });
    }

    case "clearConfirmationOpened": {
      const destination = state.destinations[action.id];

      if (destination.status === "sending" || destination.confirmClear) {
        return state;
      }

      return replaceDestination(state, action.id, {
        confirmClear: true,
        validationMessage: null,
      });
    }

    case "clearConfirmationCancelled": {
      const destination = state.destinations[action.id];

      if (!destination.confirmClear) {
        return state;
      }

      return replaceDestination(state, action.id, { confirmClear: false });
    }

    case "draftCleared": {
      const destination = state.destinations[action.id];

      if (!destination.confirmClear) {
        return state;
      }

      return replaceDestination(state, action.id, {
        draft: "",
        confirmClear: false,
        validationMessage: null,
      });
    }

    case "failureToggled": {
      const destination = state.destinations[action.id];

      if (destination.status === "sending" || destination.confirmClear) {
        return state;
      }

      return replaceDestination(state, action.id, {
        failNext: !destination.failNext,
      });
    }

    case "sendStarted": {
      const destination = state.destinations[action.id];

      if (destination.status === "sending" || destination.confirmClear) {
        return state;
      }

      return replaceDestination(state, action.id, {
        status: "sending",
        result: null,
        validationMessage: null,
        acceptedCount: destination.acceptedCount + 1,
        failNext: action.willFail ? false : destination.failNext,
      });
    }

    case "sendSucceeded": {
      const destination = state.destinations[action.id];

      if (destination.status !== "sending") {
        return state;
      }

      return replaceDestination(state, action.id, {
        status: "success",
        result: { kind: "success", body: action.body },
      });
    }

    case "sendFailed": {
      const destination = state.destinations[action.id];

      if (destination.status !== "sending") {
        return state;
      }

      return replaceDestination(state, action.id, {
        status: "error",
        result: { kind: "error", body: action.body },
      });
    }

    case "guideOpened":
      return state.guideOpen ? state : { ...state, guideOpen: true };

    case "guideClosed":
      return state.guideOpen ? { ...state, guideOpen: false } : state;

    default:
      return state;
  }
}

type DestinationCardProps = {
  definition: DestinationDefinition;
  state: DestinationState;
  onDraftChange: (id: DestinationId, value: string) => void;
  onSend: (id: DestinationId) => void;
  onOpenClearConfirmation: (id: DestinationId) => void;
  onCancelClear: (id: DestinationId) => void;
  onConfirmClear: (id: DestinationId) => void;
  onToggleFailure: (id: DestinationId) => void;
  onOpenGuide: (trigger: HTMLButtonElement) => void;
};

function getStatusLabel(state: DestinationState): string {
  if (state.confirmClear) {
    return "消去を確認中";
  }

  switch (state.status) {
    case "sending":
      return "送信中";
    case "success":
      return "送信完了";
    case "error":
      return "送信失敗";
    default:
      return "待機中";
  }
}

function DestinationCard({
  definition,
  state,
  onDraftChange,
  onSend,
  onOpenClearConfirmation,
  onCancelClear,
  onConfirmClear,
  onToggleFailure,
  onOpenGuide,
}: DestinationCardProps) {
  const isLocked = state.status === "sending" || state.confirmClear;
  const fieldId = `${definition.id}-message`;
  const hintId = `${definition.id}-hint`;
  const validationId = `${definition.id}-validation`;
  const resultId = `${definition.id}-result`;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSend(definition.id);
  };

  const handleEditorKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key === "Enter" &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      onSend(definition.id);
    }
  };

  const handleGuideClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    onOpenGuide(event.currentTarget);
  };

  return (
    <article className={`destination-card tone-${definition.tone}`}>
      <div className="card-color-bar" aria-hidden="true" />
      <header className="card-header">
        <div className="destination-heading">
          <div className="destination-avatar" aria-hidden="true">
            {definition.initials}
          </div>
          <div>
            <p className="destination-eyebrow">宛先 {definition.initials}</p>
            <h2>{definition.name}</h2>
            <p className="destination-description">{definition.description}</p>
          </div>
        </div>
        <button
          type="button"
          className="icon-button card-guide-button"
          aria-label={`${definition.name}の操作説明を開く`}
          aria-haspopup="dialog"
          onClick={handleGuideClick}
        >
          <span aria-hidden="true">?</span>
        </button>
      </header>

      <div className="card-status-row">
        <span
          className={`status-badge status-${state.status}`}
          role="status"
          aria-live="polite"
        >
          <span className="status-dot" aria-hidden="true" />
          {getStatusLabel(state)}
        </span>
        <span className="accepted-count">
          受付回数 <strong>{state.acceptedCount}</strong>
        </span>
      </div>

      <form
        className="composer-form"
        aria-label={`${definition.name}へのメッセージ送信`}
        onSubmit={handleSubmit}
      >
        <div className="field-heading">
          <label htmlFor={fieldId}>メッセージ</label>
          <span id={hintId} className="field-hint">
            Ctrl + Enter / ⌘ + Enter で送信
          </span>
        </div>
        <textarea
          id={fieldId}
          value={state.draft}
          rows={7}
          disabled={isLocked}
          aria-describedby={`${hintId}${state.validationMessage ? ` ${validationId}` : ""}`}
          aria-invalid={state.validationMessage ? "true" : undefined}
          placeholder={`${definition.name}に伝えたいことを入力`}
          onChange={(event) =>
            onDraftChange(definition.id, event.currentTarget.value)
          }
          onKeyDown={handleEditorKeyDown}
        />
        {state.validationMessage ? (
          <p id={validationId} className="field-message" role="alert">
            <span aria-hidden="true">!</span>
            {state.validationMessage}
          </p>
        ) : null}

        <div className="composer-actions">
          <p className="input-note">
            <span className="keyboard-icon" aria-hidden="true">
              ↵
            </span>
            通常の Enter は改行
          </p>
          <button
            type="submit"
            className="send-button"
            disabled={isLocked}
            aria-describedby={state.validationMessage ? validationId : undefined}
          >
            {state.status === "sending" ? (
              <>
                <span className="loading-spinner" aria-hidden="true" />
                送信中…
              </>
            ) : (
              <>
                送信する
                <span className="send-arrow" aria-hidden="true">
                  →
                </span>
              </>
            )}
          </button>
        </div>
      </form>

      {state.confirmClear ? (
        <div className="clear-confirmation" role="alert">
          <div>
            <strong>入力内容を消去しますか？</strong>
            <p>「編集に戻る」を選ぶと、入力内容を残したまま閉じます。</p>
          </div>
          <div className="confirmation-actions">
            <button
              type="button"
              className="button button-danger"
              onClick={() => onConfirmClear(definition.id)}
            >
              破棄して消去
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => onCancelClear(definition.id)}
            >
              編集に戻る
            </button>
          </div>
        </div>
      ) : null}

      <div className="card-tools">
        <button
          type="button"
          className="text-button clear-button"
          disabled={isLocked || state.draft.length === 0}
          onClick={() => onOpenClearConfirmation(definition.id)}
        >
          <span aria-hidden="true">⌫</span>
          入力を消去
        </button>
        <button
          type="button"
          className={`text-button failure-button${state.failNext ? " is-armed" : ""}`}
          aria-pressed={state.failNext}
          disabled={isLocked}
          onClick={() => onToggleFailure(definition.id)}
        >
          <span className="failure-indicator" aria-hidden="true" />
          {state.failNext ? "失敗予定を取り消す" : "次の送信を失敗させる"}
        </button>
      </div>

      {state.result ? (
        <section
          id={resultId}
          className={`result-panel result-${state.result.kind}`}
          aria-live="polite"
          aria-label={`${definition.name}の送信結果`}
        >
          <div className="result-heading">
            <span className="result-icon" aria-hidden="true">
              {state.result.kind === "success" ? "✓" : "!"}
            </span>
            <div>
              <strong>
                {state.result.kind === "success"
                  ? "送信結果"
                  : "送信に失敗しました"}
              </strong>
              {state.result.kind === "error" ? (
                <p>本文は入力欄に残っています。確認して再送信できます。</p>
              ) : null}
            </div>
          </div>
          <div className="result-body">
            <span>実際に送った本文</span>
            <p>{state.result.body}</p>
          </div>
        </section>
      ) : null}
    </article>
  );
}

type GuideDialogProps = {
  onClose: () => void;
};

function GuideDialog({ onClose }: GuideDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const focusableElements = dialogRef.current
      ? Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        )
      : [];

    if (focusableElements.length === 0) {
      event.preventDefault();
      return;
    }

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];
    const activeElement = document.activeElement;

    if (event.shiftKey && activeElement === firstElement) {
      event.preventDefault();
      lastElement.focus();
    } else if (!event.shiftKey && activeElement === lastElement) {
      event.preventDefault();
      firstElement.focus();
    }
  };

  const handleBackdropClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="dialog-layer" onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className="guide-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guide-dialog-title"
        aria-describedby="guide-dialog-description"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="dialog-header">
          <div>
            <p className="dialog-eyebrow">QUICK GUIDE</p>
            <h2 id="guide-dialog-title">この画面の使い方</h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="icon-button dialog-close"
            aria-label="操作説明を閉じる"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <p id="guide-dialog-description" className="dialog-intro">
          二つの宛先は別々に動作します。片方の送信中や確認中も、もう片方はそのまま使えます。
        </p>
        <ol className="guide-list">
          <li>
            <span className="guide-number">01</span>
            <div>
              <strong>入力して送信</strong>
              <p>
                通常の Enter は改行、Ctrl + Enter または ⌘ + Enter は送信です。送信には約1秒かかります。
              </p>
            </div>
          </li>
          <li>
            <span className="guide-number">02</span>
            <div>
              <strong>入力を消去</strong>
              <p>
                消去前にカード内で確認します。「編集に戻る」なら入力内容は残ります。
              </p>
            </div>
          </li>
          <li>
            <span className="guide-number">03</span>
            <div>
              <strong>失敗を試す</strong>
              <p>
                「次の送信を失敗させる」を選ぶと一度だけ失敗します。本文を確認して再送信できます。
              </p>
            </div>
          </li>
        </ol>
        <div className="dialog-note">
          <span aria-hidden="true">i</span>
          <p>この画面は外部サービスへ接続せず、送信処理をローカルで再現しています。</p>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const activeRequestsRef = useRef(new Set<DestinationId>());
  const timersRef = useRef(new Set<number>());
  const appShellRef = useRef<HTMLDivElement>(null);
  const guideTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    return () => {
      timersRef.current.forEach((timerId) => window.clearTimeout(timerId));
      timersRef.current.clear();
      activeRequestsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!state.guideOpen) {
      guideTriggerRef.current?.focus();
      return;
    }

    const appShell = appShellRef.current;
    const previousOverflow = document.body.style.overflow;

    appShell?.setAttribute("inert", "");
    appShell?.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "hidden";

    return () => {
      appShell?.removeAttribute("inert");
      appShell?.removeAttribute("aria-hidden");
      document.body.style.overflow = previousOverflow;
    };
  }, [state.guideOpen]);

  const handleSend = (id: DestinationId) => {
    const destination = state.destinations[id];

    if (
      state.guideOpen ||
      destination.status === "sending" ||
      destination.confirmClear ||
      activeRequestsRef.current.has(id)
    ) {
      return;
    }

    if (destination.draft.trim().length === 0) {
      dispatch({ type: "validationFailed", id });
      return;
    }

    const body = destination.draft;
    const willFail = destination.failNext;
    activeRequestsRef.current.add(id);
    dispatch({ type: "sendStarted", id, willFail });

    const timerId = window.setTimeout(() => {
      activeRequestsRef.current.delete(id);
      timersRef.current.delete(timerId);
      dispatch({
        type: willFail ? "sendFailed" : "sendSucceeded",
        id,
        body,
      });
    }, 1000);

    timersRef.current.add(timerId);
  };

  const handleOpenGuide = (trigger: HTMLButtonElement) => {
    if (state.guideOpen) {
      return;
    }

    guideTriggerRef.current = trigger;
    dispatch({ type: "guideOpened" });
  };

  const handleCloseGuide = () => {
    dispatch({ type: "guideClosed" });
  };

  return (
    <>
      <div ref={appShellRef} className="app-shell">
        <div className="page-frame">
          <header className="site-header">
            <div className="brand-lockup">
              <div className="brand-symbol" aria-hidden="true">
                <span />
                <span />
              </div>
              <div>
                <p className="brand-eyebrow">LOCAL MESSAGE DESK</p>
                <h1>二つの宛先へ送る</h1>
              </div>
            </div>
            <button
              type="button"
              className="guide-button"
              aria-label="操作説明を開く"
              aria-haspopup="dialog"
              onClick={(event) => handleOpenGuide(event.currentTarget)}
            >
              <span className="guide-button-icon" aria-hidden="true">
                ?
              </span>
              操作説明
            </button>
          </header>

          <section className="intro-section" aria-labelledby="page-intro-title">
            <div>
              <p className="section-eyebrow">TWO DESTINATIONS, ONE DESK</p>
              <h2 id="page-intro-title">宛先ごとに、落ち着いて送る。</h2>
              <p className="intro-copy">
                それぞれの入力と送信状態を独立して管理できます。送信前の確認や、失敗時の再試行もこの画面で完結します。
              </p>
            </div>
            <div className="local-badge">
              <span className="local-badge-dot" aria-hidden="true" />
              <div>
                <strong>ローカル送信</strong>
                <span>外部サービスには接続しません</span>
              </div>
            </div>
          </section>

          <main className="destination-grid" aria-label="送信先一覧">
            {DESTINATION_DEFINITIONS.map((definition) => (
              <DestinationCard
                key={definition.id}
                definition={definition}
                state={state.destinations[definition.id]}
                onDraftChange={(id, value) =>
                  dispatch({ type: "draftChanged", id, value })
                }
                onSend={handleSend}
                onOpenClearConfirmation={(id) =>
                  dispatch({ type: "clearConfirmationOpened", id })
                }
                onCancelClear={(id) =>
                  dispatch({ type: "clearConfirmationCancelled", id })
                }
                onConfirmClear={(id) => dispatch({ type: "draftCleared", id })}
                onToggleFailure={(id) =>
                  dispatch({ type: "failureToggled", id })
                }
                onOpenGuide={handleOpenGuide}
              />
            ))}
          </main>

          <footer className="page-footer">
            <span className="footer-mark" aria-hidden="true">
              •
            </span>
            入力内容はこの画面の中だけで扱います
          </footer>
        </div>
      </div>

      {state.guideOpen ? <GuideDialog onClose={handleCloseGuide} /> : null}
    </>
  );
}
