import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { RouterProvider, ToastProvider } from './lib';
import './styles.css';

// Pictures fade in as they arrive (see [data-loaded] in the styles) instead of popping in row by row.
document.addEventListener('load', (event) => { if (event.target instanceof HTMLImageElement) event.target.dataset.loaded = ''; }, true);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </RouterProvider>
  </StrictMode>
);
