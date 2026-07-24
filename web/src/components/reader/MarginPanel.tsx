import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchBookConversation, type BookSummary } from "@/lib/api";
import { useChat } from "@/lib/useChat";
import type { Message } from "../../types";
import { MessageList } from "../MessageList";

export interface PendingQuote {
  quote: string;
  chapterTitle?: string;
}

/**
 * Turns sent from a book's margins live in the MAIN session (one companion,
 * one transcript) tagged with bookId; this filters the live stream down to
 * the turns that began in this book.
 */
function bookTurns(messages: Message[], bookId: string): Message[] {
  const out: Message[] = [];
  let inTurn = false;
  for (const m of messages) {
    if (m.role === "user") inTurn = m.bookId === bookId;
    if (inTurn) out.push(m);
  }
  return out;
}

function formatQuoteMessage(pending: PendingQuote, bookTitle: string, text: string): string {
  const cite = pending.chapterTitle ? `— *${bookTitle}*, ${pending.chapterTitle}` : `— *${bookTitle}*`;
  const quoted = `> ${pending.quote.replaceAll("\n", "\n> ")}`;
  return `${quoted}\n${cite}\n\n${text}`;
}

/**
 * The margin conversation: the book's durable log (mirrored server-side,
 * outside LCM's reach) merged with live turns from the main session.
 */
export function MarginPanel({
  book,
  pendingQuote,
  onClearQuote,
  onClose,
}: {
  book: BookSummary;
  pendingQuote?: PendingQuote;
  onClearQuote: () => void;
  onClose: () => void;
}) {
  const chat = useChat();
	const [logMessages, setLogMessages] = useState<Message[]>([]);
	const [logLoaded, setLogLoaded] = useState(false);
	const [loadError, setLoadError] = useState<string>();
	const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		if (!chat.activeSessionKey) return;
		let cancelled = false;
		fetchBookConversation(book.id, chat.activeSessionKey)
			.then((messages) => {
				if (!cancelled) {
					setLogMessages(messages);
					setLoadError(undefined);
				}
			})
			.catch((err) => {
				if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
			})
      .finally(() => {
        if (!cancelled) setLogLoaded(true);
      });
    return () => {
      cancelled = true;
    };
	}, [book.id, chat.activeSessionKey]);

  useEffect(() => {
    if (pendingQuote) textareaRef.current?.focus();
  }, [pendingQuote]);

  const live = useMemo(() => bookTurns(chat.messages, book.id), [chat.messages, book.id]);

  const messages = useMemo(() => {
    const liveIds = new Set(live.map((m) => m.id));
    return [...logMessages.filter((m) => !liveIds.has(m.id)), ...live].sort((a, b) => a.ts - b.ts);
  }, [live, logMessages]);

  // Latest-assistant actions belong to the main session; only offer them
  // when the main session's newest assistant message is one of ours.
  const lastAssistant = chat.messages.findLast((m) => m.role === "assistant");
  const actionsApply = lastAssistant != null && live.some((m) => m.id === lastAssistant.id);

  const submit = useCallback(async () => {
    const text = draft.trim();
    if (!text || !chat.activeSessionKey) return;
    const outgoing = pendingQuote ? formatQuoteMessage(pendingQuote, book.title, text) : text;
    setDraft("");
    onClearQuote();
    try {
      await chat.send(outgoing, [], book.id);
      setSendError(undefined);
    } catch (err) {
      setDraft(text);
      setSendError(err instanceof Error ? err.message : String(err));
    }
  }, [book.id, book.title, chat, draft, onClearQuote, pendingQuote]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 px-5 pt-4 pb-2">
        <div className="min-w-0 flex-1">
          <h2 className="font-serif text-base leading-none">margins</h2>
          <p className="mt-1 truncate font-serif text-[11px] italic text-muted-foreground">
            with {chat.personaName} · kept with the book
          </p>
        </div>
        <button
          type="button"
          aria-label="close margins"
          onClick={onClose}
          className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {logLoaded && chat.historyLoaded && messages.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6">
            <p className="text-center font-serif text-sm italic leading-relaxed text-muted-foreground/80">
              nothing in the margins yet. select a passage and ask — this is where we talk about the book.
            </p>
          </div>
        ) : (
          <MessageList
            messages={messages}
            personaName={chat.personaName}
            historyLoaded={logLoaded && chat.historyLoaded}
            streaming={chat.streaming}
            pendingLatestAssistantAction={actionsApply ? chat.pendingLatestAssistantAction : undefined}
            onRetry={actionsApply ? chat.retry : undefined}
            onDelete={actionsApply ? chat.deleteLatest : undefined}
            onEdit={actionsApply ? chat.editLatest : undefined}
          />
        )}
      </div>

		<footer className="p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
			{loadError ? (
				<p className="mb-2 font-serif text-xs italic text-destructive">
					the older margins couldn't be opened · {loadError}
				</p>
			) : null}
			{sendError ? (
          <p className="mb-2 font-serif text-xs italic text-destructive">the words didn't carry · {sendError}</p>
        ) : null}
        <div className="flex flex-col gap-2 rounded-lg bg-muted/70 px-3 py-2.5 transition-shadow focus-within:ring-3 focus-within:ring-ring/25">
          {pendingQuote ? (
            <div className="flex items-start gap-2">
              <p className="line-clamp-3 min-w-0 flex-1 font-serif text-xs italic leading-[1.9] text-muted-foreground">
                <span className="rounded-xs bg-primary/15 box-decoration-clone px-1 py-0.5">
                  {pendingQuote.quote}
                </span>
              </p>
              <button
                type="button"
                aria-label="drop the quoted passage"
                onClick={onClearQuote}
                className="mt-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ) : null}
          <div className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                }
              }}
              rows={Math.min(5, Math.max(1, draft.split("\n").length))}
              placeholder={
                !chat.activeSessionKey
                  ? "finding the thread…"
                  : pendingQuote
                    ? "ask about this passage…"
                    : "write in the margin…"
              }
              className="min-h-6 min-w-0 flex-1 resize-none bg-transparent font-serif text-sm leading-relaxed placeholder:italic placeholder:text-muted-foreground/60 focus:outline-none"
            />
            <button
              type="button"
              aria-label="send"
              disabled={!draft.trim() || !chat.activeSessionKey}
              onClick={() => void submit()}
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-[opacity,transform] active:translate-y-px",
                "disabled:opacity-35 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
              )}
            >
              <ArrowUp className="size-4" />
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
