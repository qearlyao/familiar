import { useState } from "react";
import type { GalleryItem } from "./lib/api";
import { GalleryPage } from "./components/GalleryPage";

const DAY = 86_400_000;
const now = Date.now();

// A 0.6s sine-tone wav so the audio tile + lightbox player have real, playable
// media to read duration from. Tiny, inline, no asset dependency.
function toneWavDataUri(seconds = 0.6, freq = 440): string {
  const rate = 8000;
  const samples = Math.floor(rate * seconds);
  const bytes = 44 + samples;
  const buf = new Uint8Array(bytes);
  const view = new DataView(buf.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(36, "data");
  view.setUint32(40, samples, true);
  for (let i = 0; i < samples; i += 1) {
    const env = 1 - i / samples;
    view.setUint8(44 + i, 128 + Math.round(Math.sin((i / rate) * freq * 2 * Math.PI) * 110 * env));
  }
  let binary = "";
  for (const b of buf) binary += String.fromCharCode(b);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

const dims: [number, number][] = [
  [1024, 1536],
  [1536, 1024],
  [1024, 1024],
  [1280, 832],
  [832, 1280],
  [1024, 1024],
  [1456, 816],
  [900, 1200],
  [1024, 1024],
  [1100, 1500],
];

function makeItems(): GalleryItem[] {
  const wav = toneWavDataUri();
  const images: GalleryItem[] = dims.map((wh, i) => ({
    id: `generated/img-${i}.svg`,
    name: `img-${i}.svg`,
    kind: "image",
    mimeType: "image/svg+xml",
    url: i % 2 === 0 ? "/familiar.svg" : "/favicon.svg",
    size: 40_000 + i * 9000,
    width: wh[0],
    height: wh[1],
    createdAt: now - i * 6 * 3600_000 - (i > 3 ? 3 * DAY : 0),
    note:
      i === 0
        ? "the light in the corner finally reaches her chair. i kept this one."
        : i === 4
          ? "first attempt at the hearth-room. too cold, but i like the shadow."
          : "",
  }));
  const audio: GalleryItem[] = [
    {
      id: "generated/read-aloud.wav",
      name: "read-aloud.wav",
      kind: "audio",
      mimeType: "audio/wav",
      url: wav,
      size: 22_500,
      createdAt: now - 4 * 3600_000,
      note: "i read your note back to you, slow.",
    },
    {
      id: "generated/hum.wav",
      name: "hum.wav",
      kind: "audio",
      mimeType: "audio/wav",
      url: toneWavDataUri(0.5, 330),
      size: 18_000,
      createdAt: now - 5 * DAY,
      note: "",
    },
  ];
  return [...images, ...audio].sort((a, b) => b.createdAt - a.createdAt);
}

// Stub the gallery endpoints so GalleryPage renders against fixtures without a
// running daemon. Demo-only; the production component is untouched.
function installFetchStub() {
  let items = makeItems();
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    await new Promise((r) => setTimeout(r, 400));
    if (url.endsWith("/api/web/gallery") && method === "GET") {
      return new Response(JSON.stringify({ items }), { headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/web/gallery/note") && method === "PUT") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { id: string; note: string };
      const note = body.note.trim();
      items = items.map((it) => (it.id === body.id ? { ...it, note } : it));
      return new Response(JSON.stringify({ note }), { headers: { "Content-Type": "application/json" } });
    }
    return original(input, init);
  };
}

export function GalleryDemo() {
  useState(() => {
    installFetchStub();
    return true;
  });
  return (
    <div className="h-dvh w-full">
      <GalleryPage />
    </div>
  );
}
