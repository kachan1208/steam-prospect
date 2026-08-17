import { useState } from "react";

/**
 * One shared Simple/Detailed preference for both detail surfaces (the niche drawer and the
 * game profile). "simple" is the default: only the decision-critical reads in plain language;
 * "detailed" is the full expert-dense view.
 */
export type DetailView = "simple" | "detailed";

const STORAGE_KEY = "prospect-detail-view";

function readStored(): DetailView {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === "simple" || v === "detailed") return v;
  } catch {
    // Storage can throw (privacy mode, quota, disabled) — fall back to the default.
  }
  return "simple";
}

export function useDetailView(): [DetailView, (v: DetailView) => void] {
  const [view, setView] = useState<DetailView>(readStored);

  function set(v: DetailView) {
    setView(v);
    try {
      window.localStorage.setItem(STORAGE_KEY, v);
    } catch {
      // Best-effort persistence — the in-memory state still works for this session.
    }
  }

  return [view, set];
}
