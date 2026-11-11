import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { App } from './App';
import { adoptTokenFromUrl } from './lib/store';

adoptTokenFromUrl();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
