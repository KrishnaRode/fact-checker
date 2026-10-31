"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { Mode } from "@/lib/contracts";

const MODE_KEY = "fact-checker:mode";
const MODE_EVENT = "fact-checker:mode-change";

/** Evidence mode remembered per browser (a convenience; never required). */
export function useStoredMode(): [Mode, (m: Mode) => void] {
  const mode = useSyncExternalStore(
    (cb) => {
      window.addEventListener("storage", cb);
      window.addEventListener(MODE_EVENT, cb);
      return () => {
        window.removeEventListener("storage", cb);
        window.removeEventListener(MODE_EVENT, cb);
      };
    },
    (): Mode => {
      try {
        return localStorage.getItem(MODE_KEY) === "demo" ? "demo" : "live";
      } catch {
        return "live";
      }
    },
    (): Mode => "live",
  );
  const set = useCallback((m: Mode) => {
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* storage unavailable: falls back to live */
    }
    window.dispatchEvent(new Event(MODE_EVENT));
  }, []);
  return [mode, set];
}

export function useMediaQuery(query: string, serverValue = false): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => serverValue,
  );
}
