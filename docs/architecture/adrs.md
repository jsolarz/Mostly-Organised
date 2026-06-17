---
type: architecture
title: "Mostly Organised — Architecture Decision Records"
description: "All ADRs for the Mostly Organised add-on. Each decision is captured with context, options considered, decision, and consequences."
status: active
audience: all
tags: [gtoc, architecture, adr, decisions]
timestamp: 2026-06-17T00:00:00Z
---

# Mostly Organised — Architecture Decision Records

---

## ADR-001: Apps Script Sidebar over Workspace Add-on (Card Service)

**Status**: Accepted

**Context**
Google offers two add-on surface types:
- **Sidebar (HtmlService)**: A custom HTML/JS app embedded in an iframe. Full DOM control.
- **Card Service (CardService)**: A declarative UI model built from Card/Section/Widget objects. Renders as Google's standard card UI.

**Decision**
Use the **HtmlService sidebar**.

**Reasoning**
- A TOC tree with drag-and-drop is a rich interactive component. The CardService widget set has no tree, no drag affordance, and no way to render hierarchical data visually.
- The sidebar persists while the user works on the document. Card Service is better suited to action-triggered panels (e.g., email actions).
- HtmlService gives us full control over the rendering — critical for getting the tree indentation, expand/collapse, and drag targets right.

**Consequences**
- We own the entire UI layer. More code to write.
- CSP restrictions in the iframe require bundling all JS (no CDN).
- No access to the newer Workspace Add-on manifest features (smart chips, etc.) — acceptable for v1.

---

## ADR-002: Numbering is Display-Only (Not Injected into Heading Text)

**Status**: Accepted

**Context**
There are two ways to show section numbers:
1. **Display-only**: Numbers shown in the sidebar TOC. Document headings remain unnumbered.
2. **Inject into heading text**: "Introduction" becomes "1. Introduction" in the document itself.

**Decision**
Numbering is **display-only in the sidebar**. Document heading text is never modified to add or update numbers.

**Reasoning**
- Injected numbers create a maintenance nightmare: every reorder requires renaming every affected heading. A 10-section reorder could touch 50+ headings.
- Injected numbers pollute the document for collaborators who haven't installed the add-on — they see raw prefixes like "1.2.3 Overview" without the context.
- With display-only numbers, the add-on is non-destructive. Remove the add-on, document is unchanged.
- The user's pain (from the dead extension) was about *navigation and reordering*, not about seeing numbers in the document body.

**Consequences**
- The document itself doesn't show numbers. Users who want printed/exported numbers must use a separate step (or v2 feature: one-shot inject-and-freeze).
- Simpler implementation: no heading text patches needed for numbering changes.

**Future option (not v1)**
A "Bake numbers" command that does a one-time injection of the current numbering scheme into heading text, then disables live numbering. Out of scope for v1.

---

## ADR-003: Preact for Sidebar UI (not React, not Vanilla JS)

**Status**: Accepted

**Context**
The sidebar UI is a non-trivial interactive tree with drag-and-drop, inline edit, context menus, and real-time sync state. The options are:

1. **Vanilla JS with DOM manipulation**: No dependencies, but tree diffing and event delegation for a dynamic list is error-prone and verbose.
2. **React**: The industry standard component library. ~45 KB minified. Cannot be fetched from CDN (CSP). Bundling with clasp is possible but adds toolchain complexity.
3. **Preact**: React-compatible API, ~3 KB. Can be inlined directly into the HTML file as a script tag with the prebuilt bundle.
4. **Lit / Web Components**: Modern but unfamiliar to most contributors; overkill for a sidebar.

**Decision**
Use **Preact** with the prebuilt `preact.module.js` inlined in the HTML.

**Reasoning**
- 3 KB inlined avoids all bundling toolchain overhead for v1.
- React-compatible API means component patterns are immediately recognizable.
- Declarative rendering with hooks makes the tree/sync-state logic much cleaner than imperative DOM manipulation.
- The drag-and-drop library (`@dnd-kit/core` or similar) can also be bundled as a single file or a lightweight custom implementation used given the constraint.

**Consequences**
- Slightly more opinionated than vanilla; contributors need to know JSX/hooks.
- All JS must either be inlined or served from Apps Script's own CDN (`ScriptApp.getService().getUrl()`). No npm install at runtime.
- Build step required for the sidebar: `esbuild` bundles `sidebar/index.jsx` → inlined into `sidebar.html` before `clasp push`.

---

## ADR-004: `headingId` as Primary Node Identity Anchor (with Title Fallback)

**Status**: Accepted

**Context**
After a section move, Google Docs deletes the original paragraphs and reinserts them at a new location. This resets the `headingId` on each paragraph. We need a way to reconnect stored configuration (label overrides, exclusions) to the new headingIds after a move.

**Options considered:**
1. Use `headingId` only — lose all configuration on every move.
2. Use title text as primary identity — breaks if two sections have the same title.
3. Use `headingId` as primary; on reset, fall back to `(title, level, approximate position)` match.
4. Create a named range on every heading before the move, read the range after — ranges survive moves.

**Decision**
Option 3: `headingId` primary with title+level fallback. Named range tracking (option 4) is used only for jump-to-section (navigation), not for identity.

**Reasoning**
- Option 4 is the most correct but requires creating/reading named ranges for every heading on every move. At 200 headings that's 200 range operations — too slow.
- The fallback match (title + level) handles 95% of real-world cases. The failure case (two sections with identical title and level adjacent in the tree) is rare; a warning is surfaced to the user.
- Named ranges for navigation (jump-to-section) are justified because the Docs API provides no other reliable way to scroll to a specific paragraph after its position has shifted.

**Consequences**
- Post-move reconciliation is a best-effort match, not a guaranteed one.
- Ambiguous matches (same title, same level, adjacent) show a warning and ask the user to re-apply their override.
- Navigation named ranges must be deleted and recreated after each section move.

---

## ADR-005: Single `batchUpdate` Per Mutation (Undo Atomicity)

**Status**: Accepted

**Context**
Google Docs tracks each API call as a separate undo history entry. A section move that makes 5 API calls creates 5 undo steps — the user hits Ctrl+Z 5 times and only undoes part of the move.

**Decision**
Every mutation (move, rename, promote/demote) is executed as a **single `Docs.Documents.batchUpdate()` call** with all required requests bundled.

**Reasoning**
- One batchUpdate = one undo entry. The user can Ctrl+Z a complex move in a single keystroke.
- batchUpdate is also more efficient (one HTTP round trip vs. N).
- The ordering constraint (see sync-engine.md) is manageable: compute the correct request order before building the array.

**Consequences**
- Request construction is more complex: indices must be pre-adjusted for the ordering of inserts/deletes within the same batch.
- If the batchUpdate fails, it fails atomically — no partial mutations. This is the correct behavior; the error handler can show a clear "nothing changed" message.
- Level-adjustment after a section move (promoting/demoting child headings to match new position) may require a second batchUpdate, since the indices of the moved content are only known after the first batch completes. This is acceptable: two undo entries for a move+reLevel is still better than N.
