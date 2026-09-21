export function OrderBuyerEditor({ buyer }: {
  buyer: { id: string; name: string };
}) {
  return (
    <input
      aria-label="Buyer name"
      value={buyer.name}
      onChange={(event) => {
        buyer.name = event.target.value;
      }}
    />
  );
}
