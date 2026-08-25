import assert from 'node:assert/strict';
import test from 'node:test';
import { mountView } from '../src/view.js';

function createTerminal(columns) {
  let resizeHandler;
  return {
    columns,
    on(event, handler) {
      if (event === 'resize') resizeHandler = handler;
    },
    emit(event) {
      if (event === 'resize') resizeHandler();
    },
  };
}

function renderHistoryAtWidth(width) {
  const output = [];
  const terminal = createTerminal(width);
  const view = mountView({ terminal, write: (value) => output.push(value) });
  view.showUserMessage('hello');
  return output[0];
}

function historyLine(value) {
  return value.split('\n')[1];
}

test('renders the history band at each separate view mount', () => {
  assert.equal(historyLine(renderHistoryAtWidth(14)).length, 14);
  assert.equal(historyLine(renderHistoryAtWidth(26)).length, 26);
});

test('refreshes the live row when the terminal width changes', () => {
  const output = [];
  const terminal = createTerminal(14);
  const view = mountView({ terminal, write: (value) => output.push(value) });

  view.showStatus('ready');
  terminal.columns = 26;
  terminal.emit('resize');

  assert.equal(output.at(-1).length, 26);
});
