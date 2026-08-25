import { createOutput } from './output.js';

export function mountView({ terminal, write }) {
  const output = createOutput({ terminal, write });

  return {
    showUserMessage(text) {
      output.appendHistory(`❯ ${text}`);
    },
    showStatus(text) {
      output.setLive(text);
    },
  };
}
