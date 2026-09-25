/* Authenticated client for the OpenLine server. Never uses public MQTT. */
(function () {
  'use strict';
  var base = String(window.OPENLINE_API_URL || '').replace(/\/$/, '');
  var sessionKey = 'openline_secure_session_v1';
  var session = null;
  try { session = JSON.parse(sessionStorage.getItem(sessionKey) || 'null'); } catch (_) {}

  function headers() {
    if (!session) throw new Error('Sesión no iniciada');
    return {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + session.sessionToken
    };
  }
  async function request(path, options) {
    var response = await fetch(base + path, options);
    var body = {};
    try { body = await response.json(); } catch (_) {}
    if (!response.ok) {
      var error = new Error(body.error || 'request_failed');
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }
  function setSession(value) {
    session = value;
    try { sessionStorage.setItem(sessionKey, JSON.stringify(value)); } catch (_) {}
  }
  function clearSession() {
    session = null;
    try { sessionStorage.removeItem(sessionKey); } catch (_) {}
  }

  window.openLineSecureSync = {
    getSession: function () { return session; },
    clearSession: clearSession,
    join: async function (workshopId, password, deviceId, user, branch) {
      var result = await request('/api/auth/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workshopId: workshopId, password: password, deviceId: deviceId, user: user || 'Admin', branch: branch || 'Central' })
      });
      setSession(result);
      return result;
    },
    confirmAction: async function (password) {
      return request('/api/auth/confirm', { method: 'POST', headers: headers(), body: JSON.stringify({ password: password }) });
    },
    getState: async function () {
      return request('/api/workshops/' + encodeURIComponent(session.workshopId) + '/state', { headers: headers() });
    },
    replaceState: async function (state, baseRevision) {
      return request('/api/workshops/' + encodeURIComponent(session.workshopId) + '/state', {
        method: 'PUT', headers: headers(), body: JSON.stringify({ state: state, baseRevision: baseRevision })
      });
    },
    transaction: async function (kind, payload) {
      return request('/api/workshops/' + encodeURIComponent(session.workshopId) + '/transactions/' + kind, {
        method: 'POST', headers: headers(), body: JSON.stringify(payload)
      });
    }
  };
}());