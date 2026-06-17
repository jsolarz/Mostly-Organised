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

function jumpToSection(params) {
  // Move the document cursor to the target heading paragraph.
  // DocumentApp.setSelection() is only available server-side; calling this
  // from the sidebar via google.script.run triggers a scroll in the editor.
  var treeResult = SyncEngine.getTree();
  var node = null;
  for (var i = 0; i < treeResult.nodes.length; i++) {
    if (treeResult.nodes[i].id === params.nodeId) { node = treeResult.nodes[i]; break; }
  }
  if (!node || node.status === 'orphaned') return { ok: false };

  try {
    var doc = DocumentApp.getActiveDocument();
    var body = doc.getBody();
    // Walk body children to find the heading paragraph matching this node
    var numChildren = body.getNumChildren();
    for (var j = 0; j < numChildren; j++) {
      var el = body.getChild(j);
      if (el.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
      var para = el.asParagraph();
      if (para.getText() === node.title) {
        var rangeBuilder = doc.newRange();
        rangeBuilder.addElement(para);
        doc.setSelection(rangeBuilder.build());
        return { ok: true };
      }
    }
  } catch (e) {
    Logger.log('mostly-organised: jumpToSection failed — ' + e.message);
  }
  return { ok: false };
}
