import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { EmptyGallery, GalleryGrid, GallerySkeleton } from "./gallery/GalleryTiles";
import { groupByTime } from "./gallery/format";
import { MakingsStage } from "./gallery/MakingsStage";
import { useGalleryItems } from "./gallery/useGalleryItems";
import { useMediaQuery } from "@/lib/useMediaQuery";

import "./makings.css";

export function GalleryPage({ visible = true }: { visible?: boolean }) {
  const { items, loading, loaded, error, reload } = useGalleryItems();
  const [now] = useState(() => Date.now());

  const groups = useMemo(() => groupByTime(items, now), [items, now]);
  const showSkeleton = loading && !loaded;
  const phone = useMediaQuery("(max-width: 700px)");

  if (phone && items.length) {
    return <MakingsStage items={items} now={now} visible={visible} loading={loading} onRefresh={() => void reload()} />;
  }

  return (
    <div className="makings chat-theme">
      <header className="makings-header">
        <div><h1>makings</h1><p>the images and sounds it made</p></div>
        <Button type="button" variant="ghost" size="icon" aria-label="refresh" title="refresh"
          className="makings-refresh" onClick={() => void reload()} disabled={loading}>
          <RefreshCw className={cn("size-5", loading && "animate-spin motion-reduce:animate-none")} />
        </Button>
      </header>
      {error ? <p role="alert" className="makings-error">{error}</p> : null}
      {showSkeleton ? <GallerySkeleton /> : items.length === 0 ? <EmptyGallery onRefresh={() => void reload()} /> : (
        <GalleryGrid groups={groups} visible={visible} />
      )}
    </div>
  );
}
