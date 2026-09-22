import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'

type SavePhase = 'idle' | 'saving' | 'success' | 'error' | 'validation' | 'unchanged'

type Inquiry = {
  id: string
  ticketNumber: string
  customerName: string
  avatar: string
  email: string
  subject: string
  body: string
  savedReply: string
  receivedAt: string
  channel: string
  priority: '通常' | '要確認'
  updatedAt: string
}

type SaveState = {
  phase: SavePhase
  message: string
  targetId: string
}

type WorkspaceState = {
  inquiries: Inquiry[]
  selectedId: string
  draft: string
  save: SaveState
  acceptedSaveCount: number
  failNextSave: boolean
  notice: string
}

type WorkspaceAction =
  | { type: 'draftChanged'; value: string }
  | { type: 'selectInquiry'; inquiryId: string }
  | { type: 'restoreSaved' }
  | { type: 'saveRequested' }
  | { type: 'saveSucceeded'; targetId: string; reply: string; savedAt: string }
  | { type: 'saveFailed'; targetId: string }
  | { type: 'setSaveFeedback'; phase: 'validation' | 'unchanged'; message: string }
  | { type: 'toggleFailNextSave' }
  | { type: 'setNotice'; message: string }

const initialInquiries: Inquiry[] = [
  {
    id: 'inquiry-001',
    ticketNumber: 'Q-1048',
    customerName: '田中 美咲',
    avatar: '田',
    email: 'misaki.tanaka@example.jp',
    subject: '請求書の宛名を変更したい',
    body: 'いつもお世話になっております。\n先ほど発行された9月分の請求書について、宛名を「田中 美咲」から「株式会社ノースライト」へ変更できますでしょうか。\nお手数をおかけしますが、対応方法を教えてください。',
    savedReply: 'お問い合わせありがとうございます。\n請求書の宛名変更について承りました。確認のうえ、変更後の請求書を再発行いたします。\n完了しましたら、あらためてご連絡いたします。',
    receivedAt: '2026年9月22日 09:14',
    channel: 'メール',
    priority: '要確認',
    updatedAt: '2026年9月22日 09:14',
  },
  {
    id: 'inquiry-002',
    ticketNumber: 'Q-1047',
    customerName: '佐藤 健',
    avatar: '佐',
    email: 'ken.sato@example.jp',
    subject: 'ログイン用メールアドレスを変更したい',
    body: '登録しているメールアドレスが使えなくなってしまいました。\nログインはできていますが、新しいアドレスへ変更する手順を教えていただけますか。',
    savedReply: 'お問い合わせありがとうございます。\nログイン後、「アカウント設定」からメールアドレスを変更できます。変更後のアドレスへ確認メールが届きますので、メール内のリンクを開いて手続きを完了してください。',
    receivedAt: '2026年9月22日 08:42',
    channel: 'チャット',
    priority: '通常',
    updatedAt: '2026年9月22日 08:42',
  },
  {
    id: 'inquiry-003',
    ticketNumber: 'Q-1046',
    customerName: '中村 彩',
    avatar: '中',
    email: 'aya.nakamura@example.jp',
    subject: 'チームメンバーを追加する方法',
    body: '新しいメンバーをプロジェクトに招待したいです。\n管理者権限を持っているのですが、どの画面から招待できますか。',
    savedReply: 'お問い合わせありがとうございます。\n「チーム設定」から「メンバーを招待」を選択し、招待する方のメールアドレスを入力してください。招待メールが送信されます。',
    receivedAt: '2026年9月21日 17:26',
    channel: 'メール',
    priority: '通常',
    updatedAt: '2026年9月21日 17:26',
  },
  {
    id: 'inquiry-004',
    ticketNumber: 'Q-1045',
    customerName: '合同会社グリーン',
    avatar: 'G',
    email: 'contact@green-example.jp',
    subject: 'プラン変更後の利用料金について',
    body: '今月からプランを変更しました。次回請求では日割り計算になりますか。\nまた、現在の契約内容も確認したいです。',
    savedReply: 'お問い合わせありがとうございます。\nプラン変更月は、旧プランと新プランの利用期間に応じた日割り計算となります。現在の契約内容はアカウント設定の「契約情報」からご確認いただけます。',
    receivedAt: '2026年9月21日 15:08',
    channel: 'フォーム',
    priority: '通常',
    updatedAt: '2026年9月21日 15:08',
  },
]

const createInitialState = (): WorkspaceState => {
  const firstInquiry = initialInquiries[0]

  return {
    inquiries: initialInquiries,
    selectedId: firstInquiry.id,
    draft: firstInquiry.savedReply,
    save: {
      phase: 'idle',
      message: '保存済みの返信を表示しています。',
      targetId: firstInquiry.id,
    },
    acceptedSaveCount: 0,
    failNextSave: false,
    notice: '',
  }
}

function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  const selectedInquiry = state.inquiries.find((inquiry) => inquiry.id === state.selectedId)

  switch (action.type) {
    case 'draftChanged': {
      if (!selectedInquiry) return state
      const isDirty = action.value !== selectedInquiry.savedReply

      return {
        ...state,
        draft: action.value,
        save: {
          phase: 'idle',
          message: isDirty ? '未保存の変更があります。保存すると一覧にも反映されます。' : '保存済みの返信を表示しています。',
          targetId: state.selectedId,
        },
        notice: '',
      }
    }
    case 'selectInquiry': {
      const nextInquiry = state.inquiries.find((inquiry) => inquiry.id === action.inquiryId)
      if (!nextInquiry) return state

      return {
        ...state,
        selectedId: nextInquiry.id,
        draft: nextInquiry.savedReply,
        save: {
          phase: 'idle',
          message: '保存済みの返信を表示しています。',
          targetId: nextInquiry.id,
        },
        notice: '',
      }
    }
    case 'restoreSaved': {
      if (!selectedInquiry) return state

      return {
        ...state,
        draft: selectedInquiry.savedReply,
        save: {
          phase: 'idle',
          message: '保存済みの返信に戻しました。',
          targetId: state.selectedId,
        },
        notice: '',
      }
    }
    case 'saveRequested':
      return {
        ...state,
        save: {
          phase: 'saving',
          message: '保存しています。完了するまで問い合わせを切り替えられません。',
          targetId: state.selectedId,
        },
        acceptedSaveCount: state.acceptedSaveCount + 1,
        failNextSave: false,
        notice: '',
      }
    case 'saveSucceeded': {
      const updatedInquiries = state.inquiries.map((inquiry) =>
        inquiry.id === action.targetId
          ? { ...inquiry, savedReply: action.reply, updatedAt: action.savedAt }
          : inquiry,
      )

      return {
        ...state,
        inquiries: updatedInquiries,
        save: {
          phase: 'success',
          message: '保存しました。返信内容を一覧にも反映しています。',
          targetId: action.targetId,
        },
        notice: '',
      }
    }
    case 'saveFailed':
      return {
        ...state,
        save: {
          phase: 'error',
          message: '保存に失敗しました。入力内容は保持しています。もう一度保存してください。',
          targetId: action.targetId,
        },
        notice: '',
      }
    case 'setSaveFeedback':
      return {
        ...state,
        save: {
          phase: action.phase,
          message: action.message,
          targetId: state.selectedId,
        },
        notice: '',
      }
    case 'toggleFailNextSave':
      return {
        ...state,
        failNextSave: !state.failNextSave,
        notice: state.failNextSave ? '次回保存の失敗設定を解除しました。' : '次に受け付けた保存を失敗させます。',
      }
    case 'setNotice':
      return { ...state, notice: action.message }
    default:
      return state
  }
}

type HeaderProps = {
  acceptedSaveCount: number
  isSaving: boolean
  onOpenHelp: () => void
}

function Header({ acceptedSaveCount, isSaving, onOpenHelp }: HeaderProps) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div>
            <p className="brand-name">Reply Desk</p>
            <p className="brand-subtitle">問い合わせ対応ワークスペース</p>
          </div>
        </div>
        <div className="topbar-actions">
          <div className={`header-save-state ${isSaving ? 'is-saving' : ''}`} aria-live="polite">
            <span className="header-state-dot" aria-hidden="true" />
            <span>{isSaving ? '保存処理中' : 'ローカルモード'}</span>
          </div>
          <div className="accepted-count" aria-live="polite">
            <span>受付済み保存</span>
            <strong>{acceptedSaveCount}</strong>
            <span>回</span>
          </div>
          <button type="button" className="header-help-button" onClick={onOpenHelp}>
            <span className="help-icon" aria-hidden="true">?</span>
            操作ガイド
          </button>
        </div>
      </div>
    </header>
  )
}

type InquiryListProps = {
  inquiries: Inquiry[]
  selectedId: string
  query: string
  onQueryChange: (value: string) => void
  onClearQuery: () => void
  onSelect: (inquiryId: string, trigger: HTMLElement) => void
}

function InquiryList({
  inquiries,
  selectedId,
  query,
  onQueryChange,
  onClearQuery,
  onSelect,
}: InquiryListProps) {
  return (
    <aside className="inbox-panel panel" aria-labelledby="inbox-title">
      <div className="panel-heading inbox-heading">
        <div>
          <p className="section-kicker">INBOX</p>
          <h2 id="inbox-title">受信トレイ</h2>
        </div>
        <span className="inbox-count">{inquiries.length}件</span>
      </div>

      <label className="search-field" htmlFor="inquiry-search">
        <span className="search-icon" aria-hidden="true" />
        <span className="sr-only">問い合わせを検索</span>
        <input
          id="inquiry-search"
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="件名・本文・名前で検索"
          autoComplete="off"
        />
        {query && (
          <button type="button" className="clear-search" onClick={onClearQuery} aria-label="検索条件をクリア">
            ×
          </button>
        )}
      </label>

      <div className="list-summary">
        <span>{query ? `「${query}」の検索結果` : 'すべての問い合わせ'}</span>
        <span>{inquiries.length}件</span>
      </div>

      {inquiries.length > 0 ? (
        <ul className="inquiry-list">
          {inquiries.map((inquiry) => {
            const isSelected = inquiry.id === selectedId

            return (
              <li key={inquiry.id}>
                <button
                  type="button"
                  className={`inquiry-item ${isSelected ? 'is-selected' : ''}`}
                  aria-current={isSelected ? 'true' : undefined}
                  aria-label={`${inquiry.customerName}「${inquiry.subject}」${isSelected ? '、選択中' : ''}`}
                  onClick={(event) => onSelect(inquiry.id, event.currentTarget)}
                >
                  <span className="inquiry-item-topline">
                    <span className="customer-avatar" aria-hidden="true">{inquiry.avatar}</span>
                    <span className="customer-name">{inquiry.customerName}</span>
                    <time>{inquiry.receivedAt.split(' ')[inquiry.receivedAt.split(' ').length - 1]}</time>
                  </span>
                  <strong className="inquiry-subject">{inquiry.subject}</strong>
                  <span className="inquiry-excerpt">{inquiry.body.replace(/\n/g, ' ')}</span>
                  <span className="inquiry-reply-preview">
                    <span className="reply-preview-label">返信</span>
                    <span>{inquiry.savedReply.replace(/\n/g, ' ')}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <div className="empty-list" role="status">
          <div className="empty-list-icon" aria-hidden="true">⌕</div>
          <h3>該当する問い合わせがありません</h3>
          <p>検索語を変えるか、条件をクリアしてください。</p>
          <button type="button" className="text-button" onClick={onClearQuery}>
            検索をクリア
          </button>
        </div>
      )}
    </aside>
  )
}

type StatusPanelProps = {
  save: SaveState
  isDirty: boolean
  acceptedSaveCount: number
}

function StatusPanel({ save, isDirty, acceptedSaveCount }: StatusPanelProps) {
  const role = save.phase === 'error' || save.phase === 'validation' ? 'alert' : 'status'
  const label = {
    idle: isDirty ? '未保存' : '保存済み',
    saving: '保存中',
    success: '保存完了',
    error: '保存失敗',
    validation: '入力を確認',
    unchanged: '変更なし',
  }[save.phase]

  return (
    <div id="reply-status" className={`status-panel status-${save.phase}`} role={role} aria-live="polite">
      <div className="status-symbol" aria-hidden="true">
        {save.phase === 'saving' ? <span className="spinner" /> : save.phase === 'success' ? '✓' : save.phase === 'error' || save.phase === 'validation' ? '!' : 'i'}
      </div>
      <div className="status-copy">
        <div className="status-title-row">
          <strong>{label}</strong>
          {save.phase === 'saving' && <span className="status-count">受付 {acceptedSaveCount}回目</span>}
        </div>
        <p>{save.message}</p>
      </div>
    </div>
  )
}

type DetailProps = {
  inquiry: Inquiry
  draft: string
  save: SaveState
  isDirty: boolean
  acceptedSaveCount: number
  isSaving: boolean
  failNextSave: boolean
  onDraftChange: (value: string) => void
  onSave: () => void
  onRestore: () => void
  onToggleFailNext: () => void
  onOpenHelp: () => void
}

function InquiryDetail({
  inquiry,
  draft,
  save,
  isDirty,
  acceptedSaveCount,
  isSaving,
  failNextSave,
  onDraftChange,
  onSave,
  onRestore,
  onToggleFailNext,
  onOpenHelp,
}: DetailProps) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onSave()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      onSave()
    }
  }

  return (
    <section className="detail-panel" aria-labelledby="detail-title">
      <div className="detail-heading">
        <div>
          <p className="section-kicker">TICKET {inquiry.ticketNumber}</p>
          <h1 id="detail-title">{inquiry.subject}</h1>
        </div>
        <span className={`priority-badge ${inquiry.priority === '要確認' ? 'priority-attention' : ''}`}>
          <span className="priority-dot" aria-hidden="true" />
          {inquiry.priority}
        </span>
      </div>

      <div className="customer-strip">
        <span className="large-avatar" aria-hidden="true">{inquiry.avatar}</span>
        <div className="customer-details">
          <strong>{inquiry.customerName}</strong>
          <span>{inquiry.email}</span>
        </div>
        <div className="customer-meta">
          <span>{inquiry.channel}</span>
          <time>{inquiry.receivedAt}</time>
        </div>
      </div>

      <article className="message-card panel" aria-labelledby="message-title">
        <div className="message-card-heading">
          <div>
            <p className="section-kicker">CUSTOMER MESSAGE</p>
            <h2 id="message-title">お問い合わせ本文</h2>
          </div>
          <span className="message-date">受信 {inquiry.receivedAt}</span>
        </div>
        <p className="message-body">{inquiry.body}</p>
      </article>

      <section className="reply-card panel" aria-labelledby="reply-title">
        <div className="reply-card-heading">
          <div>
            <p className="section-kicker">RESPONSE DRAFT</p>
            <h2 id="reply-title">返信を編集</h2>
            <p className="reply-description">お客様へ送る返信を確認・編集して保存します。</p>
          </div>
          <button type="button" className="inline-help-button" onClick={onOpenHelp}>
            <span className="help-icon" aria-hidden="true">?</span>
            操作ガイド
          </button>
        </div>

        <StatusPanel save={save} isDirty={isDirty} acceptedSaveCount={acceptedSaveCount} />

        <form className="reply-form" onSubmit={handleSubmit}>
          <div className="editor-label-row">
            <label htmlFor="reply-editor">返信本文</label>
            <span className="character-count">{draft.length}文字</span>
          </div>
          <textarea
            id="reply-editor"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isSaving}
            aria-required="true"
            aria-invalid={save.phase === 'validation' ? 'true' : 'false'}
            aria-describedby="reply-helper reply-status"
            spellCheck="false"
          />
          <div id="reply-helper" className="editor-helper">
            <span><kbd>⌘</kbd><span className="shortcut-or">または</span><kbd>Ctrl</kbd> + <kbd>Enter</kbd> で保存</span>
            <span>Enter で改行</span>
          </div>

          <div className="reply-footer">
            <div className="reply-secondary-actions">
              <button type="button" className="restore-button" onClick={onRestore} disabled={isSaving}>
                <span aria-hidden="true">↶</span>
                保存済みに戻す
              </button>
              <button type="button" className="demo-fail-button" onClick={onToggleFailNext} disabled={isSaving} aria-pressed={failNextSave}>
                <span className="demo-fail-indicator" aria-hidden="true" />
                次の保存を失敗させる
              </button>
            </div>
            <button type="submit" className="save-button" disabled={isSaving}>
              {isSaving ? <span className="button-spinner" aria-hidden="true" /> : <span aria-hidden="true">↑</span>}
              {isSaving ? '保存中…' : '返信を保存'}
            </button>
          </div>
        </form>
      </section>
    </section>
  )
}

type ModalDialogProps = {
  title: string
  onClose: () => void
  children: ReactNode
  closeLabel?: string
}

function ModalDialog({ title, onClose, children, closeLabel = '閉じる' }: ModalDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previousActiveElement = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButtonRef.current?.focus()

    return () => {
      document.body.style.overflow = previousOverflow
      if (previousActiveElement?.isConnected) previousActiveElement.focus()
    }
  }, [])

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation()

    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }

    if (event.key !== 'Tab' || !dialogRef.current) return

    const focusableElements = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    )

    if (focusableElements.length === 0) {
      event.preventDefault()
      dialogRef.current.focus()
      return
    }

    const firstElement = focusableElements[0]
    const lastElement = focusableElements[focusableElements.length - 1]
    const activeElement = document.activeElement

    if (event.shiftKey && activeElement === firstElement) {
      event.preventDefault()
      lastElement.focus()
    } else if (!event.shiftKey && activeElement === lastElement) {
      event.preventDefault()
      firstElement.focus()
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) event.preventDefault()
      }}
    >
      <div
        ref={dialogRef}
        className="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="modal-header">
          <div className="modal-title-wrap">
            <span className="modal-title-icon" aria-hidden="true">i</span>
            <h2 id="modal-title">{title}</h2>
          </div>
          <button ref={closeButtonRef} type="button" className="modal-close" onClick={onClose} aria-label={closeLabel}>
            ×
          </button>
        </div>
        <div className="modal-content">{children}</div>
      </div>
    </div>
  )
}

function HelpContent() {
  return (
    <div className="help-content">
      <p className="modal-intro">この画面では、問い合わせを選び、返信を編集して保存できます。</p>
      <div className="help-list">
        <div className="help-row">
          <span className="help-row-number">01</span>
          <div>
            <strong>返信を保存する</strong>
            <p>「返信を保存」ボタン、または本文入力中の <kbd>⌘</kbd> / <kbd>Ctrl</kbd> + <kbd>Enter</kbd> で保存します。通常の <kbd>Enter</kbd> は改行になります。</p>
          </div>
        </div>
        <div className="help-row">
          <span className="help-row-number">02</span>
          <div>
            <strong>保存中の操作</strong>
            <p>保存には約1秒かかります。保存中は対象の切り替えを受け付けません。連続した保存操作も一つだけ処理します。</p>
          </div>
        </div>
        <div className="help-row">
          <span className="help-row-number">03</span>
          <div>
            <strong>編集を戻す・問い合わせを切り替える</strong>
            <p>「保存済みに戻す」で現在の下書きを戻せます。未保存のまま別の問い合わせを選ぶと、編集を破棄するか確認します。</p>
          </div>
        </div>
      </div>
      <p className="modal-note">保存の成否と、受け付けた保存回数は画面上で確認できます。</p>
    </div>
  )
}

type ConfirmDialogProps = {
  inquiry: Inquiry
  onCancel: () => void
  onDiscard: () => void
}

function ConfirmDialog({ inquiry, onCancel, onDiscard }: ConfirmDialogProps) {
  return (
    <ModalDialog title="編集を破棄して切り替えますか" onClose={onCancel}>
      <div className="confirm-content">
        <div className="confirm-icon" aria-hidden="true">!</div>
        <p>
          「{inquiry.subject}」には未保存の編集があります。切り替えると、現在の編集内容は破棄されます。
        </p>
        <div className="confirm-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>切り替えをやめる</button>
          <button type="button" className="danger-button" onClick={onDiscard}>編集を破棄して切り替える</button>
        </div>
      </div>
    </ModalDialog>
  )
}

function App() {
  const [state, dispatch] = useReducer(workspaceReducer, undefined, createInitialState)
  const [query, setQuery] = useState('')
  const [helpOpen, setHelpOpen] = useState(false)
  const [pendingInquiryId, setPendingInquiryId] = useState<string | null>(null)
  const saveTimerRef = useRef<number | null>(null)

  const selectedInquiry = state.inquiries.find((inquiry) => inquiry.id === state.selectedId) ?? state.inquiries[0]
  const isSaving = state.save.phase === 'saving'
  const isDirty = selectedInquiry ? state.draft !== selectedInquiry.savedReply : false

  const filteredInquiries = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('ja-JP')
    if (!normalizedQuery) return state.inquiries

    return state.inquiries.filter((inquiry) =>
      [inquiry.customerName, inquiry.email, inquiry.subject, inquiry.body, inquiry.savedReply]
        .join('\n')
        .toLocaleLowerCase('ja-JP')
        .includes(normalizedQuery),
    )
  }, [query, state.inquiries])

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    }
  }, [])

  const handleOpenHelp = () => setHelpOpen(true)

  const handleSelectInquiry = (nextId: string, trigger: HTMLElement) => {
    if (nextId === state.selectedId) return

    if (isSaving) {
      dispatch({ type: 'setNotice', message: '保存中のため問い合わせを切り替えられません。保存が完了してから、もう一度選択してください。' })
      return
    }

    if (isDirty) {
      setPendingInquiryId(nextId)
      trigger.focus()
      return
    }

    dispatch({ type: 'selectInquiry', inquiryId: nextId })
  }

  const handleCancelSwitch = () => setPendingInquiryId(null)

  const handleDiscardAndSwitch = () => {
    if (!pendingInquiryId) return
    const nextId = pendingInquiryId
    setPendingInquiryId(null)
    dispatch({ type: 'selectInquiry', inquiryId: nextId })
  }

  const handleSave = () => {
    if (!selectedInquiry) return

    if (isSaving || saveTimerRef.current !== null) {
      dispatch({ type: 'setNotice', message: '保存処理はすでに進行中です。完了するまでお待ちください。' })
      return
    }

    if (!state.draft.trim()) {
      dispatch({ type: 'setSaveFeedback', phase: 'validation', message: '返信本文が空白だけになっています。内容を入力してから保存してください。' })
      return
    }

    if (!isDirty) {
      dispatch({ type: 'setSaveFeedback', phase: 'unchanged', message: '保存済みの内容から変更されていません。' })
      return
    }

    const targetId = selectedInquiry.id
    const replyToSave = state.draft
    const shouldFail = state.failNextSave
    dispatch({ type: 'saveRequested' })

    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      if (shouldFail) {
        dispatch({ type: 'saveFailed', targetId })
        return
      }

      const savedAt = new Intl.DateTimeFormat('ja-JP', {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date())
      dispatch({ type: 'saveSucceeded', targetId, reply: replyToSave, savedAt })
    }, 1000)
  }

  const handleRestore = () => {
    if (isSaving) {
      dispatch({ type: 'setNotice', message: '保存中は返信を戻せません。保存が完了してから操作してください。' })
      return
    }

    if (!isDirty) {
      dispatch({ type: 'setSaveFeedback', phase: 'unchanged', message: 'すでに保存済みの内容です。' })
      return
    }

    dispatch({ type: 'restoreSaved' })
  }

  const handleToggleFailNext = () => {
    if (isSaving) {
      dispatch({ type: 'setNotice', message: '保存中は次回保存の設定を変更できません。' })
      return
    }
    dispatch({ type: 'toggleFailNextSave' })
  }

  const pendingInquiry = state.inquiries.find((inquiry) => inquiry.id === pendingInquiryId)
  const hasModal = helpOpen || Boolean(pendingInquiry)

  return (
    <>
      <div className="app-shell" aria-hidden={hasModal ? true : undefined}>
        <Header acceptedSaveCount={state.acceptedSaveCount} isSaving={isSaving} onOpenHelp={handleOpenHelp} />
        <main className="workspace">
          <div className="workspace-heading">
            <div>
              <p className="page-kicker">CUSTOMER SUPPORT / REPLY DESK</p>
              <h1>問い合わせ対応</h1>
              <p className="page-description">受信内容を確認し、丁寧な返信をすばやく整えます。</p>
            </div>
            <div className="demo-console" aria-label="実演用の保存状態">
              <div className="demo-console-label">
                <span className="demo-pulse" aria-hidden="true" />
                実演モード
              </div>
              <p>受け付けた保存処理 <strong>{state.acceptedSaveCount}</strong> 回</p>
              <span>再送信は一度だけ実行されます</span>
            </div>
          </div>

          {state.notice && (
            <div className="notice-banner" role="status" aria-live="polite">
              <span className="notice-icon" aria-hidden="true">i</span>
              <span>{state.notice}</span>
            </div>
          )}

          <div className="workspace-grid">
            <InquiryList
              inquiries={filteredInquiries}
              selectedId={state.selectedId}
              query={query}
              onQueryChange={setQuery}
              onClearQuery={() => setQuery('')}
              onSelect={handleSelectInquiry}
            />
            {selectedInquiry && (
              <InquiryDetail
                inquiry={selectedInquiry}
                draft={state.draft}
                save={state.save}
                isDirty={isDirty}
                acceptedSaveCount={state.acceptedSaveCount}
                isSaving={isSaving}
                failNextSave={state.failNextSave}
                onDraftChange={(value) => dispatch({ type: 'draftChanged', value })}
                onSave={handleSave}
                onRestore={handleRestore}
                onToggleFailNext={handleToggleFailNext}
                onOpenHelp={handleOpenHelp}
              />
            )}
          </div>
        </main>
        <footer className="app-footer">
          <span>Reply Desk</span>
          <span>ローカル非同期保存デモ</span>
        </footer>
      </div>

      {helpOpen && (
        <ModalDialog title="操作ガイド" onClose={() => setHelpOpen(false)}>
          <HelpContent />
        </ModalDialog>
      )}

      {pendingInquiry && !helpOpen && (
        <ConfirmDialog inquiry={selectedInquiry} onCancel={handleCancelSwitch} onDiscard={handleDiscardAndSwitch} />
      )}
    </>
  )
}

export default App
