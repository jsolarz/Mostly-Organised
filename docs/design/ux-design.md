---
type: architecture
title: "Mostly Organised — UX Design"
description: "Sidebar interaction model, visual states, and component breakdown for the Mostly Organised TOC panel."
status: active
audience: all
tags: [gtoc, design, ux, sidebar, interactions]
timestamp: 2026-06-17T00:00:00Z
---

# Mostly Organised — UX Design

## Sidebar Layout

```
┌─────────────────────────────────┐
│ Mostly Organised                  ⟳  ⚙     │  ← header: title, sync, settings
│ Synced just now                 │  ← sync status line
├─────────────────────────────────┤
│ Numeric ▾   [Search…]           │  ← numbering scheme selector, search
├─────────────────────────────────┤
│                                 │
│ ▼ 1 Introduction            ⋮  │  ← root node, expanded, options
│    1.1 Overview             ⋮  │  ← child, no children (no toggle)
│    1.2 Scope                ⋮  │
│ ▶ 2 Architecture            ⋮  │  ← root node, collapsed
│ ▼ 3 Implementation          ⋮  │
│    3.1 API Layer            ⋮  │
│    ▼ 3.1.1 Endpoints        ⋮  │
│       3.1.1.1 GET /toc      ⋮  │
│ ⚠ 4 Appendix (renamed)     ⋮  │  ← stale indicator
│ ~~5 Deleted Section~~           │  ← orphaned node
│                                 │
└─────────────────────────────────┘
```

---

## Node States

| State | Visual treatment |
|---|---|
| Active | Default: number (muted) + label (normal weight) |
| Hovered | Subtle background highlight; drag handle appears left; options `⋮` brightens |
| Dragging | Node becomes translucent; ghost follows cursor; drop targets highlight |
| Drop target (valid) | Blue top/bottom border (before/after) or blue left border (as child) |
| Drop target (invalid) | Red tint, cursor becomes not-allowed |
| Stale | Orange `⚠` icon before label; tooltip: "Heading renamed in document" |
| Orphaned | Struck-through text, muted; `⚠` icon; appears at bottom of tree |
| Excluded | Absent from tree (excluded nodes are not shown) |
| Editing | Label becomes inline `<input>`; confirm/cancel affordances |

---

## Interaction Flows

### Drag-and-Drop Reorder

```
hover node
  → drag handle (⠿) appears on left edge

mousedown drag handle
  → node "lifts" (slight shadow, translucent)
  → ghost element follows cursor

drag over tree
  → drop indicators show:
    ─────────── (horizontal line between nodes = before/after)
    │ (left border on a node = as child of that node)

  → drop is blocked if:
    - dropping onto itself
    - dropping onto its own descendant
    - would result in level >6 after cascade

drop
  → node snaps to new position (optimistic UI)
  → spinner on node while server executes move
  → on success: tree re-renders with fresh data
  → on failure: revert to pre-drag position, show toast error
```

### Inline Rename

```
double-click label
  → label becomes input field, pre-selected text
  → Enter / click-away = confirm
  → Escape = cancel

confirm
  → show spinner on node
  → server patches heading text in document
  → on success: re-sync, node shows new title
  → on failure: revert, show toast
```

### Options Menu (`⋮`)

```
click ⋮ or right-click node
  → context menu:

  ├ Edit TOC label          (→ sets manual override; document heading unchanged)
  ├ ─────
  ├ Promote heading         (H2→H1; grayed out if already H1)
  ├ Demote heading          (H2→H3; grayed out if already H6)
  ├ ─────
  ├ Exclude from TOC        (hidden from tree; heading unchanged)
  └ Remove orphan           (only shown if status=orphaned)
```

### Stale Resolution

```
click ⚠ on stale node
  → inline popover:

  "The heading was renamed in the document."
  Current in doc:    "New Title Here"
  Your TOC override: "Old Title Here"

  [ Update TOC ]    [ Restore heading in doc ]    [ Dismiss ]
```

---

## Numbering Scheme Display

Numbers are rendered in the sidebar only. They are muted (lower contrast) to keep the label as the primary reading target.

| Scheme | Example |
|---|---|
| None | Introduction |
| Numeric | **1.2.3** Introduction |
| Legal | **I.A.3** Introduction |
| Outline | **A.1.c** Introduction |

Excluded nodes are skipped; subsequent nodes renumber. Example with node 1.2 excluded:

```
1 Introduction
  1.1 Overview
  [1.2 Scope — excluded, not shown]
  1.2 Background     ← renumbered from what would be 1.3
```

---

## Sync Status States

| State | Display |
|---|---|
| Synced | "Synced just now" (fades to gray after 60s) |
| Synced N ago | "Synced 3 min ago" |
| Syncing | Spinner + "Syncing…" |
| Stale nodes detected | "Up to date · 2 stale" (amber) |
| Error | "Sync failed — click ⟳" (red) |

---

## Settings Panel

Accessible via `⚙` in the header. A slide-over or modal:

```
Numbering scheme      [ None | Numeric | Legal | Outline ]
───────────────────────────────────────────────────────────
Excluded headings     3 headings excluded    [ Manage ]
Label overrides       1 override active      [ Manage ]
───────────────────────────────────────────────────────────
[ Reset all TOC settings for this document ]
```

---

## Empty States

| Condition | Message |
|---|---|
| No headings in document | "No headings found. Format text as Heading 1–6 to build a TOC." |
| All headings excluded | "All headings are excluded. [Manage excluded headings]" |
| Document load error | "Could not read document. [Retry]" |

---

## Accessibility

- All interactive controls have `aria-label` or visible label
- Drag-and-drop has a keyboard fallback: select node → `Alt+Up` / `Alt+Down` to reorder, `Alt+Left` / `Alt+Right` to promote/demote
- Focus is returned to the moved node after a successful operation
- Color is never the sole indicator: stale nodes use icon + color; invalid drop targets use icon + color
