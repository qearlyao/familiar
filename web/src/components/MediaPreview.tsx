import { ExternalLink, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function MediaPreview({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  return (
    <DialogPrimitive.Root>
      <DialogPrimitive.Trigger asChild>
        <button
          type="button"
          className={cn(
            "inline-block max-w-full rounded-md text-left outline-none transition-opacity hover:opacity-90 focus-visible:ring-3 focus-visible:ring-ring/40",
            className,
          )}
        >
          <img
            src={src}
            alt={alt}
            loading="lazy"
            className="max-h-72 max-w-[min(24rem,100%)] rounded-md"
          />
        </button>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-background/90 data-closed:animate-out data-closed:fade-out-0 data-open:animate-in data-open:fade-in-0" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 flex items-center justify-center p-3 outline-none sm:p-6"
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <DialogPrimitive.Title className="sr-only">{alt}</DialogPrimitive.Title>
          <img
            src={src}
            alt={alt}
            className="max-h-[calc(100dvh-1.5rem)] max-w-[calc(100vw-1.5rem)] rounded-md object-contain shadow-lg sm:max-h-[calc(100dvh-3rem)] sm:max-w-[calc(100vw-3rem)]"
          />
          <div className="fixed top-3 right-3 flex gap-1 sm:top-4 sm:right-4">
            <Button asChild type="button" variant="ghost" size="icon-sm" title="open original" aria-label="open original">
              <a href={src} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-4" />
              </a>
            </Button>
            <DialogPrimitive.Close asChild>
              <Button type="button" variant="ghost" size="icon-sm" title="close preview" aria-label="close preview">
                <X className="size-4" />
              </Button>
            </DialogPrimitive.Close>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
