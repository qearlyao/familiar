import { useCallback, useEffect, useState } from "react";
import { fetchMcpServers, type McpServer } from "./api";
import { useRequestState } from "./requestState";

/** Held by the settings surface, so its tab can count servers and tools before it opens. */
export function useMcp(channelKey: string | undefined) {
  const [servers, setServers] = useState<McpServer[] | undefined>(undefined);
  const { error, isLoading, isMutating, run } = useRequestState();

  useEffect(() => {
    const id = window.setTimeout(() => void run(() => fetchMcpServers(channelKey), { busy: "load", apply: setServers }), 0);
    return () => window.clearTimeout(id);
  }, [channelKey, run]);

  /** every mutation answers with the fresh list and rethrows, so a form can keep its draft on failure;
      quiet ones leave the page's alert alone because their caller shows the failure itself */
  const mutate = useCallback(
    async (work: (channelKey: string | undefined) => Promise<McpServer[]>, { quiet = false } = {}) => {
      if (quiet) setServers(await work(channelKey));
      else await run(() => work(channelKey), { apply: setServers, rethrow: true });
    },
    [channelKey, run],
  );

  return { servers, error, busy: isLoading || isMutating, mutate };
}
