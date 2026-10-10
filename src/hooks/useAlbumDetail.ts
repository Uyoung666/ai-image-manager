import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  type AlbumDetail,
  getAlbum,
  subscribeAlbumRuleChanges,
} from "@/actions/albums";

export function useAlbumDetail(albumId: number) {
  const { t } = useTranslation();
  const translationRef = useRef(t);
  translationRef.current = t;
  const [album, setAlbum] = useState<AlbumDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const albumRef = useRef(album);
  albumRef.current = album;
  const activeAlbumIdRef = useRef<number | null>(albumId);
  activeAlbumIdRef.current = albumId;
  const requestRef = useRef(0);

  const loadAlbum = useCallback(async () => {
    if (activeAlbumIdRef.current !== albumId) {
      return;
    }
    const requestId = ++requestRef.current;
    try {
      const result = await getAlbum(albumId);
      if (
        requestId === requestRef.current &&
        activeAlbumIdRef.current === albumId
      ) {
        setAlbum(result);
        setLoading(false);
      }
    } catch (error) {
      if (
        requestId === requestRef.current &&
        activeAlbumIdRef.current === albumId
      ) {
        console.error("[loadAlbum] failed:", error);
        toast.error(translationRef.current("loadFailedRetry"));
        setLoading(false);
      }
    }
  }, [albumId]);

  useEffect(() => {
    activeAlbumIdRef.current = albumId;
    setAlbum(null);
    setLoading(true);
    loadAlbum();
    const unsubscribe = subscribeAlbumRuleChanges(() => {
      const current = albumRef.current;
      if (current?.id === albumId && !current.isSmart) {
        return;
      }
      // Refresh pending initial requests too: they may predate this mutation.
      loadAlbum();
    });
    return () => {
      activeAlbumIdRef.current = null;
      requestRef.current += 1;
      unsubscribe();
    };
  }, [albumId, loadAlbum]);

  return { album, loading, loadAlbum, setAlbum };
}
