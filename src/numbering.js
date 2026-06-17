// NumberingService — compute display-only section numbers from tree structure
// Runs client-side in the sidebar; also callable server-side.

var NumberingService = (function () {

  var ROMAN = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
    [100, 'C'],  [90, 'XC'],  [50, 'L'],  [40, 'XL'],
    [10, 'X'],   [9, 'IX'],   [5, 'V'],   [4, 'IV'],
    [1, 'I']
  ];

  var ALPHA_LOWER = 'abcdefghijklmnopqrstuvwxyz';
  var ALPHA_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  function _toRoman(n) {
    var result = '';
    ROMAN.forEach(function (pair) {
      while (n >= pair[0]) { result += pair[1]; n -= pair[0]; }
    });
    return result;
  }

  function _toAlphaUpper(n) {
    // 1→A, 2→B, ..., 26→Z, 27→AA, ...
    var result = '';
    while (n > 0) {
      result = ALPHA_UPPER[(n - 1) % 26] + result;
      n = Math.floor((n - 1) / 26);
    }
    return result;
  }

  function _toAlphaLower(n) {
    return _toAlphaUpper(n).toLowerCase();
  }

  // Assign display numbers to a flat node list.
  // Returns a Map<nodeId, string> — only includes visible (non-excluded) nodes.
  function compute(nodes, scheme) {
    var numbers = {}; // nodeId → display string
    if (!scheme || scheme === 'none') return numbers;

    // Counters per level: levelCounters[level] = current count (1-based)
    var levelCounters = {};

    // Track which levels have been "reset" as we traverse
    // We iterate in document order (nodes array is already sorted by startIndex)
    var visibleNodes = nodes.filter(function (n) {
      return n.status !== 'orphaned' && !n.isExcluded;
    });

    visibleNodes.forEach(function (node) {
      var level = node.level;

      // Reset counters for all levels deeper than current
      Object.keys(levelCounters).forEach(function (l) {
        if (parseInt(l, 10) > level) delete levelCounters[l];
      });

      // Increment current level counter
      levelCounters[level] = (levelCounters[level] || 0) + 1;

      // Build the number string
      numbers[node.id] = _buildNumber(levelCounters, level, scheme);
    });

    return numbers;
  }

  function _buildNumber(levelCounters, maxLevel, scheme) {
    // Collect parts from level 1 up to maxLevel
    var parts = [];
    for (var l = 1; l <= maxLevel; l++) {
      var count = levelCounters[l] || 0;
      if (count === 0) continue; // gap in levels; skip
      parts.push(_formatSegment(count, l, scheme));
    }

    switch (scheme) {
      case 'numeric':
        return parts.join('.');

      case 'legal':
        // I, I.A, I.A.1, I.A.1.a, ...  (Roman, Alpha, Numeric, alpha, ...)
        return parts.join('.');

      case 'outline':
        // A, A.1, A.1.a, A.1.a.i, ...
        return parts.join('.');

      default:
        return parts.join('.');
    }
  }

  function _formatSegment(n, level, scheme) {
    switch (scheme) {
      case 'numeric':
        return String(n);

      case 'legal':
        // Level 1: Roman, Level 2: ALPHA, Level 3+: numeric
        if (level === 1) return _toRoman(n);
        if (level === 2) return _toAlphaUpper(n);
        return String(n);

      case 'outline':
        // Level 1: ALPHA, Level 2: numeric, Level 3: alpha, Level 4: numeric, ...
        if (level % 2 === 1) return _toAlphaUpper(Math.ceil(level / 2) === 1 ? n : n);
        if (level === 1) return _toAlphaUpper(n);
        if (level === 2) return String(n);
        if (level === 3) return _toAlphaLower(n);
        if (level === 4) return String(n);
        return _toAlphaLower(n);

      default:
        return String(n);
    }
  }

  return {
    compute: compute
  };
})();
