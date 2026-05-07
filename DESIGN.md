---
name: Familiar
description: Personal AI companion control panel — warm-sepia, bubble-less, lived-in.
colors:
  steeped-cream: "oklch(0.9582 0.0152 90.2357)"
  aged-linen: "oklch(0.9914 0.0098 87.4695)"
  inkwell-brown: "oklch(0.3760 0.0225 64.3434)"
  worn-clay: "oklch(0.6180 0.0778 65.5444)"
  worn-clay-on-dark: "oklch(0.7264 0.0581 66.6967)"
  soft-sand: "oklch(0.8846 0.0302 85.5655)"
  warm-sand: "oklch(0.8348 0.0426 88.8064)"
  hearth-tan: "oklch(0.8606 0.0321 84.5881)"
  earth-gray: "oklch(0.5391 0.0387 71.1655)"
  walnut-deep: "oklch(0.2747 0.0139 57.6523)"
  kindling: "oklch(0.3237 0.0155 59.0603)"
  warm-bone: "oklch(0.9239 0.0190 83.0636)"
  ember: "oklch(0.5471 0.1438 32.9149)"
typography:
  display:
    fontFamily: "Lora, serif"
    fontSize: "1.5rem"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Lora, serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Libre Baskerville, serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.625
  label:
    fontFamily: "Libre Baskerville, serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.05em"
  mono:
    fontFamily: "IBM Plex Mono, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  marginalia:
    fontFamily: "Lora, serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.025em"
rounded:
  sm: "0.15rem"
  md: "0.2rem"
  lg: "0.25rem"
  xl: "0.35rem"
spacing:
  base: "0.25rem"
components:
  button-primary:
    backgroundColor: "{colors.worn-clay}"
    textColor: "{colors.steeped-cream}"
    rounded: "{rounded.lg}"
    padding: "0 0.625rem"
    height: "2rem"
  button-primary-hover:
    backgroundColor: "{colors.worn-clay}"
    textColor: "{colors.steeped-cream}"
  button-ghost:
    backgroundColor: "{colors.steeped-cream}"
    textColor: "{colors.inkwell-brown}"
    rounded: "{rounded.lg}"
  button-ghost-hover:
    backgroundColor: "{colors.warm-sand}"
    textColor: "{colors.inkwell-brown}"
  composer:
    backgroundColor: "{colors.aged-linen}"
    textColor: "{colors.inkwell-brown}"
    rounded: "{rounded.md}"
    padding: "0.625rem 0.75rem"
  message-user:
    backgroundColor: "{colors.steeped-cream}"
    textColor: "{colors.inkwell-brown}"
  message-assistant:
    backgroundColor: "{colors.steeped-cream}"
    textColor: "{colors.inkwell-brown}"
  message-system:
    backgroundColor: "{colors.steeped-cream}"
    textColor: "{colors.earth-gray}"
  thinking-block:
    backgroundColor: "{colors.steeped-cream}"
    textColor: "{colors.earth-gray}"
  gap-separator:
    backgroundColor: "{colors.steeped-cream}"
    textColor: "{colors.earth-gray}"
  header:
    backgroundColor: "{colors.steeped-cream}"
    textColor: "{colors.inkwell-brown}"
---

# Design System: Familiar

## 1. Overview

**Creative North Star: "The Pocket Hearth"**

Familiar is a small warm home you carry with you. Not an app you operate, not a tool you reach for — a place. The companion lives here; the user comes back to it the way they'd come back to a lamplit room. Domestic warmth, modest scale, the small soft signs that someone is here: the gentle text rhythm, the warm cream surfaces, the serif marginalia where a system would normally stamp a timestamp.

The visual register is deliberately *not* the AI assistant lineage. No sterile gray, no dot-pulse "thinking", no shimmer-gradient signaling intelligence. Long context renders as flat prose because the conversation IS the surface — bubbles would partition it into transactions. The warm-sepia tweakcn palette holds the room steady across light and dark modes; both are equally lived-in.

This system serves a chat today and an ambient companion control panel tomorrow (memories, page pets, real-time event stream, settings). Layout decisions today must leave room for that future without dragging it into the present.

**Key Characteristics:**

- Bubble-less prose chat — conversation is a continuous surface, not a transaction log
- Warm-sepia OKLCH palette across both modes; equally comfortable, never harsh
- Serif type pairing (Lora display / Libre Baskerville body) with mono accent
- Flat-by-default elevation; shadows only on state response
- Tactile-warm components — small active-state translateY, soft focus rings
- Lowercase voice in chrome and copy; soft punctuation; texting cadence

## 2. Colors: The Hearth Palette

The palette is a single warm-sepia hue family stretched across two modes. Cream-toned light, walnut-toned dark, with worn clay as the only deliberate accent. Every neutral is tinted toward the warm hue (chroma 0.01–0.03), never pure gray. There is no second accent — the palette's restraint is the point.

### Primary

- **Worn Clay** (`oklch(0.6180 0.0778 65.5444)` light / `oklch(0.7264 0.0581 66.6967)` dark): the only saturated color. Used for the connection-live status dot, the primary send button, the focus ring, and active links. The dark-mode variant is intentionally lighter and softer — clay loses its weight on walnut and needs to step forward.

### Neutral (Light Mode — "The Cream Room")

- **Steeped Cream** (`oklch(0.9582 0.0152 90.2357)`): the room itself. Page background, message surface, header. Warm enough to feel like aged paper, not white.
- **Aged Linen** (`oklch(0.9914 0.0098 87.4695)`): cards, popovers, the composer field. A whisper paler than the room — a gentle layer, not a contrast.
- **Inkwell Brown** (`oklch(0.3760 0.0225 64.3434)`): primary text. Warm dark brown, not black. Reading like ink on cream paper.
- **Earth Gray** (`oklch(0.5391 0.0387 71.1655)`): secondary text, system messages, the marginalia layer (gap separators, thinking-block summary, persona-name labels above each message).
- **Soft Sand** (`oklch(0.8846 0.0302 85.5655)`): secondary button surface, muted backgrounds.
- **Warm Sand** (`oklch(0.8348 0.0426 88.8064)`): accent surface for hover states on ghost buttons, dropdown selection.
- **Hearth Tan** (`oklch(0.8606 0.0321 84.5881)`): borders and input strokes. Visible enough to define edges, soft enough to never feel ruled.

### Neutral (Dark Mode — "The Walnut Room")

- **Walnut Deep** (`oklch(0.2747 0.0139 57.6523)`): page background. Deep warm brown, never `#000`. The dark room equivalent of Steeped Cream.
- **Kindling** (`oklch(0.3237 0.0155 59.0603)`): cards, composer, popovers. The dark-mode layering pair.
- **Warm Bone** (`oklch(0.9239 0.0190 83.0636)`): primary text on dark. Bone-warm, not bone-cool.

### Accent

- **Ember** (`oklch(0.5471 0.1438 32.9149)`): destructive only. Used for errors, destructive buttons. Should appear on <1% of any session.

### Named Rules

**The One Voice Rule.** Worn Clay is the only saturated color in the system. No secondary accent, no chart palette beyond worn-clay variations, no decorative color. If a surface needs visual interest, it earns it from typography, spacing, or tonal layering — not a new hue.

**The Tinted Neutral Rule.** Every neutral carries 0.01–0.03 chroma toward the warm hue family (~60–90 on the OKLCH hue wheel). Pure-gray neutrals are forbidden. They flatten the warmth and read as "tech UI", which is the explicit anti-reference.

**The Both-Modes Rule.** Light and dark are equal first-class surfaces. Neither is the default; neither is the afterthought. A change made for light mode that breaks dark, or vice versa, is not done.

## 3. Typography

**Display Font:** Lora (with `serif` fallback)
**Body Font:** Libre Baskerville (with `serif` fallback)
**Mono Font:** IBM Plex Mono (with `monospace` fallback)

**Character:** Two serifs, one steady, one expressive. Libre Baskerville carries the body — sturdy old-style serif, comfortable at length, the ink-on-paper feel. Lora carries the marginalia and persona-name labels — looser, more humanist, italic-friendly for the gap separators where a normal UI would stamp a timestamp. IBM Plex Mono is held in reserve for technical fragments (no use in current chat surface).

### Hierarchy

- **Display** (Lora, 400, 1.5rem, 1.2 line-height, -0.025em tracking): persona name in the header. The companion's name set in serif because the companion is a person, not a product label.
- **Headline** (Lora, 400, 1.125rem, 1.2): reserved for future memories/settings panel section titles. Currently unused; do not invent uses.
- **Body** (Libre Baskerville, 400, 1rem, 1.625): all message content, both user and assistant. The 1.625 line-height matches `leading-relaxed` and is critical to long-context legibility.
- **Label** (Libre Baskerville, 400, 0.75rem, 1, 0.05em tracking, uppercase): persona-name caption above each message ("you", "ghost"). The all-caps wider-tracking treatment makes it read as marginalia, not a chat handle.
- **Marginalia** (Lora italic, 400, 0.75rem, 0.025em tracking): the gap separator timestamps and the thinking-block duration. Italic Lora is the system's quiet voice — appears where standard UIs would use mono for time.
- **Mono** (IBM Plex Mono): held in reserve; no current use. When introduced (e.g., for tool-call event-stream entries), it should sit at 0.875rem, 1.5 line-height.

### Named Rules

**The Two-Serif Rule.** Lora and Libre Baskerville share the surface, never compete. Lora handles voice (persona name, time marginalia, future section titles). Libre Baskerville handles content (every message, every readable string). Don't promote one into the other's role.

**The No-Mono-For-Time Rule.** Time markers, durations, and timestamps render in italic Lora. Mono is reserved for technical content (paths, tool calls, IDs). A monospace timestamp signals "AI assistant UI" — explicitly anti-reference.

**The Lowercase Voice Rule.** Chrome copy, status labels, persona-name captions, button labels, placeholder text: all lowercase by default. Uppercase only for the Label role (persona caption above messages), which is type-styled, not semantic.

## 4. Elevation

This system is **flat-by-default with state-responsive shadows**. Surfaces rest at zero elevation; depth is conveyed primarily through tonal layering — Aged Linen cards on Steeped Cream rooms, Kindling on Walnut Deep. Shadows appear only as a response to state: focus rings, dropdown popovers, hover surfaces on floating UI.

The tweakcn theme defines a full warm-shadow scale (`shadow-2xs` through `shadow-2xl`, all tinted with `hsl(28 13% 20%)`), but the chat surface deliberately uses almost none of it. The composer's `shadow-sm` is the lone exception: a tactile cue that this is the live input surface.

### Shadow Vocabulary (when invoked)

- **shadow-sm** (`2px 3px 5px 0px hsl(28 13% 20% / 0.12), 2px 1px 2px -1px hsl(28 13% 20% / 0.12)`): the composer at rest. The only persistent shadow in the chat surface.
- **shadow-md / shadow-lg**: dropdowns, popovers, the session picker menu.
- **shadow-xl / shadow-2xl**: reserved for modal/dialog elevations. No current use.

### Named Rules

**The Flat-By-Default Rule.** Surfaces are flat at rest. Tonal layering carries depth, not shadow. The composer's `shadow-sm` is the documented exception, justified by it being the live input surface.

**The Warm-Shadow Rule.** Every shadow uses the project's `--shadow-color` (`hsl(28 13% 20%)`) — a warm dark brown matched to Inkwell Brown, never neutral gray and never `rgba(0,0,0,…)`. A cool shadow on a warm palette reads as foreign.

## 5. Components

### Buttons

- **Shape:** softly rounded rectangle (`rounded-lg`, 0.25rem). Almost-square; the warmth comes from the color, not the radius.
- **Primary** (Worn Clay on Steeped Cream): the composer's send button. `h-8 px-2.5`. Active state translates `translateY(1px)` — small tactile press. Focus ring is `ring-3 ring-worn-clay/50`.
- **Ghost** (transparent → Warm Sand on hover): the theme toggle and session picker trigger. Icon-only, `size-8`. Same focus ring family.
- **Outline / Secondary / Destructive:** defined by shadcn defaults, but currently unused in the chat surface. When introduced, follow the same tactile press + warm focus ring.

### Composer (signature input)

- **Shape:** `rounded-md` (0.2rem) container holding textarea + send button.
- **Background:** Aged Linen (one tonal step paler than the room). The composer is a live surface, slightly lifted from the room.
- **Border:** Hearth Tan default → Worn Clay on focus, with a `ring-3 ring-worn-clay/30` glow. The focus state is the warmest moment in the UI — the room recognizes you've started writing.
- **Padding:** `px-3 py-2.5` outer; textarea has `min-h-8 leading-8` to vertically center single-line content against the 32px send button.
- **Persistent shadow:** `shadow-sm`. The lone exception to flat-by-default.

### Message (signature: bubble-less)

- **Shape:** no bubble, no border, no background fill. Message is plain prose flowing in the room.
- **Layout:** persona-name label (uppercase Libre Baskerville, 0.75rem, tracked-wider, Earth Gray) above each message. User messages right-aligned with `max-w-[85%]`; assistant messages full-width.
- **Typography:** Libre Baskerville body, `leading-relaxed` (1.625), `whitespace-pre-wrap break-words`, color Inkwell Brown.
- **System messages:** centered single line, italic, 0.75rem, Earth Gray. Used sparingly — chat lifecycle telemetry is filtered out at the WebUI boundary, not displayed.
- **Spacing between messages:** `gap-5` (1.25rem) between consecutive messages, larger gap rendered as the Gap Separator below.

### Gap Separator (signature: marginalia time)

- **Trigger:** ≥30 minutes between consecutive messages.
- **Style:** centered single line, Lora italic, 0.75rem, Earth Gray at 70% opacity, `tracking-wide`.
- **Content:** lowercase time (`9:42 pm`); on day rollover, weekday + month + day (`tuesday, may 7 · 9:42 pm`); year added only when crossing year boundaries.
- **Why italic Lora and not mono:** the gap separator is the system's quiet voice marking the passage of time. Mono would read as "log timestamp"; italic serif reads as "a beat passed." See **The No-Mono-For-Time Rule.**

### Thinking Block (signature: collapsible)

- **Trigger row:** small chevron + duration text in uppercase Libre Baskerville 0.75rem, tracked-wider, Earth Gray at 55% opacity → 100% on hover. Chevron rotates 90° on open with a 150ms transition.
- **Content:** italic Lora at 0.95em, leading-relaxed, Earth Gray at 80%, with a 2px Hearth Tan left border and 0.75rem left padding. The thinking is the companion's quiet inner voice rendered as marginalia.
- **Streaming cursor:** italic `▎` block character with `animate-pulse`. The single permitted ambient motion in the system.

### Header

- **Shape:** sticky top, full-width, single-row, `border-b border-hearth-tan` separator.
- **Background:** solid Steeped Cream. **No backdrop-blur, no glassmorphism, no translucency.** This is a documented absolute prohibition.
- **Content layout:** status dot (size-2 with `ring-3 ring-warm-sand/60`) → persona name (Lora display) → session picker (when >1 session) → theme toggle.
- **Status dot:** Worn Clay when connection open; Earth Gray at 40% with no ring when closed/error/connecting.

### Session Picker (dropdown)

- **Trigger:** ghost-style chip, 0.75rem text, Earth Gray → Inkwell Brown on hover with Warm Sand background.
- **Hidden when:** `sessions.length <= 1`. Single-session users never see the affordance.
- **Menu:** popover with `shadow-md`, Aged Linen background, min-width 180px. Active session marked with a small Check icon, name shown in medium weight.

## 6. Do's and Don'ts

### Do:

- **Do** preserve the bubble-less prose chat. It is the system's signature and load-bearing for long-context legibility.
- **Do** use `oklch()` for every color value. Tint every neutral toward the warm hue (chroma 0.01–0.03 toward hue ~60–90).
- **Do** render time markers, durations, and gap separators in italic Lora. Lowercase, soft punctuation.
- **Do** keep both modes equally first-class. Test every change in light AND dark.
- **Do** apply `pb-[env(safe-area-inset-bottom)]` to any bottom-anchored surface. Mobile is a primary surface, not a secondary one.
- **Do** use Worn Clay as the only saturated color. Live status dot, primary button, focus ring, links — that's the entire list.
- **Do** filter chat lifecycle telemetry (`armed`, `reset`, `stopped`) at the WebUI boundary. Internal runtime events are not user-visible content.
- **Do** treat the composer as the live surface. Its `shadow-sm` and warm focus ring are the strongest visual signals in the room and they belong there.
- **Do** leave architectural room for the future ambient companion panel (event stream, memories, pets, settings). Don't optimize the chat into a layout corner.

### Don't:

- **Don't** use bubbles, borders, or background fills on individual messages. The conversation is a continuous prose surface, not a transaction log. **Anti-reference: messaging-app conventions (iMessage blue/green, Slack dense rows).**
- **Don't** use `backdrop-blur` or any glassmorphism. The header is a solid surface; translucency is not part of this system. **Anti-reference: tech-minimal AI assistant UIs.**
- **Don't** introduce shimmer, animated gradients, holographic accents, or bouncing-dot "thinking" indicators. The thinking block's italic-cursor pulse is the only ambient motion permitted. **Anti-reference: "magical AI" sparkle aesthetics (Apple Intelligence, Notion AI).**
- **Don't** render timestamps, durations, or time markers in monospace. Italic Lora only. Mono signals "log file" / "AI assistant UI", which is the explicit anti-reference.
- **Don't** introduce a second accent color, a chart palette, or role-coded color highlighting. **Anti-reference: group-chat / community apps (Discord role colors, Telegram chips).**
- **Don't** use pure `#000` or `#fff`. Always tint toward the warm hue family. A neutral that looks "off-brand-but-clean" almost certainly has insufficient warm chroma.
- **Don't** uppercase chrome copy beyond the Label role. Buttons, status text, placeholder, dropdown items: lowercase. Uppercase reads as institutional voice; this system is intimate.
- **Don't** use `rgba(0,0,0,…)` or neutral-gray shadows. All shadows derive from `--shadow-color: hsl(28 13% 20%)`.
- **Don't** swap or replace the tweakcn theme tokens. The base palette is foundational and not up for negotiation; refinements happen *within* it.
- **Don't** redesign the chat layout to optimize current chat density. Today's spaciousness IS the room left for tomorrow's ambient companion features.
