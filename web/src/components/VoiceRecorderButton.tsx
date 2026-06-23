import { useEffect, useRef, useState } from "react";
import { Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const RECORDER_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg", "audio/mp4"];

function recordingMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return RECORDER_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

function baseAudioMimeType(type: string | undefined): string {
  return type?.split(";")[0] || "audio/webm";
}

function recordingExtension(type: string): string {
  if (type === "audio/ogg") return "ogg";
  if (type === "audio/mp4") return "m4a";
  return "webm";
}

function voiceMessageName(type: string): string {
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:.]/g, "-");
  return `voice-message-${stamp}.${recordingExtension(type)}`;
}

function formatRecordingDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const remaining = total % 60;
  return `${minutes}:${remaining.toString().padStart(2, "0")}`;
}

function recordingErrorMessage(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError" || err.name === "SecurityError") return "microphone permission was blocked";
    if (err.name === "NotFoundError") return "no microphone found";
  }
  return err instanceof Error ? `voice recording failed: ${err.message}` : "voice recording failed";
}

export type VoiceRecordingState = {
  pending: boolean;
  recording: boolean;
};

export type VoiceRecorderState = VoiceRecordingState & {
  toggleRecording: () => void;
};

export function useVoiceRecorder({
  onAttach,
  onError,
}: {
  onAttach: (files: File[]) => void;
  onError: (message: string | undefined) => void;
}): VoiceRecorderState {
  const [pending, setPending] = useState(false);
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingMimeTypeRef = useRef("audio/webm");
  const recordingShouldAttachRef = useRef(false);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const mountedRef = useRef(true);

  const stopRecordingStream = () => {
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    recordingStreamRef.current = null;
  };

  const cleanupRecording = () => {
    stopRecordingStream();
    recorderRef.current = null;
    if (mountedRef.current) setRecording(false);
  };

  const startRecording = async () => {
    if (pending || recording) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      onError("voice recording is not available in this browser");
      return;
    }
    onError(undefined);
    setPending(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const preferredType = recordingMimeType();
      const recorder = preferredType ? new MediaRecorder(stream, { mimeType: preferredType }) : new MediaRecorder(stream);
      const mimeType = baseAudioMimeType(recorder.mimeType || preferredType);
      recordingStreamRef.current = stream;
      recorderRef.current = recorder;
      recordingChunksRef.current = [];
      recordingMimeTypeRef.current = mimeType;
      recordingShouldAttachRef.current = true;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordingChunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        recordingShouldAttachRef.current = false;
        cleanupRecording();
        onError("voice recording failed");
      };
      recorder.onstop = () => {
        const chunks = recordingChunksRef.current;
        const shouldAttach = recordingShouldAttachRef.current;
        const fileType = recordingMimeTypeRef.current;
        recordingChunksRef.current = [];
        recordingShouldAttachRef.current = false;
        cleanupRecording();
        if (!shouldAttach) return;
        if (chunks.length === 0) {
          onError("no audio was recorded");
          return;
        }
        onAttach([new File(chunks, voiceMessageName(fileType), { type: fileType })]);
      };
      setRecording(true);
      recorder.start();
    } catch (err) {
      recordingShouldAttachRef.current = false;
      cleanupRecording();
      onError(recordingErrorMessage(err));
    } finally {
      if (mountedRef.current) setPending(false);
    }
  };

  const stopRecording = () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    recordingShouldAttachRef.current = true;
    recorder.stop();
  };

  const toggleRecording = () => {
    if (recording) stopRecording();
    else void startRecording();
  };

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      recordingShouldAttachRef.current = false;
      const recorder = recorderRef.current;
      stopRecordingStream();
      if (recorder && recorder.state !== "inactive") {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        recorder.stop();
      }
    };
  }, []);

  return { pending, recording, toggleRecording };
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

export function VoiceRecorderButton({
  disabled,
  pending = false,
  recording,
  onClick,
}: {
  disabled?: boolean;
  pending?: boolean;
  recording: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      onClick={onClick}
      disabled={disabled || pending}
      aria-label={recording ? "stop voice recording" : "record voice message"}
      aria-pressed={recording}
      className={cn(
        "text-muted-foreground hover:text-foreground",
        recording && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
      )}
    >
      {recording ? <Square className="size-3 fill-current" strokeWidth={0} /> : <Mic className="size-4" />}
    </Button>
  );
}
