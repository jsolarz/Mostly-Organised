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

    // Apply numbering to document heading text
    nodes = applyNumberingInDocument(nodes, config.numberingScheme);

    // Refresh native Google Docs TOC to reflect heading changes
    refreshToc();

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

  // ── Structure validation ───────────────────────────────────────────────────

  function validateStructure() {
    var tree = getTree();
    var nodes = tree.nodes;
    var errors = [];

    // Build parent lookup
    var byId = {};
    nodes.forEach(function (n) { byId[n.id] = n; });

    // E-02: Missing H1
    var hasH1 = nodes.some(function (n) { return n.level === 1; });
    if (!hasH1) {
      errors.push({ code: 'E-02', type: 'warning', message: 'Start with a Heading 1 to establish the top-level structure', nodeId: null });
    }

    // E-01: Skipped levels
    nodes.forEach(function (node) {
      if (!node.parentId || !byId[node.parentId]) return;
      var parent = byId[node.parentId];
      if (node.level - parent.level > 1) {
        errors.push({ code: 'E-01', type: 'error', message: 'H' + parent.level + ' "' + parent.title + '" is followed by H' + node.level + ' "' + node.title + '" — H' + (parent.level + 1) + ' is missing', nodeId: node.id });
      }
    });

    // E-04: Empty headings
    nodes.forEach(function (node) {
      if (!node.title || !node.title.trim()) {
        errors.push({ code: 'E-04', type: 'warning', message: 'Empty heading — delete it or add heading text', nodeId: node.id });
      }
    });

    return { errors: errors, computedAt: new Date().toISOString() };
  }

  // ── Document text numbering ────────────────────────────────────────────────

  function applyNumberingInDocument(nodes, scheme) {
    var config = StorageService.getConfig();
    var baseTitles = config.baseTitles || {};
    var numbers = NumberingService.compute(nodes, scheme);
    var docId = DocumentApp.getActiveDocument().getId();

    // Fetch document content to resolve character offsets by text matching
    var docData = Docs.Documents.get(docId, { fields: 'body.content' });
    var content = (docData.body && docData.body.content) || [];
    var restHeadings = [];
    content.forEach(function (el) {
      if (!el.paragraph) return;
      var para = el.paragraph;
      var style = para.paragraphStyle && para.paragraphStyle.namedStyleType;
      if (!style || style.indexOf('HEADING_') !== 0) return;
      var level = parseInt(style.replace('HEADING_', ''), 10);
      if (isNaN(level)) return;
      var text = '';
      (para.elements || []).forEach(function (te) {
        if (te.textRun) text += (te.textRun.content || '').replace(/\n$/, '');
      });
      restHeadings.push({ level: level, title: text, start: el.startIndex, end: el.endIndex });
    });

    var pending = []; // { nodeId, prefix, clean, range }

    nodes.forEach(function (node) {
      if (node.status === 'orphaned') return;
      var current = node.title;
      var storedBase = baseTitles[node.id];
      var num = numbers[node.id];

      // Derive clean title
      var clean;
      if (storedBase) {
        var expected = num ? num + '  ' + storedBase : storedBase;
        if (current === expected || current === storedBase) {
          clean = storedBase;
        } else {
          var dsi = current.indexOf('  ');
          clean = dsi > 0 ? current.substring(dsi + 2).trim() : current.trim();
        }
      } else {
        clean = current;
      }

      var prefix = num ? num + '  ' : '';
      var target = prefix + clean;
      if (target !== current) {
        // Find the matching heading in REST data by current text + level
        var matchedRange = null;
        for (var ri = 0; ri < restHeadings.length; ri++) {
          var rh = restHeadings[ri];
          if (rh.level === node.level && rh.title === current) {
            matchedRange = { start: rh.start, end: rh.end };
            restHeadings.splice(ri, 1); // consume it
            break;
          }
        }
        if (matchedRange) {
          pending.push({ nodeId: node.id, prefix: prefix, clean: clean, range: matchedRange, oldTitle: current });
        }
      }
      node.title = target;
      baseTitles[node.id] = clean;
    });

    if (pending.length > 0) {
      // Process bottom-to-top so insertions don't shift indices of earlier headings
      pending.sort(function (a, b) { return b.range.start - a.range.start; });

      var requests = [];
      pending.forEach(function (p) {
        var range = p.range;

        // Step 1: insert new prefix at paragraph start
        // Pushes existing content right, preserving formatting of all text runs
        if (p.prefix) {
          requests.push({
            insertText: { text: p.prefix, location: { index: range.start } }
          });
        }

        // Step 2: delete old prefix (now shifted right by new prefix length)
        var oldPrefixLen = p.oldTitle.length - p.clean.length;
        if (oldPrefixLen > 0) {
          var shift = p.prefix.length;
          var delStart = range.start + shift;
          var delEnd = Math.min(range.start + shift + oldPrefixLen, range.end - 1);
          if (delEnd > delStart) {
            requests.push({
              deleteContentRange: {
                range: { startIndex: delStart, endIndex: delEnd }
              }
            });
          }
        }
      });

      if (requests.length > 0) {
        Docs.Documents.batchUpdate({ requests: requests }, docId);
      }
    }

    config.baseTitles = baseTitles;
    StorageService.setConfig(config);
    return nodes;
  }

  // ── Refresh native Google Docs TOC ─────────────────────────────────────────

  function refreshToc() {
    try {
      var docId = DocumentApp.getActiveDocument().getId();
      var docData = Docs.Documents.get(docId, { fields: 'body.content' });
      var content = (docData.body && docData.body.content) || [];

      var tocIndex = -1;
      for (var i = 0; i < content.length; i++) {
        if (content[i].tableOfContents) {
          tocIndex = content[i].startIndex;
          break;
        }
      }

      if (tocIndex < 0) return; // no TOC in document

      Docs.Documents.batchUpdate({
        requests: [
          { deleteContentRange: { range: { startIndex: tocIndex, endIndex: tocIndex + 1 } } },
          { insertTableOfContents: { location: { index: tocIndex } } }
        ]
      }, docId);
    } catch (e) {
      Logger.log('mostly-organised: refreshToc failed — ' + e.message);
    }
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
    invalidateAndResync: invalidateAndResync,
    validateStructure: validateStructure,
    applyNumberingInDocument: applyNumberingInDocument,
    refreshToc: refreshToc
  };
})();
