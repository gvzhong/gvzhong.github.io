/**
 * @fileoverview Runtime patch: strip login_hint from NVIDIA's silent-SSO flow.
 *
 * Self-contained, no imports, no build step. Designed to be loaded remotely:
 *
 *   <script src="https://your-host/6-runtime-patch.js"></script>
 *
 * or from the console / a bookmarklet:
 *
 *   fetch('https://your-host/6-runtime-patch.js').then(r=>r.text()).then(eval)
 *
 * (www.nvidia.com sets only `frame-ancestors` in its CSP -- no script-src and
 * no default-src -- so both remote <script> and eval are permitted.)
 *
 * ON LOAD IT AUTOMATICALLY:
 *   1. patches Starfleet.prototype.getAuthHintsSession,
 *   2. deletes localStorage["acctFederationData"] so the stored session cannot
 *      short-circuit the flow,
 *   3. waits for the page's account-wrapper to be ready,
 *   4. clears the session once more and runs the full getSession flow,
 *   5. logs the outcome.
 *
 * WHAT THE PATCH CHANGES
 *   - `getAuthHints()` is never called: nothing reads `?loginhint`, `?jso`, or
 *     localStorage["loginHints"];
 *   - there is no precondition at all -- the prompt=none attempt is always made
 *     (the shipped code required a <1h-old login hint to even try);
 *   - `login_hint` is not appended to the `/auth/` URL, so the downstream
 *     login.nvidia.com/authorize request omits it and the IdP resolves the
 *     default account from its own session cookie.
 *
 * The promise contract is unchanged -- always resolves, to the session object
 * or to `false` -- so getSession ordering, the Voltron token minting
 * (nvweb_E / nvweb_S), the `starfleet-getSession-completed` event and the
 * account-menu rendering all keep working.
 *
 * CONFIGURE (optional) either way:
 *   window.__nvHintPatchOptions = {autoRun: false};   // before the script tag
 *   <script src="..." data-auto-run="false" data-clear-session="false"></script>
 *
 * MANUAL CONTROLS
 *   window.__nvHintPatch.status()        current state
 *   window.__nvHintPatch.previewUrl()    the /auth/ URL that would be requested
 *   window.__nvHintPatch.clearSession()  drop the stored session
 *   window.__nvHintPatch.rerun()         re-run getSession now
 *   window.__nvHintPatch.uninstall()     restore the shipped method
 */
(function () {
  'use strict';

  const AUTH_PATH = '/auth/';
  const DEFAULT_SSO_TIMEOUT_MS = 3000;

  /**
   * The shipped chunk has this substituted in as a literal by webpack
   * DefinePlugin, so `configs.JARVIS_IDP_ID` is ignored there. We prefer the
   * config value and fall back to the literal.
   */
  const PROD_JARVIS_IDP_ID = 'PDiAhv2kJTFeQ7WOPqiQ2tRZ7lGhR2X11dXvM4TZSxg';

  /**
   * Session key. Every environment in the shipped config table uses this same
   * value, so it is safe to clear before any config has been resolved.
   */
  const SESSION_ITEM_NAME = 'acctFederationData';

  const DEFAULT_OPTIONS = {
    /** Delete the stored session on load and before each rerun. */
    clearSession: true,
    /** Keys to delete. Add 'lastLoginData' / 'loginHints' for a colder start. */
    clearKeys: [SESSION_ITEM_NAME],
    /** Run the full flow automatically once the page is ready. */
    autoRun: true,
    /** How long to wait for window.NVIDIAGDC.getSession to appear. */
    readyTimeoutMs: 25000,
    /** Keep idp_id on the URL. Set false to let Starfleet pick the IdP. */
    sendIdpId: true,
    /** No precondition: attempt the silent login for every visitor. */
    alwaysAttempt: true,
    /** Log every step. Prod builds compile Starfleet's own logger.debug out. */
    verbose: true,
  };

  if (window.__nvHintPatch) {
    console.warn('[hint-patch] already installed; skipping re-install');
    return;
  }

  /**
   * Merges options from `window.__nvHintPatchOptions` and from `data-*` on the
   * script tag. `document.currentScript` is null when eval'd, which is fine.
   *
   * @return {!Object}
   */
  function resolveOptions() {
    const options = Object.assign({}, DEFAULT_OPTIONS);
    const script = document.currentScript;
    if (script && script.dataset) {
      const d = script.dataset;
      if (d.autoRun !== undefined) options.autoRun = d.autoRun !== 'false';
      if (d.clearSession !== undefined) options.clearSession = d.clearSession !== 'false';
      if (d.sendIdpId !== undefined) options.sendIdpId = d.sendIdpId !== 'false';
      if (d.alwaysAttempt !== undefined) options.alwaysAttempt = d.alwaysAttempt !== 'false';
      if (d.verbose !== undefined) options.verbose = d.verbose !== 'false';
      if (d.clearKeys) options.clearKeys = d.clearKeys.split(',').map((s) => s.trim());
    }
    return Object.assign(options, window.__nvHintPatchOptions || {});
  }

  const OPTIONS = resolveOptions();

  const log = (...args) => {
    if (OPTIONS.verbose) console.log('%c[hint-patch]', 'color:#76b900', ...args);
  };

  /** @type {?Function} */
  let originalMethod = null;
  /** @type {?Function} */
  let patchedClass = null;
  /** @type {!Map<string, !Promise<*>>} */
  const inFlight = new Map();

  /**
   * @param {string|null|undefined} uiLocales
   * @return {string} `xx-XX`
   */
  function normalizeUiLocales(uiLocales) {
    const raw = String(uiLocales || 'en-us').replace('_', '-');
    const [language, region] = raw.split('-');
    if (!language) return 'en-US';
    if (!region) return language.toLowerCase() + '-' + language.toUpperCase();
    return language.toLowerCase() + '-' + region.toUpperCase();
  }

  /**
   * @param {!Object} configs
   * @return {?Object} Stored session, or null when absent/expired/unparseable.
   */
  function readStoredSession(configs) {
    try {
      const raw = localStorage.getItem(configs.SESSION_ITEM_NAME || SESSION_ITEM_NAME);
      if (!raw) return null;
      const session = JSON.parse(raw);
      if (!session || typeof session !== 'object') return null;
      return new Date(session.expiration) > new Date() ? session : null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Deletes the stored session so it cannot short-circuit the flow.
   *
   * @return {!Array<string>} Keys that actually existed and were removed.
   */
  function clearStoredSession() {
    const removed = [];
    for (const key of OPTIONS.clearKeys) {
      try {
        if (localStorage.getItem(key) !== null) {
          localStorage.removeItem(key);
          removed.push(key);
        }
      } catch (err) {
        console.warn('[hint-patch] could not remove', key, err);
      }
    }
    log(removed.length ? 'cleared ' + removed.join(', ') : 'nothing to clear');
    return removed;
  }

  /**
   * @param {!Object} configs
   * @param {string} uiLocales Already normalized.
   * @return {string} Same-origin `/auth/` URL, with no `login_hint`.
   */
  function buildSilentAuthUrl(configs, uiLocales) {
    const params = new URLSearchParams({
      redirect_uri: location.href,
      client_id: configs.CLIENT_ID,
      ui_locales: uiLocales,
      prompt: 'none',
      // login_hint deliberately absent -- this is the entire point of the patch.
    });
    if (OPTIONS.sendIdpId) {
      params.set('idp_id', configs.JARVIS_IDP_ID || PROD_JARVIS_IDP_ID);
    }
    return location.origin + AUTH_PATH + '?' + params.toString();
  }

  /** @return {!Promise<void>} Resolves once document.body exists. */
  function whenBodyReady() {
    if (document.body) return Promise.resolve();
    return new Promise((resolve) => {
      document.addEventListener('DOMContentLoaded', () => resolve(), {once: true});
    });
  }

  /**
   * One silent authorization in a hidden iframe.
   *
   * Hardened relative to the shipped version, which matters more now that this
   * runs unconditionally: origin is verified, the message is attributed to this
   * specific iframe, the `message` listener and the timer are released on every
   * exit path, and `removeChild` is null-guarded. The shipped code does none of
   * these and throws `NotFoundError` when the page's two concurrent getSession
   * calls collide.
   *
   * @param {!Object} configs
   * @param {string} uiLocales Already normalized.
   * @return {!Promise<Object|boolean>} Never rejects.
   */
  function runSilentAuth(configs, uiLocales) {
    return whenBodyReady().then(() => new Promise((resolve) => {
      const url = buildSilentAuthUrl(configs, uiLocales);
      log('silent auth ->', url);
      console.assert(
          url.indexOf('login_hint') === -1, 'login_hint leaked into /auth/ URL');

      const iframe = document.createElement('iframe');
      iframe.hidden = true;
      iframe.setAttribute('aria-hidden', 'true');
      iframe.title = 'silent-authentication';
      iframe.src = url;

      const timeoutMs = configs.SSO_TIMEOUT || DEFAULT_SSO_TIMEOUT_MS;
      let settled = false;

      function settle(value, reason) {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        window.removeEventListener('message', onMessage);
        // On success `/auth/` also navigates this iframe back to the referrer,
        // loading a whole page inside it. Detaching now cancels that.
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
        log('silent auth', reason, value ? '(session)' : '(anonymous)');
        resolve(value);
      }

      function onMessage(event) {
        if (event.origin !== location.origin) return;
        if (event.source && event.source !== iframe.contentWindow) return;
        if (event.data === 'success') {
          settle(readStoredSession(configs) || false, 'succeeded');
        } else if (event.data === 'failure') {
          settle(false, 'failed');
        }
      }

      const timeoutId = setTimeout(() => settle(false, 'timed out'), timeoutMs);
      window.addEventListener('message', onMessage);
      document.body.appendChild(iframe);
    }));
  }

  /**
   * Replacement for `Starfleet.prototype.getAuthHintsSession`.
   * Same signature, same contract: resolves to the session or to `false`.
   *
   * @this {!Object}
   * @param {string} uiLocales
   * @return {!Promise<Object|boolean>}
   */
  function getAuthHintsSessionNoHint(uiLocales) {
    const configs = this.configs || {};

    if (!configs.CLIENT_ID || !configs.SESSION_ITEM_NAME) {
      // resolveStarfleetConfig() yields null for an unknown NVIDIAGDC.web.env
      // and the caller spreads it, so this is a realistic input.
      log('no CLIENT_ID/SESSION_ITEM_NAME in configs; skipping silent auth');
      return Promise.resolve(false);
    }

    // The AEM clientlib calls getSession twice per page load (two separate
    // DOMContentLoaded handlers). Collapse them into one round trip.
    const normalized = normalizeUiLocales(uiLocales);
    const key = configs.CLIENT_ID + '|' + normalized;
    let attempt = inFlight.get(key);
    if (attempt) {
      log('joining in-flight silent auth');
      return attempt;
    }
    attempt = runSilentAuth(configs, normalized);
    inFlight.set(key, attempt);
    attempt.then(() => inFlight.delete(key), () => inFlight.delete(key));
    return attempt;
  }

  /**
   * @param {Function} StarfleetClass
   * @return {Function} The same class, patched.
   */
  function patch(StarfleetClass) {
    if (!StarfleetClass || !StarfleetClass.prototype) return StarfleetClass;
    if (StarfleetClass.__hintPatched) return StarfleetClass;
    originalMethod = StarfleetClass.prototype.getAuthHintsSession;
    StarfleetClass.prototype.getAuthHintsSession = getAuthHintsSessionNoHint;
    StarfleetClass.__hintPatched = true;
    patchedClass = StarfleetClass;
    log('patched Starfleet.prototype.getAuthHintsSession');
    return StarfleetClass;
  }

  // Install. The accessor wins the race regardless of script order: the
  // account-wrapper bundle assigns window.NVIDIAGDC.starfleet right before it
  // dispatches "starfleet-ready", which is what the AEM clientlib waits on.
  window.NVIDIAGDC = window.NVIDIAGDC || {};
  if (window.NVIDIAGDC.starfleet) {
    patch(window.NVIDIAGDC.starfleet);
  } else {
    let stored;
    Object.defineProperty(window.NVIDIAGDC, 'starfleet', {
      configurable: true,
      enumerable: true,
      get: () => stored,
      set: (value) => {
        stored = patch(value);
      },
    });
    log('armed; waiting for the account-wrapper bundle');
  }

  const api = {
    options: OPTIONS,
    clearSession: clearStoredSession,

    /** @return {!Object} Everything worth seeing in one place. */
    status() {
      const cfg = window.NVIDIAGDC.getPageLevelLoginConfigs ?
          window.NVIDIAGDC.getPageLevelLoginConfigs() :
          null;
      return {
        patched: !!patchedClass,
        env: window.NVIDIAGDC?.web?.env,
        pageConfig: cfg,
        loginHintsInLocalStorage: localStorage.getItem('loginHints'),
        loginHintsCookiePresent: document.cookie.indexOf('loginHints=') !== -1,
        lastLogin: localStorage.getItem('lastLoginData'),
        session: localStorage.getItem(SESSION_ITEM_NAME),
        deviceId: localStorage.getItem('nvDeviceId'),
      };
    },

    /**
     * @param {!Object=} configs Defaults to the live prod config.
     * @return {string} The `/auth/` URL this patch would request.
     */
    previewUrl(configs) {
      const resolved = configs || {
        CLIENT_ID: 'HdpDyyR1DqQFapN2MBk5kjJgAvu6UTXRDgtwLhQjrH8',
        JARVIS_IDP_ID: PROD_JARVIS_IDP_ID,
      };
      return buildSilentAuthUrl(
          resolved, normalizeUiLocales(document.documentElement.lang));
    },

    /**
     * Re-runs the whole flow. `redirectToLogin` is forced off so a failed
     * silent auth cannot navigate the tab away mid-debug.
     *
     * @param {{clear: (boolean|undefined)}=} options
     * @return {!Promise<*>}
     */
    async rerun(options = {}) {
      if (typeof window.NVIDIAGDC.getSession !== 'function') {
        console.error('[hint-patch] window.NVIDIAGDC.getSession is not available yet');
        return undefined;
      }
      const shouldClear =
          options.clear !== undefined ? options.clear : OPTIONS.clearSession;
      if (shouldClear) clearStoredSession();

      const pageConfig = window.NVIDIAGDC.getPageLevelLoginConfigs ?
          window.NVIDIAGDC.getPageLevelLoginConfigs() :
          {};
      const session = await window.NVIDIAGDC.getSession({
        pageSSOEnabled: true,
        redirectToLogin: false,
        customLoginPageURL: null,
        starfleetConfigOverrides: pageConfig.STARFLEET_CONFIG_OVERRIDES,
      });

      // Written straight to console: format specifiers are only honoured in the
      // first argument, so this cannot go through log().
      if (session && Object.keys(session).length) {
        console.log(
            '%c[hint-patch] RESULT: signed in as ' + session.email,
            'color:#76b900;font-weight:bold');
        console.log({
          email: session.email,
          idp_id: session.idp_id,
          client_id: session.client_id,
          expiration: session.expiration,
        });
      } else {
        console.log(
            '%c[hint-patch] RESULT: anonymous — no session without a login hint',
            'color:#d33;font-weight:bold');
      }
      return session;
    },

    /** @return {boolean} */
    uninstall() {
      if (!patchedClass || !originalMethod) return false;
      patchedClass.prototype.getAuthHintsSession = originalMethod;
      delete patchedClass.__hintPatched;
      patchedClass = null;
      log('uninstalled');
      return true;
    },
  };

  window.__nvHintPatch = api;

  /**
   * Waits until the AEM clientlib has published getSession and the DOM is
   * parsed. Polling is used deliberately: the clientlib exposes no event for
   * "getSession is defined", and the bundle may load either before or after us.
   *
   * @return {!Promise<boolean>} False on timeout.
   */
  function whenPageReady() {
    const isReady = () =>
        typeof window.NVIDIAGDC.getSession === 'function' &&
        document.readyState !== 'loading';
    if (isReady()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (isReady()) {
          clearInterval(timer);
          resolve(true);
        } else if (Date.now() - startedAt > OPTIONS.readyTimeoutMs) {
          clearInterval(timer);
          resolve(false);
        }
      }, 50);
    });
  }

  // Clear immediately, before the page's own DOMContentLoaded handlers call
  // getSession -- otherwise the stored session short-circuits the flow and the
  // silent path never runs.
  if (OPTIONS.clearSession) clearStoredSession();

  if (OPTIONS.autoRun) {
    whenPageReady().then((ready) => {
      if (!ready) {
        console.error(
            '[hint-patch] timed out waiting for window.NVIDIAGDC.getSession; ' +
            'call __nvHintPatch.rerun() manually');
        return;
      }
      log('auto-running the flow');
      return api.rerun();
    });
  }

  log('ready -- window.__nvHintPatch');
})();
