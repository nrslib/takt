import { formatDateTime, type Inquiry } from '../domain/inquiry';

type InquiryDetailProps = {
  inquiry: Inquiry;
};

export function InquiryDetail({ inquiry }: InquiryDetailProps) {
  return (
    <article className="inquiry-detail" aria-labelledby="inquiry-detail-heading">
      <h2 id="inquiry-detail-heading">{inquiry.subject}</h2>
      <p className="inquiry-detail-meta">お客様：{inquiry.customerName}</p>
      <section aria-labelledby="inquiry-body-heading">
        <h3 id="inquiry-body-heading">問い合わせ本文</h3>
        <p className="prewrap">{inquiry.body}</p>
      </section>
      <section aria-labelledby="saved-reply-heading">
        <h3 id="saved-reply-heading">保存済みの返信</h3>
        <p className="prewrap saved-reply">{inquiry.reply}</p>
        <p className="inquiry-detail-meta">最終保存：{formatDateTime(inquiry.replyUpdatedAt)}</p>
      </section>
    </article>
  );
}
