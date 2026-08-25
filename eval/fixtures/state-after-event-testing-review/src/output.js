function fitLine(text, width) {
  return String(text).padEnd(width, ' ').slice(0, width);
}

function formatBand(text, width) {
  const value = String(text);
  const lines = [];
  for (let offset = 0; offset < value.length; offset += width) {
    lines.push(fitLine(value.slice(offset, offset + width), width));
  }
  if (lines.length === 0) lines.push(fitLine('', width));
  return `\n${lines.join('\n')}\n`;
}

export function createOutput({ terminal, write }) {
  let liveText = null;

  const appendHistory = (text) => {
    write(formatBand(text, terminal.columns));
  };

  const setLive = (text) => {
    liveText = text;
  };

  const refresh = () => {
    if (liveText !== null) write(fitLine(liveText, terminal.columns));
  };

  terminal.on('resize', () => refresh());

  return { appendHistory, setLive, refresh };
}
