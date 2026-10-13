import { QueryClient } from '@tanstack/react-query';

export const serverState = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 0, retry: false, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
});
