import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useNavigationHistoryStore } from "../stores";

export function useHeaderTitle(title: string | null | undefined) {
  const { key } = useLocation();
  const setTitleOverride = useNavigationHistoryStore((s) => s.setTitleOverride);
  const clearTitleOverride = useNavigationHistoryStore(
    (s) => s.clearTitleOverride
  );

  useEffect(() => {
    if (!title) return;
    setTitleOverride(key, title);

    return () => clearTitleOverride(key);
  }, [key, title, setTitleOverride, clearTitleOverride]);
}
