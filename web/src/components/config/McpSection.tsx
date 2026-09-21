import { useState, type FormEvent } from "react";
import { Dialog } from "radix-ui";
import { addMcpServer, reconnectMcpServer, removeMcpServer, setMcpDeferred, type McpServer } from "@/lib/api";
import type { useMcp } from "@/lib/useMcp";
import { cn } from "@/lib/utils";
import { IconChevronDown, IconPlus } from "../organicIcons";
import { Sheet } from "../Sheet";
import { Card, EnumToggle, Field } from "./inputs";

type Mcp = ReturnType<typeof useMcp>;

const REACH_OPTIONS = [
  { value: "hand", label: "at hand" },
  { value: "fetched", label: "fetched" },
] as const;

const KIND_OPTIONS = [
  { value: "command", label: "a command" },
  { value: "url", label: "a url" },
] as const;

function ServerRow({ server, mcp }: { server: McpServer; mcp: Mcp }) {
  // errors land in the page's alert; the row only needs to not throw
  const act = (work: Parameters<Mcp["mutate"]>[0]) => void mcp.mutate(work).catch(() => {});
  const down = server.status === "failed";
  return (
    <div className={cn("mcp-server", down && "is-down")}>
      <div className="mcp-line">
        <div className="mcp-what">
          <span className="mcp-name">
            <i />
            {server.name}
            <span className="mcp-chip">{server.transport}</span>
            {server.source === "config" && <span className="mcp-chip">config.toml</span>}
          </span>
          <small className="mcp-where">
            {server.where}
            {server.headers > 0 && ` · ${server.headers} header${server.headers === 1 ? "" : "s"}`}
            {" · "}
            {down ? "no tools reachable" : `${server.tools.length} tools`}
          </small>
          <small className={down ? "settings-error" : "mcp-status"}>{down ? server.error : server.deferred ? "connected · fetched on demand" : "connected · loaded now"}</small>
        </div>
        <div className="settings-row-control">
          {down ? (
            <button type="button" className="pill-button" disabled={mcp.busy} onClick={() => act((key) => reconnectMcpServer(server.name, key))}>
              try again
            </button>
          ) : (
            <EnumToggle
              value={server.deferred ? "fetched" : "hand"}
              options={REACH_OPTIONS}
              ariaPrefix={`how ${server.name} reaches them`}
              disabled={mcp.busy}
              onChange={(next) => act((key) => setMcpDeferred(server.name, next === "fetched", key))}
            />
          )}
        </div>
      </div>
      <div className="mcp-foot">
        {server.tools.length > 0 && (
          <details className="settings-fold">
            <summary>
              see all {server.tools.length}
              <IconChevronDown />
            </summary>
            <div className="mcp-tools">
              {server.tools.map((tool) => (
                <div key={tool.name} className="mcp-tool" title={tool.description}>
                  <code>{tool.name}</code>
                  <span>{tool.description}</span>
                  {tool.loaded && <em>loaded here</em>}
                </div>
              ))}
            </div>
          </details>
        )}
        {!down && (
          <button type="button" className="pill-button is-quiet" disabled={mcp.busy} onClick={() => act((key) => reconnectMcpServer(server.name, key))}>
            reconnect
          </button>
        )}
        {server.source === "web" && (
          <button type="button" className="pill-button is-quiet" disabled={mcp.busy} onClick={() => act((key) => removeMcpServer(server.name, key))}>
            remove
          </button>
        )}
      </div>
    </div>
  );
}

type Pair = { key: string; value: string };

/** Rows of name → value that always keep one blank row at the end to type into. */
function Pairs({ pairs, placeholder, disabled, onChange }: { pairs: Pair[]; placeholder: string; disabled: boolean; onChange: (next: Pair[]) => void }) {
  const rows = [...pairs, { key: "", value: "" }];
  const edit = (index: number, patch: Partial<Pair>) => {
    const next = rows.map((row, i) => (i === index ? { ...row, ...patch } : row));
    onChange(next.filter((row) => row.key || row.value));
  };
  return (
    <div className="mcp-kv">
      {rows.map((row, index) => (
        <div key={index}>
          <input className="pill-input" placeholder={placeholder} value={row.key} disabled={disabled} spellCheck={false} autoCapitalize="off" onChange={(e) => edit(index, { key: e.target.value })} />
          <input className="pill-input" placeholder="value" value={row.value} disabled={disabled} spellCheck={false} autoCapitalize="off" onChange={(e) => edit(index, { value: e.target.value })} />
        </div>
      ))}
    </div>
  );
}

const record = (pairs: Pair[]) => Object.fromEntries(pairs.filter((p) => p.key.trim()).map((p) => [p.key.trim(), p.value]));

function AddServerForm({ mcp, onDone }: { mcp: Mcp; onDone: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"command" | "url">("command");
  const [target, setTarget] = useState("");
  const [pairs, setPairs] = useState<Pair[]>([]);
  const [failure, setFailure] = useState<string | undefined>();
  const [sending, setSending] = useState(false);
  const ready = name.trim() && target.trim() && !mcp.busy && !sending;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    // ponytail: splits on whitespace, so an argument with spaces in it can't be added here yet
    const [command, ...args] = target.trim().split(/\s+/);
    const server =
      kind === "command"
        ? { name: name.trim(), command, args, env: record(pairs) }
        : { name: name.trim(), url: target.trim(), headers: record(pairs) };
    setSending(true);
    try {
      await mcp.mutate((key) => addMcpServer(server, key), { quiet: true });
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err)); // keep the draft
      return;
    } finally {
      setSending(false);
    }
    onDone();
  };

  return (
    <form className="mcp-form" onSubmit={(event) => void submit(event)}>
      <div className="mcp-form-head">
        <h4>add a server</h4>
        <p>connects right away; nothing needs a restart.</p>
      </div>
      <Field label="name">
        <input className="pill-input" placeholder="calendar" value={name} disabled={mcp.busy} spellCheck={false} autoCapitalize="off" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="it runs as">
        <EnumToggle value={kind} options={KIND_OPTIONS} ariaPrefix="server kind" disabled={mcp.busy} onChange={setKind} />
      </Field>
      <Field label={kind}>
        <input
          className="pill-input"
          placeholder={kind === "command" ? "npx -y @some/mcp-server --flag" : "https://example.com/mcp"}
          value={target}
          disabled={mcp.busy}
          spellCheck={false}
          autoCapitalize="off"
          onChange={(e) => setTarget(e.target.value)}
        />
      </Field>
      <Field label={kind === "command" ? "environment" : "headers"}>
        <Pairs pairs={pairs} placeholder={kind === "command" ? "KEY" : "Header"} disabled={mcp.busy} onChange={setPairs} />
      </Field>
      <p className="settings-note">
        write <code>{"${NAME}"}</code> to pull a secret from the server's environment instead of storing it here.
      </p>
      {failure && <p role="alert" className="settings-error">{failure}</p>}
      <div className="mcp-foot">
        <button type="submit" className="pill-button" disabled={!ready}>
          {sending ? "connecting…" : "connect"}
        </button>
      </div>
    </form>
  );
}

/** The + at the end of the servers: a dialog on desktop, a sheet from the bottom on a phone (settings.css). */
function AddServer({ mcp }: { mcp: Mcp }) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet
      open={open}
      onOpenChange={setOpen}
      className="mcp-add-panel"
      trigger={
        <Dialog.Trigger className="pill-button is-quiet mcp-add">
          <IconPlus />
          add a server
        </Dialog.Trigger>
      }
    >
      <Dialog.Title className="sr-only">add a server</Dialog.Title>
      <i className="mcp-add-grab" />
      {/* keyed on open so each opening starts from a blank form */}
      <AddServerForm key={String(open)} mcp={mcp} onDone={() => setOpen(false)} />
    </Sheet>
  );
}

export function McpSection({ mcp }: { mcp: Mcp }) {
  const connected = mcp.servers?.filter((server) => server.status === "connected") ?? [];
  const handy = connected.filter((server) => !server.deferred).length;
  return (
    <Card
      title="mcp servers"
      hint={mcp.servers ? `${handy} at hand · ${connected.length - handy} fetched on demand` : "counting them…"}
      action={<AddServer mcp={mcp} />}
    >
      <div className="settings-rows">
        {mcp.servers?.map((server) => <ServerRow key={server.name} server={server} mcp={mcp} />)}
        {mcp.servers?.length === 0 && <p className="settings-note">none yet — lend them one.</p>}
      </div>
    </Card>
  );
}
