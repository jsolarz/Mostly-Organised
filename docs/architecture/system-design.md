---
type: architecture
title: "Mostly Organised — System Design"
description: "End-to-end architecture of the Mostly Organised add-on: component map, layer responsibilities, data flow, and deployment model."
status: active
audience: all
tags: [gtoc, architecture, system-design, apps-script]
timestamp: 2026-06-17T00:00:00Z
---

# Mostly Organised — System Design

## Component Map

```
┌─────────────────────────────────────────────────────────────────────┐
│  Google Docs (browser)                                               │
│                                                                      │
│  ┌─────────────────────────────────┐  ┌─────────────────────────┐   │
│  │         Document Canvas         │  │     Sidebar (HTML App)  │   │
│  │                                 │  │                         │   │
│  │  H1 Introduction                │  │  ▼ 1 Introduction       │   │
│  │    H2 Overview                  │  │    ▶ 1.1 Overview       │   │
│  │    H2 Scope                 ◄───┼──┼──   1.2 Scope           │   │
│  │  H1 Architecture            ───►│  │  ▼ 2 Architecture       │   │
│  │    H2 Components                │  │    ▼ 2.1 Components     │   │
│  │      H3 API Layer               │  │       2.1.1 API Layer   │   │
│  │                                 │  │       2.1.2 Data Layer  │   │
│  └─────────────────────────────────┘  └────────────┬────────────┘   │
│                                                     │ google.script  │
│                                                     │ .run.*(...)    │
└─────────────────────────────────────────────────────┼───────────────┘
                                                       │
                              ┌────────────────────────▼──────────────────────┐
                              │  Apps Script Server (V8)                       │
                              │                                                │
                              │  ┌─────────────┐  ┌──────────────────────┐   │
                              │  │  Sync Engine │  │  Mutation Executor   │   │
                              │  │  parse()     │  │  moveSection()       │   │
                              │  │  reconcile() │  │  renameHeading()     │   │
                              │  │  diff()      │  │  promoteHeading()    │   │
                              │  └──────┬───────┘  └────────┬─────────────┘   │
                              │         │                    │                 │
                              │  ┌──────▼────────────────────▼─────────────┐  │
                              │  │             Storage Layer                 │  │
                              │  │  ScriptCache  DocumentProperties         │  │
                              │  │  UserProperties                          │  │
                              │  └──────────────────────────────────────────┘  │
                              │                        │                       │
                              └────────────────────────┼───────────────────────┘
                                                        │
                              ┌─────────────────────────▼─────────────────────┐
                              │  Google APIs                                    │
                              │  Docs API v1 (batchUpdate, get)                │
                              │  DocumentApp (Apps Script native)              │
                              └───────────────────────────────────────────────┘
```

---

## Layers

### 1. Sidebar (Client — HTML Service)

A single HTML page served by Apps Script's `HtmlService`. Runs in an iframe inside the Google Docs sidebar.

**Responsibilities:**
- Render the TOC tree (vanilla JS or Preact — see ADR-003)
- Handle drag-and-drop interactions
- Call server functions via `google.script.run`
- Show sync status, stale/orphan indicators, numbering
- Store no state beyond render state; always fetch from server on open

**Communication pattern:**
```javascript
// All calls are async callbacks; there is no promise API in Apps Script
google.script.run
  .withSuccessHandler(onTreeLoaded)
  .withFailureHandler(onError)
  .getTree();
```

**Why no framework?**
The sidebar is served from Apps Script's CDN with strict CSP. No external CDN imports. Either bundle or use no-dependency code. Preact (~3 KB) can be inlined. React cannot be practically bundled within the 500 KB script size limit.

### 2. Server (Apps Script — Code.gs et al.)

Runs in Google's V8 environment. All functions callable from the sidebar are declared globally.

**Module structure:**
```
Code.gs           — entry points: onOpen(), doGet(), menu registration
sync.gs           — SyncEngine: parse(), reconcile(), getTree()
mutations.gs      — MutationExecutor: moveSection(), renameHeading(), promoteHeading()
storage.gs        — StorageService: read/write DocumentProperties, UserProperties, ScriptCache
numbering.gs      — NumberingService: compute display numbers for a tree
```

**Execution model:**
- Each `google.script.run` call spawns a new isolated execution context
- No shared in-memory state between calls
- All state must be persisted to Storage between calls

### 3. Storage Layer

| Store | API | Scope | Size limit | Use |
|---|---|---|---|---|
| ScriptCache | `CacheService.getScriptCache()` | All users of script | 500 KB/entry, 6h TTL | Parsed TocNode tree |
| DocumentProperties | `PropertiesService.getDocumentProperties()` | All editors of doc | 9 KB/key, 500 KB total | TocDocument config (excludes, overrides, scheme) |
| UserProperties | `PropertiesService.getUserProperties()` | Current user | 9 KB/key, 500 KB total | TocUserPreferences (expand state, panel width) |

### 4. Google APIs

Two access modes used in parallel:

| Mode | When | Why |
|---|---|---|
| `DocumentApp` (native) | Reading document structure | Simpler object model for traversal |
| `Docs.Documents.batchUpdate()` | Writing mutations | Only way to batch multiple operations atomically |

The Docs REST API (`Docs.Documents.get()`) is used for reading when character indices are needed, since `DocumentApp` abstracts them away.

---

## Data Flow: Initial Load

```
User opens sidebar
       │
       ▼
onOpen() → showSidebar() → serve index.html
       │
       ▼ (sidebar renders skeleton, then calls:)
google.script.run.getTree()
       │
       ▼ (server)
StorageService.getCache("mo:tree:{docId}")
       │
       ├─ HIT ──► return cached TocNode[]
       │
       └─ MISS ──► SyncEngine.parse()
                       │
                       ▼
                   Docs.Documents.get(docId)
                   → extract headings
                   → build TocNode[]
                   → reconcile with DocumentProperties
                   → StorageService.setCache(...)
                   → return TocNode[]
       │
       ▼ (sidebar)
render tree with numbering from NumberingService (client-side)
```

---

## Data Flow: Section Move

```
User drops node A before node B
       │
       ▼ (sidebar)
google.script.run.moveSection({
  sourceId: "sec-001",
  targetId: "sec-003",
  position: "before"
})
       │
       ▼ (server)
SyncEngine.getTree()   // fresh tree with current startIndex/endIndex
       │
       ▼
MutationExecutor.moveSection(sourceNode, targetNode, "before")
       │
       ├─ compute insertion index
       ├─ build batchUpdate requests
       │     [insertContentRequests, deleteContentRangeRequest]
       │
       ▼
Docs.Documents.batchUpdate(docId, { requests })
       │
       ├─ SUCCESS ──► StorageService.invalidateCache(docId)
       │              SyncEngine.parse()   // re-parse with new headingIds
       │              reconcile overrides  // reattach by title proximity
       │              return fresh TocNode[]
       │
       └─ FAILURE ──► return { error: "Move failed", detail: response }
       │
       ▼ (sidebar)
Re-render tree (success) OR show error toast (failure)
```

---

## Deployment Model

```
Developer machine
  └── clasp push → Apps Script project
                      │
                      ├── Head deployment (development)
                      └── Versioned deployment → Google Workspace Marketplace
```

**Tools:**
- `clasp` (Google's CLI) for local development and push
- Apps Script project linked to a manifest (`appsscript.json`)
- Marketplace listing requires a GCP project with the Docs API enabled and OAuth consent screen configured

**OAuth scopes (minimum viable):**
```json
{
  "oauthScopes": [
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/drive.file"
  ]
}
```

`documents` scope: read and write the active document.
`drive.file`: access files the user opened with this add-on (required for Workspace Add-on manifest compliance; does not grant broad Drive access).

---

## Key Design Constraints and Mitigations

| Constraint | Mitigation |
|---|---|
| No persistent server — Apps Script is stateless between calls | ScriptCache + Properties service as state layer |
| No real-time push from server to sidebar | Pull-on-demand; manual refresh button always available |
| batchUpdate indices are order-sensitive | Pre-compute request order before building request array (see sync-engine.md) |
| headingIds reset after paragraph delete/insert | Post-move reconciliation by title + position proximity |
| DocumentProperties 500 KB total limit | Store only IDs and overrides, never full node objects |
| Sidebar iframe CSP blocks external CDN | Inline or bundle all JS; no unpkg/CDN imports |
| 6-minute Apps Script execution timeout | Section moves on large documents must complete in <6 min; for very large docs, warn before executing |
