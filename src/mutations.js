// MutationExecutor — all document write operations via batchUpdate

var MutationExecutor = (function () {

  // Apps Script uses 'HEADING_1' etc; Docs REST API uses 'HEADING_1' as namedStyleType
  var HEADING_STYLES = [null, 'HEADING_1', 'HEADING_2', 'HEADING_3', 'HEADING_4', 'HEADING_5', 'HEADING_6'];

  function _docId() {
    return DocumentApp.getActiveDocument().getId();
  }

  // ── Character offset resolution ────────────────────────────────────────────
  // Returns { nodeId: { start, end, sectionEnd } } where:
  //   start/end = the heading paragraph's own character range
  //   sectionEnd = character index where this section ends (start of next peer/ancestor, or doc end)

  function _resolveOffsets(docData, nodes) {
    var offsets = {};
    var content = (docData.body && docData.body.content) || [];

    // Build flat list of heading elements from REST response with char positions
    var restHeadings = [];
    content.forEach(function (element) {
      if (!element.paragraph) return;
      var para = element.paragraph;
      var style = para.paragraphStyle && para.paragraphStyle.namedStyleType;
      if (!style || style.indexOf('HEADING_') !== 0) return;
      var level = parseInt(style.replace('HEADING_', ''), 10);
      if (isNaN(level)) return;
      var text = '';
      (para.elements || []).forEach(function (el) {
        if (el.textRun) text += (el.textRun.content || '').replace(/\n$/, '');
      });
      restHeadings.push({ level: level, title: text, start: element.startIndex, end: element.endIndex });
    });

    // Match TocNodes → REST headings by (title, level), first-come-first-served
    var usedIdx = {};
    var activeNodes = nodes.filter(function (n) { return n.status !== 'orphaned'; });

    // Pass 1: exact title + level match
    activeNodes.forEach(function (node) {
      for (var i = 0; i < restHeadings.length; i++) {
        if (usedIdx[i]) continue;
        var rh = restHeadings[i];
        if (rh.level === node.level && rh.title === node.title) {
          offsets[node.id] = { start: rh.start, end: rh.end };
          usedIdx[i] = true;
          return;
        }
      }
    });

    // Pass 2: title-only match (drift handling)
    activeNodes.forEach(function (node) {
      if (offsets[node.id]) return;
      for (var i = 0; i < restHeadings.length; i++) {
        if (usedIdx[i]) continue;
        if (restHeadings[i].title === node.title) {
          offsets[node.id] = { start: restHeadings[i].start, end: restHeadings[i].end };
          usedIdx[i] = true;
          return;
        }
      }
    });

    // Compute sectionEnd for each matched node
    // Sort matched nodes by start position
    var sorted = activeNodes.filter(function (n) { return offsets[n.id]; })
      .sort(function (a, b) { return offsets[a.id].start - offsets[b.id].start; });

    // Doc end = endIndex of last content element
    var docEnd = content.length > 0 ? content[content.length - 1].endIndex : 1;

    sorted.forEach(function (node, idx) {
      var nodeLevel = node.level;
      var sectionEnd = docEnd;
      for (var j = idx + 1; j < sorted.length; j++) {
        if (sorted[j].level <= nodeLevel) {
          sectionEnd = offsets[sorted[j].id].start;
          break;
        }
      }
      offsets[node.id].sectionEnd = sectionEnd;
    });

    return offsets;
  }

  // ── Section Move ───────────────────────────────────────────────────────────

  function moveSection(sourceId, targetId, position) {
    var treeResult = SyncEngine.getTree();
    var nodes = treeResult.nodes;

    var source = _findNode(nodes, sourceId);
    var target = _findNode(nodes, targetId);

    if (!source) return { ok: false, error: 'Source node not found' };
    if (!target) return { ok: false, error: 'Target node not found' };
    if (source.id === target.id) return { ok: false, error: 'Cannot move onto itself' };
    if (_isDescendant(nodes, target.id, source.id)) {
      return { ok: false, error: 'Cannot move a section into its own descendant' };
    }

    var levelDelta = (position === 'child') ? (target.level + 1 - source.level) : 0;
    if (!_validateLevelCascade(nodes, source, levelDelta)) {
      return { ok: false, error: 'Move would demote a heading past Heading 6' };
    }

    var docId = _docId();
    var docData = Docs.Documents.get(docId, { fields: 'body.content' });
    var offsets = _resolveOffsets(docData, nodes);

    if (!offsets[source.id]) return { ok: false, error: 'Could not locate source in document — try re-syncing' };
    if (!offsets[target.id]) return { ok: false, error: 'Could not locate target in document — try re-syncing' };

    var srcStart = offsets[source.id].start;
    var srcEnd = offsets[source.id].sectionEnd; // exclusive; end of the full section block

    var insertAt = _computeInsertionPoint(offsets, nodes, target, position);

    // Collect paragraphs in source range from docData
    var content = (docData.body && docData.body.content) || [];
    var srcParagraphs = content.filter(function (el) {
      return el.startIndex >= srcStart && el.endIndex <= srcEnd;
    });

    if (srcParagraphs.length === 0) {
      return { ok: false, error: 'Source section is empty or could not be read' };
    }

    // Build requests: insert copy at target, delete original
    // Ordering rule:
    //   insertAt <= srcStart → INSERT first, then delete at shifted indices
    //   insertAt >  srcStart → DELETE first, then insert at shifted indices
    var requests = [];

    if (insertAt <= srcStart) {
      // Insert before source: indices shift after insertion
      _buildInsertRequests(srcParagraphs, insertAt, requests);
      var shift = srcEnd - srcStart;
      requests.push({
        deleteContentRange: {
          range: { startIndex: srcStart + shift, endIndex: srcEnd + shift }
        }
      });
    } else {
      // Insert after source: delete first, insertion index shifts back
      requests.push({
        deleteContentRange: {
          range: { startIndex: srcStart, endIndex: srcEnd }
        }
      });
      var shiftedInsert = insertAt - (srcEnd - srcStart);
      _buildInsertRequests(srcParagraphs, shiftedInsert, requests);
    }

    try {
      Docs.Documents.batchUpdate({ requests: requests }, docId);
    } catch (e) {
      return { ok: false, error: 'Move failed: ' + e.message };
    }

    // Level cascade: second batchUpdate if heading levels need adjustment
    if (levelDelta !== 0) {
      _applyLevelCascade(docId, nodes, source, levelDelta);
    }

    return SyncEngine.invalidateAndResync();
  }

  function _computeInsertionPoint(offsets, nodes, target, position) {
    if (position === 'before') {
      return offsets[target.id].start;
    }
    if (position === 'after') {
      return offsets[target.id].sectionEnd;
    }
    // 'child': insert after target's last child's sectionEnd, or after target heading if no children
    var children = nodes.filter(function (n) {
      return n.parentId === target.id && n.status !== 'orphaned' && offsets[n.id];
    }).sort(function (a, b) { return offsets[a.id].start - offsets[b.id].start; });

    if (children.length === 0) return offsets[target.id].end; // right after heading paragraph
    var lastChild = children[children.length - 1];
    return offsets[lastChild.id].sectionEnd;
  }

  // Build insertText + updateParagraphStyle + updateTextStyle requests for a block of paragraphs.
  // Inserts them at insertAt in REVERSE order so each insert at the same index prepends correctly.
  function _buildInsertRequests(paragraphs, insertAt, requests) {
    for (var i = paragraphs.length - 1; i >= 0; i--) {
      var el = paragraphs[i];
      if (!el.paragraph) continue;
      var para = el.paragraph;
      var text = '';
      (para.elements || []).forEach(function (e) {
        if (e.textRun) text += (e.textRun.content || '').replace(/\n$/, '');
      });

      // insertText preserves the newline terminator that Docs requires
      requests.push({
        insertText: {
          text: text + '\n',
          location: { index: insertAt }
        }
      });

      var style = para.paragraphStyle && para.paragraphStyle.namedStyleType;
      if (style) {
        requests.push({
          updateParagraphStyle: {
            range: { startIndex: insertAt, endIndex: insertAt + text.length + 1 },
            paragraphStyle: { namedStyleType: style },
            fields: 'namedStyleType'
          }
        });
      }

      // Preserve inline text styles
      var cursor = insertAt;
      (para.elements || []).forEach(function (e) {
        if (!e.textRun) return;
        var runText = (e.textRun.content || '').replace(/\n$/, '');
        var ts = e.textRun.textStyle;
        if (ts && runText) {
          var fields = [];
          var styleObj = {};
          if (ts.bold !== undefined)          { styleObj.bold = ts.bold;                   fields.push('bold'); }
          if (ts.italic !== undefined)         { styleObj.italic = ts.italic;               fields.push('italic'); }
          if (ts.underline !== undefined)      { styleObj.underline = ts.underline;         fields.push('underline'); }
          if (ts.strikethrough !== undefined)  { styleObj.strikethrough = ts.strikethrough; fields.push('strikethrough'); }
          if (ts.link)                         { styleObj.link = ts.link;                   fields.push('link'); }
          if (fields.length > 0) {
            requests.push({
              updateTextStyle: {
                range: { startIndex: cursor, endIndex: cursor + runText.length },
                textStyle: styleObj,
                fields: fields.join(',')
              }
            });
          }
        }
        cursor += runText.length;
      });
    }
  }

  // ── Rename Heading ────────────────────────────────────────────────────────

  function renameHeading(nodeId, newTitle) {
    var treeResult = SyncEngine.getTree();
    var node = _findNode(treeResult.nodes, nodeId);
    if (!node) return { ok: false, error: 'Node not found' };

    var docId = _docId();
    var docData = Docs.Documents.get(docId, { fields: 'body.content' });
    var offsets = _resolveOffsets(docData, treeResult.nodes);
    var range = offsets[nodeId];
    if (!range) return { ok: false, error: 'Could not locate heading in document' };

    // range.end includes the trailing \n; delete only the text (end - 1) to preserve the newline
    var textEnd = range.end - 1;

    var requests = [
      {
        deleteContentRange: {
          range: { startIndex: range.start, endIndex: textEnd }
        }
      },
      {
        insertText: {
          text: newTitle,
          location: { index: range.start }
        }
      },
      {
        updateParagraphStyle: {
          range: { startIndex: range.start, endIndex: range.start + newTitle.length + 1 },
          paragraphStyle: { namedStyleType: HEADING_STYLES[node.level] },
          fields: 'namedStyleType'
        }
      }
    ];

    try {
      Docs.Documents.batchUpdate({ requests: requests }, docId);
    } catch (e) {
      return { ok: false, error: 'Rename failed: ' + e.message };
    }

    return SyncEngine.invalidateAndResync();
  }

  // ── Change Heading Level ──────────────────────────────────────────────────

  function changeHeadingLevel(nodeId, delta) {
    var treeResult = SyncEngine.getTree();
    var nodes = treeResult.nodes;
    var node = _findNode(nodes, nodeId);
    if (!node) return { ok: false, error: 'Node not found' };

    var newLevel = node.level + delta;
    if (newLevel < 1) return { ok: false, error: 'Cannot promote past Heading 1' };
    if (newLevel > 6) return { ok: false, error: 'Cannot demote past Heading 6' };
    if (!_validateLevelCascade(nodes, node, delta)) {
      return { ok: false, error: 'Cannot demote — a descendant would exceed Heading 6' };
    }

    var docId = _docId();
    var docData = Docs.Documents.get(docId, { fields: 'body.content' });
    var offsets = _resolveOffsets(docData, nodes);
    var subtree = _collectSubtree(nodes, nodeId);

    var requests = [];
    subtree.forEach(function (n) {
      var r = offsets[n.id];
      if (!r) return;
      var targetLevel = Math.max(1, Math.min(6, n.level + delta));
      requests.push({
        updateParagraphStyle: {
          // Range must cover at least one character + the paragraph terminator
          range: { startIndex: r.start, endIndex: r.end },
          paragraphStyle: { namedStyleType: HEADING_STYLES[targetLevel] },
          fields: 'namedStyleType'
        }
      });
    });

    if (requests.length === 0) return { ok: false, error: 'No headings to update' };

    try {
      Docs.Documents.batchUpdate({ requests: requests }, docId);
    } catch (e) {
      return { ok: false, error: 'Level change failed: ' + e.message };
    }

    return SyncEngine.invalidateAndResync();
  }

  // ── Label Override ────────────────────────────────────────────────────────

  function setLabelOverride(nodeId, label) {
    var treeResult = SyncEngine.getTree();
    var node = _findNode(treeResult.nodes, nodeId);
    if (!node) return { ok: false, error: 'Node not found' };
    StorageService.setLabelOverride(node.headingId || node.id, label || null);
    StorageService.invalidateTreeCache();
    return SyncEngine.getTree();
  }

  // ── Exclude / Include ─────────────────────────────────────────────────────

  function setExcluded(nodeId, excluded) {
    var treeResult = SyncEngine.getTree();
    var node = _findNode(treeResult.nodes, nodeId);
    if (!node) return { ok: false, error: 'Node not found' };

    var config = StorageService.getConfig();
    var key = node.headingId || node.id;
    var current = config.excludedHeadingIds || [];

    if (excluded) {
      if (current.indexOf(key) === -1) current.push(key);
    } else {
      current = current.filter(function (id) { return id !== key; });
    }

    StorageService.setExcludedHeadingIds(current);
    StorageService.invalidateTreeCache();
    return SyncEngine.getTree();
  }

  // ── Stale Resolution ──────────────────────────────────────────────────────

  function resolveStale(nodeId, resolution) {
    var treeResult = SyncEngine.getTree();
    var node = _findNode(treeResult.nodes, nodeId);
    if (!node) return { ok: false, error: 'Node not found' };

    if (resolution === 'accept') {
      StorageService.invalidateTreeCache();
      return SyncEngine.getTree();
    }
    if (resolution === 'restore') {
      return renameHeading(nodeId, node.syncedTitle);
    }
    return { ok: false, error: 'Unknown resolution: ' + resolution };
  }

  // ── Remove Orphan ─────────────────────────────────────────────────────────

  function removeOrphan(nodeId) {
    var treeResult = SyncEngine.getTree();
    var node = _findNode(treeResult.nodes, nodeId);
    if (!node) return { ok: false, error: 'Node not found' };
    if (node.status !== 'orphaned') return { ok: false, error: 'Node is not orphaned' };

    var config = StorageService.getConfig();
    var key = node.headingId || node.id;
    config.excludedHeadingIds = (config.excludedHeadingIds || []).filter(function (id) { return id !== key; });
    delete (config.labelOverrides || {})[key];
    StorageService.setConfig(config);
    StorageService.invalidateTreeCache();
    return SyncEngine.getTree();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function _findNode(nodes, id) {
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].id === id) return nodes[i];
    }
    return null;
  }

  function _isDescendant(nodes, candidateId, ancestorId) {
    var byId = {};
    nodes.forEach(function (n) { byId[n.id] = n; });
    var node = byId[candidateId];
    while (node && node.parentId) {
      if (node.parentId === ancestorId) return true;
      node = byId[node.parentId];
    }
    return false;
  }

  function _collectSubtree(nodes, rootId) {
    var result = [];
    var toVisit = [rootId];
    while (toVisit.length > 0) {
      var id = toVisit.pop();
      var node = _findNode(nodes, id);
      if (!node) continue;
      result.push(node);
      nodes.forEach(function (n) {
        if (n.parentId === id) toVisit.push(n.id);
      });
    }
    return result;
  }

  function _validateLevelCascade(nodes, source, delta) {
    if (delta <= 0) return true;
    var subtree = _collectSubtree(nodes, source.id);
    for (var i = 0; i < subtree.length; i++) {
      if (subtree[i].level + delta > 6) return false;
    }
    return true;
  }

  function _applyLevelCascade(docId, nodes, source, delta) {
    var subtree = _collectSubtree(nodes, source.id);
    // Re-fetch fresh offsets after the move
    var docData = Docs.Documents.get(docId, { fields: 'body.content' });
    var freshNodes = SyncEngine.parse();
    var offsets = _resolveOffsets(docData, freshNodes);

    var requests = [];
    subtree.forEach(function (n) {
      var r = offsets[n.id];
      if (!r) return;
      var targetLevel = Math.max(1, Math.min(6, n.level + delta));
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: r.start, endIndex: r.end },
          paragraphStyle: { namedStyleType: HEADING_STYLES[targetLevel] },
          fields: 'namedStyleType'
        }
      });
    });

    if (requests.length > 0) {
      try {
        Docs.Documents.batchUpdate({ requests: requests }, docId);
      } catch (e) {
        Logger.log('mostly-organised: level cascade failed — ' + e.message);
      }
    }
  }

  return {
    moveSection: moveSection,
    renameHeading: renameHeading,
    changeHeadingLevel: changeHeadingLevel,
    setLabelOverride: setLabelOverride,
    setExcluded: setExcluded,
    resolveStale: resolveStale,
    removeOrphan: removeOrphan
  };
})();
