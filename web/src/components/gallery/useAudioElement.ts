import { useCallback, useEffect, useRef, useState } from "react";

export function useAudioElement(): {
  audioRef: React.RefCallback<HTMLAudioElement>;
  playing: boolean;
  duration: number | undefined;
  toggle: () => void;
} {
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const detachAudioListenersRef = useRef<(() => void) | undefined>(undefined);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState<number>();

  const syncPlaybackState = useCallback((el = audioElementRef.current) => {
    setPlaying(Boolean(el && !el.paused && !el.ended));
  }, []);

  const syncDuration = useCallback((el = audioElementRef.current) => {
    setDuration(el && Number.isFinite(el.duration) ? el.duration : undefined);
  }, []);

  const audioRef = useCallback(
    (el: HTMLAudioElement | null) => {
      detachAudioListenersRef.current?.();
      detachAudioListenersRef.current = undefined;
      audioElementRef.current = el;

      if (!el) {
        setPlaying(false);
        return;
      }

      const onMeta = () => syncDuration(el);
      const onPlayback = () => syncPlaybackState(el);
      onMeta();
      onPlayback();
      el.addEventListener("loadedmetadata", onMeta);
      el.addEventListener("durationchange", onMeta);
      el.addEventListener("play", onPlayback);
      el.addEventListener("playing", onPlayback);
      el.addEventListener("pause", onPlayback);
      el.addEventListener("ended", onPlayback);
      el.addEventListener("emptied", onPlayback);
      detachAudioListenersRef.current = () => {
        el.removeEventListener("loadedmetadata", onMeta);
        el.removeEventListener("durationchange", onMeta);
        el.removeEventListener("play", onPlayback);
        el.removeEventListener("playing", onPlayback);
        el.removeEventListener("pause", onPlayback);
        el.removeEventListener("ended", onPlayback);
        el.removeEventListener("emptied", onPlayback);
      };
    },
    [syncDuration, syncPlaybackState],
  );

  useEffect(() => {
    return () => detachAudioListenersRef.current?.();
  }, []);

  const toggle = useCallback(() => {
    const el = audioElementRef.current;
    if (!el) return;
    if (!el.paused && !el.ended) {
      el.pause();
      syncPlaybackState(el);
      return;
    }
    if (el.ended) el.currentTime = 0;
    setPlaying(true);
    void el
      .play()
      .then(() => syncPlaybackState(el))
      .catch(() => syncPlaybackState(el));
  }, [syncPlaybackState]);

  return { audioRef, playing, duration, toggle };
}
