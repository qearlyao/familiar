import { useEffect, useState } from "react";
import { mmss } from "@/lib/clock";

const BARS = Array.from({ length: 28 });

export function VoiceRecordingBar() {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const update = () => setSeconds(Math.floor((Date.now() - startedAt) / 1000));
    const timer = window.setInterval(update, 250);
    update();
    return () => window.clearInterval(timer);
  }, []);

  return (
    <>
      <span className="composer-rec-dot" aria-hidden="true" />
      <span className="composer-rec-time" aria-live="polite">
        {mmss(seconds)}
      </span>
      <div className="composer-rec-bars" aria-hidden="true">
        {BARS.map((_, i) => (
          <i key={i} style={{ animationDelay: `${(i % 7) * 0.13}s` }} />
        ))}
      </div>
    </>
  );
}
