import { CustomerCard } from '../features/orders/components/customer-card';
import { OrderLines } from '../features/orders/components/order-lines';
import { OrderSummary } from '../features/orders/components/order-summary';
import { hasOrderChanges } from '../features/orders/order-draft';
import { useOrderEditSession } from '../features/orders/use-order-edit-session';

export function OrderEditPage({ orderId }: { orderId: string }) {
  const { data, error, saveStatus, inputError, requestSave,
    handleSelectCustomer, handleAddLine, handleChangeQuantity, handleRemoveLine,
  } = useOrderEditSession(orderId);

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
