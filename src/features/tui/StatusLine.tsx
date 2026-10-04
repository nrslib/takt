import { Text } from 'ink';
import { useEffect, useState, type ReactElement } from 'react';

/**
 * Exactly one row, always. The interactive frame keeps a constant height so Ink
 * erases the same number of lines on every tick; a frame that grows and shrinks
 * is what leaves spinner and prompt residue behind in the scrollback.
 *
 * The live response tail rides on this row instead of a block of its own, and it
 * carries no speaker label — the confirmed reply is rendered in the transcript.
 */
const SPINNER_FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const FRAME_INTERVAL_MS = 120;

export interface StatusLineProps {
  readonly busy: boolean;
  readonly label: string;
  /** Raw streamed text; only its last line is shown. */
  readonly streamed: string;
}

function selectTail(streamed: string): string {
  if (streamed === '') {
    return '';
  }
  const lines = streamed.split('\n');
  const lastLine = lines[lines.length - 1];
  return lastLine === undefined || lastLine === '' ? (lines[lines.length - 2] ?? '') : lastLine;
}

export function StatusLine({ busy, label, streamed }: StatusLineProps): ReactElement {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    if (!busy) {
      return;
    }
    const intervalId = setInterval(() => {
      setFrameIndex((index) => (index + 1) % SPINNER_FRAMES.length);
    }, FRAME_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [busy]);

  if (!busy) {
    return <Text> </Text>;
  }

  const tail = selectTail(streamed);
  // Dim throughout: the status row is the quietest thing on screen, and the
  // confirmed reply that follows it is what should draw the eye.
  return (
    <Text dimColor wrap="truncate-end">
      {`${SPINNER_FRAMES.charAt(frameIndex)} ${label}`}
      {tail === '' ? '' : `  ${tail}`}
    </Text>
  );
}
