import { useCallback, useEffect, useRef, useState } from 'react';
import { getCustomers, getOrder, getProducts, saveOrder } from '../features/orders/api';
import { CustomerCard } from '../features/orders/components/customer-card';
import { OrderLines } from '../features/orders/components/order-lines';
import { OrderSummary } from '../features/orders/components/order-summary';
import {
  addLine,
  changeLineQuantity,
  hasOrderChanges,
  parseQuantity,
  removeLine,
} from '../features/orders/order-draft';
import type { Customer, Order, OrderLine, Product } from '../features/orders/types';

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

export function OrderEditPage({ orderId }: { orderId: string }) {
  const [data, setData] = useState<OrderData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' });
  const [inputError, setInputError] = useState<string | null>(null);

  const saving = useRef(false);

  useEffect(() => {
    let active = true;
    setData(null);
    setError(null);
    setSaveStatus({ kind: 'idle' });
    setInputError(null);
    Promise.all([getOrder(orderId), getCustomers(), getProducts()]).then(
      ([order, customers, products]) => {
        if (active) setData({ customers, products, saved: order, draft: order });
      },
      (error: unknown) => {
        if (active) setError(error instanceof Error ? error.message : '読み込みに失敗しました');
      },
    );
    return () => { active = false; };
  }, [orderId]);

  const requestSave = useCallback(() => {
    if (saving.current || !data || !hasOrderChanges(data.saved, data.draft)) return;
    saving.current = true;
    setSaveStatus({ kind: 'saving' });
    setInputError(null);
    saveOrder(data.draft).then(
      confirmed => {
        saving.current = false;
        setData({ ...data, saved: confirmed, draft: confirmed });
        setSaveStatus({ kind: 'saved' });
      },
      (error: unknown) => {
        saving.current = false;
        setSaveStatus({
          kind: 'failed',
          message: error instanceof Error ? error.message : '保存に失敗しました',
        });
      },
    );
  }, [data]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey || event.key !== 's') return;
      event.preventDefault();
      requestSave();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [requestSave]);

  if (error) return <main><p role="alert">{error}</p></main>;
  if (!data) return <main><p role="status">読み込み中</p></main>;
  const customer = data.customers.find(item => item.id === data.draft.customerId);
  if (!customer) return <main><p role="alert">顧客が見つかりません</p></main>;
  const rows = [];
  for (const line of data.draft.lines) {
    const product = data.products.find(item => item.id === line.productId);
    if (!product) return <main><p role="alert">商品が見つかりません: {line.productId}</p></main>;
    rows.push({ ...line, name: product.name, unitPrice: product.prices[customer.priceGroup] });
  }
  const total = rows.reduce((sum, row) => sum + row.quantity * row.unitPrice, 0);
  const isSaving = saveStatus.kind === 'saving';
  const canSave = !isSaving && hasOrderChanges(data.saved, data.draft);

  const applyDraft = (draft: Order) => {
    setInputError(null);
    setSaveStatus({ kind: 'idle' });
    setData({ ...data, draft });
  };
  const applyLines = (lines: OrderLine[]) => applyDraft({ ...data.draft, lines });

  const handleSelectCustomer = (customerId: string) => {
    if (saving.current) return;
    applyDraft({ ...data.draft, customerId });
  };

  const handleAddLine = (productId: string, quantity: string) => {
    if (saving.current) return;
    if (!productId) {
      setInputError('商品を選択してください');
      return;
    }
    const parsed = parseQuantity(quantity);
    if (parsed === null) {
      setInputError(QUANTITY_ERROR);
      return;
    }
    applyLines(addLine(data.draft.lines, productId, parsed));
  };

  const handleChangeQuantity = (productId: string, quantity: string) => {
    if (saving.current) return;
    const parsed = parseQuantity(quantity);
    if (parsed === null) {
      setInputError(QUANTITY_ERROR);
      return;
    }
    applyLines(changeLineQuantity(data.draft.lines, productId, parsed));
  };

  const handleRemoveLine = (productId: string) => {
    if (saving.current) return;
    applyLines(removeLine(data.draft.lines, productId));
  };

  return <main>
    <h1>注文 {data.saved.id}</h1>
    <CustomerCard
      customers={data.customers}
      selected={customer}
      disabled={isSaving}
      onSelect={handleSelectCustomer}
    />
    <OrderLines
      rows={rows}
      products={data.products}
      disabled={isSaving}
      inputError={inputError}
      onAdd={handleAddLine}
      onChangeQuantity={handleChangeQuantity}
      onRemove={handleRemoveLine}
    />
    <OrderSummary total={total} />
    <button type="button" disabled={!canSave} onClick={requestSave}>保存</button>
    {isSaving && <p role="status">保存中</p>}
    {saveStatus.kind === 'saved' && <p role="status">保存しました</p>}
    {saveStatus.kind === 'failed' && <p role="alert">{saveStatus.message}</p>}
  </main>;
}
