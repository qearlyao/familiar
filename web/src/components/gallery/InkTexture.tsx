const TEXTURES = ["wash", "bloom", "botanical", "grass"];

/** Keep each recording's supplied transparent artwork stable across filters and refreshes. */
export function InkTexture({ id, className = "" }: {
  id: string; className?: string;
}) {
  let hash = 0;
  for (const character of id) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  const variant = (hash >>> 0) % 4;
  return <span aria-hidden="true" className={`makings-ink ${className}`}
    style={{ backgroundImage: `url('/textures/makings-${TEXTURES[variant]}.webp')` }} />;
}
