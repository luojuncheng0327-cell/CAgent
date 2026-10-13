import { create } from 'zustand';

type Next<T> = T | ((previous: T) => T);
interface WorkspaceState {
  settings: boolean;
  view: 'chat' | 'memory';
  right: boolean;
  rail: boolean;
  setSettings: (value: Next<boolean>) => void;
  setView: (value: Next<'chat' | 'memory'>) => void;
  setRight: (value: Next<boolean>) => void;
  setRail: (value: Next<boolean>) => void;
}
const valueOf = <T>(value: Next<T>, previous: T): T =>
  typeof value === 'function' ? (value as (previous: T) => T)(previous) : value;

// Navigation stays in memory. Drafts and credentials retain their existing scoped persistence.
export const useWorkspaceState = create<WorkspaceState>((set) => ({
  settings: false,
  view: 'chat',
  right: true,
  rail: true,
  setSettings: (value) => set((state) => ({ settings: valueOf(value, state.settings) })),
  setView: (value) => set((state) => ({ view: valueOf(value, state.view) })),
  setRight: (value) => set((state) => ({ right: valueOf(value, state.right) })),
  setRail: (value) => set((state) => ({ rail: valueOf(value, state.rail) })),
}));
