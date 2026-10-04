import { useState } from 'react';
export function Cart() {
  const [quantity, setQuantity] = useState(1);
  const total = quantity * 100;
  return <section>
    <button type="button" onClick={() => setQuantity(quantity + 1)}>Add</button>
    <button type="button" onClick={() => setQuantity(0)}>Clear</button>
    <output>{quantity} items: {total} yen</output>
  </section>;
}
