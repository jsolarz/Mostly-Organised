# Mostly Organised

> *"The Table of Contents was, technically, a list. It was the kind of list that gives other lists a bad name."*

A Google Docs add-on for people who write long documents and would like them to be,
on balance, mostly organised.

---

## The Problem

Google Docs has a Table of Contents feature. It shows you your headings. You can click them.
That is, in its entirety, what it does.

You cannot reorder sections. You cannot number them in any way that survives editing.
You cannot promote a Heading 2 to a Heading 1 without selecting it, opening the paragraph
style menu, and wondering, briefly, if there's a better career available somewhere.

The one third-party add-on that solved this was discontinued. It is gone. We do not speak
of why. We simply build a replacement.

---

## What It Does

Mostly Organised adds a sidebar to Google Docs that treats your Table of Contents as
something you can actually *work with*.

**Reorder sections by dragging them.** When you move a node in the tree, the actual
document content — the heading and everything beneath it until the next section of equal
rank — moves with it. One drag. One undo step.

**Number sections without touching the document.** Choose a numbering scheme
(`1.1.1`, `I.A.1`, or `A.1.a`) and the sidebar shows your sections numbered. The document
headings are not modified. When you reorder, the numbers update. The document remains
clean for collaborators who have not installed the add-on and would find `1.2.3 Overview`
somewhat alarming.

**Promote and demote headings.** Right-click a node and promote it from H2 to H1, or
demote it. Child headings cascade accordingly. The entire subtree updates in a single
operation that can be undone with Ctrl+Z.

**Rename headings from the sidebar.** Double-click a label, type the new name, press Enter.
The heading in the document changes. You do not have to find it first.

**Detect when things have drifted.** If you (or a collaborator) rename a heading directly
in the document while the sidebar is open, it will notice. It will show you a small warning.
It will offer you a sensible choice. It will not silently decide on your behalf.

**Exclude headings from the TOC.** Some headings are structural placeholders. They do not
need to appear in your Table of Contents and they do not need to affect your numbering.
You can tell the add-on this. It will remember.

---

## Installation

1. Open any Google Doc
2. **Extensions → Add-ons → Get add-ons**
3. Search for *Mostly Organised*
4. Install, grant permissions, proceed

The add-on will appear under **Extensions → Mostly Organised → Open TOC panel**.

---

## Local Development

You will need [Node.js](https://nodejs.org) and a Google account.

```bash
# Clone and install
git clone https://github.com/your-org/mostly-organised
cd mostly-organised
npm install

# Authenticate with Google
npx clasp login

# Create a new Apps Script project
# Go to script.google.com → New project
# Copy the script ID from the URL and paste it into .clasp.json
# Then enable the Docs Advanced Service in the Apps Script editor:
# Services → Google Docs API → Add

# Build and push
npm run push
```

Open a Google Doc. Under **Extensions**, you will find the add-on. If you do not find it,
refresh the page. If you still do not find it, run `onOpen` manually from the Apps Script
editor once to trigger the OAuth consent screen.

### Development loop

```bash
# Edit src/*.js and src/sidebar.html
npm run push   # build → dist/ then clasp push
# Refresh the Google Doc (F5)
# Reopen the sidebar
# Repeat
```

### Testing the sidebar UI without Apps Script

Serve the sidebar locally with a mock `google.script.run`:

```bash
cd src
python3 -m http.server 8080
# Open http://localhost:8080/sidebar.html
```

Add the following before the Preact script to mock the server responses:

```html
<script>
window.google = {
  script: {
    run: new Proxy({}, {
      get: function(_, fn) {
        return {
          withSuccessHandler: function(cb) {
            return { withFailureHandler: function() { return this; },
              [fn]: function(p) { cb(MOCK[fn] || {}); } };
          }
        };
      }
    }),
    host: { editor: { focus: function() {} } }
  }
};
var MOCK = {
  getTree: {
    nodes: [
      { id:'h1', parentId:null, level:1, order:0, title:'Introduction',
        status:'active', isExpanded:true, isExcluded:false, syncedTitle:'Introduction' },
      { id:'h2', parentId:'h1', level:2, order:0, title:'Overview',
        status:'active', isExpanded:true, isExcluded:false, syncedTitle:'Overview' },
      { id:'h3', parentId:null, level:1, order:1, title:'Architecture',
        status:'stale', isExpanded:true, isExcluded:false, syncedTitle:'Old Architecture Title' }
    ],
    config: { numberingScheme:'numeric' },
    syncedAt: new Date().toISOString()
  }
};
</script>
```

---

## How It Works

The add-on is a Google Apps Script **Editor Add-on** — no external server, no database,
no subscription, no data leaving Google's infrastructure. Your document stays in Google.
Your preferences stay in the document's own properties storage.

The sidebar is an HTML page served by Apps Script's `HtmlService`, rendered in an iframe
inside the Google Docs sidebar. It communicates with the Apps Script backend via
`google.script.run`, which is the approved and somewhat baroque method for doing so.

Document mutations — moving sections, changing heading levels, renaming headings — are
issued as single `batchUpdate` API calls. This matters because each separate API call creates
a separate entry in Google Docs' undo history. A single `batchUpdate` means a single Ctrl+Z.

Section numbering is computed entirely in the sidebar and never written to the document.

---

## Project Structure

```
src/
  Code.js          Entry points: onOpen, showSidebar, server-side RPC functions
  sync.js          Parse document headings → TOC tree; stale/orphan detection
  mutations.js     All document writes: move, rename, promote/demote, exclude
  storage.js       DocumentProperties, UserProperties, ScriptCache wrappers
  numbering.js     Compute display-only section numbers from tree structure
  sidebar.html     The sidebar UI (Preact, inlined; drag-drop, all interactions)

docs/
  requirements/prd.md          What it does and why
  architecture/system-design.md   Component map and data flows
  architecture/data-model.md      TocNode schema and storage strategy
  architecture/sync-engine.md     The hard part: parsing, reconciling, mutating
  architecture/adrs.md            Architecture decisions and the reasoning behind them
  design/ux-design.md             Sidebar layout, states, interactions

appsscript.json    Apps Script manifest (scopes, advanced services)
package.json       Dev tooling (clasp, eslint)
.clasp.json        Script ID — fill in yours before pushing
```

---

## Constraints Worth Knowing

**No real-time sync.** Apps Script cannot push updates to the sidebar unprompted.
The tree refreshes when you open the sidebar, after any action you take, or when you
click the refresh button. If a colleague is editing the document simultaneously, their
changes will appear on the next refresh.

**Mobile is not supported.** Google Docs on mobile does not render add-on sidebars.
The document is unchanged; the sidebar simply does not appear.

**The document must have headings.** The add-on reads paragraph styles. Text that looks
like a heading but is formatted as Normal text with large font will not be detected.
Apply Heading 1 through Heading 6 styles using the paragraph style menu.

**After a section move, heading IDs change.** Google Docs assigns internal IDs to heading
paragraphs. When content is deleted and reinserted (as section moves require), those IDs
reset. The add-on handles this with a title-based reconciliation pass. If you have two
sections with identical titles at the same level, label overrides may need to be
reapplied after a move involving those sections.

---

## License

MIT. Use it, modify it, ship it. If you make it significantly better, consider contributing
back, though no one will be unreasonably upset if you don't.

---

*Mostly Organised. Your document is not fully organised. It is mostly organised.*
*This is, under the circumstances, considered an achievement.*
