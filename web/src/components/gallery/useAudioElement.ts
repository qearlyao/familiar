import { useCallback, useEffect, useRef, useState } from "react";

const EVENTS = ["error", "loadedmetadata", "durationchange", "timeupdate", "seeking", "seeked", "play", "playing", "pause", "ended", "emptied"];

export function useAudioElement() {
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const detachAudioListenersRef = useRef<(() => void) | undefined>(undefined);
  const [error, setError] = useState<string>();
  const playRequest = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState<number>();
  const [currentTime, setCurrentTime] = useState(0);

  /** read the element's state into ours; unchanged values bail out of the re-render */
  const sync = useCallback((el = audioElementRef.current) => {
    setPlaying(Boolean(el && !el.paused && !el.ended));
    setDuration(el && Number.isFinite(el.duration) ? el.duration : undefined);
    setCurrentTime(el && Number.isFinite(el.currentTime) ? el.currentTime : 0);
  }, []);

  const audioRef = useCallback(
    (el: HTMLAudioElement | null) => {
      detachAudioListenersRef.current?.();
      detachAudioListenersRef.current = undefined;
      audioElementRef.current = el;
      sync(el);
      if (!el) return;

      const onEvent = (event: Event) => {
        if (event.type === "error") {
          const message = `Unable to load recording (media error ${el.error?.code ?? "unknown"}).`;
          console.error("[makings.audio]", message, { src: el.currentSrc });
          setError(message);
        }
        sync(el);
      };
      for (const event of EVENTS) el.addEventListener(event, onEvent);
      detachAudioListenersRef.current = () => {
        // A detached <audio> keeps playing, so leaving the page must silence it.
        el.pause();
        for (const event of EVENTS) el.removeEventListener(event, onEvent);
      };
    },
    [sync],
  );

  useEffect(() => {
    return () => detachAudioListenersRef.current?.();
  }, []);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      sync();
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [playing, sync]);

  const pause = useCallback(() => {
    playRequest.current++;
    audioElementRef.current?.pause();
    sync();
  }, [sync]);

  const start = useCallback((el: HTMLAudioElement) => {
    const request = ++playRequest.current;
    setError(undefined);
    void el.play().catch((err: unknown) => {
      // Replacing a source or pausing intentionally cancels an in-flight play.
      if (request !== playRequest.current) return;
      const message = err instanceof Error ? err.message : String(err);
      console.error("[makings.audio] Playback failed", { src: el.currentSrc, error: message });
      setError(`Couldn't play this recording: ${message}`);
    }).finally(() => {
      if (request === playRequest.current) sync(el);
    });
  }, [sync]);

  const toggle = useCallback(() => {
    const el = audioElementRef.current;
    if (!el) return;
    if (!el.paused && !el.ended) { pause(); return; }
    if (el.ended) el.currentTime = 0;
    start(el);
  }, [pause, start]);

  const playSource = useCallback((url: string) => {
    const el = audioElementRef.current;
    if (!el) return;
    pause();
    el.src = url;
    el.load();
    sync(el);
    start(el);
  }, [pause, start, sync]);

  const seek = useCallback(
    (time: number) => {
      const el = audioElementRef.current;
      if (!el || !Number.isFinite(el.duration)) return;
      el.currentTime = Math.min(el.duration, Math.max(0, time));
      sync(el);
    },
    [sync],
  );

  return { audioRef, playing, duration, currentTime, toggle, seek, pause, playSource, error };
}
