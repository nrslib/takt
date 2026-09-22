import { useState, type KeyboardEvent } from 'react';

interface SearchBoxProps {
  onSubmit(query: string): void;
}

export function SearchBox({ onSubmit }: SearchBoxProps) {
  const [query, setQuery] = useState('');

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') onSubmit(query.trim());
  }

  return (
    <input
      aria-label="Search"
      value={query}
      onChange={(event) => setQuery(event.target.value)}
      onKeyDown={handleKeyDown}
    />
  );
}
