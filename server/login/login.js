/* Whoop-plus login page. Plain script (no build step); CSP forbids inline scripts. */
(function () {
  'use strict';

  var SWA = window.SimpleWebAuthnBrowser;
  var params = new URLSearchParams(location.search);
  var hasBluetooth = typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  var webauthnOk = false;
  try {
    webauthnOk = Boolean(SWA && SWA.browserSupportsWebAuthn());
  } catch (e) {
    webauthnOk = false;
  }

  function $(id) { return document.getElementById(id); }

  var views = ['view-loading', 'view-setup', 'view-login', 'view-pair'];
  function show(id) {
    views.forEach(function (v) { $(v).hidden = v !== id; });
  }

  function notice(msg, kind) {
    var el = $('notice');
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = msg;
    el.className = 'notice' + (kind === 'ok' ? ' ok' : '');
    el.hidden = false;
  }

  function showPlanB(on) { $('planb').hidden = !on; }

  Array.prototype.forEach.call(document.querySelectorAll('.origin'), function (el) {
    el.textContent = location.origin;
  });

  function api(path, body) {
    var opts = { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.message || ('Fehler ' + res.status));
          err.server = true;
          err.code = data.error;
          throw err;
        }
        return data;
      });
    });
  }

  /** Map WebAuthn / network errors to friendly German messages. */
  function describe(err) {
    if (err && err.server) return err.message;
    var name = (err && (err.name || (err.cause && err.cause.name))) || '';
    if (name === 'NotAllowedError' || name === 'AbortError') {
      return 'Der Vorgang wurde abgebrochen oder ist abgelaufen. Bitte noch einmal versuchen.';
    }
    if (name === 'InvalidStateError') return 'Auf diesem Gerät existiert bereits ein Passkey für diese Seite.';
    if (name === 'SecurityError') return 'Sicherheitsfehler: Die Domain passt nicht zur Passkey-Konfiguration (RP_ID/ORIGIN).';
    if (name === 'NotSupportedError') return 'Dieser Browser unterstützt Passkeys nicht.';
    if (err instanceof TypeError) return 'Keine Verbindung zum Server. Bist du online?';
    return 'Das hat nicht geklappt' + (err && err.message ? ': ' + err.message : '.');
  }

  function busy(btn, on, label) {
    if (on) {
      btn.dataset.label = btn.textContent;
      btn.textContent = label || 'Bitte warten…';
      btn.disabled = true;
    } else {
      btn.textContent = btn.dataset.label || btn.textContent;
      btn.disabled = false;
    }
  }

  function requireWebAuthn() {
    if (webauthnOk) return true;
    notice('Passkeys sind in diesem Browser nicht verfügbar. Nutze die Anleitung unten.');
    showPlanB(true);
    return false;
  }

  // ------------------------------------------------------------- flows
  function init() {
    return api('/api/auth/status').then(function (status) {
      if (status.authenticated) {
        if (hasBluetooth && !params.has('koppeln')) {
          location.replace('/');
          return;
        }
        if (status.sessionVia === 'passkey') {
          show('view-pair');
          showPlanB(false);
          return;
        }
        // Signed in via pairing link: creating new pairing links requires a passkey login.
        show('view-login');
        notice('Kopplungs-Links kannst du nur nach einer Anmeldung mit dem Passkey erstellen (in Safari).');
        showPlanB(!webauthnOk || hasBluetooth);
        return;
      }
      show(status.registered ? 'view-login' : 'view-setup');
      // In Bluefy (Web Bluetooth present) passkeys often fail – show plan B right away.
      showPlanB(!webauthnOk || hasBluetooth);
    }).catch(function (err) {
      show('view-loading');
      notice(describe(err));
    });
  }

  $('setup-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    notice('');
    if (!requireWebAuthn()) return;
    var code = $('setup-code').value.trim();
    if (!code) { notice('Bitte den Setup-Code eingeben.'); return; }
    var btn = $('setup-btn');
    busy(btn, true);
    api('/api/auth/register/options', { setupCode: code })
      .then(function (optionsJSON) { return SWA.startRegistration({ optionsJSON: optionsJSON }); })
      .then(function (response) { return api('/api/auth/register/verify', { response: response }); })
      .then(function () {
        notice('Passkey eingerichtet. Die Registrierung ist jetzt geschlossen.', 'ok');
        return init();
      })
      .catch(function (err) {
        notice(describe(err));
        if (!err.server) showPlanB(true);
        if (err.code === 'registration_closed') init();
      })
      .then(function () { busy(btn, false); });
  });

  $('login-btn').addEventListener('click', function () {
    notice('');
    if (!requireWebAuthn()) return;
    var btn = $('login-btn');
    busy(btn, true);
    api('/api/auth/login/options', {})
      .then(function (optionsJSON) { return SWA.startAuthentication({ optionsJSON: optionsJSON }); })
      .then(function (response) { return api('/api/auth/login/verify', { response: response }); })
      .then(function () { return init(); })
      .catch(function (err) {
        notice(describe(err));
        if (!err.server) showPlanB(true);
      })
      .then(function () { busy(btn, false); });
  });

  $('pair-btn').addEventListener('click', function () {
    notice('');
    var btn = $('pair-btn');
    busy(btn, true);
    api('/api/auth/pair', {})
      .then(function (data) {
        $('pair-url').value = data.url;
        $('pair-exp').textContent = new Date(data.expiresAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        $('pair-result').hidden = false;
        btn.dataset.label = 'Neuen Link erstellen';
      })
      .catch(function (err) {
        notice(describe(err));
        if (err.code === 'pairing_requires_passkey') show('view-login');
        if (err.code === 'unauthenticated') init();
      })
      .then(function () { busy(btn, false); });
  });

  $('copy-btn').addEventListener('click', function () {
    var input = $('pair-url');
    var done = function () {
      $('copy-btn').textContent = 'Kopiert ✓';
      setTimeout(function () { $('copy-btn').textContent = 'Kopieren'; }, 2000);
    };
    var fallback = function () {
      input.focus();
      input.select();
      input.setSelectionRange(0, input.value.length);
      try {
        if (document.execCommand('copy')) { done(); return; }
      } catch (e) { /* ignore */ }
      notice('Kopieren nicht möglich – bitte den Link markieren und manuell kopieren.');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(input.value).then(done, fallback);
    } else {
      fallback();
    }
  });

  $('logout-btn').addEventListener('click', function () {
    api('/api/auth/logout', {}).then(function () { location.replace('/login'); }, function (err) { notice(describe(err)); });
  });

  if (params.get('pair') === 'invalid') {
    notice('Der Kopplungs-Link ist ungültig, abgelaufen oder wurde schon benutzt. Erstelle in Safari einen neuen Link.');
  }

  init();
})();
