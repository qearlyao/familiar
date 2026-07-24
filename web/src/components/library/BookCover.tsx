import { cn } from "@/lib/utils";
import type { BookSummary } from "@/lib/api";

// Curated warm tones for generated covers, picked deterministically per title
// so the shelf reads as a matched set in the app's own palette.
const COVER_TONES = [
  "oklch(0.45 0.07 55)",
  "oklch(0.42 0.08 33)",
  "oklch(0.45 0.06 110)",
  "oklch(0.40 0.05 75)",
  "oklch(0.38 0.06 25)",
];

function toneFor(title: string): string {
  let hash = 0;
  for (let i = 0; i < title.length; i += 1) hash = (hash * 31 + title.charCodeAt(i)) | 0;
  return COVER_TONES[Math.abs(hash) % COVER_TONES.length];
}

export function BookCover({ book, className }: { book: BookSummary; className?: string }) {
  if (book.coverUrl) {
    return (
      <img
        src={book.coverUrl}
        alt={book.title}
        loading="lazy"
        className={cn("aspect-2/3 w-full rounded-sm object-cover shadow-md", className)}
      />
    );
  }
  return (
    <div
      aria-hidden
      className={cn(
        "relative flex aspect-2/3 w-full flex-col justify-between overflow-hidden rounded-sm py-[9%] pr-[9%] pl-[14%] shadow-md",
        className,
      )}
      style={{ backgroundColor: toneFor(book.title) }}
    >
      {/* A darker strip along the left edge: the book's spine. */}
      <div
        className="pointer-events-none absolute inset-y-0 left-0 w-[6%]"
        style={{ backgroundColor: `color-mix(in oklch, ${toneFor(book.title)}, black 25%)` }}
      />
      <p
        className="mt-[14%] line-clamp-5 font-sans text-[0.82em] leading-snug tracking-tight text-[oklch(0.96_0.015_85)]"
        style={{ textWrap: "balance" }}
      >
        {book.title}
      </p>
      {book.author ? (
        <p className="line-clamp-2 font-serif text-[0.6em] italic text-[oklch(0.96_0.015_85)]/75">{book.author}</p>
      ) : null}
    </div>
  );
}
