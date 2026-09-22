import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('#root が見つかりません。');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
