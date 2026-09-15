import { useCallback, useEffect, useRef, useState } from "react";

function durationFrom(el: HTMLAudioElement | null): number | undefined {
  return el && Number.isFinite(el.duration) ? el.duration : undefined;
}

export function useAudioElement(): {
  audioRef: React.RefCallback<HTMLAudioElement>;
  playing: boolean;
  duration: number | undefined;
  currentTime: number;
  toggle: () => void;
  pause: () => void;
  playSource: (url: string) => void;
  error: string | undefined;
  seek: (time: number) => void;
} {
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const detachAudioListenersRef = useRef<(() => void) | undefined>(undefined);
  const [error, setError] = useState<string>();
  const playRequest = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState<number>();
  const [currentTime, setCurrentTime] = useState(0);

  const syncPlaybackState = useCallback((el = audioElementRef.current) => {
    setPlaying(Boolean(el && !el.paused && !el.ended));
  }, []);

  const syncDuration = useCallback((el = audioElementRef.current) => {
    setDuration(durationFrom(el));
  }, []);

  const syncCurrentTime = useCallback((el = audioElementRef.current) => {
    setCurrentTime(el && Number.isFinite(el.currentTime) ? el.currentTime : 0);
  }, []);

  const audioRef = useCallback(
    (el: HTMLAudioElement | null) => {
      detachAudioListenersRef.current?.();
      detachAudioListenersRef.current = undefined;
      audioElementRef.current = el;

      if (!el) {
        setPlaying(false);
        setCurrentTime(0);
        setDuration(undefined);
        return;
      }

      const onError = () => {
        const message = `Unable to load recording (media error ${el.error?.code ?? "unknown"}).`;
        console.error("[makings.audio]", message, { src: el.currentSrc });
        setError(message);
        syncPlaybackState(el);
      };
      const onMeta = () => syncDuration(el);
      const onPlayback = () => syncPlaybackState(el);
      const onTime = () => syncCurrentTime(el);
      onMeta();
      onPlayback();
      onTime();
      const listeners: [string, () => void][] = [
        ["error", onError], ["loadedmetadata", onMeta], ["durationchange", onMeta],
        ["timeupdate", onTime], ["seeking", onTime], ["seeked", onTime],
        ["play", onPlayback], ["playing", onPlayback], ["pause", onPlayback],
        ["ended", onPlayback], ["ended", onTime], ["emptied", onPlayback], ["emptied", onTime],
      ];
      for (const [event, handler] of listeners) el.addEventListener(event, handler);
      detachAudioListenersRef.current = () => {
        // A detached <audio> keeps playing, so leaving the page must silence it.
        el.pause();
        for (const [event, handler] of listeners) el.removeEventListener(event, handler);
      };
    },
    [syncCurrentTime, syncDuration, syncPlaybackState],
  );

  useEffect(() => {
    return () => detachAudioListenersRef.current?.();
  }, []);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      syncCurrentTime();
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [playing, syncCurrentTime]);

  const pause = useCallback(() => {
    playRequest.current++;
    audioElementRef.current?.pause();
    syncPlaybackState();
    syncCurrentTime();
  }, [syncCurrentTime, syncPlaybackState]);

  const start = useCallback((el: HTMLAudioElement) => {
    const request = ++playRequest.current;
    setError(undefined);
    void el.play().then(() => {
      if (request !== playRequest.current) return;
      syncPlaybackState(el);
      syncCurrentTime(el);
    }).catch((err: unknown) => {
      // Replacing a source or pausing intentionally cancels an in-flight play.
      if (request !== playRequest.current) return;
      const message = err instanceof Error ? err.message : String(err);
      console.error("[makings.audio] Playback failed", { src: el.currentSrc, error: message });
      setError(`Couldn't play this recording: ${message}`);
      syncPlaybackState(el);
      syncCurrentTime(el);
    });
  }, [syncCurrentTime, syncPlaybackState]);

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
    syncDuration(el);
    syncCurrentTime(el);
    start(el);
  }, [pause, start, syncDuration, syncCurrentTime]);

  const seek = useCallback(
    (time: number) => {
      const el = audioElementRef.current;
      if (!el || !Number.isFinite(el.duration)) return;
      el.currentTime = Math.min(el.duration, Math.max(0, time));
      syncCurrentTime(el);
    },
    [syncCurrentTime],
  );

  return { audioRef, playing, duration, currentTime, toggle, seek, pause, playSource, error };
}
