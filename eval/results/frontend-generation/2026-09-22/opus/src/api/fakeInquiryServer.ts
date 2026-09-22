import { seedInquiries, type Inquiry } from '../domain/inquiry';

/**
 * 外部サービスの代わりに、ブラウザ内で保存処理を再現するサーバー。
 * 保存済みの値はこのモジュールが持ち、保存結果として確定した問い合わせを返す。
 */

const SAVE_DELAY_MS = 1000;

const records = new Map<string, Inquiry>(seedInquiries.map((inquiry) => [inquiry.id, { ...inquiry }]));

export class SaveReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaveReplyError';
  }
}

export function listInquiries(): Inquiry[] {
  return Array.from(records.values(), (inquiry) => ({ ...inquiry }));
}

type SaveReplyOptions = {
  /** 実演用：この保存を失敗させる */
  simulateFailure: boolean;
};

export function saveReply(inquiryId: string, reply: string, options: SaveReplyOptions): Promise<Inquiry> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const current = records.get(inquiryId);
      if (current === undefined) {
        reject(new SaveReplyError('対象の問い合わせが見つかりません。'));
        return;
      }
      if (options.simulateFailure) {
        reject(new SaveReplyError('サーバーで保存に失敗しました（実演用の失敗）。'));
        return;
      }
      const saved: Inquiry = { ...current, reply, replyUpdatedAt: new Date().toISOString() };
      records.set(inquiryId, saved);
      resolve({ ...saved });
    }, SAVE_DELAY_MS);
  });
}
