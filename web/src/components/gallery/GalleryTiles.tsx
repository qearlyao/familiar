import { useEffect, useState, type CSSProperties } from "react";
import { Download, ImageIcon, MoreHorizontal, Pause, Play, RefreshCw } from "lucide-react";
import { Popover } from "radix-ui";
import { MediaPreview, type PreviewMedia } from "../MediaPreview";
import type { GalleryItem } from "@/lib/api";
import { formatDuration, formatShortDate, type TimeGroup } from "./format";
import { useAudioElement } from "./useAudioElement";
import { InkTexture } from "./InkTexture";

function Caption({ item }: { item: GalleryItem }) {
  const date = new Date(item.createdAt);
  return <figcaption className="makings-caption">
    <span>{item.note}</span>
    <time dateTime={date.toISOString()} title={date.toLocaleString()}>{formatShortDate(item.createdAt)}</time>
  </figcaption>;
}

function SoundTile({ item, visible, active, onActivate }: {
  item: GalleryItem; visible: boolean; active: boolean; onActivate: () => void;
}) {
  const { audioRef, pause, toggle, playing, duration, currentTime, seek, error } = useAudioElement();
  const title = item.note || `a voice from ${formatShortDate(item.createdAt)}`;
  useEffect(() => { if (!visible || !active) pause(); }, [visible, active, pause]);
  return <figure className="makings-tile">
    <div className="makings-sound-card">
      <InkTexture id={item.id} />
      <audio ref={audioRef} src={item.url} preload="metadata" />
      <h3 title={title}>{title}</h3>
      <span className="makings-duration">{playing || currentTime > 0 ? `${formatDuration(currentTime) ?? "0:00"} / ` : ""}{formatDuration(duration) ?? "—:—"}</span>
      <div className="makings-transport">
        <button type="button" className="makings-play" onClick={() => { onActivate(); toggle(); }}
          aria-label={`${playing ? "pause" : "play"} ${title}`}>
          {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
        </button>
        <div className="makings-progress" style={{ "--progress": `${duration ? currentTime / duration * 100 : 0}%` } as CSSProperties}>
          <span aria-hidden="true" />
          <input type="range" min={0} max={duration || 1} step="0.1" value={currentTime} disabled={!duration}
            aria-label={`seek ${title}`} aria-valuetext={`${formatDuration(currentTime) ?? "0:00"} of ${formatDuration(duration) ?? "unknown duration"}`}
            onChange={(event) => seek(Number(event.target.value))} />
        </div>
        <Popover.Root>
          <Popover.Trigger asChild><button type="button" className="makings-details" aria-label={`actions for ${title}`}><MoreHorizontal size={23} /></button></Popover.Trigger>
          <Popover.Portal><Popover.Content className="chat-theme makings-actions" sideOffset={6} align="end">
            <a href={item.url} download={item.name}><Download size={16} /> download recording</a>
          </Popover.Content></Popover.Portal>
        </Popover.Root>
      </div>
      {error && <p role="alert" className="makings-audio-error">{error}</p>}
    </div>
    <Caption item={item} />
  </figure>;
}

export function GalleryGrid({ groups, visible }: { groups: TimeGroup[]; visible: boolean }) {
  // Only one recording is the selected one; every other tile pauses itself when it loses that.
  const [selectedId, setSelectedId] = useState<string>();
  const media: PreviewMedia[] = groups.flatMap((group) => group.entries).filter((item) => item.kind === "image")
    .map((item) => ({ src: item.url, name: item.note || item.name, kind: "image" }));

  return <div className="makings-collection">
    {groups.map((group) => <section key={group.key} aria-labelledby={`makings-${group.key}`}>
      <h2 className="makings-group-heading" id={`makings-${group.key}`}>{group.label}</h2>
      <div className="makings-grid">
        {group.entries.map((item) => item.kind === "audio" ?
          <SoundTile key={item.id} item={item} visible={visible} active={selectedId === item.id}
            onActivate={() => setSelectedId(item.id)} /> :
          <figure key={item.id} className="makings-tile">
            <MediaPreview src={item.url} alt={item.note || `image from ${formatShortDate(item.createdAt)}`}
              className="makings-image-frame" imageClassName="makings-image" items={media} closeLabel="back to makings"
              onOpenChange={(open) => { if (open) setSelectedId(undefined); }} />
            <Caption item={item} />
          </figure>)}
      </div>
    </section>)}
  </div>;
}

export function GallerySkeleton() {
  return <div className="makings-loading" role="status">gathering the things it made…</div>;
}

export function EmptyGallery({ onRefresh }: { onRefresh: () => void }) {
  return <div className="makings-empty"><ImageIcon size={30} /><h2>nothing made yet</h2>
    <p>when familiar draws something or records a sound, it will be kept here.</p>
    <button type="button" className="makings-refresh" onClick={onRefresh}><RefreshCw size={16} /> look again</button>
  </div>;
}
