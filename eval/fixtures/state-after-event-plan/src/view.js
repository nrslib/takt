import { createOutput } from './output.js';

export function mountView({ terminal, screen }) {
  const output = createOutput({ terminal, screen });

  return {
    showUserMessage(text) {
      output.appendHistory(`❯ ${text}`);
    },
    showStatus(text) {
      output.setLive(text);
    },
  };
}
