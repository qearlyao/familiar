import { type ChangeEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";

// parse() outcome: a committable value, a silent snap-back to the live value
// (bad input or a no-op edit), or a held draft flagged invalid (only the
// model-ref field surfaces that styling).
export type ParseResult<T> = { value: T } | "reset" | "invalid";

// Draft/busy/commit lifecycle shared by every text-and-number config field.
// The draft resyncs to a new live value only while the input is unfocused, so a
// commit that updates the underlying setting never yanks the caret out from under
// someone still typing (and we no longer need a remount-via-key hack).
export function useCommittedInput<T>(
  live: string,
  parse: (draft: string) => ParseResult<T>,
  onCommit: (value: T) => Promise<void>,
) {
  const [draft, setDraft] = useState(live);
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setDraft(live);
  }, [live]);

  const commit = async () => {
    const parsed = parse(draft);
    if (parsed === "invalid") {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (parsed === "reset") {
      setDraft(live);
      return;
    }
    setBusy(true);
    try {
      await onCommit(parsed.value);
    } catch {
      setDraft(live);
    } finally {
      setBusy(false);
    }
  };

  return {
    busy,
    invalid,
    inputProps: {
      value: draft,
      onChange: (event: ChangeEvent<HTMLInputElement>) => {
        setDraft(event.target.value);
        if (invalid) setInvalid(false);
      },
      onFocus: () => {
        focused.current = true;
      },
      onBlur: () => {
        focused.current = false;
        void commit();
      },
      onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) event.currentTarget.blur();
      },
    },
  };
}
