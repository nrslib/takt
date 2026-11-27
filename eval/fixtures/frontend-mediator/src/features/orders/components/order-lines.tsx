export interface LineRow {
  productId: string;
  name: string;
  quantity: number;
  unitPrice: number;
}

export function OrderLines({ rows }: { rows: LineRow[] }) {
  return <section aria-label="明細">
    <h2>明細</h2>
    <table>
      <thead><tr><th>商品</th><th>数量</th><th>単価</th><th>小計</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.productId}>
        <td>{row.name}</td><td>{row.quantity}</td>
        <td>{row.unitPrice}円</td><td>{row.quantity * row.unitPrice}円</td>
      </tr>)}</tbody>
    </table>
  </section>;
}
