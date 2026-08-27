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

export function createOutput({ terminal, screen }) {
  let liveText = null;
  let liveRendered = false;

  const appendHistory = (text) => {
    const historyLines = liveRendered ? screen.lines.slice(0, -1) : screen.lines;
    const lines = [...historyLines, ...formatBand(text, terminal.columns).split('\n')];
    if (liveText !== null) lines.push(fitLine(liveText, terminal.columns));
    screen.render(lines);
    liveRendered = liveText !== null;
  };

  const setLive = (text) => {
    liveText = text;
  };

  const refresh = () => {
    if (liveText === null) return;
    const historyLines = liveRendered ? screen.lines.slice(0, -1) : screen.lines;
    screen.render([...historyLines, fitLine(liveText, terminal.columns)]);
    liveRendered = true;
  };

  terminal.on('resize', () => refresh());

  return { appendHistory, setLive, refresh };
}
