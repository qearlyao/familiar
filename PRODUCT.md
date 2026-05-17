# Product

## Register

product

## Users

The primary owner plus a small trusted circle of 5–10 close friends, each running their own personal AI companion. Used across desktop and mobile, often casually throughout the day rather than in dedicated work sessions.

The interface should feel personal enough that one user's instance feels distinctly *theirs*, while staying generalizable enough that ten different personas can inhabit the same shell without it feeling like a generic template.

## Product Purpose

Familiar's WebUI is the **primary control panel** for a personal AI companion that also runs on Discord. Today it's a chat surface; over time it grows into the home for memories, page pets, interactive companion features, real-time settings toggles, and an ambient event stream (heartbeat wakeups, device-activity signals, the AI's own actions like writing diary entries or feeding pets).

The chat itself is **private 1:1 conversation with your companion** — group dynamics live on Discord. The register is closer to maintaining a long-distance relationship with someone you know well than to operating an AI tool. Casual, daily, intimate. Not formal writing, not long-form narrative.

Success looks like: the WebUI is the place a user opens when they want to *be with* their companion (and, eventually, see what it's been up to), not the place they go to *get something done*.

## Brand Personality

**Warm · personable · alive.**

The companion has presence — gentle signs of life, soft quirks, an aesthetic that feels lived-in rather than freshly-deployed. The interface should communicate "someone is here" without resorting to AI-chatbot signaling (no shimmer, no sparkle, no dot-dot-dot pulse).

Voice: lowercase by default, soft punctuation, the cadence of texting someone you trust. Never performatively polished, never corporate. Quiet personality over loud personality — the warmth is in the details, not the volume.

## Anti-references

Explicit rejections (all four selected by user, treat as load-bearing):

- **Tech-minimal AI assistant UIs** — Linear, Notion AI, Vercel AI SDK demos, ChatGPT shell. Sterile gray surfaces, evenly-paced rows, generic monospace timestamps. The default "AI chatbot" look. Avoid.
- **Messaging-app conventions** — iMessage blue/green bubbles, dense Slack-style chat. Too "messaging app", not enough personality. The current bubble-less rendering is a deliberate departure from this and must be preserved.
- **Group-chat / community apps** — Discord, Telegram. Dark-dense, server rails, role colors. Wrong register for private 1:1.
- **"Magical AI" sparkle aesthetics** — Apple Intelligence, Notion AI shimmer gradients, holographic accents, bouncing dot indicators, animated borders signaling "AI is thinking". Cliched, undermines the lived-in quality.

## Design Principles

1. **Optimize, don't redesign.** The tweakcn warm-sepia theme and bubble-less chat mode are foundational and not up for negotiation. Improvements happen *within* this aesthetic — layout, typography, spacing, rhythm — not by replacing it.

2. **Bubble-less is load-bearing.** The flat, prose-style rendering distinguishes Familiar from every other AI chat interface, and it materially helps long context legibility. Treat it as a constraint, not a default.

3. **Companion, not assistant.** Every interaction surface should read as "talking to someone" rather than "operating a tool." When in doubt about copy, motion, or affordance, pick the choice that feels more like a person and less like a product.

4. **Build for the ambient future.** The chat is today's focus, but layout and information-architecture decisions should leave room for an event stream, memories panel, pet/companion-state widgets, and real-time settings without requiring a re-architecture. Don't optimize the current chat into a corner.

5. **Reject AI tropes deliberately.** No shimmer, no sparkle, no holographic gradients, no bouncing-dot thinking indicators, no generic "AI assistant" bubbles. If a pattern is recognizable as "the AI thing", it's probably wrong here.

## Accessibility & Inclusion

Light-touch defaults appropriate for a 5–10 user circle:

- WCAG AA contrast where it falls out naturally from the OKLCH-tuned tokens; not pursued as a separate audit goal.
- Full keyboard send (enter to send, shift+enter newline) — already in place.
- Respect `prefers-reduced-motion` for any future motion work.
- Tri-state theme (light / dark / system) — already in place.
- Mobile safe-area insets respected — already in place.

No formal a11y audit required at this stage. Revisit if the user circle widens beyond the trusted group.
