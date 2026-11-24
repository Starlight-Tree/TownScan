'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { AreaSummary } from './api-types';

interface AreasContextValue {
  areas: AreaSummary[];
  nameOf: (areaId: string) => string;
}

const AreasContext = createContext<AreasContextValue>({ areas: [], nameOf: (id) => id });

export function AreasProvider({ areas, children }: { areas: AreaSummary[]; children: ReactNode }) {
  const value = useMemo<AreasContextValue>(() => {
    const byId = new Map(areas.map((a) => [a.id, a]));
    return { areas, nameOf: (id) => byId.get(id)?.name ?? id };
  }, [areas]);
  return <AreasContext.Provider value={value}>{children}</AreasContext.Provider>;
}

export function useAreas(): AreasContextValue {
  return useContext(AreasContext);
}
