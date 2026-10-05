export function renderReceipt(amount) {
  return `<main><h1>受付完了</h1><p>金額: ${amount}</p><button type="button" onclick="this.closest('main').hidden = true">閉じる</button></main>`;
}
