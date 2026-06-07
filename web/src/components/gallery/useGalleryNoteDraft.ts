import { useCallback, useEffect, useRef, useState } from "react";
import type { GalleryItem } from "@/lib/api";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useGalleryNoteDraft({
  item,
  saveNote,
}: {
  item: GalleryItem | undefined;
  saveNote: (id: string, text: string) => Promise<string>;
}) {
  const [draft, setDraft] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [noteSaved, setNoteSaved] = useState(false);
  const [noteError, setNoteError] = useState<string | undefined>();
  const lastOpenedIdRef = useRef<string | undefined>(undefined);
  const savingRef = useRef(false);

  const openedId = item?.id;
  const openedInitialNote = item?.note ?? "";

  useEffect(() => {
    if (lastOpenedIdRef.current === openedId) return;
    lastOpenedIdRef.current = openedId;
    setDraft(openedInitialNote);
    setNoteSaved(false);
    setNoteError(undefined);
  }, [openedId, openedInitialNote]);

  const setNoteDraft = useCallback((value: string) => {
    setDraft(value);
    setNoteSaved(false);
    setNoteError(undefined);
  }, []);

  const saveCurrentNote = useCallback(async () => {
    if (!item || draft === item.note) return true;
    if (savingRef.current) return false;

    savingRef.current = true;
    setSavingNote(true);
    setNoteError(undefined);
    try {
      await saveNote(item.id, draft);
      setNoteSaved(true);
      return true;
    } catch (error) {
      setNoteError(errorMessage(error));
      return false;
    } finally {
      savingRef.current = false;
      setSavingNote(false);
    }
  }, [draft, item, saveNote]);

  return {
    draft,
    dirty: item ? draft !== item.note : false,
    savingNote,
    noteSaved,
    noteError,
    setDraft: setNoteDraft,
    saveCurrentNote,
    flushIfDirty: saveCurrentNote,
  };
}
