import type { Message } from "./types";
import { MessageList } from "./components/MessageList";

const now = Date.now();
const minute = 60_000;

const fixtures: Message[] = [
  {
    id: "u-1",
    role: "user",
    who: "you",
    ts: now - 10 * minute,
    steps: [
      { kind: "text", id: "u-1-t", text: "do you remember that note about the lamp?", complete: true },
    ],
  },
  {
    id: "a-1",
    role: "assistant",
    who: "ghost",
    ts: now - 9 * minute,
    steps: [
      {
        kind: "thinking",
        id: "a-1-think-1",
        text: "she's asking about the hearth-lamp note. let me look through memory for it.",
        startedAt: now - 9 * minute - 3000,
        endedAt: now - 9 * minute - 1000,
        complete: true,
      },
      {
        kind: "tool",
        id: "a-1-tool-1",
        tool: {
          id: "a-1-tool-1",
          name: "memory_search",
          status: "completed",
          args: { query: "lamp hearth cold room", topK: 5 },
          result: {
            results: [
              { id: "m-7", text: "the hearth-lamp doesn't quite reach the corner where she sits at night.", score: 0.91 },
              { id: "m-3", text: "she said cold rooms made her feel like a stranger in her own house.", score: 0.78 },
              { id: "m-12", text: "the lamp is older than the apartment. she keeps meaning to rewire it.", score: 0.74 },
            ],
          },
          startedAt: now - 9 * minute - 1000,
          completedAt: now - 9 * minute - 100,
        },
      },
      {
        kind: "thinking",
        id: "a-1-think-2",
        text: "ok, three matches. the most direct one is m-7. i'll quote it back gently.",
        startedAt: now - 9 * minute - 100,
        endedAt: now - 9 * minute + 800,
        complete: true,
      },
      {
        kind: "text",
        id: "a-1-text-1",
        text: "yes — i was just looking at it. you wrote that the hearth-lamp doesn't quite reach the corner where you sit at night. it was a tuesday, the night we talked about cold rooms.",
        complete: true,
      },
    ],
  },

  {
    id: "u-2",
    role: "user",
    who: "you",
    ts: now - 5 * minute,
    steps: [
      { kind: "text", id: "u-2-t", text: "send me the cat meme + read it aloud", complete: true },
    ],
  },
  {
    id: "a-2",
    role: "assistant",
    who: "ghost",
    ts: now - 5 * minute + 500,
    steps: [
      {
        kind: "thinking",
        id: "a-2-think",
        text: "she wants two things: the meme + TTS. send the meme first, then speak.",
        startedAt: now - 5 * minute + 500,
        endedAt: now - 5 * minute + 1500,
        complete: true,
      },
      {
        kind: "tool",
        id: "a-2-tool-1",
        tool: {
          id: "a-2-tool-1",
          name: "meme",
          status: "completed",
          args: { name: "cat-loaf", family: "cats" },
          result: { url: "https://example.com/cat-loaf.png" },
          startedAt: now - 5 * minute + 1500,
          completedAt: now - 5 * minute + 1700,
        },
      },
      {
        kind: "text",
        id: "a-2-text-1",
        text: "here's the loaf.",
        complete: true,
      },
      {
        kind: "tool",
        id: "a-2-tool-2",
        tool: {
          id: "a-2-tool-2",
          name: "tts_speak",
          status: "completed",
          args: { text: "here's the loaf. she is a small bread now." },
          startedAt: now - 5 * minute + 2000,
          completedAt: now - 5 * minute + 3500,
        },
      },
      {
        kind: "text",
        id: "a-2-text-2",
        text: "she is a small bread now.",
        complete: true,
      },
    ],
  },

  {
    id: "u-3",
    role: "user",
    who: "you",
    ts: now - 2 * minute,
    steps: [{ kind: "text", id: "u-3-t", text: "what time is it where the server lives?", complete: true }],
  },
  {
    id: "a-3",
    role: "assistant",
    who: "ghost",
    ts: now - 2 * minute + 500,
    silent: true,
    steps: [
      {
        kind: "thinking",
        id: "a-3-think",
        text: "she's checking on the server, not asking for chat. quick lookup and let it sit.",
        startedAt: now - 2 * minute + 500,
        endedAt: now - 2 * minute + 1200,
        complete: true,
      },
      {
        kind: "tool",
        id: "a-3-tool",
        tool: {
          id: "a-3-tool",
          name: "bash",
          status: "completed",
          args: { command: "date '+%Z %H:%M'" },
          result: "UTC 04:12\n",
          startedAt: now - 2 * minute + 1200,
          completedAt: now - 2 * minute + 1400,
        },
      },
    ],
  },

  {
    id: "u-4",
    role: "user",
    who: "you",
    ts: now - minute,
    steps: [{ kind: "text", id: "u-4-t", text: "can you write a note to the diary about today?", complete: true }],
  },
  {
    id: "a-4",
    role: "assistant",
    who: "ghost",
    ts: now - minute + 500,
    steps: [
      {
        kind: "thinking",
        id: "a-4-think",
        text: "diary write. compose then call write_file.",
        startedAt: now - minute + 500,
        endedAt: now - minute + 1200,
        complete: true,
      },
      {
        kind: "tool",
        id: "a-4-tool",
        tool: {
          id: "a-4-tool",
          name: "write_file",
          status: "error",
          args: { path: "/diary/2026-05-25.md", content: "..." },
          error: "EACCES: permission denied, open '/diary/2026-05-25.md'",
          startedAt: now - minute + 1200,
          completedAt: now - minute + 1300,
        },
      },
      {
        kind: "text",
        id: "a-4-text",
        text: "i couldn't reach the diary file — permissions. could you check it for me?",
        complete: true,
      },
    ],
  },

  {
    id: "u-5",
    role: "user",
    who: "you",
    ts: now - 40_000,
    steps: [{ kind: "text", id: "u-5-t", text: "summarize the long thread from last week", complete: true }],
  },
  {
    id: "a-err-1",
    role: "assistant",
    who: "ghost",
    ts: now - 38_000,
    steps: [
      {
        kind: "thinking",
        id: "a-err-1-think",
        text: "big context. let me pull the thread and condense it.",
        startedAt: now - 38_000,
        endedAt: now - 37_000,
        complete: true,
      },
      {
        kind: "error",
        id: "a-err-1-error",
        text: "503 Service Unavailable · upstream provider overloaded (anthropic/claude-opus-4-8)",
      },
    ],
  },
  {
    id: "a-err-2",
    role: "assistant",
    who: "ghost",
    ts: now - 20_000,
    steps: [
      {
        kind: "error",
        id: "a-err-2-error",
        text: "429 Too Many Requests · rate_limit_exceeded — retry after 30s",
      },
    ],
  },

  {
    id: "a-5",
    role: "assistant",
    who: "ghost",
    ts: now - 5_000,
    steps: [
      {
        kind: "thinking",
        id: "a-5-think",
        text: "still thinking about how to phrase this. she asked about—",
        startedAt: now - 5_000,
      },
    ],
  },
];

export function Playground() {
  return (
    <div className="flex h-dvh flex-col bg-background text-foreground antialiased">
      <div className="border-b border-border px-5 py-3">
        <span className="font-serif text-lg text-foreground">ghost</span>
        <span className="ml-3 font-serif italic text-xs text-muted-foreground/70">
          playground · synthetic states
        </span>
      </div>
      <main className="flex-1 overflow-y-auto">
        <MessageList messages={fixtures} personaName="ghost" historyLoaded={true} />
      </main>
    </div>
  );
}
