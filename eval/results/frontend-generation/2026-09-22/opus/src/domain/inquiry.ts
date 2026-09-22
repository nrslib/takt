/** 問い合わせ1件。reply はサーバーに保存済みの返信 */
export type Inquiry = {
  id: string;
  subject: string;
  customerName: string;
  body: string;
  reply: string;
  /** 返信を最後に保存した時刻（ISO 8601） */
  replyUpdatedAt: string;
};

export const seedInquiries: readonly Inquiry[] = [
  {
    id: 'inq-1001',
    subject: '請求書の宛名を変更したい',
    customerName: '青木 さくら',
    body: '先月分の請求書の宛名を、個人名から「株式会社あおば」に変更していただけますか。再発行が必要であれば手順を教えてください。',
    reply: 'お問い合わせありがとうございます。請求書の宛名変更を承りました。再発行した請求書を3営業日以内にお送りします。',
    replyUpdatedAt: '2026-09-18T10:15:00+09:00',
  },
  {
    id: 'inq-1002',
    subject: 'ログインできません',
    customerName: '石川 健',
    body: 'パスワードを再設定したのですが、ログイン画面で「認証に失敗しました」と表示されます。ブラウザは最新版です。',
    reply: 'ご不便をおかけしております。お手数ですが、ブラウザのキャッシュを削除してから再度お試しください。',
    replyUpdatedAt: '2026-09-19T14:02:00+09:00',
  },
  {
    id: 'inq-1003',
    subject: '配送先住所の追加について',
    customerName: '上田 美穂',
    body: '勤務先でも受け取れるように、配送先を2か所登録したいです。設定画面のどこから追加できますか。',
    reply: 'マイページの「配送先の管理」から、最大5か所まで登録できます。',
    replyUpdatedAt: '2026-09-20T09:40:00+09:00',
  },
  {
    id: 'inq-1004',
    subject: '領収書の発行方法',
    customerName: '遠藤 大輔',
    body: '経費精算に使うため、注文ごとの領収書をPDFで受け取りたいです。',
    reply: '注文履歴の各注文にある「領収書を表示」から、PDFをダウンロードできます。',
    replyUpdatedAt: '2026-09-21T16:25:00+09:00',
  },
];

export function isBlankReply(text: string): boolean {
  return text.trim() === '';
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
