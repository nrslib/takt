import { getCustomers, getOrder, getProducts, saveOrder } from './api';
import { addLine, changeLineQuantity, hasOrderChanges, parseQuantity, removeLine } from './order-draft';
import type { Customer, Order, OrderLine, Product } from './types';

interface OrderData {
  customers: Customer[];
  products: Product[];
  saved: Order;
  draft: Order;
}

type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'failed'; message: string };

const QUANTITY_ERROR = '数量は1以上の整数で入力してください';

interface EditorSnapshot {
  data: OrderData | null;
  error: string | null;
  saveStatus: SaveStatus;
  inputError: string | null;
}

export class OrderEditSession {
  private snapshot: EditorSnapshot = {
    data: null, error: null, saveStatus: { kind: 'idle' }, inputError: null,
  };
  private listeners = new Set<() => void>();

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private update(patch: Partial<EditorSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  load(orderId: string) {
    let active = true;
    this.update({ data: null, error: null, saveStatus: { kind: 'idle' }, inputError: null });
    Promise.all([getOrder(orderId), getCustomers(), getProducts()]).then(
      ([order, customers, products]) => {
        if (active) this.update({ data: { customers, products, saved: order, draft: order } });
      },
      (error: unknown) => {
        if (active) this.update({ error: error instanceof Error ? error.message : '読み込みに失敗しました' });
      },
    );
    return () => { active = false; };
  }

  requestSave = () => {
    const { data, saveStatus } = this.snapshot;
    if (saveStatus.kind === 'saving' || !data || !hasOrderChanges(data.saved, data.draft)) return;
    this.update({ saveStatus: { kind: 'saving' }, inputError: null });
    saveOrder(data.draft).then(
      confirmed => this.update({
        data: { ...data, saved: confirmed, draft: confirmed }, saveStatus: { kind: 'saved' },
      }),
      (error: unknown) => this.update({ saveStatus: {
        kind: 'failed', message: error instanceof Error ? error.message : '保存に失敗しました',
      } }),
    );
  };

  private applyDraft(draft: Order) {
    const { data } = this.snapshot;
    if (!data) return;
    this.update({ data: { ...data, draft }, inputError: null, saveStatus: { kind: 'idle' } });
  }

  handleSelectCustomer = (customerId: string) => {
    const { data, saveStatus } = this.snapshot;
    if (!data || saveStatus.kind === 'saving') return;
    this.applyDraft({ ...data.draft, customerId });
  };

  handleAddLine = (productId: string, quantity: string) => {
    const { data, saveStatus } = this.snapshot;
    if (!data || saveStatus.kind === 'saving') return;
    if (!productId) {
      this.update({ inputError: '商品を選択してください' });
      return;
    }
    const parsed = parseQuantity(quantity);
    if (parsed === null) {
      this.update({ inputError: QUANTITY_ERROR });
      return;
    }
    this.applyLines(addLine(data.draft.lines, productId, parsed));
  };

  handleChangeQuantity = (productId: string, quantity: string) => {
    const { data, saveStatus } = this.snapshot;
    if (!data || saveStatus.kind === 'saving') return;
    const parsed = parseQuantity(quantity);
    if (parsed === null) {
      this.update({ inputError: QUANTITY_ERROR });
      return;
    }
    this.applyLines(changeLineQuantity(data.draft.lines, productId, parsed));
  };

  handleRemoveLine = (productId: string) => {
    const { data, saveStatus } = this.snapshot;
    if (!data || saveStatus.kind === 'saving') return;
    this.applyLines(removeLine(data.draft.lines, productId));
  };

  private applyLines(lines: OrderLine[]) {
    const { data } = this.snapshot;
    if (data) this.applyDraft({ ...data.draft, lines });
  }
}
