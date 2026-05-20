import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import type { SettingSource } from "@/lib/api";

interface ModelSectionProps {
  models: string[];
  current: string | undefined;
  source: SettingSource | undefined;
  disabled: boolean;
  onChange: (model: string) => void;
}

export function ModelSection({ models, current, source, disabled, onChange }: ModelSectionProps) {
  return (
    <section>
      <h3 className="font-serif text-lg leading-tight tracking-tight text-foreground">model</h3>
      <p className="mt-1 font-serif text-xs italic text-muted-foreground">
        which language model carries this conversation.
      </p>
      <RadioGroup
        value={current ?? ""}
        onValueChange={onChange}
        disabled={disabled}
        className="mt-4 grid gap-1"
      >
        {models.map((model) => {
          const id = `model-${model}`;
          const isActive = model === current;
          const [provider, ...rest] = model.split("/");
          const name = rest.join("/");
          return (
            <Label
              key={model}
              htmlFor={id}
              className={
                "group/row flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-accent has-data-[state=checked]:bg-primary has-data-[state=checked]:text-primary-foreground has-data-[state=checked]:hover:bg-primary"
              }
            >
              <RadioGroupItem value={model} id={id} />
              <span className="font-mono text-sm leading-tight">
                <span className={isActive ? "text-primary-foreground/70" : "text-muted-foreground group-hover/row:text-foreground"}>{provider}</span>
                <span className={isActive ? "text-primary-foreground/70" : "text-muted-foreground group-hover/row:text-foreground"}>/</span>
                <span className={isActive ? "text-primary-foreground" : "text-muted-foreground group-hover/row:text-foreground"}>{name}</span>
              </span>
            </Label>
          );
        })}
      </RadioGroup>
      {current && source ? (
        <p className="mt-2 font-serif text-xs italic text-muted-foreground/70">
          {source === "override" ? "set for this channel" : "inherited from default config"}
        </p>
      ) : null}
    </section>
  );
}
