import { useCallback, useEffect, useRef, useState } from "react";

function durationFrom(el: HTMLAudioElement | null): number | undefined {
  return el && Number.isFinite(el.duration) ? el.duration : undefined;
}

export function useAudioMetadata(): {
  audioRef: React.RefCallback<HTMLAudioElement>;
  duration: number | undefined;
} {
  const detachAudioListenersRef = useRef<(() => void) | undefined>(undefined);
  const [duration, setDuration] = useState<number>();

  const audioRef = useCallback((el: HTMLAudioElement | null) => {
    detachAudioListenersRef.current?.();
    detachAudioListenersRef.current = undefined;

    if (!el) {
      setDuration(undefined);
      return;
    }

    const syncDuration = () => setDuration(durationFrom(el));
    syncDuration();
    el.addEventListener("loadedmetadata", syncDuration);
    el.addEventListener("durationchange", syncDuration);
    el.addEventListener("emptied", syncDuration);
    detachAudioListenersRef.current = () => {
      el.removeEventListener("loadedmetadata", syncDuration);
      el.removeEventListener("durationchange", syncDuration);
      el.removeEventListener("emptied", syncDuration);
    };
  }, []);

  useEffect(() => {
    return () => detachAudioListenersRef.current?.();
  }, []);

  return { audioRef, duration };
}

export function useAudioElement(): {
  audioRef: React.RefCallback<HTMLAudioElement>;
  playing: boolean;
  duration: number | undefined;
  currentTime: number;
  toggle: () => void;
  seek: (time: number) => void;
} {
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const detachAudioListenersRef = useRef<(() => void) | undefined>(undefined);
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

      const onMeta = () => syncDuration(el);
      const onPlayback = () => syncPlaybackState(el);
      const onTime = () => syncCurrentTime(el);
      onMeta();
      onPlayback();
      onTime();
      el.addEventListener("loadedmetadata", onMeta);
      el.addEventListener("durationchange", onMeta);
      el.addEventListener("timeupdate", onTime);
      el.addEventListener("seeking", onTime);
      el.addEventListener("seeked", onTime);
      el.addEventListener("play", onPlayback);
      el.addEventListener("playing", onPlayback);
      el.addEventListener("pause", onPlayback);
      el.addEventListener("ended", onPlayback);
      el.addEventListener("ended", onTime);
      el.addEventListener("emptied", onPlayback);
      el.addEventListener("emptied", onTime);
      detachAudioListenersRef.current = () => {
        el.removeEventListener("loadedmetadata", onMeta);
        el.removeEventListener("durationchange", onMeta);
        el.removeEventListener("timeupdate", onTime);
        el.removeEventListener("seeking", onTime);
        el.removeEventListener("seeked", onTime);
        el.removeEventListener("play", onPlayback);
        el.removeEventListener("playing", onPlayback);
        el.removeEventListener("pause", onPlayback);
        el.removeEventListener("ended", onPlayback);
        el.removeEventListener("ended", onTime);
        el.removeEventListener("emptied", onPlayback);
        el.removeEventListener("emptied", onTime);
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

  const toggle = useCallback(() => {
    const el = audioElementRef.current;
    if (!el) return;
    if (!el.paused && !el.ended) {
      el.pause();
      syncPlaybackState(el);
      syncCurrentTime(el);
      return;
    }
    if (el.ended) {
      el.currentTime = 0;
      syncCurrentTime(el);
    }
    setPlaying(true);
    void el
      .play()
      .then(() => {
        syncPlaybackState(el);
        syncCurrentTime(el);
      })
      .catch(() => {
        syncPlaybackState(el);
        syncCurrentTime(el);
      });
  }, [syncCurrentTime, syncPlaybackState]);

  const seek = useCallback(
    (time: number) => {
      const el = audioElementRef.current;
      if (!el || !Number.isFinite(el.duration)) return;
      el.currentTime = Math.min(el.duration, Math.max(0, time));
      syncCurrentTime(el);
    },
    [syncCurrentTime],
  );

  return { audioRef, playing, duration, currentTime, toggle, seek };
}
