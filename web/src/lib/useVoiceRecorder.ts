import { useEffect, useRef, useState } from "react";

const RECORDER_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/mp4",
];

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

function recordingErrorMessage(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError" || err.name === "SecurityError") return "microphone permission was blocked";
    if (err.name === "NotFoundError") return "no microphone found";
  }
  return err instanceof Error ? `voice recording failed: ${err.message}` : "voice recording failed";
}

export type VoiceRecorderState = VoiceRecordingState & {
  toggleRecording: () => void;
  cancelRecording: () => void;
};

type VoiceRecordingState = {
  pending: boolean;
  recording: boolean;
};

type RecordingFinishMode = "attach" | "discard";

type RecordingSession = {
  chunks: Blob[];
  finishMode: RecordingFinishMode;
  mimeType: string;
  stream: MediaStream;
};

function createRecordingSession(stream: MediaStream, mimeType: string): RecordingSession {
  return {
    chunks: [],
    finishMode: "attach",
    mimeType,
    stream,
  };
}

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
  const recordingSessionRef = useRef<RecordingSession | null>(null);
  const mountedRef = useRef(true);

  const clearRecordingSession = () => {
    const session = recordingSessionRef.current;
    recordingSessionRef.current = null;
    recorderRef.current = null;
    session?.stream.getTracks().forEach((track) => track.stop());
    if (mountedRef.current) setRecording(false);
    return session;
  };

  const finishRecording = (mode: RecordingFinishMode) => {
    const recorder = recorderRef.current;
    const session = recordingSessionRef.current;
    if (!recorder || !session || recorder.state === "inactive") return;
    session.finishMode = mode;
    recorder.stop();
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
      recorderRef.current = recorder;
      recordingSessionRef.current = createRecordingSession(stream, mimeType);
      recorder.ondataavailable = (event) => {
        const session = recordingSessionRef.current;
        if (session && event.data.size > 0) session.chunks.push(event.data);
      };
      recorder.onerror = () => {
        const session = recordingSessionRef.current;
        if (session) session.finishMode = "discard";
        clearRecordingSession();
        onError("voice recording failed");
      };
      recorder.onstop = () => {
        const session = clearRecordingSession();
        if (!session || session.finishMode === "discard") return;
        if (session.chunks.length === 0) {
          onError("no audio was recorded");
          return;
        }
        onAttach([new File(session.chunks, voiceMessageName(session.mimeType), { type: session.mimeType })]);
      };
      setRecording(true);
      recorder.start();
    } catch (err) {
      clearRecordingSession();
      onError(recordingErrorMessage(err));
    } finally {
      if (mountedRef.current) setPending(false);
    }
  };

  const stopRecording = () => finishRecording("attach");
  const cancelRecording = () => finishRecording("discard");

  const toggleRecording = () => {
    if (recording) stopRecording();
    else void startRecording();
  };

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      const recorder = recorderRef.current;
      clearRecordingSession();
      if (recorder && recorder.state !== "inactive") {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        recorder.stop();
      }
    };
  }, []);

  return { pending, recording, toggleRecording, cancelRecording };
}
