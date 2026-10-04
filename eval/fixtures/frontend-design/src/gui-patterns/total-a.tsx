import { useState } from 'react';
export function Cart() {
  const [quantity, setQuantity] = useState(1);
  const [total, setTotal] = useState(100);
  function add() {
    setQuantity(quantity + 1);
    setTotal(total + 100);
  }
  return <section>
    <button type="button" onClick={add}>Add</button>
    <button type="button" onClick={() => setQuantity(0)}>Clear</button>
    <output>{quantity} items: {total} yen</output>
  </section>;
}
