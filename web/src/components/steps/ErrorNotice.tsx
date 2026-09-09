export function ErrorNotice({ text }: { text: string }) {
  return (
    <div className="chat-error">
      <span>lost somewhere between us</span>
      <pre>{text}</pre>
    </div>
  );
}
