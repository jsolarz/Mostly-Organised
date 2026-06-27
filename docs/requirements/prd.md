---
type: requirement
title: "Mostly Organised — Product Requirements Document"
description: "Full requirements for the Mostly Organised Google Docs add-on: what it does, what it doesn't, and why."
status: active
audience: all
tags: [gtoc, requirements, prd, google-docs]
timestamp: 2026-06-17T00:00:00Z
---

# Mostly Organised — Product Requirements Document

## Problem

The native Google Docs table of contents is read-only scaffolding. You cannot reorder sections, promote/demote headings, apply custom numbering, or see the document structure as a working surface. The only dead add-on that solved this has been removed from the Marketplace.

**Core jobs this product does:**
1. Surface the document's heading hierarchy as a manipulable tree
2. Reorder sections by dragging — moving the TOC entry moves the document content
3. Number sections with a customizable scheme, injected into heading text
4. Promote and demote headings (H2→H1, H3→H2, etc.) from the sidebar

---

## Scope

### In scope (v1)

| # | Feature | Priority |
|---|---|---|
| R-01 | Parse all headings (H1–H6) into a synchronized TOC tree | Must |
| R-02 | Display TOC in a persistent sidebar with expand/collapse | Must |
| R-03 | Drag-and-drop to reorder sections; document content moves | Must |
| R-04 | Section numbering with configurable scheme (injected into document text) | Must |
| R-05 | Promote/demote heading level from sidebar | Must |
| R-06 | Rename a heading from the sidebar (patches document text) | Must |
| R-07 | Jump to section on click | Must |
| R-08 | Exclude individual headings from TOC display | Should |
| R-09 | Manual TOC label override (TOC shows different text than heading) | Should |
| R-10 | Stale/orphan detection when heading is deleted or changed outside sidebar | Should |
| R-11 | Sync status indicator with auto-sync and manual refresh | Must |
| R-12 | Document structure validation panel (heading hierarchy errors) | Should |
| R-13 | Native Google Docs TOC auto-refresh on sync | Must |

### Out of scope (v1)

- Multi-document TOC
- Section-level permissions or approvals
- AI-generated summaries or semantic search
- Mobile support (Docs mobile does not render add-on sidebars)
- Real-time collaborative conflict resolution beyond stale detection

---

## Users

**Primary**: Solo or small-team technical writers, documentation engineers, and knowledge managers working in Google Docs who produce long structured documents (10+ sections).

**Anti-user**: Casual one-page doc writers. This add-on adds overhead they don't need.

---

## Functional Requirements

### R-01: TOC Parsing

- Scan the document body and extract all paragraphs with a heading style (HEADING_1 through HEADING_6)
- For each heading, capture: Google's `headingId`, character start/end index, heading style, current text
- Derive parent–child relationships from heading level transitions
- Compute `order` as position among siblings (same parent, same level)
- Result: a flat list of `TocNode` records that can be reconstituted as a tree

### R-02: Sidebar Display

- Render TOC as an indented tree matching the heading hierarchy
- Each node shows: [expand/collapse toggle if has children] [numbering] [label] [edit/options affordance]
- Expand/collapse state is persisted per-user per-document (`UserProperties`)
- Empty document (no headings) shows a placeholder prompt

### R-03: Drag-and-Drop Reorder

- Any node can be dragged to a new position within the tree
- Drop targets: before, after, or as child of another node (with visual guide)
- Dropping a node executes a **section move** in the document (see Architecture — Sync Engine)
- A node with children carries its full subtree; moving H1 moves all its H2/H3 descendants
- After move completes: full re-sync, tree refreshes, numbering recomputes
- Invalid drop targets (would create circular parentage): visually blocked

### R-04: Section Numbering

- Numbering is injected into the document heading text as a prefix, e.g. `1.  Introduction`, `1.1.  Background`
- Number prefix is separated from the heading text by two spaces (`  `) for reliable detection/stripping on re-parse
- Supported schemes: `numeric` (1.1.1), `legal` (I.A.1), `outline` (A.1.a)
- Numbering scheme is stored per-document in `DocumentProperties`
- Excluded nodes (R-08) are skipped in numbering sequence — subsequent nodes renumber
- Numbering recomputes entirely from tree structure at render time; no stored number values
- The original heading text (without prefix) is stored as `baseTitle` in config for reliable stripping when numbering changes or is disabled
- Setting the scheme to `none` strips all numbering prefixes from heading text, restoring the original titles
- Document text updates are issued as a single `batchUpdate` per sync (atomic undo)

### R-05: Promote / Demote

- Sidebar exposes indent/outdent controls per node (keyboard shortcut or button)
- Promote: decreases heading level by one (H3 → H2); cascade to children (+1 each)
- Demote: increases heading level by one (H2 → H3); cascade to children (+1 each)
- Guard: H1 cannot be promoted; H6 cannot be demoted
- Guard: promoting H2 to H1 where its parent is an H1 — that parent is no longer its parent; siblings shift
- Execution: single `replaceText` + `updateParagraphStyle` call per affected paragraph
- After execution: full re-sync

### R-06: Rename Heading

- Double-click TOC label → inline text edit field
- On confirm: patches the heading paragraph text in the document via Docs API
- If node has a manual label override (R-09), rename updates the override, not the document heading
- On cancel: no change

### R-07: Jump to Section

- Single-click on a TOC node scrolls the document to that heading
- Implementation: server looks up the heading by `startIndex` and calls `DocumentApp.setSelection()` to move the cursor
- O(1) direct element access via cached `startIndex`, no full document parse required
- Fallback: if cached index is stale, re-resolve via ScriptCache

### R-08: Exclude from TOC

- Right-click or options menu → "Exclude from TOC"
- Excluded nodes are hidden from sidebar display and skipped in numbering
- Exclusion state stored per-document, per-`headingId` in `DocumentProperties`
- The heading itself is unchanged in the document

### R-09: Manual Label Override

- Right-click or options menu → "Edit TOC label"
- Sidebar shows the override label; document heading text is unchanged
- Override state stored per-document, per-`headingId` in `DocumentProperties`
- Stale indicator shown if override exists but heading text has also changed (document-side edit)

### R-10: Stale / Orphan Detection

- **Stale**: heading text in document differs from `TocNode.title` (user edited heading outside sidebar)
  - Indicator: warning icon on node, tooltip explains
  - Resolution: "Update label" (accept doc change) or "Restore heading" (push override back to doc)
- **Orphaned**: `headingId` no longer exists in document (heading was deleted)
  - Indicator: struck-through node in sidebar
  - Resolution: "Remove from TOC"

### R-11: Sync

- Sync runs automatically on: sidebar open, after every sidebar-initiated document mutation
- Auto-sync polling: sidebar polls every 30 seconds when visible; stops when sidebar loses focus or is minimized
- Polling compares tree hash to avoid unnecessary re-renders
- Manual refresh button always available
- Sync status shows: "Synced just now" / "Synced 3 min ago" / "Syncing..." / "Out of sync — click to refresh"

### R-12: Document Structure Validation

- Validate the heading tree against common accessibility and style rules
- Display errors/warnings in a collapsible panel below the toolbar, separate from the TOC tree
- Each error is clickable: jumps to the offending heading in the document
- Errors are advisory only — no auto-fix; the user resolves issues manually in the document
- Re-validates on every sync

**Error types:**

| Code | Type | Description |
|---|---|---|
| E-01 | Error | Skipped heading level — e.g., H1 → H3 without H2 |
| E-02 | Warning | Document has no Heading 1 |
| E-03 | Warning | Empty heading — heading style applied to blank text |

### R-13: Native TOC Auto-Refresh

- After every sync, the native Google Docs TOC (Insert → Table of contents) is refreshed
- Implementation: find existing `tableOfContents` element, delete it, re-insert via `insertTableOfContents` at the same position
- Refresh happens silently in the background during `getTree()`; no user action required
- If no native TOC exists in the document, this step is skipped

---

## Non-Functional Requirements

| NFR | Requirement |
|---|---|
| NFR-01 | Sidebar loads under 2 seconds on a 200-heading document |
| NFR-02 | Section move completes under 5 seconds for a section up to 50 paragraphs |
| NFR-03 | All document mutations issued as a single `batchUpdate` call (atomicity + undo hygiene) |
| NFR-04 | Add-on requests minimum viable OAuth scopes: `documents` + `drive.file` |
| NFR-05 | Works on Google Docs in Chrome, Firefox, Edge (desktop) |
| NFR-06 | Graceful degradation on very large documents (>500 headings): warn, still functional |

---

## Constraints

- **Apps Script runtime**: No Node.js, no npm packages, no persistent server. All logic runs in Google's V8 environment.
- **Pull-based with polling**: Server cannot push to sidebar unprompted. Sidebar polls for changes every 30 seconds.
- **Single `batchUpdate`**: Programmatic edits that span multiple API calls each create separate undo history entries. All document mutations must be batched.
- **`DocumentProperties` is shared**: All editors of a document see the same stored TOC configuration. Per-user state (UI preferences) goes in `UserProperties`.
- **`headingId` stability**: Google's `headingId` values survive minor edits but are reset on paragraph deletion/recreation. This is the key reason orphan detection is required.
