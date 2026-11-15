import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

export const LIBRARY_HEALTH_QUERY = ["libraryHealth"] as const;

export function useLibraryChange() {
  const client = useQueryClient();
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (
        event.data?.channel === "file-change" ||
        event.data?.channel === "ai-embedding-done" ||
        event.data?.channel === "ai-status-changed"
      ) {
        client.invalidateQueries({
          queryKey: LIBRARY_HEALTH_QUERY,
          refetchType: "active",
        });
        if (
          event.data?.channel === "file-change" ||
          event.data?.channel === "ai-embedding-done"
        ) {
          client.invalidateQueries({
            queryKey: ["photos"],
            refetchType: "active",
          });
          client.invalidateQueries({
            queryKey: ["folders"],
            refetchType: "active",
          });
        }
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [client]);
}
