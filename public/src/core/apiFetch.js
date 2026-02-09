/**
 * apiFetch.js — API fetch helpers with operator auth, idempotency, and retry
 *
 * Depends on:
 *   window.CS.config   (from config/api.js)
 *   window.CS.operator  (from core/operator.js)
 *
 * Provides:
 *   window.CS.api.fetchJson(url)               — GET with operator_id, error typing
 *   window.CS.api.actionFetch(url, opts)        — POST/PATCH with idempotency + retry
 *   window.CS.api.generateIdempotencyKey()      — UUID v4
 *   window.CS.api.showBanner(message, type)     — temporary feedback banner
 */
(function () {
  'use strict';

  window.CS = window.CS || {};
  window.CS.api = window.CS.api || {};

  var config   = window.CS.config   || {};
  var operator = window.CS.operator || {};

  // ── Utilities ────────────────────────────────

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /**
   * Generate a UUID v4 idempotency key.
   * @returns {string}
   */
  function generateIdempotencyKey() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // ── Banner (temporary feedback) ──────────────
  // TODO: Add a dedicated banner container element in the HTML for action feedback.
  //       Currently prepends a temporary div into #session-detail.

  /**
   * Show a temporary banner message inside #session-detail.
   * @param {string} message
   * @param {'success'|'error'|'warning'} type
   */
  function showBanner(message, type) {
    var detail = document.getElementById('session-detail');
    if (!detail) return;

    // Remove any existing banners
    detail.querySelectorAll('.action-banner').forEach(function (b) { b.remove(); });

    var className = type === 'success' ? 'success' : 'error';
    var banner = document.createElement('div');
    banner.className = className + ' action-banner';
    banner.style.marginBottom = '10px';
    banner.textContent = message;
    detail.prepend(banner);

    setTimeout(function () { banner.remove(); }, 5000);
  }

  // ── fetchJson (GET requests) ─────────────────

  /**
   * Fetch JSON from a GET endpoint.
   * Automatically attaches operator_id as header + query param.
   * Throws typed errors for 403, 429, 409/503.
   *
   * @param {string} url — absolute or relative URL
   * @returns {Promise<Object>} parsed response body
   */
  async function fetchJson(url) {
    var operatorId = operator.getId ? operator.getId() : null;
    var fetchUrl = new URL(url, window.location.origin);

    if (operatorId && !fetchUrl.searchParams.has('operator_id')) {
      fetchUrl.searchParams.set('operator_id', operatorId);
    }

    var headers = {};
    if (operatorId) headers['x-operator-id'] = operatorId;

    var response = await fetch(fetchUrl.toString(), { headers: headers });
    var data = null;
    try {
      data = await response.json();
    } catch (_e) {
      throw new Error('Invalid server response');
    }

    // ── Typed error responses ──
    if (response.status === 403) {
      throw {
        code: 'FORBIDDEN',
        message: (data && data.error) || "You don't have access to this booking",
        status: 403
      };
    }
    if (response.status === 429) {
      throw {
        code: 'RATE_LIMITED',
        message: 'Rate limit exceeded. Please wait.',
        status: 429
      };
    }
    if (response.status === 503 || response.status === 409) {
      throw {
        code: 'RETRY_LATER',
        message: (data && data.error) || 'Temporary issue',
        status: response.status
      };
    }
    if (!response.ok || !data || data.success === false) {
      throw new Error((data && data.error) || 'Request failed');
    }

    return data;
  }

  // ── actionFetch (POST / PATCH with retry) ────

  /**
   * Execute a mutating API call with:
   *  - X-Idempotency-Key header (generated once, reused across retries)
   *  - x-operator-id header
   *  - Automatic retry with exponential backoff on 409 / 503
   *  - User-facing banners for 403, 429, retry progress
   *
   * @param {string} url
   * @param {{ method?: string, body?: Object }} opts
   * @returns {Promise<Object|null>} parsed response, or null on 403/429
   */
  async function actionFetch(url, opts) {
    var method = (opts && opts.method) || 'POST';
    var body   = (opts && opts.body)   || null;

    var operatorId = operator.getId ? operator.getId() : null;
    if (!operatorId) {
      showBanner('Operator ID is required.', 'error');
      throw new Error('OPERATOR_ID_REQUIRED');
    }

    var maxRetries = config.MAX_ACTION_RETRIES || 3;
    var baseDelay  = config.RETRY_BASE_DELAY_MS || 1000;
    var idempotencyKey = generateIdempotencyKey();

    for (var attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        var response = await fetch(url, {
          method: method,
          headers: {
            'Content-Type': 'application/json',
            'X-Idempotency-Key': idempotencyKey,
            'x-operator-id': operatorId
          },
          body: body ? JSON.stringify(body) : undefined
        });

        var data = null;
        try { data = await response.json(); } catch (_e) {
          throw new Error('Invalid server response');
        }

        // ── Retryable ──
        if ((response.status === 409 || response.status === 503) && attempt < maxRetries) {
          showBanner('Temporary issue — retrying…', 'warning');
          await sleep(baseDelay * Math.pow(2, attempt));
          continue;
        }

        // ── Non-retryable errors ──
        if (response.status === 403) {
          showBanner("You don't have access to this booking", 'error');
          return null;
        }
        if (response.status === 429) {
          showBanner('Rate limit reached. Please wait a moment.', 'warning');
          return null;
        }

        if (!response.ok || (data && data.success === false)) {
          throw new Error((data && data.error) || 'Action failed');
        }

        return data;
      } catch (error) {
        if (attempt >= maxRetries) {
          showBanner('Action failed after retries: ' + error.message, 'error');
          throw error;
        }
        showBanner('Temporary issue — retrying…', 'warning');
        await sleep(baseDelay * Math.pow(2, attempt));
      }
    }
  }

  // ── Public API ───────────────────────────────
  window.CS.api.fetchJson             = fetchJson;
  window.CS.api.actionFetch           = actionFetch;
  window.CS.api.generateIdempotencyKey = generateIdempotencyKey;
  window.CS.api.showBanner            = showBanner;
})();
