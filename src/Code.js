// Entry points: Editor Add-on (container-bound Apps Script)

function onOpen(e) {
  DocumentApp.getUi()
    .createMenu('Mostly Organised')
    .addItem('Open TOC panel', 'showSidebar')
    .addToUi();
}

// onInstall fires when the add-on is installed from the Marketplace;
// onOpen does not fire in that case, so we call it explicitly.
function onInstall(e) {
  onOpen(e);
}

function showSidebar() {
  var html = HtmlService.createHtmlOutputFromFile('sidebar')
    .setTitle('Mostly Organised')
    .setWidth(300);
  DocumentApp.getUi().showSidebar(html);
}

// --- Server functions called from sidebar via google.script.run ---

function getTree() {
  return SyncEngine.getTree();
}

function moveSection(params) {
  return MutationExecutor.moveSection(params.sourceId, params.targetId, params.position);
}

function renameHeading(params) {
  return MutationExecutor.renameHeading(params.nodeId, params.newTitle);
}

function setLabelOverride(params) {
  return MutationExecutor.setLabelOverride(params.nodeId, params.label);
}

function changeHeadingLevel(params) {
  return MutationExecutor.changeHeadingLevel(params.nodeId, params.delta);
}

function setExcluded(params) {
  return MutationExecutor.setExcluded(params.nodeId, params.excluded);
}

function saveNumberingScheme(params) {
  return StorageService.setNumberingScheme(params.scheme);
}

function saveUserPrefs(params) {
  return StorageService.setUserPrefs(params.prefs);
}

function resolveStale(params) {
  return MutationExecutor.resolveStale(params.nodeId, params.resolution);
}

function removeOrphan(params) {
  return MutationExecutor.removeOrphan(params.nodeId);
}

function forceSync() {
  StorageService.invalidateTreeCache();
  return SyncEngine.getTree();
}

function validateStructure() {
  return SyncEngine.validateStructure();
}

function jumpToSection(params) {
  // Move the document cursor to the target heading paragraph.
  // Uses startIndex for O(1) direct access — avoids parsing the entire document.
  // DocumentApp.setSelection() is only available server-side; calling this
  // from the sidebar via google.script.run triggers a scroll in the editor.
  if (!params || !params.nodeId) return { ok: false };

  try {
    var doc = DocumentApp.getActiveDocument();
    var body = doc.getBody();
    var idx = params.startIndex;

    // Direct access via cached index (fast path)
    if (idx != null && idx >= 0 && idx < body.getNumChildren()) {
      var el = body.getChild(idx);
      if (el.getType() === DocumentApp.ElementType.PARAGRAPH) {
        var para = el.asParagraph();
        var rangeBuilder = doc.newRange();
        rangeBuilder.addElement(para);
        doc.setSelection(rangeBuilder.build());
        return { ok: true };
      }
    }

    // Fallback: look up node from cache and walk by title
    var cached = StorageService.getTreeCache();
    if (cached) {
      for (var i = 0; i < cached.length; i++) {
        if (cached[i].id === params.nodeId) {
          var fallbackIdx = cached[i].startIndex;
          if (fallbackIdx != null && fallbackIdx >= 0 && fallbackIdx < body.getNumChildren()) {
            var fel = body.getChild(fallbackIdx);
            if (fel.getType() === DocumentApp.ElementType.PARAGRAPH) {
              var fpara = fel.asParagraph();
              var frb = doc.newRange();
              frb.addElement(fpara);
              doc.setSelection(frb.build());
              return { ok: true };
            }
          }
          break;
        }
      }
    }

    return { ok: false };
  } catch (e) {
    Logger.log('mostly-organised: jumpToSection failed — ' + e.message);
    return { ok: false };
  }
}
