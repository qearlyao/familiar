import { useEffect, useRef, useState } from "react";
import type { GalleryItem } from "@/lib/api";
import { MediaPreview, type PreviewMedia } from "../MediaPreview";
import { IconChevronLeft, IconChevronRight, IconPause, IconPlay, IconRefresh, IconShare } from "../organicIcons";
import { AudioWaveform } from "./AudioWaveform";
import { formatDuration, formatShortDate, formatWhen } from "./format";
import { InkTexture } from "./InkTexture";
import { useAudioElement } from "./useAudioElement";

function titleOf(item: GalleryItem): string {
  return item.note || `a ${item.kind === "audio" ? "voice" : "picture"} from ${formatShortDate(item.createdAt)}`;
}

async function share(item: GalleryItem) {
  try {
    const blob = await (await fetch(item.url)).blob();
    const file = new File([blob], item.name, { type: blob.type });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: titleOf(item) });
      return;
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return;
  }
  // No file sharing here (or the browser refused it): hand the file over as a download.
  const link = document.createElement("a");
  link.href = item.url;
  link.download = item.name;
  link.click();
}

/** One making at a time, full bleed: a picture fills the phone, a voice turns it into a waveform. */
export function MakingsStage({ items, now, visible, loading, onRefresh }: {
  items: GalleryItem[]; now: number; visible: boolean; loading: boolean; onRefresh: () => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const { audioRef, pause, toggle, playSource, playing, duration, currentTime, seek, error } = useAudioElement();
  const [loadedId, setLoadedId] = useState<string>();
  const current = items[Math.min(index, items.length - 1)];
  const isVoice = current?.kind === "audio";
  const media: PreviewMedia[] = items.filter((item) => item.kind === "image")
    .map((item) => ({ src: item.url, name: titleOf(item), kind: "image" }));

  useEffect(() => { if (!visible) pause(); }, [visible, pause]);
  useEffect(() => { pause(); }, [current?.id, pause]);
  useEffect(() => {
    strip.current?.children[index]?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }, [index]);

  const go = (next: number) => {
    const el = track.current;
    if (!el) return;
    el.scrollTo({ left: ((next + items.length) % items.length) * el.clientWidth, behavior: "smooth" });
  };
  const onScroll = () => {
    const el = track.current;
    if (el?.clientWidth) setIndex(Math.round(el.scrollLeft / el.clientWidth));
  };
  const play = () => {
    if (loadedId === current.id) toggle();
    else { setLoadedId(current.id); playSource(current.url); }
  };

  if (!current) return null;
  const heard = loadedId === current.id;
  const length = heard ? formatDuration(duration) : undefined;

  return (
    <div className="makings-stage">
      <audio ref={audioRef} preload="metadata" />
      <div ref={track} className="makings-stage-track" onScroll={onScroll} aria-label="makings" aria-roledescription="carousel">
        {items.map((item, i) => (
          <div key={item.id} className="makings-slide"
            aria-roledescription="slide" aria-label={`${i + 1} of ${items.length}`}>
            {item.kind === "image"
              ? <MediaPreview src={item.url} alt={titleOf(item)} items={media} closeLabel="back to makings"
                  className="makings-slide-image" imageClassName="makings-slide-img" />
              : <InkTexture id={item.id} className="makings-slide-ink" />}
          </div>
        ))}
      </div>

      <div className="makings-stage-chrome">
        <header className="makings-stage-head">
          <h1>makings</h1>
          <span className="makings-stage-count">{index + 1} of {items.length}</span>
          <button type="button" className="makings-stage-round" onClick={onRefresh} disabled={loading} aria-label="refresh" title="refresh">
            <IconRefresh size={21} className={loading ? "animate-spin motion-reduce:animate-none" : undefined} />
          </button>
        </header>

        <div className="makings-stage-middle">
          <button type="button" className="makings-stage-step" onClick={() => go(index - 1)} aria-label="earlier" title="earlier">
            <IconChevronLeft size={20} />
          </button>
          {isVoice && <button type="button" className="makings-stage-play" onClick={play} aria-label={heard && playing ? "pause" : "play"}>
            {heard && playing ? <IconPause size={46} /> : <IconPlay size={46} />}
          </button>}
          <button type="button" className="makings-stage-step" onClick={() => go(index + 1)} aria-label="older" title="older">
            <IconChevronRight size={20} />
          </button>
        </div>

        <div className="makings-stage-panel">
          {isVoice && <div className="makings-stage-wave">
            <AudioWaveform key={current.id} url={current.url} duration={heard ? duration : undefined}
              currentTime={heard ? currentTime : 0} onSeek={seek} />
          </div>}
          <div className="makings-stage-copy">
            <h2>{titleOf(current)}</h2>
            <span>{[isVoice && "voice", length, formatWhen(current.createdAt, now)].filter(Boolean).join(" · ")}</span>
            {heard && error && <p role="alert">{error}</p>}
          </div>
          <button type="button" className="makings-stage-share" onClick={() => void share(current)}><IconShare size={17} /> share</button>
          <div ref={strip} className="makings-stage-strip">
            {items.map((item, i) => (
              <button key={item.id} type="button" onClick={() => go(i)} aria-label={`jump to ${titleOf(item)}`} aria-current={i === index || undefined}
                className="makings-thumb">
                {item.kind === "image" ? <img src={item.url} alt="" loading="lazy" /> : <InkTexture id={item.id} />}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
