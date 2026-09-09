/** Radix autofocus for portaled panels: focus the panel itself, not its first control.
    Safari draws a ring on a programmatically focused button; chat.css keeps the panel ringless. */
export function focusPanel(event: Event) {
  event.preventDefault();
  if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
}
