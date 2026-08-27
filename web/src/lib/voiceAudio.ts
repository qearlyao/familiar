// Mic capture → 16k PCM for STT, and 24k PCM playback for TTS.
// ponytail: ScriptProcessorNode instead of an AudioWorklet — no separate module
// file to bundle. Swap to a worklet if capture ever glitches under load.

const CAPTURE_SAMPLE_RATE = 16_000;
const PLAYBACK_SAMPLE_RATE = 24_000;
const CAPTURE_CHUNK = 4096;

function floatToPcm16(input: Float32Array): ArrayBuffer {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out.buffer;
}

function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    // average the source window so we low-pass instead of aliasing
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

export interface MicCapture {
  level: () => number;
  stop: () => void;
}

export async function startMicCapture(onChunk: (pcm: ArrayBuffer) => void, onSpeech?: () => void): Promise<MicCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(CAPTURE_CHUNK, 1, 1);
  let level = 0;
  let speechActive = false;
  let speechFrames = 0;
  let quietFrames = 0;

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    let peak = 0;
    let sumSquares = 0;
    for (let i = 0; i < input.length; i++) {
      const sample = Math.abs(input[i]);
      peak = Math.max(peak, sample);
      sumSquares += sample * sample;
    }
    level = peak;
    const rms = Math.sqrt(sumSquares / input.length);
    if (rms > 0.035 && peak > 0.1) {
      speechFrames += 1;
      quietFrames = 0;
    } else if (rms < 0.018) {
      quietFrames += 1;
      speechFrames = 0;
      if (quietFrames >= 3) speechActive = false;
    } else {
      quietFrames = 0;
      speechFrames = 0;
    }
    if (onSpeech && speechFrames >= 3 && !speechActive) {
      speechActive = true;
      onSpeech();
    }
    onChunk(floatToPcm16(downsample(input, context.sampleRate, CAPTURE_SAMPLE_RATE)));
  };

  source.connect(processor);
  // ScriptProcessor only fires while connected to a destination; a zero gain
  // keeps the mic out of the speakers.
  const mute = context.createGain();
  mute.gain.value = 0;
  processor.connect(mute);
  mute.connect(context.destination);
  // constructed after an await, so it can land suspended and never fire
  void context.resume();

  return {
    level: () => level,
    stop: () => {
      processor.onaudioprocess = null;
      processor.disconnect();
      mute.disconnect();
      source.disconnect();
      for (const track of stream.getTracks()) track.stop();
      void context.close();
    },
  };
}

export interface VoicePlayer {
  enqueue: (pcmBase64: string) => void;
  clear: () => void;
  playing: () => boolean;
  level: () => number;
  close: () => void;
}

export function createVoicePlayer(): VoicePlayer {
  const context = new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  analyser.connect(context.destination);
  const bins = new Uint8Array(analyser.frequencyBinCount);
  let playAt = 0;
  let sources: AudioBufferSourceNode[] = [];

  return {
    enqueue: (pcmBase64) => {
      const bytes = Uint8Array.from(atob(pcmBase64), (c) => c.charCodeAt(0));
      const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
      if (!samples.length) return;
      const buffer = context.createBuffer(1, samples.length, PLAYBACK_SAMPLE_RATE);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 0x8000;

      void context.resume();
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(analyser);
      playAt = Math.max(playAt, context.currentTime);
      source.start(playAt);
      playAt += buffer.duration;
      sources.push(source);
      source.onended = () => {
        sources = sources.filter((s) => s !== source);
      };
    },
    clear: () => {
      for (const source of sources) {
        try {
          source.stop();
        } catch {
          // already ended
        }
      }
      sources = [];
      playAt = 0;
    },
    playing: () => sources.length > 0,
    level: () => {
      analyser.getByteFrequencyData(bins);
      let sum = 0;
      for (const bin of bins) sum += bin;
      return sum / bins.length / 255;
    },
    close: () => {
      analyser.disconnect();
      void context.close();
    },
  };
}
