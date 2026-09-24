import { useState } from 'react';
function Picker({ selected, onSelect }: { selected: string; onSelect(value: string): void }) {
  return <button type="button" onClick={() => onSelect('two')}>{selected}</button>;
}
function Details({ selected }: { selected: string }) {
  return <output>{selected}</output>;
}
export function Screen() {
  const [selected, setSelected] = useState('one');
  return <main><Picker selected={selected} onSelect={setSelected} /><Details selected={selected} /></main>;
}
