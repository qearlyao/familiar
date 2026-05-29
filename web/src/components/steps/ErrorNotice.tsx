export function ErrorNotice({ text }: { text: string }) {
  return (
    <div className="my-1 rounded-r-md border-l-2 border-destructive/50 bg-destructive/[0.06] py-2 pl-3 pr-3">
      <span className="font-serif italic text-sm tracking-wide text-destructive/85">
        lost somewhere between us
      </span>
      <div className="mt-1.5 h-px bg-destructive/15" />
      <div className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-destructive/90">
        {text}
      </div>
    </div>
  );
}
