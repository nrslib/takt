import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
} from "react";
import type {
  FormEvent,
  KeyboardEvent,
  MouseEvent,
} from "react";

const DESTINATIONS = [
  {
    id: "studio",
    label: "制作チーム",
    detail: "画面とコンテンツの担当者",
    initials: "ST",
    accent: "violet",
  },
  {
    id: "support",
    label: "サポート窓口",
    detail: "お客様対応の担当者",
    initials: "CS",
    accent: "teal",
  },
] as const;

type DestinationId = (typeof DESTINATIONS)[number]["id"];
type DeliveryStatus = "idle" | "sending" | "error";
type OutcomeKind = "validation" | "success" | "error";

type Outcome = {
  kind: OutcomeKind;
  message: string;
};

type DestinationState = {
  draft: string;
  status: DeliveryStatus;
  clearConfirming: boolean;
  failNext: boolean;
  acceptedCount: number;
  pendingBody: string | null;
  lastSentBody: string | null;
  outcome: Outcome | null;
};

type AppState = {
  helpOpen: boolean;
  destinations: Record<DestinationId, DestinationState>;
};

type Action =
  | { type: "DRAFT_CHANGED"; id: DestinationId; value: string }
  | { type: "SUBMIT_REJECTED"; id: DestinationId }
  | { type: "SEND_ACCEPTED"; id: DestinationId; body: string }
  | { type: "SEND_SUCCEEDED"; id: DestinationId; body: string }
  | { type: "SEND_FAILED"; id: DestinationId; body: string }
  | { type: "REQUEST_CLEAR"; id: DestinationId }
  | { type: "CONFIRM_CLEAR"; id: DestinationId }
  | { type: "CANCEL_CLEAR"; id: DestinationId }
  | { type: "TOGGLE_FAIL_NEXT"; id: DestinationId }
  | { type: "OPEN_HELP" }
  | { type: "CLOSE_HELP" };

const EMPTY_DESTINATION: DestinationState = {
  draft: "",
  status: "idle",
  clearConfirming: false,
  failNext: false,
  acceptedCount: 0,
  pendingBody: null,
  lastSentBody: null,
  outcome: null,
};

function createInitialState(): AppState {
  return {
    helpOpen: false,
    destinations: {
      studio: { ...EMPTY_DESTINATION },
      support: { ...EMPTY_DESTINATION },
    },
  };
}

function updateDestination(
  state: AppState,
  id: DestinationId,
  update: (destination: DestinationState) => DestinationState,
): AppState {
  return {
    ...state,
    destinations: {
      ...state.destinations,
      [id]: update(state.destinations[id]),
    },
  };
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "DRAFT_CHANGED":
      return updateDestination(state, action.id, (destination) => ({
        ...destination,
        draft: action.value,
        status: destination.status === "error" ? "idle" : destination.status,
        outcome:
          destination.outcome?.kind === "validation" ||
          destination.outcome?.kind === "error"
            ? null
            : destination.outcome,
      }));

    case "SUBMIT_REJECTED":
      return updateDestination(state, action.id, (destination) => {
        if (destination.status === "sending" || destination.clearConfirming) {
          return destination;
        }

        return {
          ...destination,
          outcome: {
            kind: "validation",
            message: "本文を入力してください。空白だけのメッセージは送信できません。",
          },
        };
      });

    case "SEND_ACCEPTED":
      return updateDestination(state, action.id, (destination) => {
        if (
          destination.status === "sending" ||
          destination.clearConfirming ||
          !action.body.trim()
        ) {
          return destination;
        }

        return {
          ...destination,
          status: "sending",
          pendingBody: action.body,
          failNext: false,
          acceptedCount: destination.acceptedCount + 1,
          outcome: null,
        };
      });

    case "SEND_SUCCEEDED":
      return updateDestination(state, action.id, (destination) => {
        if (
          destination.status !== "sending" ||
          destination.pendingBody !== action.body
        ) {
          return destination;
        }

        return {
          ...destination,
          draft: "",
          status: "idle",
          pendingBody: null,
          lastSentBody: action.body,
          outcome: {
            kind: "success",
            message: "送信が完了しました。",
          },
        };
      });

    case "SEND_FAILED":
      return updateDestination(state, action.id, (destination) => {
        if (
          destination.status !== "sending" ||
          destination.pendingBody !== action.body
        ) {
          return destination;
        }

        return {
          ...destination,
          status: "error",
          pendingBody: null,
          outcome: {
            kind: "error",
            message: "送信に失敗しました。本文は保持されています。再送信してください。",
          },
        };
      });

    case "REQUEST_CLEAR":
      return updateDestination(state, action.id, (destination) => {
        if (
          destination.status === "sending" ||
          destination.clearConfirming ||
          !destination.draft.length
        ) {
          return destination;
        }

        return { ...destination, clearConfirming: true };
      });

    case "CONFIRM_CLEAR":
      return updateDestination(state, action.id, (destination) => {
        if (!destination.clearConfirming) {
          return destination;
        }

        return {
          ...destination,
          draft: "",
          clearConfirming: false,
          status: "idle",
          outcome: null,
        };
      });

    case "CANCEL_CLEAR":
      return updateDestination(state, action.id, (destination) => ({
        ...destination,
        clearConfirming: false,
      }));

    case "TOGGLE_FAIL_NEXT":
      return updateDestination(state, action.id, (destination) => {
        if (destination.status === "sending" || destination.clearConfirming) {
          return destination;
        }

        return { ...destination, failNext: !destination.failNext };
      });

    case "OPEN_HELP":
      return { ...state, helpOpen: true };

    case "CLOSE_HELP":
      return { ...state, helpOpen: false };

    default:
      return state;
  }
}

function useMessageMediator() {
  const [state, dispatch] = useReducer(reducer, undefined, createInitialState);
  const stateRef = useRef(state);
  const sendLocksRef = useRef<Record<DestinationId, boolean>>({
    studio: false,
    support: false,
  });
  const timersRef = useRef<Partial<Record<DestinationId, number>>>({});

  stateRef.current = state;

  useEffect(() => {
    return () => {
      Object.values(timersRef.current).forEach((timer) => {
        if (timer !== undefined) {
          window.clearTimeout(timer);
        }
      });
    };
  }, []);

  const changeDraft = useCallback((id: DestinationId, value: string) => {
    const destination = stateRef.current.destinations[id];
    if (
      stateRef.current.helpOpen ||
      destination.status === "sending" ||
      destination.clearConfirming
    ) {
      return;
    }

    dispatch({ type: "DRAFT_CHANGED", id, value });
  }, []);

  const send = useCallback((id: DestinationId) => {
    const destination = stateRef.current.destinations[id];

    if (
      stateRef.current.helpOpen ||
      sendLocksRef.current[id] ||
      destination.status === "sending" ||
      destination.clearConfirming
    ) {
      return;
    }

    if (!destination.draft.trim()) {
      dispatch({ type: "SUBMIT_REJECTED", id });
      return;
    }

    const body = destination.draft;
    const shouldFail = destination.failNext;
    sendLocksRef.current[id] = true;
    dispatch({ type: "SEND_ACCEPTED", id, body });

    timersRef.current[id] = window.setTimeout(() => {
      sendLocksRef.current[id] = false;
      timersRef.current[id] = undefined;
      dispatch({
        type: shouldFail ? "SEND_FAILED" : "SEND_SUCCEEDED",
        id,
        body,
      });
    }, 1000);
  }, []);

  const requestClear = useCallback((id: DestinationId) => {
    const destination = stateRef.current.destinations[id];
    if (
      stateRef.current.helpOpen ||
      destination.status === "sending" ||
      destination.clearConfirming
    ) {
      return;
    }

    dispatch({ type: "REQUEST_CLEAR", id });
  }, []);

  const confirmClear = useCallback((id: DestinationId) => {
    if (stateRef.current.helpOpen) {
      return;
    }

    dispatch({ type: "CONFIRM_CLEAR", id });
  }, []);

  const cancelClear = useCallback((id: DestinationId) => {
    if (stateRef.current.helpOpen) {
      return;
    }

    dispatch({ type: "CANCEL_CLEAR", id });
  }, []);

  const toggleFailNext = useCallback((id: DestinationId) => {
    const destination = stateRef.current.destinations[id];
    if (
      stateRef.current.helpOpen ||
      destination.status === "sending" ||
      destination.clearConfirming
    ) {
      return;
    }

    dispatch({ type: "TOGGLE_FAIL_NEXT", id });
  }, []);

  const openHelp = useCallback(() => {
    dispatch({ type: "OPEN_HELP" });
  }, []);

  const closeHelp = useCallback(() => {
    dispatch({ type: "CLOSE_HELP" });
  }, []);

  return {
    state,
    actions: {
      changeDraft,
      send,
      requestClear,
      confirmClear,
      cancelClear,
      toggleFailNext,
      openHelp,
      closeHelp,
    },
  };
}

type MessageCardProps = {
  config: (typeof DESTINATIONS)[number];
  destination: DestinationState;
  onChangeDraft: (id: DestinationId, value: string) => void;
  onSend: (id: DestinationId) => void;
  onRequestClear: (id: DestinationId) => void;
  onConfirmClear: (id: DestinationId) => void;
  onCancelClear: (id: DestinationId) => void;
  onToggleFailNext: (id: DestinationId) => void;
  onOpenHelp: (event: MouseEvent<HTMLButtonElement>) => void;
};

function MessageCard({
  config,
  destination,
  onChangeDraft,
  onSend,
  onRequestClear,
  onConfirmClear,
  onCancelClear,
  onToggleFailNext,
  onOpenHelp,
}: MessageCardProps) {
  const inputId = `message-${config.id}`;
  const hintId = `${inputId}-hint`;
  const outcomeId = `${inputId}-outcome`;
  const confirmationId = `${inputId}-confirmation`;
  const isSending = destination.status === "sending";
  const isConfirming = destination.clearConfirming;
  const hasValidationError = destination.outcome?.kind === "validation";
  const isError = destination.outcome?.kind === "error";
  const isSuccess = destination.outcome?.kind === "success";
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cancelClearRef = useRef<HTMLButtonElement>(null);
  const hadConfirmationRef = useRef(false);

  useEffect(() => {
    if (isConfirming) {
      hadConfirmationRef.current = true;
      cancelClearRef.current?.focus();
      return;
    }

    if (hadConfirmationRef.current) {
      hadConfirmationRef.current = false;
      textareaRef.current?.focus();
    }
  }, [isConfirming]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSend(config.id);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      (event.ctrlKey || event.metaKey) &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  let describedBy = hintId;
  if (hasValidationError || isError || isSuccess) {
    describedBy = `${hintId} ${outcomeId}`;
  }
  if (isConfirming) {
    describedBy = `${hintId} ${confirmationId}`;
  }

  return (
    <article className={`message-card message-card--${config.accent}`}>
      <header className="card-header">
        <div className="destination-heading">
          <div className="destination-avatar" aria-hidden="true">
            {config.initials}
          </div>
          <div>
            <p className="eyebrow">TO</p>
            <h2>{config.label}</h2>
            <p className="destination-detail">{config.detail}</p>
          </div>
        </div>
        <button
          type="button"
          className="icon-button guide-button"
          onClick={onOpenHelp}
          aria-label={`${config.label}の操作ガイドを開く`}
        >
          <span aria-hidden="true">?</span>
          <span>操作ガイド</span>
        </button>
      </header>

      <div className="card-metrics" aria-label={`${config.label}の送信情報`}>
        <span className="metric-chip">
          <span className="metric-dot" aria-hidden="true" />
          受け付けた送信 <strong>{destination.acceptedCount}回</strong>
        </span>
        {destination.failNext && (
          <span className="armed-chip">
            <span aria-hidden="true">↯</span> 次回失敗を設定中
          </span>
        )}
      </div>

      <form
        className="message-form"
        onSubmit={handleSubmit}
        aria-busy={isSending}
      >
        <div className="field-heading">
          <label htmlFor={inputId}>メッセージ本文</label>
          <span className="character-count" aria-live="polite">
            {destination.draft.length}文字
          </span>
        </div>
        <textarea
          ref={textareaRef}
          id={inputId}
          value={destination.draft}
          onChange={(event) => onChangeDraft(config.id, event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="伝えたいことを入力してください"
          rows={7}
          disabled={isSending || isConfirming}
          aria-invalid={hasValidationError}
          aria-describedby={describedBy}
        />
        <p id={hintId} className="field-hint">
          <span className="keyboard-key">Ctrl</span>
          <span aria-hidden="true">+</span>
          <span className="keyboard-key">Enter</span>
          <span className="hint-separator">または</span>
          <span className="keyboard-key">⌘</span>
          <span aria-hidden="true">+</span>
          <span className="keyboard-key">Enter</span>
          <span>で送信</span>
        </p>

        <div className="form-actions">
          <button
            type="button"
            className="text-button"
            onClick={() => onRequestClear(config.id)}
            disabled={!destination.draft.length || isSending || isConfirming}
          >
            <span aria-hidden="true">×</span>
            入力を消去
          </button>
          <button
            type="submit"
            className="send-button"
            disabled={isSending || isConfirming}
          >
            {isSending ? (
              <>
                <span className="spinner" aria-hidden="true" />
                送信中
              </>
            ) : isError ? (
              <>
                再送信
                <span aria-hidden="true">↗</span>
              </>
            ) : (
              <>
                送信する
                <span aria-hidden="true">↗</span>
              </>
            )}
          </button>
        </div>
      </form>

      <div className="card-controls">
        <button
          type="button"
          className={`failure-toggle ${destination.failNext ? "failure-toggle--active" : ""}`}
          onClick={() => onToggleFailNext(config.id)}
          disabled={isSending || isConfirming}
          aria-pressed={destination.failNext}
        >
          <span aria-hidden="true">↯</span>
          {destination.failNext
            ? "次回送信の失敗を解除"
            : "次の送信を失敗させる"}
        </button>
        <span className="control-note">
          動作確認用の一回限りの設定
        </span>
      </div>

      {isConfirming && (
        <div
          id={confirmationId}
          className="inline-confirmation"
          role="alertdialog"
          aria-labelledby={`${confirmationId}-title`}
        >
          <div className="confirmation-icon" aria-hidden="true">
            !
          </div>
          <div className="confirmation-copy">
            <h3 id={`${confirmationId}-title`}>入力内容を消去しますか？</h3>
            <p>この欄に入力した本文を破棄します。送信済みの履歴は残ります。</p>
          </div>
          <div className="confirmation-actions">
            <button
              ref={cancelClearRef}
              type="button"
              className="secondary-button"
              onClick={() => onCancelClear(config.id)}
            >
              編集に戻る
            </button>
            <button
              type="button"
              className="danger-button"
              onClick={() => onConfirmClear(config.id)}
            >
              破棄する
            </button>
          </div>
        </div>
      )}

      {isSending && (
        <div className="status-message status-message--sending" role="status">
          <span className="status-mark" aria-hidden="true">
            <span className="spinner spinner--small" />
          </span>
          <span>
            <strong>送信処理中</strong>
            <small>この宛先の入力は一時的にロックされています</small>
          </span>
        </div>
      )}

      {destination.outcome && !isSending && (
        <div
          id={outcomeId}
          className={`status-message status-message--${destination.outcome.kind}`}
          role={destination.outcome.kind === "validation" || isError ? "alert" : "status"}
        >
          <span className="status-mark" aria-hidden="true">
            {destination.outcome.kind === "success"
              ? "✓"
              : destination.outcome.kind === "error"
                ? "!"
                : "i"}
          </span>
          <span>
            <strong>{destination.outcome.message}</strong>
            {isError && <small>内容を確認して、そのまま再送信できます。</small>}
          </span>
        </div>
      )}

      {isSuccess && destination.lastSentBody !== null && (
        <section className="sent-preview" aria-label="実際に送った本文">
          <div className="sent-preview-heading">
            <span>実際に送った本文</span>
            <span className="sent-badge">送信済み</span>
          </div>
          <p>{destination.lastSentBody}</p>
        </section>
      )}
    </article>
  );
}

type HelpDialogProps = {
  open: boolean;
  onClose: () => void;
};

function HelpDialog({ open, onClose }: HelpDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const dialog = dialogRef.current;
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!dialog) {
        return;
      }

      if (!dialog.contains(event.target as Node)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );

      if (!focusable.length) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  return (
    <div className="dialog-layer" role="presentation">
      <div className="dialog-scrim" aria-hidden="true" />
      <div
        ref={dialogRef}
        className="help-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-dialog-title"
        aria-describedby="help-dialog-description"
      >
        <div className="dialog-topline">
          <span className="dialog-kicker">QUICK GUIDE</span>
          <button
            ref={closeButtonRef}
            type="button"
            className="dialog-close"
            onClick={onClose}
            aria-label="操作ガイドを閉じる"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <h2 id="help-dialog-title">操作ガイド</h2>
        <p id="help-dialog-description" className="dialog-lead">
          二つの宛先はそれぞれ独立して動作します。片方の処理中も、もう片方はそのまま使えます。
        </p>
        <div className="guide-list">
          <div className="guide-item">
            <span className="guide-number">01</span>
            <div>
              <h3>入力して送信</h3>
              <p>
                通常のEnterは改行です。<strong>Ctrl + Enter</strong> または <strong>⌘ + Enter</strong>で送信できます。
              </p>
            </div>
          </div>
          <div className="guide-item">
            <span className="guide-number">02</span>
            <div>
              <h3>入力を消去</h3>
              <p>「入力を消去」を押すと確認が表示されます。編集に戻れば内容は残ります。</p>
            </div>
          </div>
          <div className="guide-item">
            <span className="guide-number">03</span>
            <div>
              <h3>失敗を試す</h3>
              <p>「次の送信を失敗させる」を設定すると一度だけ失敗します。本文を保持したまま再送信できます。</p>
            </div>
          </div>
        </div>
        <div className="dialog-footer">
          <span className="dialog-footer-mark" aria-hidden="true">i</span>
          <span>この画面の送信処理はデモ用で、外部サービスには接続しません。</span>
        </div>
      </div>
    </div>
  );
}

function App() {
  const { state, actions } = useMessageMediator();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const hadOpenHelpRef = useRef(false);

  useEffect(() => {
    if (state.helpOpen) {
      hadOpenHelpRef.current = true;
      return;
    }

    if (hadOpenHelpRef.current) {
      hadOpenHelpRef.current = false;
      returnFocusRef.current?.focus();
    }
  }, [state.helpOpen]);

  const handleOpenHelp = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      returnFocusRef.current = event.currentTarget;
      actions.openHelp();
    },
    [actions.openHelp],
  );

  return (
    <>
      <div className="app-shell" aria-hidden={state.helpOpen || undefined}>
        <header className="topbar">
          <a className="brand" href="/" aria-label="Relay ホーム">
            <span className="brand-mark" aria-hidden="true">
              <span />
              <span />
            </span>
            <span>relay</span>
          </a>
          <div className="topbar-actions">
            <span className="local-badge">
              <span className="live-dot" aria-hidden="true" />
              ローカル動作
            </span>
            <button
              type="button"
              className="top-guide-button"
              onClick={handleOpenHelp}
            >
              <span className="top-guide-icon" aria-hidden="true">?</span>
              使い方
            </button>
          </div>
        </header>

        <main className="main-content">
          <section className="intro" aria-labelledby="page-title">
            <div className="intro-copy">
              <p className="section-kicker">
                <span className="kicker-line" aria-hidden="true" />
                MESSAGE DESK
              </p>
              <h1 id="page-title">
                二つの宛先へ、
                <span>同時に送る。</span>
              </h1>
              <p className="intro-description">
                宛先ごとにメッセージを用意して、必要なタイミングで届けましょう。
                <br />
                それぞれの送信状態は独立して管理されます。
              </p>
            </div>
            <div className="intro-note" aria-label="送信状態の説明">
              <span className="intro-note-icon" aria-hidden="true">↗</span>
              <span>
                <strong>2 destinations</strong>
                <small>個別に送信できます</small>
              </span>
            </div>
          </section>

          <section className="cards-grid" aria-label="宛先ごとのメッセージ入力">
            {DESTINATIONS.map((config) => (
              <MessageCard
                key={config.id}
                config={config}
                destination={state.destinations[config.id]}
                onChangeDraft={actions.changeDraft}
                onSend={actions.send}
                onRequestClear={actions.requestClear}
                onConfirmClear={actions.confirmClear}
                onCancelClear={actions.cancelClear}
                onToggleFailNext={actions.toggleFailNext}
                onOpenHelp={handleOpenHelp}
              />
            ))}
          </section>

          <footer className="page-footer">
            <span>送信先ごとに処理が完了するまで約1秒かかります</span>
            <span className="footer-divider" aria-hidden="true" />
            <span>外部サービスへの接続はありません</span>
          </footer>
        </main>
      </div>

      <HelpDialog open={state.helpOpen} onClose={actions.closeHelp} />
    </>
  );
}

export default App;
