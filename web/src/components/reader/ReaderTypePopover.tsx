const PAPERS = ["sand", "clay", "sage"];

export function ReaderTypePopover({
  fontSize,
  paper,
  onFontSize,
  onPaper,
}: {
  fontSize: number;
  paper: string;
  onFontSize: (size: number) => void;
  onPaper: (paper: string) => void;
}) {
  return (
    <div className="reader-popover reader-type-popover">
      <div className="reader-type-row">
        <span>type size</span>
        <div className="reader-font-options">
          <button type="button" aria-label="smaller type" disabled={fontSize <= 14} onClick={() => onFontSize(Math.max(14, fontSize - 1))} className="reader-type-button">A</button>
          <output aria-live="polite">{fontSize}</output>
          <button type="button" aria-label="larger type" disabled={fontSize >= 22} onClick={() => onFontSize(Math.min(22, fontSize + 1))} className="reader-type-button">A</button>
        </div>
      </div>
      <div className="reader-paper-row">
        <span>paper</span>
        <div>
          {PAPERS.map((name) => (
            <button
              key={name}
              type="button"
              aria-label={`${name} paper`}
              aria-pressed={paper === name}
              className={`reader-paper-choice is-${name}`}
              onClick={() => onPaper(name)}
            >
              <span>{name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
