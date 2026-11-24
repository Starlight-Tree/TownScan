'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { getHealth } from '../lib/api';
import type { HealthResponse } from '../lib/api-types';
import { useAsync, type AsyncState } from '../lib/use-api';

interface HealthContextValue {
  state: AsyncState<HealthResponse>;
  reload: () => void;
}

const HealthContext = createContext<HealthContextValue>({ state: { status: 'loading' }, reload: () => {} });

const loadHealth = (signal: AbortSignal) => getHealth(signal);

export function HealthProvider({ children }: { children: ReactNode }) {
  const { state, reload } = useAsync(loadHealth);
  return <HealthContext.Provider value={{ state, reload }}>{children}</HealthContext.Provider>;
}

export function useHealth(): HealthContextValue {
  return useContext(HealthContext);
}
