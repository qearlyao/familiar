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
  const [savingNote, setSavingNote] = useState(false);
  const [noteSaved, setNoteSaved] = useState(false);
  const [noteError, setNoteError] = useState<string | undefined>();
  const lastOpenedIdRef = useRef<string | undefined>(undefined);
  const savingRef = useRef(false);

  const openedId = item?.id;

  useEffect(() => {
    if (lastOpenedIdRef.current === openedId) return;
    lastOpenedIdRef.current = openedId;
    setNoteSaved(false);
    setNoteError(undefined);
  }, [openedId]);

  const saveCurrentNote = useCallback(async (text: string) => {
    if (!item || text === item.note) return true;
    if (savingRef.current) return false;

    savingRef.current = true;
    setSavingNote(true);
    setNoteError(undefined);
    try {
      await saveNote(item.id, text);
      setNoteSaved(true);
      return true;
    } catch (error) {
      setNoteError(errorMessage(error));
      return false;
    } finally {
      savingRef.current = false;
      setSavingNote(false);
    }
  }, [item, saveNote]);

  return {
    savingNote,
    noteSaved,
    noteError,
    saveCurrentNote,
    flushIfDirty: () => !savingRef.current,
  };
}
