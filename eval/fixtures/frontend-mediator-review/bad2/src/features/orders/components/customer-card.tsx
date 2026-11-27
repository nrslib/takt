import { useState } from 'react';
import type { Customer } from '../types';

interface CustomerCardProps {
  customers: Customer[];
  selected: Customer;
  disabled: boolean;
  onSelect: (customerId: string) => void;
}

export function CustomerCard({ customers, selected, disabled, onSelect }: CustomerCardProps) {
  const [search, setSearch] = useState('');
  const candidates = customers.filter(customer => customer.name.includes(search));

  return <section aria-label="顧客">
    <h2>顧客</h2>
    <p>{selected.name}</p>
    <p>価格区分: {selected.priceGroup}</p>
    <label htmlFor="customer-search">顧客名で絞り込み</label>
    <input
      id="customer-search"
      type="search"
      value={search}
      disabled={disabled}
      onChange={event => setSearch(event.target.value)}
    />
    <fieldset>
      <legend>顧客の候補</legend>
      {candidates.map(candidate => <label key={candidate.id}>
        <input
          type="radio"
          name="customer"
          value={candidate.id}
          checked={candidate.id === selected.id}
          disabled={disabled}
          onChange={() => onSelect(candidate.id)}
        />
        {candidate.name}（{candidate.priceGroup}）
      </label>)}
    </fieldset>
  </section>;
}
