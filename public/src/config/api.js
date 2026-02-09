/**
 * api.js — API configuration constants
 *
 * Loaded before core modules. Provides:
 *   window.CS.config.API_BASE
 *   window.CS.config.POLL_INTERVALS
 *   window.CS.config.MAX_ACTION_RETRIES
 *   window.CS.config.RETRY_BASE_DELAY_MS
 */
(function () {
  'use strict';

  window.CS = window.CS || {};
  window.CS.config = window.CS.config || {};

  /** Base URL for all API requests (same origin). */
  window.CS.config.API_BASE = window.location.origin;

  /** Polling intervals in milliseconds. */
  window.CS.config.POLL_INTERVALS = Object.freeze({
    sessions:      10000,   // 10 s — sessions sidebar refresh
    sessionDetail:  5000,   //  5 s — active session detail refresh
    messages:       5000,   //  5 s — messages panel refresh
    booking:        5000    //  5 s — booking card refresh
  });

  /** Maximum automatic retries for mutating actions (409 / 503). */
  window.CS.config.MAX_ACTION_RETRIES = 3;

  /** Base delay before first retry; doubles on each subsequent attempt. */
  window.CS.config.RETRY_BASE_DELAY_MS = 1000;
})();
