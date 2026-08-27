// Forward each new assistant-text delta to the upstream TTS stream.
// .js extension so the node-resolution root tsconfig can typecheck this from test/
import { hasSilentMarker, stripStreamingTail, withoutSilentMarker } from "./silentMarker.js";

function speakableText(raw: string): string {
  const text = withoutSilentMarker(raw);
  // an unclosed fence is still streaming: hold it back rather than read code aloud
  const fences = text.split("```").length - 1;
  const safe = fences % 2 === 1 ? text.slice(0, text.lastIndexOf("```")) : text;
  // markdown reads badly out loud; [laughs]-style audio tags stay for the voice model
  return safe
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)/g, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    // collapse spaces but keep newlines: they are the paragraph boundary
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{2,}/g, "\n");
}

export interface SpeechFeed {
  /** Feed the full reply text so far; returns newly speakable chunks. */
  push: (fullText: string) => string[];
  /** Finish the turn without adding a locally buffered tail. */
  end: () => string[];
  reset: () => void;
}

export function createSpeechFeed(): SpeechFeed {
  let spokenChars = 0;
  let buffered = "";

  return {
    push: (fullText) => {
      // a silent turn is for the eyes only, never voiced
      if (hasSilentMarker(fullText)) return [];
      const speakable = speakableText(stripStreamingTail(fullText));
      if (speakable.length <= spokenChars) return [];
      const delta = speakable.slice(spokenChars);
      spokenChars = speakable.length;
      buffered += delta;
      const chunks: string[] = [];
      const boundary = /[。.!！？?；;\n]/;
      while (true) {
        boundary.lastIndex = 0;
        const match = boundary.exec(buffered);
        if (!match) break;
        const split = match.index + match[0].length;
        chunks.push(buffered.slice(0, split));
        buffered = buffered.slice(split);
      }
      return chunks;
    },
    end: () => {
      const tail = buffered;
      buffered = "";
      return tail.trim() ? [tail] : [];
    },
    reset: () => {
      spokenChars = 0;
      buffered = "";
    },
  };
}
