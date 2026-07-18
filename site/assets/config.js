/* ============================================================================
 * Point the marketing site at your CRM.
 *
 *   >>> CHANGE THIS ONE LINE AFTER YOUR DNS IS LIVE <<<
 *
 * The marketing site (www.) and the CRM (app.) are separate hosts, so every
 * "Log in" / "Start free trial" link on the site has to know where the app is.
 * They all read this value, so this is the only place to edit.
 *
 * Examples:
 *   https://app.yourbuilder.com     (recommended: a subdomain for the app)
 *   http://203.0.113.10             (a bare VPS IP, before DNS — works, but
 *                                    note the app cannot be INSTALLED over
 *                                    plain http, only browsed)
 * ==========================================================================*/
window.APP_URL = 'https://app.example.com';

/* ---------------------------------------------------------------------------
 * Everything below is wiring — you should not need to touch it.
 * Any <a data-app="/login"> gets its href built from APP_URL. The href in the
 * HTML is a real fallback, so links still work if this script fails to load.
 * -------------------------------------------------------------------------*/
(function () {
  function apply() {
    var base = String(window.APP_URL || '').replace(/\/+$/, '');
    if (!base) return;
    var links = document.querySelectorAll('[data-app]');
    for (var i = 0; i < links.length; i++) {
      var path = links[i].getAttribute('data-app') || '';
      links[i].href = base + path;
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply);
  } else {
    apply();
  }
})();
