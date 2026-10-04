import { useEffect } from 'react';
export function Updates({ channel, subscribe, onMessage }: {
  channel: string;
  subscribe(channel: string, listener: (message: string) => void): () => void;
  onMessage(message: string): void;
}) {
  useEffect(() => subscribe(channel, onMessage), [channel, subscribe, onMessage]);
  return <p>Listening to {channel}</p>;
}
