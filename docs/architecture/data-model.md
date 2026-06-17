---
type: architecture
title: "Mostly Organised — Data Model"
description: "Complete data model for the TOC add-on: TocNode schema, storage strategy, and state lifecycle."
status: active
audience: all
tags: [gtoc, architecture, data-model, schema]
timestamp: 2026-06-17T00:00:00Z
---

# Mostly Organised — Data Model

## TocNode

The atomic unit. Every heading in the document maps to exactly one `TocNode`. The set of all nodes for a document forms the **TOC tree**.

```typescript
interface TocNode {
  // --- Identity ---
  id: string;              // Stable across re-syncs. Format: headingId || "manual-{uuid}"
  headingId: string | null; // Google's paragraph headingId. Null for manually-added nodes (future).
  documentId: string;      // Google Doc ID

  // --- Tree position ---
  parentId: string | null; // null = root-level node
  level: number;           // 1–6, mirrors heading level in document
  order: number;           // 0-indexed position among siblings

  // --- Content ---
  title: string;           // Current text of the heading paragraph in the document
  labelOverride: string | null; // User-set TOC label; null = show title

  // --- Document location ---
  startIndex: number;      // Character offset of heading paragraph start
  endIndex: number;        // Character offset of heading paragraph end (exclusive)
  namedRangeId: string | null; // Bookmark created for jump-to-section. Null until first sync with nav enabled.

  // --- Display config ---
  isExcluded: boolean;     // Hidden from TOC display and skipped in numbering
  isExpanded: boolean;     // Sidebar expand/collapse state (stored per-user in UserProperties)

  // --- Sync state ---
  syncedTitle: string;     // Title at last sync — used for stale detection
  status: TocNodeStatus;   // See below
}

type TocNodeStatus =
  | "active"     // In sync with document
  | "stale"      // title in document differs from syncedTitle
  | "orphaned"   // headingId no longer found in document
  | "excluded";  // Hidden by user choice
```

### Key Design Decisions

**`headingId` as identity anchor**
Google assigns a `headingId` to each heading paragraph. It survives text edits and minor reformatting, but is reset when the paragraph is deleted and a new one is inserted. This means: after a section move (which deletes and re-inserts content), headingIds change. Post-move sync must reconcile by title + position proximity, then update stored `headingId` values.

**`startIndex` / `endIndex`**
Character offsets into the document body. Essential for section-move operations (must know where a section starts and ends to extract and reinsert it). These become stale after any document mutation — always re-read from the API after each batch operation.

**`order` is derived, not stored**
`order` is computed at render time by sorting siblings by `startIndex`. Storing it would require maintaining consistency across every move. Deriving it is cheaper and always correct.

---

## TocDocument

Per-document configuration. Stored in `DocumentProperties` (shared across all editors).

```typescript
interface TocDocument {
  documentId: string;
  numberingScheme: NumberingScheme;
  excludedHeadingIds: string[];    // headingIds excluded from TOC (R-08)
  labelOverrides: Record<string, string>; // headingId → override label (R-09)
  lastSyncedAt: string;            // ISO timestamp
  version: number;                 // Incremented on every config write; used for optimistic conflict detection
}

type NumberingScheme =
  | "none"
  | "numeric"    // 1, 1.1, 1.1.1
  | "legal"      // I, I.A, I.A.1
  | "outline";   // A, A.1, A.1.a
```

---

## TocUserPreferences

Per-user, per-document state. Stored in `UserProperties`.

```typescript
interface TocUserPreferences {
  documentId: string;
  expandedNodeIds: string[];  // Nodes the user has expanded
  panelWidth: number;         // Sidebar panel width in px
}
```

---

## Storage Strategy

```
DocumentProperties  (shared, all editors)
  └── "mo:config:{documentId}"     → JSON(TocDocument)

UserProperties  (per-user)
  └── "mo:prefs:{documentId}"      → JSON(TocUserPreferences)

ScriptCache  (ephemeral, 6-hour TTL)
  └── "mo:tree:{documentId}"       → JSON(TocNode[])
```

**Why cache the tree?**
Parsing 200 headings from the raw document JSON is the most expensive operation. The `ScriptCache` (Apps Script's built-in key-value cache) avoids re-parsing on every sidebar interaction. Cache is invalidated on any sidebar-initiated mutation.

**Why not store the tree in DocumentProperties?**
`DocumentProperties` values are limited to 9 KB per key and 500 KB total per script. A 200-node tree serialized with full fields exceeds that. The cache (500 KB per entry) handles it; the source of truth is always the live document.

---

## State Lifecycle

```
Document created / add-on installed
         │
         ▼
    INITIAL SYNC
    Parse headings → TocNode[]
    Build TocDocument config (defaults)
    Populate ScriptCache
         │
         ▼
    SIDEBAR DISPLAYS TREE
         │
    ┌────┴────────────────────────────────────────────────────┐
    │                                                          │
    ▼                                                          ▼
USER ACTION (drag/rename/promote)              EXTERNAL EDIT (user types in doc)
    │                                                          │
    ▼                                                          │
batchUpdate to Docs API                                        │
    │                                                          │
    ▼                                                          │
Invalidate ScriptCache                                         │
    │                                                          │
    ▼                                                          │
Re-sync (parse document, rebuild tree)                         │
    │                                                          │
    ▼                                                          │
Stale/orphan detection                    ◄────────────────────┘
    │                                         (detected on next sync)
    ▼
Render updated tree
```

---

## Section Boundary Rule

The boundary of a section is defined as:

> **A section starts at its heading paragraph and ends at the last paragraph before the next heading of equal or higher level (lower level number), or at the end of the document.**

Example:
```
[H1] Introduction        ← section starts here
[P]  Some text
[H2] Overview            ← H1's section ends here (H2 is lower level); H2 section starts
[P]  Details
[H2] Scope               ← H2 "Overview" section ends here
[P]  More details
[H1] Architecture        ← H1 "Introduction" section ends here (same level); H1 "Architecture" starts
```

This rule is implemented in the sync engine when computing `endIndex` for each node. It must be recomputed after every document mutation because character indices shift.
