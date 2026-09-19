import { useEffect, useState } from "react";
import { Download, ImageIcon, MoreHorizontal, Pause, Play, RefreshCw } from "lucide-react";
import { Popover } from "radix-ui";
import { MediaPreview, type PreviewMedia } from "../MediaPreview";
import { AudioWaveform } from "./AudioWaveform";
import type { GalleryItem } from "@/lib/api";
import { formatDuration, formatShortDate, type TimeGroup } from "./format";
import { InkTexture } from "./InkTexture";
import { useAudioElement } from "./useAudioElement";

function ImageTile({ item, onOpen, media, featured = false }: {
  item: GalleryItem; onOpen: () => void; media: PreviewMedia[]; featured?: boolean;
}) {
  return (
    <figure className={`makings-image${featured ? " is-featured" : ""}`}>
      <MediaPreview src={item.url} alt={item.note || `image from ${formatShortDate(item.createdAt)}`}
        className="makings-image-frame" items={media} closeLabel="back to makings"
        onOpenChange={(open) => { if (open) onOpen(); }} />
      <span className="makings-caption">
        <span>{item.note || ""}</span>
        <time dateTime={new Date(item.createdAt).toISOString()}>{formatShortDate(item.createdAt)}</time>
      </span>
    </figure>
  );
}

export function GalleryGrid({ groups, visible }: {
  groups: TimeGroup[]; visible: boolean;
}) {
  const images = groups.flatMap((group) => group.entries.filter((item) => item.kind === "image"));
  const media: PreviewMedia[] = images.map((item) => ({ src: item.url, name: item.note || item.name, kind: "image" }));
  const [featured, ...earlier] = images;
  const imageGroups = groups.map((group) => ({ ...group,
    entries: group.entries.filter((item) => item.kind === "image" && item.id !== featured?.id),
  })).filter((group) => group.entries.length);
  const sounds = groups.map((group) => ({ ...group,
    entries: group.entries.filter((item) => item.kind === "audio"),
  })).filter((group) => group.entries.length);
  const [selectedId, setSelectedId] = useState<string>();
  const { audioRef, pause, toggle, playSource, playing: isPlaying, duration, currentTime, seek, error } = useAudioElement();
  useEffect(() => { if (!visible) pause(); }, [visible, pause]);
  useEffect(() => {
    if (selectedId && !sounds.some((group) => group.entries.some((item) => item.id === selectedId))) pause();
  }, [sounds, selectedId, pause]);

  const play = (item: GalleryItem) => {
    if (selectedId === item.id) toggle();
    else {
      setSelectedId(item.id);
      playSource(item.url);
    }
  };

  return (
    <div className="makings-columns">
      <section className="makings-pictures" aria-labelledby="makings-pictures-title">
        <h2 id="makings-pictures-title">pictures to look back on</h2>
        <div className="makings-picture-list">
        {featured ? <>
          <h3 className="makings-group-heading">{groups.find((group) => group.entries.some((item) => item.id === featured.id))?.label ?? "latest image"}</h3>
          <ImageTile item={featured} featured media={media} onOpen={pause} />
          {earlier.length > 0 && <div className="makings-earlier">
            {imageGroups.map((group) => <section key={group.key}>
              <h3 className="makings-group-heading">{group.key === groups[0]?.key ? "a little earlier" : group.label}</h3>
              <div className="makings-thumbnails">
                {group.entries.map((item) => <ImageTile key={item.id} item={item} media={media} onOpen={pause} />)}
              </div>
            </section>)}
          </div>}
        </> : <div className="makings-empty-column"><ImageIcon size={28} /><h2>pictures will find their way here</h2><p>the images it makes will be kept here.</p></div>}
        </div>
      </section>
      <section className="makings-sounds" aria-labelledby="makings-sounds-title">
        <h2 id="makings-sounds-title">sounds to come back to</h2>
        <audio ref={audioRef} preload="metadata" />
        <div className="makings-sound-list" tabIndex={0} aria-label="recordings">
          {sounds.length ? sounds.map((group) => <section key={group.key}>
            <h3 className="makings-group-heading">{group.label}</h3>
            {group.entries.map((item) => {
              const active = selectedId === item.id;
              const playing = active && isPlaying;
              return <article key={item.id} className={`makings-recording${active ? " is-active" : ""}`}>
                <button type="button" className="makings-play" onClick={() => play(item)}
                  aria-label={`${playing ? "pause" : "play"} recording from ${formatShortDate(item.createdAt)}`}>
                  {playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
                </button>
                <div className="makings-recording-copy">
                  <button type="button" className="makings-recording-title" onClick={() => play(item)}
                    title={new Date(item.createdAt).toLocaleString()}>a voice from {formatShortDate(item.createdAt)}</button>
                {active && <span className="makings-player-time">{formatDuration(currentTime) ?? "0:00"} / {formatDuration(duration) ?? "—"}</span>}
                </div>
                <InkTexture id={item.id} />
                {active && <div className="makings-recording-meta">
                <Popover.Root>
                  <Popover.Trigger asChild><button type="button" className="makings-details" aria-label="recording actions"><MoreHorizontal size={17} /></button></Popover.Trigger>
                  <Popover.Portal><Popover.Content className="chat-theme makings-actions" sideOffset={6} align="end">
                    <a href={item.url} download={item.name}><Download size={16} /> download recording</a>
                  </Popover.Content></Popover.Portal>
                </Popover.Root>
                </div>}
                {active && <div className="makings-inline-player">
                  <AudioWaveform key={item.id} url={item.url} duration={duration} currentTime={currentTime} onSeek={seek} />
                  {error && <p role="alert" className="makings-error">{error}</p>}
                </div>}
              </article>;
            })}
          </section>) : <p className="makings-empty-sounds">a quiet shelf for the sounds it makes.</p>}
        </div>
      </section>
    </div>
  );
}

export function GallerySkeleton() {
  return <div className="makings-loading" role="status">gathering the things it made…</div>;
}

export function EmptyGallery({ onRefresh }: { onRefresh: () => void }) {
  return <div className="makings-empty-column makings-empty">
    <ImageIcon size={30} /><h2>nothing made yet</h2>
    <p>when familiar draws something or records a sound, it will be kept here.</p>
    <button type="button" className="makings-refresh" onClick={onRefresh}><RefreshCw size={16} /> look again</button>
  </div>;
}
