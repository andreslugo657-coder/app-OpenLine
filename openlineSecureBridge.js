(function () {
  'use strict';

  const channelByFunction = {
    publishRepairsMQTT: 'repairs',
    publishStockMQTT: 'stock',
    publishSalesMQTT: 'sales',
    publishCashMQTT: 'cash',
    publishSettingsMQTT: 'settings',
    publishMQTT: 'settings'
  };

  function safeGet(name, fallback) {
    try {
      return window[name] !== undefined ? window[name] : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function getContext() {
    const workshopId = safeGet('currentWorkshopId', 'TALLER-XXXX');
    const myDeviceId = safeGet('myDeviceId', 'dev_' + Math.random().toString(36).slice(2, 9));
    const activeUser = safeGet('activeUser', 'Admin');
    const localBranch = safeGet('localBranch', 'Central');
    const settings = safeGet('workshopSettings', {}) || {};
    return {
      workshopId: String(workshopId).toUpperCase(),
      deviceId: String(myDeviceId),
      user: String(activeUser || 'Admin'),
      branch: String(localBranch || 'Central'),
      adminPin: settings.adminPin || '1234'
    };
  }

  function ensureClient() {
    if (window.openLineSecureSync) return Promise.resolve(true);

    if (!window.OPENLINE_API_URL) {
      console.warn('[OpenLine Secure Bridge] OPENLINE_API_URL is not configured');
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      const existing = document.querySelector('script[data-openline-secure-client]');
      if (existing) {
        existing.addEventListener('load', () => resolve(Boolean(window.openLineSecureSync)), { once: true });
        return;
      }

      const script = document.createElement('script');
      script.src = './secureSyncClient.js';
      script.async = true;
      script.setAttribute('data-openline-secure-client', 'true');
      script.onload = function () {
        resolve(Boolean(window.openLineSecureSync));
      };
      script.onerror = function () {
        console.warn('[OpenLine Secure Bridge] secureSyncClient.js failed to load');
        resolve(false);
      };
      document.head.appendChild(script);
    });
  }

  async function ensureSession() {
    if (window.__openlineSecureSession && window.__openlineSecureSession.expiresAt > Date.now()) {
      return window.__openlineSecureSession;
    }

    const clientReady = await ensureClient();
    if (!clientReady || !window.openLineSecureSync) {
      return null;
    }

    const ctx = getContext();
    try {
      const session = await window.openLineSecureSync.authorize(
        ctx.workshopId,
        ctx.deviceId,
        ctx.user,
        ctx.branch,
        ctx.adminPin
      );

      window.__openlineSecureSession = session;
      return session;
    } catch (error) {
      console.warn('[OpenLine Secure Bridge] secure authorize failed:', error);
      return null;
    }
  }

  function safeCall(fn, args) {
    if (typeof fn === 'function') {
      try {
        return fn.apply(window, args || []);
      } catch (error) {
        console.warn('[OpenLine Secure Bridge] fallback call failed:', error);
      }
    }
    return undefined;
  }

  function buildData(channel) {
    const repairs = safeGet('repairs', []) || [];
    const stockItems = safeGet('stockItems', []) || [];
    const sales = safeGet('sales', []) || [];
    const cashMovements = safeGet('cashMovements', []) || [];
    const cashClosures = safeGet('cashClosures', []) || [];
    const settings = safeGet('workshopSettings', {}) || {};

    if (channel === 'repairs') {
      return repairs.map(function (r) {
        const copy = Object.assign({}, r);
        copy.photos = [];
        return copy;
      }).slice(0, 100);
    }

    if (channel === 'stock') {
      return stockItems;
    }

    if (channel === 'sales') {
      return sales.slice(0, 100);
    }

    if (channel === 'cash') {
      return { cashMovements: cashMovements.slice(0, 150), cashClosures: cashClosures.slice(0, 50) };
    }

    if (channel === 'settings') {
      return settings;
    }

    return null;
  }

  function patchPublisher(functionName) {
    const original = safeGet(functionName);
    if (!original || window.__openlineSecureBridgePatched[functionName]) {
      return;
    }

    window.__openlineSecureBridgePatched[functionName] = true;

    window[functionName] = async function () {
      const channel = channelByFunction[functionName] || 'settings';
      const payload = buildData(channel);

      try {
        const session = await ensureSession();
        if (session && window.openLineSecureSync) {
          await window.openLineSecureSync.publish(channel, payload);
          return true;
        }
      } catch (error) {
        console.warn('[OpenLine Secure Bridge] publish via API failed, falling back to original:', error);
      }

      return safeCall(original, arguments);
    };
  }

  function initBridge() {
    if (!window.__openlineSecureBridgeInitialized) {
      window.__openlineSecureBridgeInitialized = true;
      window.__openlineSecureBridgePatched = {};

      Object.keys(channelByFunction).forEach(function (fnName) {
        patchPublisher(fnName);
      });

      if (!window.OPENLINE_API_URL) {
        window.OPENLINE_API_URL = 'http://localhost:3000';
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBridge, { once: true });
  } else {
    initBridge();
  }

  window.ensureOpenLineSecureSession = ensureSession;
  window.openLineSecureBridge = { ensureSession, initBridge };
}());
