import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ArrowLeft, ArrowRight, Globe, RotateCw } from "lucide-react";
import { browserUrl } from "@/lib/api";
import { ViewerDialog } from "./ViewerDialog";
import "./browser-box.css";

type Frame = { src: string; width: number; height: number };
type Send = (message: object) => void;

/** One socket to the live browser. While it is down, a new `attempt` tries again, and so does coming back to the app. */
function useBrowserStream(attempt: number, maxFps: number) {
  const socket = useRef<WebSocket | null>(null);
  const fps = useRef(maxFps);
  const [wake, setWake] = useState(0);
  const [frame, setFrame] = useState<Frame>();
  const [url, setUrl] = useState("");
  // the page's real size, when the server could ask for it: a cloud browser's frames claim another
  const [viewport, setViewport] = useState<{ width: number; height: number }>();

  const send = useCallback<Send>((message) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
  }, []);

  useEffect(() => {
    if (socket.current) return;
    const ws = new WebSocket(browserUrl());
    socket.current = ws;
    let live = false;
    ws.onopen = () => send({ type: "config", maxFps: fps.current });
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      // the tab list names the page on arrival; url messages follow it from there
      if (message.type === "url") setUrl(message.url ?? "");
      if (message.type === "tabs") setUrl(message.tabs?.find((tab: { active?: boolean }) => tab.active)?.url ?? "");
      if (message.type === "viewport") setViewport({ width: message.width, height: message.height });
      if (message.type !== "frame") return;
      live = true;
      setFrame({ src: `data:image/jpeg;base64,${message.data}`, width: message.metadata.deviceWidth, height: message.metadata.deviceHeight });
      send({ type: "ack", seq: message.seq });
    };
    ws.onclose = () => {
      if (socket.current !== ws) return;
      socket.current = null;
      // a phone drops the socket whenever the app is put away; the box waits for the return
      if (document.hidden) return;
      // it was just here: look once more before letting the box go
      if (live) setWake((n) => n + 1);
      else setFrame(undefined);
    };
  }, [attempt, wake, send]);
  useEffect(() => {
    const onReturn = () => {
      if (!document.hidden) setWake((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      document.removeEventListener("visibilitychange", onReturn);
      socket.current?.close();
      socket.current = null;
    };
  }, []);
  useEffect(() => {
    fps.current = maxFps;
    send({ type: "config", maxFps });
  }, [maxFps, send]);

  return { frame: frame && { ...frame, ...viewport }, url, send };
}

/** Chrome's modifier bits. */
const modifiersOf = (event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
  (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);

/** Keys the page only understands with their virtual key code. */
const NAMED_KEYS: Record<string, { code: number; text?: string }> = {
  Enter: { code: 13, text: "\r" }, Backspace: { code: 8 }, Tab: { code: 9 }, Escape: { code: 27 }, " ": { code: 32, text: " " },
  PageUp: { code: 33 }, PageDown: { code: 34 }, End: { code: 35 }, Home: { code: 36 },
  ArrowLeft: { code: 37 }, ArrowUp: { code: 38 }, ArrowRight: { code: 39 }, ArrowDown: { code: 40 }, Delete: { code: 46 },
};

function sendKey(send: Send, eventType: "keyDown" | "keyUp", key: string, code = "", modifiers = 0) {
  const named = NAMED_KEYS[key];
  const single = [...key].length === 1;
  // with ctrl or cmd held it is a shortcut, not a character
  const text = eventType === "keyDown" && !(modifiers & 6) ? (named?.text ?? (single ? key : undefined)) : undefined;
  // only letters and digits share their char code with a key code: "." is 46, which is Delete
  const keyCode = named?.code ?? (/^[a-z0-9]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : 0);
  send({ type: "input_keyboard", eventType, key, code, text, modifiers, windowsVirtualKeyCode: keyCode });
}

function pressKey(send: Send, key: string) {
  sendKey(send, "keyDown", key);
  sendKey(send, "keyUp", key);
}

/** The browser's own bar, which the stream leaves out: back, forward, again, and somewhere to write an address. */
function BrowserNav({ url, send }: { url: string; send: Send }) {
  // what is being written; undefined while the bar just shows where the page is
  const [draft, setDraft] = useState<string>();
  return (
    <form
      className="browser-nav"
      onSubmit={(event) => {
        event.preventDefault();
        const address = draft?.trim();
        if (address) send({ type: "page_open", url: /^https?:\/\//i.test(address) ? address : `https://${address}` });
        event.currentTarget.querySelector("input")?.blur();
      }}
    >
      <button type="button" className="viewer-ghost" aria-label="back a page" onClick={() => send({ type: "page_back" })}><ArrowLeft size={17} strokeWidth={2.5} /></button>
      <button type="button" className="viewer-ghost" aria-label="forward a page" onClick={() => send({ type: "page_forward" })}><ArrowRight size={17} strokeWidth={2.5} /></button>
      <button type="button" className="viewer-ghost" aria-label="load the page again" onClick={() => send({ type: "page_reload" })}><RotateCw size={16} strokeWidth={2.5} /></button>
      <input
        value={draft ?? url}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => event.target.select()}
        onBlur={() => setDraft(undefined)}
        placeholder="an address to go to"
        aria-label="address"
        inputMode="url"
        enterKeyHint="go"
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
      />
    </form>
  );
}

const TOUCH_SLOP_PX = 8;

/** The page itself: a mouse drives it directly; a finger taps to click and drags to scroll. */
// shortcut: no pinch-zoom, so a 1280-wide page is small on a portrait phone; add zoom if turning the phone isn't enough
function BrowserStage({ frame, url, send }: { frame: Frame; url: string; send: Send }) {
  const [text, setText] = useState("");
  const finger = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const scaleOf = (event: PointerEvent<HTMLImageElement>) => frame.width / event.currentTarget.getBoundingClientRect().width;
  const pointOf = (event: { clientX: number; clientY: number; currentTarget: Element }) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.round((event.clientX - rect.left) * (frame.width / rect.width)), y: Math.round((event.clientY - rect.top) * (frame.height / rect.height)) };
  };
  const mouse = (event: PointerEvent<HTMLImageElement>, eventType: string, extra: object = {}) =>
    send({ type: "input_mouse", eventType, ...pointOf(event), button: "none", modifiers: modifiersOf(event), ...extra });
  const buttonOf = (event: PointerEvent<HTMLImageElement>) => ({ button: (["left", "middle", "right"] as const)[event.button] ?? "none", clickCount: 1 });

  const onPointerDown = (event: PointerEvent<HTMLImageElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    if (event.pointerType === "touch") finger.current = { x: event.clientX, y: event.clientY, moved: false };
    else {
      event.currentTarget.focus();
      mouse(event, "mousePressed", buttonOf(event));
    }
  };
  const onPointerMove = (event: PointerEvent<HTMLImageElement>) => {
    const touch = finger.current;
    if (event.pointerType !== "touch") return mouse(event, "mouseMoved");
    if (!touch) return;
    const dx = touch.x - event.clientX;
    const dy = touch.y - event.clientY;
    if (!touch.moved && Math.hypot(dx, dy) < TOUCH_SLOP_PX) return;
    const scale = scaleOf(event);
    mouse(event, "mouseWheel", { deltaX: dx * scale, deltaY: dy * scale });
    finger.current = { x: event.clientX, y: event.clientY, moved: true };
  };
  const onPointerUp = (event: PointerEvent<HTMLImageElement>) => {
    if (event.pointerType !== "touch") return mouse(event, "mouseReleased", buttonOf(event));
    const tapped = finger.current && !finger.current.moved;
    finger.current = null;
    if (!tapped) return;
    mouse(event, "mouseMoved");
    mouse(event, "mousePressed", { button: "left", clickCount: 1 });
    mouse(event, "mouseReleased", { button: "left", clickCount: 1 });
  };
  const onKey = (event: KeyboardEvent<HTMLImageElement>) => {
    if (event.key === "Escape") return; // Escape stays ours: it leaves the room
    event.preventDefault();
    sendKey(send, event.type === "keydown" ? "keyDown" : "keyUp", event.key, event.code, modifiersOf(event));
  };

  return (
    <div className="viewer-body">
      <div className="viewer-stage">
        <BrowserNav url={url} send={send} />
        <div className="viewer-frame">
          <img
            className="browser-screen"
            src={frame.src}
            alt="the page they have open"
            draggable={false}
            tabIndex={0}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => { finger.current = null; }}
            onWheel={(event) => send({ type: "input_mouse", eventType: "mouseWheel", ...pointOf(event), button: "none", deltaX: event.deltaX, deltaY: event.deltaY, modifiers: modifiersOf(event) })}
            onContextMenu={(event) => event.preventDefault()}
            onKeyDown={onKey}
            onKeyUp={onKey}
          />
        </div>
        {/* A real field, so the phone's keyboard, paste and password autofill all work; its words are typed into the page. */}
        <form
          className="browser-type"
          onSubmit={(event) => {
            event.preventDefault();
            if (!text) return pressKey(send, "Enter");
            for (const char of text) pressKey(send, char === "\n" ? "Enter" : char);
            setText("");
          }}
        >
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              // with nothing written here, these keys go straight to the page
              if (text || (event.key !== "Backspace" && event.key !== "Tab")) return;
              event.preventDefault();
              pressKey(send, event.key);
            }}
            placeholder="write here, then send"
            aria-label="text to type into the page"
            enterKeyHint="send"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" className="viewer-accent">{text ? "send" : "enter"}</button>
        </form>
      </div>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** The browser they have open, live: a small look in the thread, and a room to step in and take the page yourself. */
export function BrowserBox({ attempt }: { attempt: number }) {
  const [open, setOpen] = useState(false);
  // a slow look while it sits in the thread, a quick one once you are driving
  const { frame, url, send } = useBrowserStream(attempt, open ? 15 : 1);
  if (!frame) return null;
  return (
    <ViewerDialog
      trigger={
        <button type="button" className="browser-box" aria-label="step into their browser">
          <span className="browser-box-head">
            <Globe strokeWidth={2.75} />
            <span>their browser</span>
            <span className="browser-box-host">{hostOf(url)}</span>
          </span>
          <img src={frame.src} alt="" draggable={false} />
          <span className="browser-box-open">step in</span>
        </button>
      }
      title="their browser"
      subtitle="the page they have open, yours to take"
      onOpenChange={setOpen}
    >
      <BrowserStage frame={frame} url={url} send={send} />
    </ViewerDialog>
  );
}
