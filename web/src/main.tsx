import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/inter';
import './index.css';
import { App } from './App';
import { RouterProvider } from './lib/router';
import { OverlayProvider } from './components/overlay';
import { applyTheme } from './lib/theme';
import { ApiError } from './lib/api';

applyTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider>
        <OverlayProvider>
          <App />
        </OverlayProvider>
      </RouterProvider>
    </QueryClientProvider>
  </StrictMode>,
);
