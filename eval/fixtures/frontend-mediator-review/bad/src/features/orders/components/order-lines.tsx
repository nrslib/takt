import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Product } from '../types';

export interface LineRow {
  productId: string;
  name: string;
  quantity: number;
  unitPrice: number;
}

interface OrderLinesProps {
  rows: LineRow[];
  products: Product[];
  disabled: boolean;
  inputError: string | null;
  onAdd: (productId: string, quantity: string) => void;
  onChangeQuantity: (productId: string, quantity: string) => void;
  onRemove: (productId: string) => void;
}

export function OrderLines({
  rows,
  products,
  disabled,
  inputError,
  onAdd,
  onChangeQuantity,
  onRemove,
}: OrderLinesProps) {
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState('1');

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onAdd(productId, quantity);
  }

  return <section aria-label="明細">
    <h2>明細</h2>
    <table>
      <thead><tr><th>商品</th><th>数量</th><th>単価</th><th>小計</th><th>操作</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.productId}>
        <td>{row.name}</td>
        <td><input
          type="number"
          min="1"
          step="1"
          value={row.quantity}
          disabled={disabled}
          aria-label={`${row.name}の数量`}
          onChange={event => onChangeQuantity(row.productId, event.target.value)}
        /></td>
        <td>{row.unitPrice}円</td><td>{row.quantity * row.unitPrice}円</td>
        <td><button
          type="button"
          disabled={disabled}
          onClick={() => onRemove(row.productId)}
        >{row.name}を削除</button></td>
      </tr>)}</tbody>
    </table>
    <form aria-label="明細の追加" onSubmit={handleSubmit}>
      <label htmlFor="add-product">追加する商品</label>
      <select
        id="add-product"
        value={productId}
        disabled={disabled}
        onChange={event => setProductId(event.target.value)}
      >
        <option value="">未選択</option>
        {products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}
      </select>
      <label htmlFor="add-quantity">追加する数量</label>
      <input
        id="add-quantity"
        type="number"
        min="1"
        step="1"
        value={quantity}
        disabled={disabled}
        onChange={event => setQuantity(event.target.value)}
      />
      <button type="submit" disabled={disabled}>明細を追加</button>
    </form>
    {inputError && <p role="alert">{inputError}</p>}
  </section>;
}
