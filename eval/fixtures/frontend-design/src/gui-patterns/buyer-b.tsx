export function BuyerEditor({ buyer }: { buyer: { name: string } }) {
  return <input aria-label="Buyer name" value={buyer.name}
    onChange={(event) => { buyer.name = event.target.value; }} />;
}
