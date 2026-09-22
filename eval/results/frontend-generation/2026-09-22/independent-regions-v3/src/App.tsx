import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from 'react'
import type {
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  RefObject,
} from 'react'

type Destination = {
  id: 'team' | 'support'
  name: string
  subtitle: string
  description: string
  initials: string
  accent: 'coral' | 'blue'
  placeholder: string
}

const destinations: Destination[] = [
  {
    id: 'team',
    name: '企画チーム',
    subtitle: 'Project room',
    description: 'アイデア、進捗、チームへの共有事項',
    initials: 'PT',
    accent: 'coral',
    placeholder: 'チームに共有したいことを書いてください',
  },
  {
    id: 'support',
    name: 'カスタマーサポート',
    subtitle: 'Support desk',
    description: 'お客さま対応、確認依頼、引き継ぎ',
    initials: 'CS',
    accent: 'blue',
    placeholder: 'サポートへ伝えたい内容を書いてください',
  },
]

type DeliveryResult =
  | { kind: 'none' }
  | { kind: 'sending'; body: string }
  | { kind: 'success'; body: string }
  | { kind: 'failure'; body: string }

type ComposerState = {
  draft: string
  result: DeliveryResult
  validationMessage: string | null
  clearConfirming: boolean
  failNext: boolean
  acceptedCount: number
}

type ComposerEvent =
  | { type: 'draftChanged'; value: string }
  | { type: 'validationError' }
  | { type: 'sendStarted'; body: string }
  | { type: 'sendSucceeded'; body: string }
  | { type: 'sendFailed'; body: string }
  | { type: 'clearRequested' }
  | { type: 'clearCanceled' }
  | { type: 'clearConfirmed' }
  | { type: 'failNextToggled' }

const emptyComposerState: ComposerState = {
  draft: '',
  result: { kind: 'none' },
  validationMessage: null,
  clearConfirming: false,
  failNext: false,
  acceptedCount: 0,
}

function composerReducer(
  state: ComposerState,
  event: ComposerEvent,
): ComposerState {
  switch (event.type) {
    case 'draftChanged':
      if (state.result.kind === 'sending' || state.clearConfirming) {
        return state
      }
      return {
        ...state,
        draft: event.value,
        validationMessage: null,
      }
    case 'validationError':
      return {
        ...state,
        validationMessage: '本文を入力してください。空白だけのメッセージは送信できません。',
      }
    case 'sendStarted':
      if (state.result.kind === 'sending' || state.clearConfirming) {
        return state
      }
      return {
        ...state,
        result: { kind: 'sending', body: event.body },
        validationMessage: null,
        acceptedCount: state.acceptedCount + 1,
        failNext: false,
      }
    case 'sendSucceeded':
      if (state.result.kind !== 'sending') {
        return state
      }
      return {
        ...state,
        draft: '',
        result: { kind: 'success', body: event.body },
      }
    case 'sendFailed':
      if (state.result.kind !== 'sending') {
        return state
      }
      return {
        ...state,
        result: { kind: 'failure', body: event.body },
      }
    case 'clearRequested':
      if (
        state.result.kind === 'sending' ||
        state.clearConfirming ||
        state.draft.length === 0
      ) {
        return state
      }
      return {
        ...state,
        clearConfirming: true,
        validationMessage: null,
      }
    case 'clearCanceled':
      return {
        ...state,
        clearConfirming: false,
      }
    case 'clearConfirmed':
      if (!state.clearConfirming) {
        return state
      }
      return {
        ...state,
        draft: '',
        clearConfirming: false,
        validationMessage: null,
      }
    case 'failNextToggled':
      return {
        ...state,
        failNext: !state.failNext,
      }
    default:
      return state
  }
}

function useMessageComposer() {
  const [state, dispatch] = useReducer(composerReducer, emptyComposerState)
  const stateRef = useRef(state)
  const timerRef = useRef<number | null>(null)

  stateRef.current = state

  const requestSend = useCallback(() => {
    const current = stateRef.current

    if (
      current.clearConfirming ||
      current.result.kind === 'sending' ||
      timerRef.current !== null
    ) {
      return
    }

    if (current.draft.trim().length === 0) {
      dispatch({ type: 'validationError' })
      return
    }

    const body = current.draft
    const shouldFail = current.failNext

    dispatch({ type: 'sendStarted', body })
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      dispatch({
        type: shouldFail ? 'sendFailed' : 'sendSucceeded',
        body,
      })
    }, 1000)
  }, [])

  const changeDraft = useCallback((value: string) => {
    dispatch({ type: 'draftChanged', value })
  }, [])

  const requestClear = useCallback(() => {
    const current = stateRef.current
    if (
      current.result.kind === 'sending' ||
      current.clearConfirming ||
      current.draft.length === 0
    ) {
      return
    }
    dispatch({ type: 'clearRequested' })
  }, [])

  const cancelClear = useCallback(() => {
    dispatch({ type: 'clearCanceled' })
  }, [])

  const confirmClear = useCallback(() => {
    const current = stateRef.current
    if (!current.clearConfirming || current.result.kind === 'sending') {
      return
    }
    dispatch({ type: 'clearConfirmed' })
  }, [])

  const toggleFailNext = useCallback(() => {
    dispatch({ type: 'failNextToggled' })
  }, [])

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
      }
    }
  }, [])

  return {
    ...state,
    changeDraft,
    requestSend,
    requestClear,
    cancelClear,
    confirmClear,
    toggleFailNext,
  }
}

type MessageComposerProps = {
  destination: Destination
  onOpenHelp: (trigger: HTMLButtonElement) => void
}

function MessageComposer({
  destination,
  onOpenHelp,
}: MessageComposerProps) {
  const {
    draft,
    result,
    validationMessage,
    clearConfirming,
    failNext,
    acceptedCount,
    changeDraft,
    requestSend,
    requestClear,
    cancelClear,
    confirmClear,
    toggleFailNext,
  } = useMessageComposer()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const confirmationRef = useRef<HTMLDivElement>(null)
  const headingId = `${destination.id}-heading`
  const textareaId = `${destination.id}-message`
  const statusId = `${destination.id}-status`
  const confirmationHeadingId = `${destination.id}-clear-heading`
  const confirmationDescriptionId = `${destination.id}-clear-description`
  const isSending = result.kind === 'sending'
  const isInputLocked = isSending || clearConfirming

  useEffect(() => {
    if (clearConfirming) {
      confirmationRef.current?.focus()
    }
  }, [clearConfirming])

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    requestSend()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === 'Enter' &&
      (event.ctrlKey || event.metaKey)
    ) {
      event.preventDefault()
      requestSend()
    }
  }

  const handleHelpClick = (event: MouseEvent<HTMLButtonElement>) => {
    onOpenHelp(event.currentTarget)
  }

  const handleCancelClear = () => {
    cancelClear()
    window.requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const handleConfirmClear = () => {
    confirmClear()
    window.requestAnimationFrame(() => textareaRef.current?.focus())
  }

  return (
    <section
      className={`composer-card composer-card--${destination.accent}`}
      aria-labelledby={headingId}
    >
      <div className="composer-card__topline">
        <div>
          <div className="destination-kicker">
            <span className="destination-dot" aria-hidden="true" />
            <span>{destination.subtitle}</span>
          </div>
          <h2 id={headingId}>{destination.name}</h2>
          <p className="destination-description">{destination.description}</p>
        </div>
        <div className="destination-initials" aria-hidden="true">
          {destination.initials}
        </div>
      </div>

      <form className="composer-form" onSubmit={handleSubmit}>
        <div className="field-label-row">
          <label htmlFor={textareaId}>{destination.name}のメッセージ本文</label>
          <button
            type="button"
            className="field-help-button"
            onClick={handleHelpClick}
            aria-label={`${destination.name}の操作ガイドを開く`}
          >
            <span aria-hidden="true">?</span>
            操作ガイド
          </button>
        </div>

        <div className="textarea-shell">
          <textarea
            ref={textareaRef}
            id={textareaId}
            value={draft}
            onChange={(event) => changeDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={destination.placeholder}
            rows={6}
            disabled={isInputLocked}
            aria-invalid={validationMessage !== null}
            aria-required="true"
            aria-keyshortcuts="Control+Enter Meta+Enter"
            aria-describedby={`${statusId}${validationMessage ? ` ${destination.id}-validation` : ''}`}
          />
          <span className="character-count" aria-live="polite">
            {draft.length}文字
          </span>
        </div>

        {validationMessage && (
          <p
            id={`${destination.id}-validation`}
            className="form-message form-message--error"
            role="alert"
          >
            <span aria-hidden="true">!</span>
            {validationMessage}
          </p>
        )}

        <div className="form-actions">
          <button
            type="button"
            className="clear-button"
            onClick={requestClear}
            disabled={isInputLocked || draft.length === 0}
          >
            <span aria-hidden="true">×</span>
            入力を消去
          </button>
          <button
            type="submit"
            className="send-button"
            disabled={isInputLocked}
          >
            {isSending ? '送信中' : '送信する'}
            <span className="send-shortcut">Ctrl / ⌘ + Enter</span>
            <span className="send-arrow" aria-hidden="true">
              ↗
            </span>
          </button>
        </div>
      </form>

      {clearConfirming && (
        <div
          ref={confirmationRef}
          className="inline-confirmation"
          role="alertdialog"
          aria-labelledby={confirmationHeadingId}
          aria-describedby={confirmationDescriptionId}
          tabIndex={-1}
        >
          <div className="inline-confirmation__icon" aria-hidden="true">
            ?
          </div>
          <div className="inline-confirmation__content">
            <h3 id={confirmationHeadingId}>入力を消去しますか？</h3>
            <p id={confirmationDescriptionId}>入力中の本文は元に戻せません。</p>
          </div>
          <div className="inline-confirmation__actions">
            <button type="button" className="text-button" onClick={handleCancelClear}>
              編集に戻る
            </button>
            <button
              type="button"
              className="danger-button"
              onClick={handleConfirmClear}
            >
              破棄して消去
            </button>
          </div>
        </div>
      )}

      <div className="composer-card__footer">
        <button
          type="button"
          className={`fail-toggle${failNext ? ' fail-toggle--active' : ''}`}
          onClick={toggleFailNext}
          aria-pressed={failNext}
        >
          <span className="fail-toggle__indicator" aria-hidden="true" />
          {failNext ? '次回の失敗を設定中' : '次の送信を失敗させる'}
        </button>
        <div className="accepted-count" aria-label={`受け付けた送信回数 ${acceptedCount}回`}>
          <span className="accepted-count__number">{acceptedCount}</span>
          <span className="accepted-count__label">受け付けた送信回数</span>
        </div>
      </div>

      <DeliveryStatus
        result={result}
        statusId={statusId}
        onRetry={requestSend}
      />
    </section>
  )
}

type DeliveryStatusProps = {
  result: DeliveryResult
  statusId: string
  onRetry: () => void
}

function DeliveryStatus({ result, statusId, onRetry }: DeliveryStatusProps) {
  if (result.kind === 'none') {
    return (
      <div id={statusId} className="delivery-status delivery-status--idle">
        <span className="status-mark" aria-hidden="true">
          ·
        </span>
        <span>
          <strong>未送信</strong>
          <small>本文を入力して送信してください</small>
        </span>
      </div>
    )
  }

  if (result.kind === 'sending') {
    return (
      <div
        id={statusId}
        className="delivery-status delivery-status--sending"
        role="status"
        aria-live="polite"
      >
        <span className="status-spinner" aria-hidden="true" />
        <span>
          <strong>送信処理中</strong>
          <small>約1秒で完了します。入力はロックされています</small>
        </span>
      </div>
    )
  }

  if (result.kind === 'success') {
    return (
      <div
        id={statusId}
        className="delivery-status delivery-status--success"
        role="status"
        aria-live="polite"
      >
        <div className="delivery-status__heading">
          <span className="status-mark" aria-hidden="true">
            ✓
          </span>
          <strong>送信しました</strong>
        </div>
        <span className="delivery-status__label">実際に送った本文</span>
        <p className="sent-body">{result.body}</p>
      </div>
    )
  }

  return (
    <div
      id={statusId}
      className="delivery-status delivery-status--failure"
      role="alert"
      aria-live="assertive"
    >
      <div className="delivery-status__heading">
        <span className="status-mark" aria-hidden="true">
          !
        </span>
        <strong>送信に失敗しました</strong>
      </div>
      <p>本文は保持しています。内容を確認して再試行できます。</p>
      <span className="delivery-status__label">送信しようとした本文</span>
      <p className="sent-body">{result.body}</p>
      <button type="button" className="retry-button" onClick={onRetry}>
        この本文を再試行する
        <span aria-hidden="true">↗</span>
      </button>
    </div>
  )
}

type HelpDialogProps = {
  dialogRef: RefObject<HTMLDivElement | null>
  onClose: () => void
}

function HelpDialog({ dialogRef, onClose }: HelpDialogProps) {
  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className="help-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-dialog-title"
        tabIndex={-1}
      >
        <div className="help-dialog__header">
          <div>
            <span className="help-dialog__eyebrow">QUICK GUIDE</span>
            <h2 id="help-dialog-title">操作ガイド</h2>
          </div>
          <button type="button" className="dialog-close" onClick={onClose}>
            <span aria-hidden="true">×</span>
            <span className="sr-only">操作ガイドを閉じる</span>
          </button>
        </div>

        <div className="help-dialog__body">
          <div className="guide-row">
            <div className="guide-key" aria-hidden="true">
              <span>Ctrl</span>
              <b>↵</b>
            </div>
            <div>
              <strong>すぐに送信する</strong>
              <p>本文にカーソルがある状態で Ctrl + Enter または ⌘ + Enter。</p>
            </div>
          </div>
          <div className="guide-row">
            <div className="guide-key guide-key--plain" aria-hidden="true">
              <b>↵</b>
            </div>
            <div>
              <strong>改行する</strong>
              <p>通常の Enter は本文の中で改行します。</p>
            </div>
          </div>
          <div className="guide-row">
            <div className="guide-key guide-key--plain" aria-hidden="true">
              <b>!</b>
            </div>
            <div>
              <strong>失敗を試す</strong>
              <p>「次の送信を失敗させる」を押すと、次の一回だけ失敗します。</p>
            </div>
          </div>
          <p className="guide-note">
            各宛先の入力・送信状態は独立しています。一方が処理中でも、もう一方はそのまま使えます。
          </p>
        </div>

        <div className="help-dialog__footer">
          <button type="button" className="dialog-done" onClick={onClose}>
            わかりました
            <span aria-hidden="true">↗</span>
          </button>
        </div>
      </div>
    </div>
  )
}

function App() {
  const [helpOpen, setHelpOpen] = useState(false)
  const helpTriggerRef = useRef<HTMLButtonElement | null>(null)
  const pageContentRef = useRef<HTMLDivElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)

  const openHelp = useCallback((trigger: HTMLButtonElement) => {
    helpTriggerRef.current = trigger
    setHelpOpen(true)
  }, [])

  const closeHelp = useCallback(() => {
    setHelpOpen(false)
  }, [])

  useEffect(() => {
    const pageContent = pageContentRef.current
    if (!pageContent) {
      return
    }

    if (helpOpen) {
      pageContent.setAttribute('inert', '')
      pageContent.setAttribute('aria-hidden', 'true')
      dialogRef.current?.focus()
      return
    }

    pageContent.removeAttribute('inert')
    pageContent.removeAttribute('aria-hidden')
    helpTriggerRef.current?.focus()
  }, [helpOpen])

  useEffect(() => {
    if (!helpOpen) {
      return
    }

    const handleDialogKeyDown = (event: globalThis.KeyboardEvent) => {
      const dialog = dialogRef.current
      if (!dialog) {
        return
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        closeHelp()
        return
      }

      if (event.key !== 'Tab') {
        return
      }

      const focusableElements = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      )
      if (focusableElements.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }

      const first = focusableElements[0]
      const last = focusableElements[focusableElements.length - 1]
      const active = document.activeElement

      if (!dialog.contains(active) || active === dialog) {
        event.preventDefault()
        if (event.shiftKey) {
          last.focus()
        } else {
          first.focus()
        }
      } else if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleDialogKeyDown)
    return () => {
      document.removeEventListener('keydown', handleDialogKeyDown)
    }
  }, [closeHelp, helpOpen])

  return (
    <>
      <div ref={pageContentRef} className="app-shell">
        <header className="site-header">
          <div className="brand" aria-label="ふたつの宛先へ送信">
            <span className="brand-mark" aria-hidden="true">
              <span />
              <span />
            </span>
            <span>
              <strong>DUO</strong>
              <small>MESSAGE DESK</small>
            </span>
          </div>
          <div className="header-actions">
            <span className="local-badge">
              <span aria-hidden="true" />
              LOCAL DEMO
            </span>
            <button
              type="button"
              className="header-help-button"
              onClick={(event) => openHelp(event.currentTarget)}
            >
              <span className="help-icon" aria-hidden="true">?</span>
              使い方
            </button>
          </div>
        </header>

        <main>
          <section className="hero" aria-labelledby="page-title">
            <div className="hero__copy">
              <p className="section-eyebrow">
                <span>01</span>
                TWO DESTINATIONS / ONE DESK
              </p>
              <h1 id="page-title">
                ふたつの宛先へ、
                <br />
                <em>同じ画面から。</em>
              </h1>
              <p className="hero__description">
                宛先ごとに入力と送信状態を管理できます。
                <br className="desktop-break" />
                片方を送信中でも、もう片方はいつも通り操作できます。
              </p>
            </div>
            <div className="hero__aside" aria-label="この画面の特徴">
              <div className="hero__aside-line" />
              <p>Independent by design.</p>
              <span>それぞれの入力を、それぞれのペースで。</span>
            </div>
          </section>

          <section className="instruction-bar" aria-label="操作の概要">
            <div className="instruction-bar__item">
              <span className="instruction-bar__number">A</span>
              <span>
                <strong>書く</strong>
                <small>宛先ごとに本文を入力</small>
              </span>
            </div>
            <span className="instruction-bar__arrow" aria-hidden="true">→</span>
            <div className="instruction-bar__item">
              <span className="instruction-bar__number">B</span>
              <span>
                <strong>送る</strong>
                <small>ボタンまたは Ctrl / ⌘ + Enter</small>
              </span>
            </div>
            <span className="instruction-bar__arrow" aria-hidden="true">→</span>
            <div className="instruction-bar__item">
              <span className="instruction-bar__number">C</span>
              <span>
                <strong>確認する</strong>
                <small>送った本文と結果を表示</small>
              </span>
            </div>
            <button
              type="button"
              className="instruction-help"
              onClick={(event) => openHelp(event.currentTarget)}
            >
              <span aria-hidden="true">?</span>
              操作ガイド
            </button>
          </section>

          <section className="destinations" aria-labelledby="destinations-title">
            <div className="destinations__heading">
              <div>
                <p className="section-eyebrow"><span>02</span> DESTINATIONS</p>
                <h2 id="destinations-title">送信先を選ばず、並行して進める</h2>
              </div>
              <p>入力欄のガイドから、いつでも操作方法を確認できます。</p>
            </div>
            <div className="composer-grid">
              {destinations.map((destination) => (
                <MessageComposer
                  key={destination.id}
                  destination={destination}
                  onOpenHelp={openHelp}
                />
              ))}
            </div>
          </section>
        </main>

        <footer className="site-footer">
          <span>DUO MESSAGE DESK</span>
          <span>操作を分けて、仕事を止めない。</span>
        </footer>
      </div>

      {helpOpen && <HelpDialog dialogRef={dialogRef} onClose={closeHelp} />}
    </>
  )
}

export default App
