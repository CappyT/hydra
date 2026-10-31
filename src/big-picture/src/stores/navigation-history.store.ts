import { create } from "zustand";

export interface NavigationHistoryEntry {
  key: string;
  pathname: string;
}

interface NavigationHistoryState {
  stack: NavigationHistoryEntry[];
  /** Page-specific header titles, keyed by the location key of the page. */
  titleOverrides: Record<string, string>;
  push: (entry: NavigationHistoryEntry) => void;
  pop: () => void;
  replaceTop: (entry: NavigationHistoryEntry) => void;
  setTitleOverride: (locationKey: string, title: string) => void;
  clearTitleOverride: (locationKey: string) => void;
}

export const useNavigationHistoryStore = create<NavigationHistoryState>(
  (set) => ({
    stack: [],
    titleOverrides: {},
    push: (entry) =>
      set((state) => {
        const last = state.stack[state.stack.length - 1];
        if (last && last.key === entry.key) return state;
        return { stack: [...state.stack, entry] };
      }),
    pop: () =>
      set((state) =>
        state.stack.length === 0 ? state : { stack: state.stack.slice(0, -1) }
      ),
    replaceTop: (entry) =>
      set((state) => {
        if (state.stack.length === 0) return { stack: [entry] };
        const stack = state.stack.slice(0, -1);
        stack.push(entry);
        return { stack };
      }),
    setTitleOverride: (locationKey, title) =>
      set((state) =>
        state.titleOverrides[locationKey] === title
          ? state
          : {
              titleOverrides: { ...state.titleOverrides, [locationKey]: title },
            }
      ),
    clearTitleOverride: (locationKey) =>
      set((state) => {
        if (!(locationKey in state.titleOverrides)) return state;
        const { [locationKey]: _removed, ...titleOverrides } =
          state.titleOverrides;
        return { titleOverrides };
      }),
  })
);
