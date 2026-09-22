import { useState } from 'react';
import { formatDateTime, type Inquiry } from '../domain/inquiry';

type InquiryListProps = {
  inquiries: Inquiry[];
  selectedId: string;
  selectedHasUnsavedChanges: boolean;
  /** 保存中など、切替を受け付けない状態 */
  switchLocked: boolean;
  rejectionMessage: string | null;
  onSelect: (inquiryId: string, opener: HTMLElement) => void;
};

function matches(inquiry: Inquiry, keyword: string): boolean {
  const normalized = keyword.trim().toLowerCase();
  if (normalized === '') {
    return true;
  }
  return [inquiry.subject, inquiry.customerName, inquiry.body, inquiry.reply].some((field) =>
    field.toLowerCase().includes(normalized),
  );
}

export function InquiryList({
  inquiries,
  selectedId,
  selectedHasUnsavedChanges,
  switchLocked,
  rejectionMessage,
  onSelect,
}: InquiryListProps) {
  // 検索語はこの一覧だけで使う表示フィルタなので、一覧の中で持つ
  const [keyword, setKeyword] = useState('');
  const visible = inquiries.filter((inquiry) => matches(inquiry, keyword));

  return (
    <section className="inquiry-list" aria-labelledby="inquiry-list-heading">
      <h2 id="inquiry-list-heading">問い合わせ一覧</h2>
      <div className="search">
        <label htmlFor="inquiry-search">検索</label>
        <input
          id="inquiry-search"
          type="search"
          value={keyword}
          placeholder="件名・お客様名・本文・返信"
          aria-describedby="inquiry-search-result"
          onChange={(event) => setKeyword(event.target.value)}
        />
      </div>
      <p id="inquiry-search-result" className="search-result" role="status">
        {keyword.trim() === '' ? `${inquiries.length}件` : `「${keyword.trim()}」の検索結果：${visible.length}件`}
      </p>

      {switchLocked && (
        <p id="inquiry-switch-lock" className="hint">
          返信を保存中のため、保存が終わるまで他の問い合わせには切り替えられません。
        </p>
      )}
      <p className="rejection" role="status">
        {rejectionMessage}
      </p>

      {visible.length === 0 ? (
        <p className="empty">該当する問い合わせはありません。検索語を変えてお試しください。</p>
      ) : (
        <ul>
          {visible.map((inquiry) => {
            const selected = inquiry.id === selectedId;
            return (
              <li key={inquiry.id}>
                <button
                  type="button"
                  className="inquiry-item"
                  aria-current={selected ? 'true' : undefined}
                  aria-disabled={switchLocked && !selected ? 'true' : undefined}
                  aria-describedby={switchLocked ? 'inquiry-switch-lock' : undefined}
                  onClick={(event) => onSelect(inquiry.id, event.currentTarget)}
                >
                  <span className="inquiry-item-subject">{inquiry.subject}</span>
                  <span className="inquiry-item-meta">
                    {inquiry.customerName} ・ 返信 {formatDateTime(inquiry.replyUpdatedAt)}
                  </span>
                  <span className="inquiry-item-reply">{inquiry.reply}</span>
                  {selected && (
                    <span className="badge">{selectedHasUnsavedChanges ? '選択中・未保存の変更あり' : '選択中'}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
