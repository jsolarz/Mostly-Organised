// StorageService — read/write DocumentProperties, UserProperties, ScriptCache

var StorageService = (function () {
  var CACHE_TTL = 21600; // 6 hours (Apps Script max)

  function _docId() {
    return DocumentApp.getActiveDocument().getId();
  }

  function _cacheKey() {
    return 'mo:tree:' + _docId();
  }

  function _configKey() {
    return 'mo:config:' + _docId();
  }

  function _prefsKey() {
    return 'mo:prefs:' + _docId();
  }

  // --- Tree cache ---

  function getTreeCache() {
    var raw = CacheService.getScriptCache().get(_cacheKey());
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function setTreeCache(nodes) {
    try {
      CacheService.getScriptCache().put(_cacheKey(), JSON.stringify(nodes), CACHE_TTL);
    } catch (e) {
      // Cache put can fail silently if value exceeds 100KB compressed; that's fine
      Logger.log('mo: cache write failed — ' + e.message);
    }
  }

  function invalidateTreeCache() {
    CacheService.getScriptCache().remove(_cacheKey());
  }

  // --- Document config (shared across all editors) ---

  function getConfig() {
    var raw = PropertiesService.getDocumentProperties().getProperty(_configKey());
    if (!raw) {
      return {
        documentId: _docId(),
        numberingScheme: 'numeric',
        excludedHeadingIds: [],
        labelOverrides: {},
        baseTitles: {},
        lastSyncedAt: null,
        version: 0
      };
    }
    return JSON.parse(raw);
  }

  function setConfig(config) {
    config.version = (config.version || 0) + 1;
    PropertiesService.getDocumentProperties().setProperty(_configKey(), JSON.stringify(config));
  }

  function setNumberingScheme(scheme) {
    var config = getConfig();
    config.numberingScheme = scheme;
    setConfig(config);
    return { ok: true };
  }

  function setExcludedHeadingIds(ids) {
    var config = getConfig();
    config.excludedHeadingIds = ids;
    setConfig(config);
  }

  function setLabelOverride(headingId, label) {
    var config = getConfig();
    if (label === null || label === undefined) {
      delete config.labelOverrides[headingId];
    } else {
      config.labelOverrides[headingId] = label;
    }
    setConfig(config);
  }

  function touchLastSynced() {
    var config = getConfig();
    config.lastSyncedAt = new Date().toISOString();
    setConfig(config);
  }

  // --- User preferences (per-user) ---

  function getUserPrefs() {
    var raw = PropertiesService.getUserProperties().getProperty(_prefsKey());
    if (!raw) {
      return {
        documentId: _docId(),
        expandedNodeIds: [],
        panelWidth: 280
      };
    }
    return JSON.parse(raw);
  }

  function setUserPrefs(prefs) {
    PropertiesService.getUserProperties().setProperty(_prefsKey(), JSON.stringify(prefs));
    return { ok: true };
  }

  return {
    getTreeCache: getTreeCache,
    setTreeCache: setTreeCache,
    invalidateTreeCache: invalidateTreeCache,
    getConfig: getConfig,
    setConfig: setConfig,
    setNumberingScheme: setNumberingScheme,
    setExcludedHeadingIds: setExcludedHeadingIds,
    setLabelOverride: setLabelOverride,
    touchLastSynced: touchLastSynced,
    getUserPrefs: getUserPrefs,
    setUserPrefs: setUserPrefs
  };
})();
