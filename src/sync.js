// SyncEngine — parse, reconcile, and serve the TOC tree

var SyncEngine = (function () {

  // ── Heading level from DocumentApp enum ───────────────────────────────────
  // Using explicit comparison because enum-as-object-key is unreliable in V8.

  function _getHeadingLevel(para) {
    var h = para.getHeading();
    var ph = DocumentApp.ParagraphHeading;
    if (h === ph.HEADING1) return 1;
    if (h === ph.HEADING2) return 2;
    if (h === ph.HEADING3) return 3;
    if (h === ph.HEADING4) return 4;
    if (h === ph.HEADING5) return 5;
    if (h === ph.HEADING6) return 6;
    return 0;
  }

  // ── Fetch headingIds from the Docs REST API ────────────────────────────────
  // DocumentApp does not expose headingId. Only the REST API does.
  // Returns: Map of "title::level" → headingId

  function _fetchHeadingIds(docId) {
    var map = {};
    try {
      var docData = Docs.Documents.get(docId, { fields: 'body.content' });
      var content = (docData.body && docData.body.content) || [];
      content.forEach(function (element) {
        if (!element.paragraph) return;
        var para = element.paragraph;
        var style = para.paragraphStyle && para.paragraphStyle.namedStyleType;
        if (!style || style.indexOf('HEADING_') !== 0) return;
        var level = parseInt(style.replace('HEADING_', ''), 10);
        if (isNaN(level)) return;
        var headingId = para.paragraphStyle.headingId;
        if (!headingId) return;
        var text = _extractRestText(para);
        var key = text + '::' + level;
        // First match wins; duplicate title+level headings get only the first headingId
        if (!map[key]) map[key] = headingId;
      });
    } catch (e) {
      Logger.log('mostly-organised: could not fetch headingIds — ' + e.message);
    }
    return map;
  }

  function _extractRestText(para) {
    var text = '';
    (para.elements || []).forEach(function (el) {
      if (el.textRun) text += (el.textRun.content || '').replace(/\n$/, '');
    });
    return text;
  }

  // ── Parse ──────────────────────────────────────────────────────────────────

  function parse() {
    var doc = DocumentApp.getActiveDocument();
    var docId = doc.getId();
    var body = doc.getBody();
    var numChildren = body.getNumChildren();

    // Get headingIds from REST API (one call up front)
    var headingIdMap = _fetchHeadingIds(docId);

    var raw = [];

    for (var i = 0; i < numChildren; i++) {
      var el = body.getChild(i);
      if (el.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;

      var para = el.asParagraph();
      var level = _getHeadingLevel(para);
      if (!level) continue;

      var title = para.getText();
      var headingId = headingIdMap[title + '::' + level] || null;
      // Stable ID: headingId preferred; fallback is title+level (position-free)
      var stableId = headingId || _slugify(title + '-h' + level);

      raw.push({
        stableId: stableId,
        headingId: headingId,
        title: title,
        level: level,
        elementIndex: i
      });
    }

    // Compute section end indices (element-index based)
    for (var j = 0; j < raw.length; j++) {
      raw[j].startIndex = raw[j].elementIndex;
      raw[j].endIndex = _computeSectionEndIndex(raw, j, numChildren - 1);
    }

    return _buildTree(raw, docId);
  }

  function _computeSectionEndIndex(raw, idx, docLastIndex) {
    var level = raw[idx].level;
    for (var k = idx + 1; k < raw.length; k++) {
      if (raw[k].level <= level) {
        return raw[k].elementIndex - 1;
      }
    }
    return docLastIndex;
  }

  function _buildTree(raw, docId) {
    var nodes = [];
    var stack = []; // ancestry stack { stableId, level }

    for (var i = 0; i < raw.length; i++) {
      var r = raw[i];

      while (stack.length > 0 && stack[stack.length - 1].level >= r.level) {
        stack.pop();
      }

      var parentId = stack.length > 0 ? stack[stack.length - 1].stableId : null;

      nodes.push({
        id: r.stableId,
        headingId: r.headingId,
        documentId: docId,
        parentId: parentId,
        level: r.level,
        order: i,
        title: r.title,
        labelOverride: null,
        startIndex: r.startIndex,
        endIndex: r.endIndex,
        namedRangeId: null,
        isExcluded: false,
        isExpanded: true,
        syncedTitle: r.title,
        status: 'active'
      });

      stack.push({ stableId: r.stableId, level: r.level });
    }

    _assignSiblingOrder(nodes);
    return nodes;
  }

  function _assignSiblingOrder(nodes) {
    var counts = {};
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].parentId || '__root__';
      if (counts[key] === undefined) counts[key] = 0;
      nodes[i].order = counts[key]++;
    }
  }

  // ── Reconcile ─────────────────────────────────────────────────────────────

  function reconcile(freshNodes, config, userPrefs) {
    var overrides = config.labelOverrides || {};
    var excluded = config.excludedHeadingIds || [];
    var expandedSet = {};
    (userPrefs.expandedNodeIds || []).forEach(function (id) { expandedSet[id] = true; });

    freshNodes.forEach(function (node) {
      node.labelOverride = overrides[node.headingId] || overrides[node.id] || null;

      node.isExcluded = excluded.indexOf(node.headingId) !== -1 ||
        excluded.indexOf(node.id) !== -1;
      if (node.isExcluded) node.status = 'excluded';

      // Preserve stored expand state; default open
      node.isExpanded = expandedSet.hasOwnProperty(node.id)
        ? expandedSet[node.id]
        : true;
    });

    return freshNodes;
  }

  // ── Stale / Orphan detection ───────────────────────────────────────────────

  function detectDrift(freshNodes, cachedNodes) {
    if (!cachedNodes || cachedNodes.length === 0) return freshNodes;

    var cachedById = {};
    cachedNodes.forEach(function (n) { cachedById[n.id] = n; });

    var freshIds = {};
    freshNodes.forEach(function (n) { freshIds[n.id] = true; });

    // Stale: same id exists but title changed since last sync
    freshNodes.forEach(function (node) {
      var cached = cachedById[node.id];
      if (cached && cached.syncedTitle && node.title !== cached.syncedTitle) {
        if (node.status === 'active') node.status = 'stale';
        node.syncedTitle = cached.syncedTitle;
      }
    });

    // Orphaned: was in cache but no longer in document
    // Carry forward regardless of prior orphan status so they persist until dismissed
    cachedNodes.forEach(function (cached) {
      if (freshIds[cached.id]) return;
      var orphan = JSON.parse(JSON.stringify(cached));
      orphan.status = 'orphaned';
      freshNodes.push(orphan);
    });

    return freshNodes;
  }

  // ── Main entry point ──────────────────────────────────────────────────────

  function getTree() {
    var cached = StorageService.getTreeCache();
    var config = StorageService.getConfig();
    var userPrefs = StorageService.getUserPrefs();

    var freshNodes = parse();
    reconcile(freshNodes, config, userPrefs);
    var nodes = detectDrift(freshNodes, cached);

    StorageService.setTreeCache(nodes);
    StorageService.touchLastSynced();

    return {
      nodes: nodes,
      config: config,
      userPrefs: userPrefs,
      syncedAt: new Date().toISOString()
    };
  }

  function invalidateAndResync() {
    StorageService.invalidateTreeCache();
    return getTree();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function _slugify(text) {
    return (text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  }

  return {
    parse: parse,
    reconcile: reconcile,
    detectDrift: detectDrift,
    getTree: getTree,
    invalidateAndResync: invalidateAndResync
  };
})();
