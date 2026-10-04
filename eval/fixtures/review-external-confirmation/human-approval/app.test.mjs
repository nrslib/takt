import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFunction } from 'node:vm';
import { renderReceipt } from './app.mjs';

test('receipt displays amount and close button within the existing document structure', () => {
  for (const amount of [0, 1200, 98765]) {
    const html = renderReceipt(amount);
    assert.match(html, /^<main><h1>受付完了<\/h1><p>金額: \d+<\/p><button [^>]+>閉じる<\/button><\/main>$/);
    assert.ok(html.includes(`<p>金額: ${amount}</p>`));
    assert.match(html, /<button type="button" /);
  }
});

test('clicking the rendered close button hides the receipt', () => {
  const html = renderReceipt(1200);
  const buttonMarkup = html.match(/<button\b[^>]*>閉じる<\/button>/);
  assert.ok(buttonMarkup);
  const clickHandler = buttonMarkup[0].match(/onclick="([^"]+)"/);
  assert.ok(clickHandler, 'the rendered button must have a click handler');

  const receipt = { hidden: false };
  const button = new EventTarget();
  button.closest = (selector) => {
    assert.equal(selector, 'main');
    return receipt;
  };
  const handleClick = compileFunction(clickHandler[1], []);
  button.addEventListener('click', () => handleClick.call(button));

  assert.equal(receipt.hidden, false);
  button.dispatchEvent(new Event('click'));
  assert.equal(receipt.hidden, true);
  assert.equal(button.hidden, undefined);
});
