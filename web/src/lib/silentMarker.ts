const SILENT_MARKER = "[[FAMILIAR_SILENT]]";

export function hasSilentMarker(text: string): boolean {
  return text.includes(SILENT_MARKER);
}

export function withoutSilentMarker(text: string): string {
  return text.split(SILENT_MARKER).join("").trim();
}

// hide a partially streamed marker at the tail so it never flashes raw
export function stripStreamingTail(text: string): string {
  for (let i = Math.min(SILENT_MARKER.length - 1, text.length); i > 0; i--) {
    if (text.endsWith(SILENT_MARKER.slice(0, i))) return text.slice(0, -i);
  }
  return text;
}
