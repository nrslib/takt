export function BuyerEditor({ buyer, onNameChange }: {
  buyer: { name: string }; onNameChange(name: string): void;
}) {
  return <input aria-label="Buyer name" value={buyer.name}
    onChange={(event) => onNameChange(event.target.value)} />;
}
