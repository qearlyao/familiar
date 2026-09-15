import { useCallback, useEffect, useState } from "react";
import { fetchGallery, type GalleryItem } from "@/lib/api";

export function useGalleryItems() {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const next = await fetchGallery();
      next.sort((a, b) => b.createdAt - a.createdAt);
      setItems(next);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  return { items, loading, loaded, error, reload: load };
}
