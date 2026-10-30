import { useEffect, useState } from 'react';
import { connectedProviders } from '../storage/secureStore';
import type { AiProviderId } from '../store/settingsStore';
import { create } from 'zustand';

const useProviders = create<{ list: AiProviderId[]; loaded: boolean; refresh: () => Promise<void> }>((set) => ({
  list: [],
  loaded: false,
  refresh: async () => set({ list: await connectedProviders(), loaded: true }),
}));

export function refreshProviders() {
  return useProviders.getState().refresh();
}

export function useConnectedProviders(): AiProviderId[] {
  const { list, loaded, refresh } = useProviders();
  const [, force] = useState(0);
  useEffect(() => {
    if (!loaded) void refresh().then(() => force((x) => x + 1));
  }, [loaded, refresh]);
  return list;
}

export function useProvidersLoaded(): boolean {
  return useProviders((s) => s.loaded);
}
