---
type: architecture
title: "Mostly Organised — Sync Engine"
description: "How Mostly Organised reads document state, detects changes, and executes mutations. The authoritative design for the hardest part."
status: active
audience: all
tags: [gtoc, architecture, sync, section-move, docs-api]
timestamp: 2026-06-17T00:00:00Z
---

# Mostly Organised — Sync Engine

The sync engine is the core of Mostly Organised. It does three things: **read** the document into a tree, **reconcile** that tree against stored state, and **execute** mutations back to the document.

---

## Read Phase: Parsing the Document

```
DocumentApp.getActiveDocument()
  .getBody()
  .getParagraphs()
  → filter to heading paragraphs
  → extract headingId, text, style, startIndex
  → sort by startIndex
  → compute parent–child relationships
  → compute endIndex for each node (section boundary rule)
  → return TocNode[]
```

### Heading Style → Level Map

| Apps Script Style | Level |
|---|---|
| `DocumentApp.ParagraphHeading.HEADING1` | 1 |
| `DocumentApp.ParagraphHeading.HEADING2` | 2 |
| `DocumentApp.ParagraphHeading.HEADING3` | 3 |
| `DocumentApp.ParagraphHeading.HEADING4` | 4 |
| `DocumentApp.ParagraphHeading.HEADING5` | 5 |
| `DocumentApp.ParagraphHeading.HEADING6` | 6 |

### Parent–Child Algorithm

Linear scan over sorted headings. A stack tracks the current ancestry chain:

```
stack = []

for each heading H (sorted by startIndex):
  pop stack while stack.top().level >= H.level
  H.parentId = stack.empty() ? null : stack.top().id
  push H onto stack
```

This is O(n) and handles arbitrary level jumps (H1 → H3 is valid).

### Section Boundary (`endIndex`) Algorithm

```
for i in 0..headings.length:
  H = headings[i]
  nextPeerOrAncestor = first heading[j] where j > i and heading[j].level <= H.level
  H.endIndex = nextPeerOrAncestor
    ? nextPeerOrAncestor.startIndex - 1
    : document.body.length
```

**Note**: `endIndex` includes all descendant headings' content. Moving H1 by its `[startIndex, endIndex]` range moves its complete subtree.

---

## Reconcile Phase: Diffing Against Stored State

After parsing, the engine compares the fresh `TocNode[]` against the last-synced state in `ScriptCache`:

```
freshNodes: TocNode[]   (just parsed)
cachedNodes: TocNode[]  (from ScriptCache, or empty if first sync)

for each cachedNode C:
  match = freshNodes.find(n => n.headingId === C.headingId)
  if not match:
    C.status = "orphaned"
  else if match.title !== C.syncedTitle:
    C.status = "stale"
    C.title = match.title   // update to current doc text

for each freshNode F not found in cachedNodes:
  F.status = "active"       // new heading added since last sync
  apply stored overrides (labelOverride, isExcluded) if headingId matches DocumentProperties
```

**Post-move headingId reconciliation**
When a section move completes, headingIds change (paragraphs are deleted and reinserted). The engine uses a fallback match: `(title, approximate level)` to reconnect stored overrides to new headingIds. This is imperfect but covers the common case; a warning is shown if the match is ambiguous.

---

## Execute Phase: Document Mutations

All mutations are issued as a single `Docs.Documents.batchUpdate(documentId, { requests })` call.

**Why batch?** Each separate API call adds a discrete entry to Docs' undo history. A section move via 10 separate calls = 10 undo steps. A single `batchUpdate` = 1 undo step.

### Operation: Section Move

The most complex mutation. Triggered by drag-and-drop reorder.

**Inputs**: `sourceNode: TocNode`, `targetNode: TocNode`, `position: "before" | "after" | "child"`

**Algorithm**:

```
1. CAPTURE
   Read source section content as a sequence of structural elements
   [sourceNode.startIndex, sourceNode.endIndex]

2. COMPUTE TARGET INSERTION POINT
   position = "before" → insert at targetNode.startIndex
   position = "after"  → insert after targetNode.endIndex
   position = "child"  → insert after targetNode's last existing child's endIndex
                         (or at targetNode.endIndex if no children)

3. ADJUST INDICES
   If targetInsertionPoint > sourceNode.startIndex:
     targetInsertionPoint -= (sourceNode.endIndex - sourceNode.startIndex + 1)
     // account for the content that will be removed

4. BATCH REQUESTS
   a. insertContentFromDocument (or equivalent paragraph copy via requests)
   b. deleteContentRange [source range]
   NOTE: insertion must happen before deletion if target is after source
         (indices shift after deletion; insertion on stale indices corrupts the doc)
   → issue as single batchUpdate

5. POST-MOVE LEVEL ADJUSTMENT
   If source.level !== target.level and position = "child":
     Compute levelDelta = targetNode.level + 1 - sourceNode.level
     Apply updateParagraphStyle to all heading paragraphs in the moved section:
       newStyle = clamp(oldStyle + levelDelta, HEADING_1, HEADING_6)
     Issue as second batchUpdate (after move confirming indices settled)
```

**Critical ordering constraint**: In Apps Script / Docs API, `insertText`/`insertParagraph` requests shift subsequent indices. A batchUpdate processes requests sequentially. When deleting source and inserting at target in the same batch:
- If target is before source in the document: **insert first, then delete** (deletion index shifts up by inserted length, must recalculate)
- If target is after source: **delete first, then insert** (insertion index shifts down by deleted length, must recalculate)

This is pre-computed before building the request array, not handled by the API.

### Operation: Rename Heading

```
requests:
  - replaceAllText (scoped to heading paragraph range):
      replaceText: newTitle
      matchCase: true
```

Simpler than `deleteContentRange` + `insertText` because it preserves the headingId.

### Operation: Promote / Demote

```
for each heading in subtree (including root):
  newLevel = clamp(heading.level + levelDelta, 1, 6)
  requests.push:
    - updateParagraphStyle:
        range: { startIndex, endIndex }
        paragraphStyle: { namedStyleType: "HEADING_" + newLevel }
        fields: "namedStyleType"
```

Issued as a single `batchUpdate`.

### Operation: Refresh Native TOC

After every sync, the native Google Docs TOC is refreshed:

```
1. Find the tableOfContents element in body.content
2. Delete it: deleteContentRange [tocIndex, tocIndex + 1]
3. Re-insert: insertTableOfContents { location: { index: tocIndex } }
4. Issue as single batchUpdate
```

If no native TOC exists in the document, this step is skipped.

### Operation: Document Text Numbering

Numbering is injected into heading text as a prefix:

```
1. Compute numbers from tree structure via NumberingService.compute()
2. For each heading:
   a. Derive clean title from stored baseTitles config
   b. Compute target = prefix + clean (e.g., "1.1  Background")
   c. Find heading in document via text + level matching
   d. Insert new prefix at paragraph start (preserves formatting)
   e. Delete old prefix (shifted right by new prefix length)
3. Process headings bottom-to-top to avoid index shifting
4. Store baseTitles in DocumentProperties for reliable stripping
```

The double-space separator (`  `) between prefix and title allows reliable detection and stripping on re-parse.

---

## Jump to Section

Each `TocNode` stores the element's `startIndex` from the document body. On click:

1. Client sends `{ nodeId, startIndex }` to server
2. Server calls `body.getChild(startIndex)` for O(1) direct access
3. Server calls `DocumentApp.setSelection()` to scroll to the heading
4. Fallback: if index is stale, re-resolve from ScriptCache by nodeId

No named ranges are created. The `startIndex` is refreshed on every sync.

---

## Cache Invalidation Strategy

```
Event                          → Cache action
────────────────────────────────────────────────
Sidebar opens                  → Read cache; if miss, re-parse and populate
User drag-drop executes        → Invalidate + re-parse
User rename executes           → Invalidate + re-parse
User promote/demote executes   → Invalidate + re-parse
Manual refresh triggered       → Invalidate + re-parse
```

Cache key: `"mo:tree:{documentId}"`
TTL: 6 hours (Apps Script CacheService maximum)
On cache miss: always re-parse from live document

---

## Error Handling

| Error condition | Behavior |
|---|---|
| Docs API quota exceeded | Show "Rate limit hit — try again in 30 seconds" |
| batchUpdate partial failure | Show "Move failed — document unchanged"; log response to console |
| headingId reconciliation ambiguous (>1 match) | Show "Could not restore label — please re-apply" |
| Section boundary calculation crosses document end | Clamp to `document.body.length - 1` |
| Move would create >H6 child | Block the drop; show "Cannot demote past Heading 6" |

---

## Auto-Sync Polling

The sidebar polls the server every 30 seconds to detect document changes made outside the sidebar:

```
setInterval(function() {
  if (document.hidden) return;  // skip if sidebar is minimized
  rpc('getTree', null).then(function(res) {
    var hash = hashNodes(res.nodes);
    if (hash !== lastHash) {
      // Tree changed — update state and re-render
      setState(res);
      lastHash = hash;
    }
    runValidation(res.nodes);
  });
}, 30000);
```

Polling stops when the sidebar loses focus or is minimized (`document.hidden` check). The tree hash is a simple string concatenation of node IDs + titles + levels — cheap to compute and compare. If the hash hasn't changed, no re-render occurs.
