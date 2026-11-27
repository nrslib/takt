export function OrderSummary({ total }: { total: number }) {
  return <section aria-label="注文合計"><h2>合計</h2><p>{total}円</p></section>;
}
