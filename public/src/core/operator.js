/**
 * operator.js — Operator identity management
 *
 * Depends on: (none)
 *
 * Provides:
 *   window.CS.operator.getId()       — returns operator ID or prompts
 *   window.CS.operator.clearId()     — removes stored ID (re-prompts on next call)
 */
(function () {
  'use strict';

  window.CS = window.CS || {};
  window.CS.operator = window.CS.operator || {};

  var STORAGE_KEY = 'operator_id';

  /**
   * Get the current operator ID.
   * Reads from localStorage first; if absent, prompts the user.
   * Returns the trimmed ID string, or null if the user cancels.
   */
  function getId() {
    var id = localStorage.getItem(STORAGE_KEY);
    if (!id) {
      id = prompt('Enter your Operator ID:');
      if (id && id.trim()) {
        localStorage.setItem(STORAGE_KEY, id.trim());
      }
    }
    return id ? id.trim() : null;
  }

  /**
   * Clear the stored operator ID.
   * The next call to getId() will re-prompt.
   */
  function clearId() {
    localStorage.removeItem(STORAGE_KEY);
  }

  // ── Public API ───────────────────────────────
  window.CS.operator.getId  = getId;
  window.CS.operator.clearId = clearId;
})();
