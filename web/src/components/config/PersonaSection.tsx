interface PersonaSectionProps {
  name: string | undefined;
}

export function PersonaSection({ name }: PersonaSectionProps) {
  return (
    <section>
      <h3 className="font-serif text-lg leading-tight tracking-tight text-foreground">persona</h3>
      <p className="mt-1 font-serif text-xs italic text-muted-foreground">
        the companion's identity, voice, and disposition.
      </p>
      <div className="mt-3 flex items-baseline gap-3">
        <span className="font-serif text-2xl leading-none tracking-tight text-foreground">
          {name ?? "—"}
        </span>
      </div>
      <p className="mt-2 font-serif text-xs italic text-muted-foreground/70">
        editable in-app in v1. for now, edit your persona files directly.
      </p>
    </section>
  );
}
