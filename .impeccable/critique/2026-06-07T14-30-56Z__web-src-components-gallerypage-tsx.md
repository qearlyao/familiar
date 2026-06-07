---
target: web/src/components/GalleryPage.tsx
total_score: 24
p0_count: 0
p1_count: 2
timestamp: 2026-06-07T14-30-56Z
slug: web-src-components-gallerypage-tsx
---
**Design Health Score**

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Loading, saving, and play state exist; note auto-save and save failure status are too quiet. |
| 2 | Match System / Real World | 3 | "makings" and time groups fit Familiar; file size and item index feel like asset-manager metadata. |
| 3 | User Control and Freedom | 2 | Image review has next/previous; audio review is isolated and note save behavior is ambiguous. |
| 4 | Consistency and Standards | 2 | Image tiles, audio tiles, image lightbox, and audio popup each use a different interaction model. |
| 5 | Error Prevention | 2 | Dirty notes can save on close/navigation without strong local confirmation or failure handling. |
| 6 | Recognition Rather Than Recall | 3 | Dates, note previews, and labels help scanning; audio annotation is still too easy to miss. |
| 7 | Flexibility and Efficiency | 2 | Keyboard arrows are image-only; audio has no sequence browsing or efficient listen-through mode. |
| 8 | Aesthetic and Minimalist Design | 3 | Strong warm archive feel; audio cards and dialogs are over-shaped for the quieter system. |
| 9 | Error Recovery | 2 | Global error banner exists, but save failures are not attached to the note surface. |
| 10 | Help and Documentation | 2 | Empty state is warm, but does not explain how this shelf fills or what happens next. |
| **Total** | | **24/40** | **Promising, but the media-review layer needs register polish.** |

**Anti-Patterns Verdict**

**LLM assessment**: The page does not immediately read as generic AI output. The masonry grid, lowercase voice, serif marginalia, and "makings" naming carry Familiar well. The weak point is not the shell; it is the audio and review layer. `rounded-3xl` media cards, radial glow blobs, modal blur, border plus shadow framing, and visible file metadata nudge the page toward a generated "media library with notes" pattern instead of a lived-in companion shelf.

**Deterministic scan**: `detect.mjs --json web/src/components/GalleryPage.tsx` returned `[]`, so there were 0 deterministic slop findings and no false positives. The scanner did not flag the issues above because they are product-register and emotional-fit problems, not mechanical slop patterns.

**Visual overlays**: Browser evidence was attempted, but no reliable user-visible overlay is available. Live-server started and stopped cleanly, but script injection did not appear in the Vite page. Browser snapshots were used as fallback evidence.

**Overall Impression**

The page has a good bones-level idea: a small shelf of things Familiar made, grouped by time. It feels personal before it feels useful, which is right. The biggest opportunity is to stop treating audio and note review as generic media-management tasks. Audio should feel like a first-class remembered artifact, not a decorative play blob attached to a form modal.

**What's Working**

- The time-grouped masonry grid is a strong foundation. It feels casual and archival without becoming a dashboard.
- The page name, lowercase copy, serif dates, and note previews preserve Familiar's warm voice.
- Showing notes directly under tiles makes artifacts feel kept and remembered, not merely stored.

**Priority Issues**

**[P1] Audio tiles do not feel like first-class makings**

Why it matters: Images are inspectable artifacts; audio is currently an abstract bloom plus a tiny note affordance. That makes sounds feel secondary and less emotionally legible.

Fix: Make the whole audio tile one coherent "listening slip": compact play mark, duration/progress, date marginalia, and note preview in one readable object. Reduce the giant rounded bloom card. Keep the bloom as state texture if it still earns its place, but do not make it the whole artifact.

Suggested command: `$impeccable shape`

**[P1] Dialogs break the lived-in register**

Why it matters: The audio popup and image lightbox feel closer to a generic media manager than a companion shelf. Backdrop blur, heavy modal framing, big radii, and file metadata flatten the emotional moment.

Fix: Use solid warm overlays, smaller radii, flatter surfaces, and note-first hierarchy. Hide file size and item count behind secondary details, or move them below the emotional timestamp.

Suggested command: `$impeccable polish`

**[P2] Save and error feedback are too quiet for note editing**

Why it matters: Notes are personal. If a note is auto-saved, saved manually, or fails, the user needs local confidence that the thought was kept.

Fix: Put save status and save errors inside the note area, not only in the footer or global banner. On failed save, keep the dialog open and show "try again" near the save button.

Suggested command: `$impeccable harden`

**[P2] Image and audio browsing models diverge**

Why it matters: Users scanning makings should not relearn navigation by media type. Images support previous/next review; audio notes are isolated.

Fix: Add previous/next to the audio popup or unify audio and image into the same artifact-review frame, with media-specific controls inside it.

Suggested command: `$impeccable layout`

**[P3] Empty and error states are competent, not memorable**

Why it matters: This page is about the companion's acts. Empty and error states can make the companion feel present without sparkle tropes.

Fix: Rewrite the empty state to explain where makings come from and what kind of thing might appear here. Keep raw exception text out of the primary emotional surface.

Suggested command: `$impeccable clarify`

**Persona Red Flags**

**First-time owner**: They understand "makings," but may not know how makings happen. The tiny "add a note" action on audio is easy to miss after pressing play. Empty state does not connect this shelf to companion behavior elsewhere.

**Returning sentimental user**: They want to revisit a moment, but "recording · 592 kb · 7 of 53" makes the artifact feel like a file. Save feedback is too faint for a personal note, and audio lacks a listen-through flow.

**Keyboard / efficiency user**: Image lightbox has arrow navigation, but audio popup does not. Audio tiles have nested tab stops, so the focus path feels fragmented. There is no clear keyboard path for save beyond tabbing to the footer.

**Minor Observations**

- `Palette` in the empty state reads a little too much like a creative-tool icon.
- `backdrop-blur-sm` conflicts with the documented no-glassmorphism direction.
- Radial bloom motion is warmer than AI shimmer, but still close enough to glow-token territory that it needs restraint.
- `rounded-3xl` is off-system for Familiar; warmth should come from tone, type, and spacing rather than pillowy geometry.
- Browser console reported Radix `DialogContent` warnings for missing `Description` or `aria-describedby`.
- Image alt fallback to filenames weakens accessibility and the emotional read.

**Questions to Consider**

- What if an audio making looked like a remembered note with a play mark, rather than a media card?
- Does the user need file size during the first emotional encounter with a piece?
- Should "note kept" feel like a small relational acknowledgment instead of a form status?
- Why are images browsable as a sequence while sounds are isolated popups?
