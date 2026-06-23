import { useEffect, useState } from "react";

function formatRecordingDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const remaining = total % 60;
  return `${minutes}:${remaining.toString().padStart(2, "0")}`;
}

export function VoiceRecordingStatus() {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const update = () => setSeconds(Math.floor((Date.now() - startedAt) / 1000));
    const timer = window.setInterval(update, 250);
    update();
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div
      className="flex items-center gap-2 rounded-sm bg-muted/60 px-2 py-1 text-xs italic text-muted-foreground"
      aria-live="polite"
    >
      <span className="size-2 rounded-full bg-primary" />
      <span>recording · {formatRecordingDuration(seconds)}</span>
    </div>
  );
}
