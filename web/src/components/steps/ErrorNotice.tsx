export function ErrorNotice({ text, label = "lost somewhere between us" }: { text: string; label?: string }) {
  return (
    <div className="chat-error">
      <span>{label}</span>
      <pre>{text}</pre>
    </div>
  );
}
