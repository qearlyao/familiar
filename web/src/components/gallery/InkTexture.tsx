/** Four supplied ink washes, sampled as equal-height cells from the original transparent sheet. */
export function InkTexture({ id, className = "" }: {
  id: string; className?: string;
}) {
  let hash = 0;
  for (const character of id) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  const variant = (hash >>> 0) % 4;
  return <span aria-hidden="true" className={`makings-ink ${className}`}
    style={{ backgroundPosition: `center ${variant * 100 / 3}%` }} />;
}
