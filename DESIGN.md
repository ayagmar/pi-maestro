---
name: Pi Maestro
description: Orchestrator/advisor and fresh-context executor workflows for Pi
---

# Design System: Pi Maestro

## Overview

**Creative North Star: "The Control Room Field Manual"**

Pi Maestro should feel like a precise technical field manual opened beside a live orchestration console: explanatory enough to teach, operational enough to trust, and distinctive enough to remember. The landing experience uses disciplined product demonstrations and one purposeful advisor-to-executor sequence; the documentation then settles into a quieter, highly legible system for sustained reading.

The visual language draws from Braun technical manuals for explanatory discipline, Panic’s software sites for demonstrative personality, and GitHub Docs for durable technical navigation. It explicitly rejects generic Product Hunt AI SaaS styling, vague spectacle, and terminal aesthetics used as costume.

**Key Characteristics:**
- Confident, evidence-led product storytelling
- Clear separation between explanation, live workflow, and reference material
- A committed honey/ochre identity balanced by neutral reading surfaces
- Humanist typography with monospace reserved for real technical artifacts
- One memorable orchestration sequence rather than scattered decorative motion

## Colors

Use a committed honey/ochre anchor on a true neutral white foundation, with a deep ink-blue counterpoint. Marketing surfaces may let the anchor carry substantial visual weight; documentation surfaces remain restrained for long-form reading. The values below are the tokens in `src/styles/global.css`. Every text pairing meets WCAG 2.2 AA (4.5:1 for text, 3:1 for large text and interface boundaries); the lowest text ratio in use is 6.5:1.

### Primary
- **Signal Honey** (`--honey`, `oklch(0.8 0.15 92)`): The brand anchor for decisive moments, active orchestration, primary actions, and selected workflow states. It is used as a fill, a rule, or text on dark surfaces.
- **Honey Deep** (`--honey-deep`, `oklch(0.43 0.1 100)`): The same hue darkened for text, links, focus rings, and selected-state markers on white (8:1 on `--paper`).

### Secondary
- **Control Ink** (`--ink-blue`, `oklch(0.23 0.045 245)`; `--ink-blue-light`, `oklch(0.31 0.05 245)`): A deep ink-blue counterpoint for the hero, the footer, the dark landing section, and the primary header action.

### Neutral
- **True White** (`--paper`, `oklch(1 0 0)`): The principal reading surface; it must remain neutral rather than becoming cream or parchment. `--surface` (`oklch(0.97 0.004 245)`) is a faint cool tint for table headers, the page outline, and hover states, and `--line` (`oklch(0.88 0.008 245)`) draws dividers.
- **Console Black** (`--console`, `oklch(0.17 0.035 245)`): Code blocks and the example board. Text on it is `--on-dark` (`oklch(0.93 0.01 245)`, 15.6:1) or `--on-dark-muted` (`oklch(0.78 0.02 245)`, 9.6:1). `--ink` (`oklch(0.2 0.035 245)`) is the primary text color on white.
- **Quiet Graphite** (`--ink-soft`, `oklch(0.34 0.032 245)`; `--muted`, `oklch(0.46 0.026 245)`): Secondary text and subdued interface information (11.7:1 and 7.1:1 on white).

### Status
- **Success, warning, danger** (`--success` `oklch(0.82 0.15 150)`, `--warning` `oklch(0.82 0.13 80)`, `--danger` `oklch(0.78 0.13 28)`): Task states on the dark example board. Each state also shows its name as text, so color is never the only signal.

### Named Rules

**The Signal Color Rule.** Honey/ochre communicates action, progress, and identity. It is never scattered as decoration.

**The Neutral Surface Rule.** Warmth belongs to the brand anchor, not the page background. Cream, beige, parchment, and sand surfaces are prohibited.

## Typography

**Display Font:** `"Avenir Next", "Segoe UI Variable", "Segoe UI", "Trebuchet MS", system-ui, sans-serif`
**Body Font:** the same humanist sans stack. The site loads no web fonts, so type never blocks rendering.
**Label/Mono Font:** `"SFMono-Regular", "Cascadia Code", "Roboto Mono", ui-monospace, monospace`, reserved for commands, code, task identifiers, logs, and authentic terminal output

**Character:** The primary family should be technically precise without feeling sterile. Its hierarchy must carry both a confident landing page and dense documentation without requiring a decorative display face.

### Hierarchy
- **Display:** `clamp(2.4rem, 5.2vw, 4.4rem)`, weight 700, tracking `-0.03em`, balanced wrapping. Used once, for the landing-page headline.
- **Headline:** `clamp(1.7rem, 3vw, 2.4rem)` for page and section titles. Documentation `h2` is `1.55rem` with a hairline rule above it, and `h3` is `1.2rem`.
- **Title:** `1.2rem` for workflow stages, card titles, and documentation subsections.
- **Body:** `1rem` at line height 1.6, with prose capped at `70ch`. The landing lede uses `clamp(1.1rem, 1.6vw, 1.3rem)`.
- **Label:** `0.875rem` with ordinary casing for navigation, table cells, and metadata. Uppercase and wide tracking are not used.
- **Code:** Commands and source excerpts only; monospace never substitutes for the brand voice.

### Named Rules

**The Evidence Type Rule.** Monospace means the content is genuinely technical. If the text is marketing copy, navigation, or explanation, it uses the humanist sans.

## Elevation

The system is flat by default. Depth comes from tonal separation, composition, and clear layering of workflow stages—not decorative card shadows. The site has no shadows. The example board is a flat dark surface with a one-pixel border, the sticky header is separated by a hairline, and the mobile menu and search dialog sit on a border and a dimmed backdrop. Motion is limited to color transitions on interactive elements, and none of it runs when the visitor prefers reduced motion.

### Named Rules

**The Operational Depth Rule.** Elevation appears only when it explains hierarchy, focus, or movement through the orchestration model. Decorative floating surfaces are forbidden.

## Layout and components

- **Shell:** content is `min(1180px, 100% - 3rem)` wide, `100% - 2rem` below 600px. Documentation pages use a 15.5rem sticky sidebar and a 52rem reading column; below 900px the sidebar becomes a collapsible page list.
- **Header:** sticky, `4.25rem`, white with a hairline. The current page is marked with `aria-current` and a honey underline. Search opens a modal dialog (Ctrl or Cmd K) backed by a lazily loaded `/search-index.json`, with combobox and listbox semantics.
- **Buttons:** `3rem` minimum height, `0.4rem` radius, weight 700. Primary is Signal Honey with ink text; on dark surfaces the secondary button is outlined in `--on-dark-muted`, and on white it is outlined in `--ink-soft`.
- **Code blocks:** Console Black, `0.875rem` mono, horizontal scroll instead of wrapping, and a Copy button that is added to every documentation block by script and works without it as plain selectable text.
- **Example board:** a real table (task, title, status, spend) with the footer line the extension prints. It is captioned as an example, because it is not live data.
- **Documentation:** pages render the repository's markdown directly. `src/data/doc-html.mjs` removes the file's own H1, routes relative links between files to site pages, and wraps tables in a focusable scroll region.
- **Focus:** a 3px `--honey-deep` outline offset by 3px (Signal Honey on dark surfaces). Interactive targets are at least `2.75rem` tall.

## Do's and Don'ts

### Do:
- **Do** show real advisor, executor, reviewer, evidence, cost, and recovery states.
- **Do** use Signal Honey for meaningful action and progress, not ornamental accents.
- **Do** keep documentation navigation stable, keyboard accessible, and easy to scan.
- **Do** make screenshots and short demos optional proof with poster images, captions, and user-controlled playback.
- **Do** use one selectively choreographed advisor-to-executor sequence and provide a reduced-motion equivalent.
- **Do** distinguish marketing storytelling from long-form reference reading while keeping one visual voice.

### Don't:
- **Don't** use generic AI marketing: vague transformation claims, interchangeable SaaS language, decorative AI gradients, fake productivity promises, unexplained abstractions, or visuals that imply capability without evidence.
- **Don't** imitate the generic Product Hunt AI SaaS launch page with purple gradients, glowing blobs, fake dashboards, or endless identical feature cards.
- **Don't** turn the site into a dense terminal-only presentation; terminal artifacts must demonstrate real product behavior.
- **Don't** use cream, beige, parchment, or sand as the body background.
- **Don't** use monospace as lazy shorthand for “developer tool.”
- **Don't** use gradient text, decorative glassmorphism, repeated eyebrow labels, or numbered section scaffolding.
- **Don't** pair decorative one-pixel borders with wide soft shadows or over-round cards and sections.
