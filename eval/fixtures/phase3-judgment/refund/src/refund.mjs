export function calculateRefund(order) {
  const subtotal = order.items.reduce((total, item) => total + item.unitPrice * item.quantity, 0);
  const discount = subtotal * order.discountRate;
  const discountedAmount = subtotal - discount;
  const fee = discountedAmount * order.feeRate;
  return Math.round((discountedAmount - fee) * 100) / 100;
}

const refundOrders = [
  {
    id: 'order-1048',
    items: [{ unitPrice: 1.2, quantity: 1 }],
    discountRate: 0.25,
    feeRate: 0.05,
  },
];

export function refundPayment(orderId) {
  const order = refundOrders.find((entry) => entry.id === orderId);
  if (order === undefined) throw new Error(`Unknown order: ${orderId}`);
  return { orderId, amount: calculateRefund(order) };
}
