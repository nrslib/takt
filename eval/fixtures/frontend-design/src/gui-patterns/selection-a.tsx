import { useState } from 'react';
function Picker() {
  const [selected, setSelected] = useState('one');
  return <button type="button" onClick={() => setSelected('two')}>{selected}</button>;
}
function Details() {
  const [selected] = useState('one');
  return <output>{selected}</output>;
}
export function Screen() {
  return <main><Picker /><Details /></main>;
}
