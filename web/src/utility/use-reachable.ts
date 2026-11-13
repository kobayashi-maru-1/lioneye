import { useEffect, useState } from "react";

export type Reachable = "checking" | "online" | "offline";

/** How long the check may take before the page counts as offline. */
const CHECK_WAIT_MS = 10000;

/**
 * Whether a page can be reached, checked again whenever `attempt` changes. A frame can't
 * report a failed load across origins, so pages that frame another site check first.
 * A hung connection (captive portal) counts as offline.
 */
export function useReachable(url: string, attempt: number): Reachable {
  const [status, setStatus] = useState<Reachable>("checking");
  useEffect(() => {
    const abort = new AbortController();
    let current = true;
    const timer = setTimeout(() => abort.abort(), CHECK_WAIT_MS);
    setStatus("checking");
    fetch(url, {
      method: "HEAD",
      mode: "no-cors",
      cache: "no-store",
      signal: abort.signal,
    }).then(
      () => current && setStatus("online"),
      () => current && setStatus("offline"),
    );
    return () => {
      current = false;
      clearTimeout(timer);
      abort.abort();
    };
  }, [url, attempt]);
  return status;
}
