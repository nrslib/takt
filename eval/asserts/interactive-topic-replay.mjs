const simulatedToolOutput = /\bTool\s+(?:Use|Result)\s*:|(?:^|\n)\s*(?:ツール呼び出し|ツール実行|ツール結果)\s*[:：]|(?:^|\n)\s*to=functions\.[\w.]+/iu;

export default function assertTextOnlyReplay(output) {
  const pass = !simulatedToolOutput.test(output);
  return {
    pass,
    score: pass ? 1 : 0,
    reason: pass ? 'No simulated tool exchange' : 'Output contains a simulated tool call or result',
  };
}
