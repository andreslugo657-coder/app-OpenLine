/* Browser client for the secure gateway. Set window.OPENLINE_API_URL before loading this file. */
(function () {
  'use strict';
  const base = String(window.OPENLINE_API_URL || '').replace(/\/$/, '');
  let session = null;
  function headers() { return { 'Content-Type': 'application/json', 'X-Device-ID': session.deviceId, Authorization: 'Bearer ' + session.sessionToken }; }
  window.openLineSecureSync = {
    authorize: async function (workshopId, deviceId, user, branch, adminPin) {
      if (!base) throw new Error('OPENLINE_API_URL is not configured');
      const response = await fetch(base + '/api/authorize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workshopId, deviceId, user, branch, adminPin }) });
      if (!response.ok) throw new Error('Authorization failed');
      session = await response.json();
      return session;
    },
    publish: async function (channel, data) {
      if (!session) throw new Error('Device is not authorized');
      const response = await fetch(base + '/api/sync/' + encodeURIComponent(channel), { method: 'POST', headers: headers(), body: JSON.stringify(data) });
      if (!response.ok) throw new Error('Sync failed');
      return response.json();
    },
    pull: async function (channel) {
      if (!session) throw new Error('Device is not authorized');
      const response = await fetch(base + '/api/sync/' + encodeURIComponent(channel), { headers: headers() });
      if (!response.ok) throw new Error('Pull failed');
      return response.json();
    }
  };
}());
