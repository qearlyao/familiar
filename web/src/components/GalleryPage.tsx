import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyGallery, GalleryGrid, GallerySkeleton } from "./gallery/GalleryTiles";
import { groupByTime } from "./gallery/format";
import { MakingsStage } from "./gallery/MakingsStage";
import { useGalleryItems } from "./gallery/useGalleryItems";
import { useMediaQuery } from "@/lib/useMediaQuery";

import "./makings.css";

type Filter = "all" | "image" | "audio";
const FILTERS = [{ value: "all", label: "all" }, { value: "image", label: "images" }, { value: "audio", label: "sounds" }] as const;

export function GalleryPage({ visible = true }: { visible?: boolean }) {
  const { items, loading, loaded, error, reload } = useGalleryItems();
  const [filter, setFilter] = useState<Filter>("all");
  const [now] = useState(() => Date.now());
  const groups = groupByTime(items.filter((item) => filter === "all" || item.kind === filter), now);
  const phone = useMediaQuery("(max-width: 700px)");

  if (phone && items.length) {
    return <MakingsStage items={items} now={now} visible={visible} loading={loading} onRefresh={() => void reload()} />;
  }

  return (
    <div className="makings chat-theme">
      <header className="makings-header">
        <div><h1>makings</h1><p>the images and sounds it made</p></div>
        <button type="button" className="makings-refresh" onClick={() => void reload()} disabled={loading}>
          <RefreshCw size={20} className={cn(loading && "animate-spin motion-reduce:animate-none")} />
          <span>refresh</span>
        </button>
      </header>
      <div className="makings-filters" role="group" aria-label="filter makings">
        {FILTERS.map(({ value, label }) => <button key={value} type="button" aria-pressed={filter === value}
          onClick={() => setFilter(value)}>{label}</button>)}
      </div>
      {error && <p role="alert" className="makings-error">{error}</p>}
      {loading && !loaded ? <GallerySkeleton /> : items.length === 0
        ? <EmptyGallery onRefresh={() => void reload()} />
        : groups.length ? <GalleryGrid groups={groups} visible={visible} />
        : <div className="makings-empty" role="status"><h2>no {filter === "image" ? "images" : "sounds"} yet</h2>
            <p>the things it makes will find their way here.</p></div>}
    </div>
  );
}
