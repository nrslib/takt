import type { Customer } from '../types';

export function CustomerCard({ customer }: { customer: Customer }) {
  return <section aria-label="顧客">
    <h2>顧客</h2>
    <p>{customer.name}</p>
    <p>価格区分: {customer.priceGroup}</p>
  </section>;
}
