const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SERVER_SECRET = String(process.env.OPENLINE_SERVER_SECRET || '');
const MASTER_PASSWORD = String(process.env.OPENLINE_MASTER_PASSWORD || '');
const MASTER_PASSWORD_HASH = String(process.env.OPENLINE_MASTER_PASSWORD_HASH || '');
const DATA_FILE = path.resolve(process.env.OPENLINE_DATA_FILE || path.join(__dirname, 'data', 'openline.json'));
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_STATE_ITEMS = 10000;

if (SERVER_SECRET.length < 32) {
  throw new Error('OPENLINE_SERVER_SECRET must contain at least 32 characters');
}
if (!MASTER_PASSWORD && !MASTER_PASSWORD_HASH) {
  throw new Error('Set OPENLINE_MASTER_PASSWORD or OPENLINE_MASTER_PASSWORD_HASH before starting');
}

const allowedOrigins = String(process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=()');
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const sameOrigin = origin && origin === `${req.protocol}://${req.get('host')}`;
  if (!origin || sameOrigin) return next();
  if (!allowedOrigins.includes(origin)) return res.status(403).json({ error: 'origin_not_allowed' });
  return cors({ origin, credentials: false })(req, res, next);
});
app.use(express.json({ limit: '4mb', strict: true }));

function now() { return Date.now(); }
function token(bytes = 32) { return crypto.randomBytes(bytes).toString('hex'); }
function normalizeId(value) { return String(value || '').trim().toUpperCase(); }
function safeId(value) { return /^[A-Z0-9][A-Z0-9_-]{2,47}$/.test(value); }
function safeDeviceId(value) { return /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,95}$/.test(String(value || '')); }
function safeBranch(value) { return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 80; }
function equal(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function hashPassword(password, salt = token(16)) {
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}
function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt, expected] = String(stored).split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return equal(actual, expected);
}
function masterPasswordMatches(password) {
  if (MASTER_PASSWORD_HASH) return verifyPassword(password, MASTER_PASSWORD_HASH);
  return equal(String(password), MASTER_PASSWORD);
}
function trackingToken(workshopId, orderId) {
  return crypto.createHmac('sha256', SERVER_SECRET).update(`${workshopId}:${orderId}`).digest('hex');
}

function defaultSettings(name = 'OpenLine') {
  return { name, subtitle: 'Servicio Técnico Profesional', adminPhone: '', branches: ['Central'], usersByBranch: {}, logo: '' };
}
function emptyState(name) {
  return {
    revision: 0,
    repairs: [],
    stockItems: [],
    cashMovements: [],
    cashClosures: [],
    sales: [],
    settings: defaultSettings(name)
  };
}
function sanitizeSettings(settings, fallbackName) {
  const input = settings && typeof settings === 'object' ? settings : {};
  const branches = Array.isArray(input.branches)
    ? [...new Set(input.branches.filter(safeBranch).map((branch) => branch.trim()))].slice(0, 100)
    : ['Central'];
  if (!branches.length) branches.push('Central');
  return {
    name: String(input.name || fallbackName || 'OpenLine').slice(0, 120),
    subtitle: String(input.subtitle || 'Servicio Técnico Profesional').slice(0, 180),
    adminPhone: String(input.adminPhone || '').replace(/[^\d+]/g, '').slice(0, 30),
    branches,
    usersByBranch: typeof input.usersByBranch === 'object' && input.usersByBranch !== null ? input.usersByBranch : {},
    logo: typeof input.logo === 'string' && input.logo.length <= 800000 ? input.logo : ''
  };
}
function sanitizeState(input, workshop) {
  if (!input || typeof input !== 'object') throw new Error('invalid state');
  const arrays = ['repairs', 'stockItems', 'cashMovements', 'cashClosures', 'sales'];
  const state = {};
  for (const key of arrays) {
    if (!Array.isArray(input[key]) || input[key].length > MAX_STATE_ITEMS) throw new Error(`invalid ${key}`);
    state[key] = input[key];
  }
  state.settings = sanitizeSettings(input.settings, workshop.name);
  return state;
}
function publicWorkshop(workshop) {
  return {
    workshopId: workshop.id,
    name: workshop.name,
    branches: workshop.state.settings.branches,
    license: { type: workshop.license.type, expiresAt: workshop.license.expiresAt || null },
    createdAt: workshop.createdAt,
    members: Object.values(workshop.members).filter((member) => !member.revoked).length
  };
}
function publicState(workshop) {
  return {
    workshopId: workshop.id,
    revision: workshop.state.revision,
    repairs: workshop.state.repairs,
    stockItems: workshop.state.stockItems,
    cashMovements: workshop.state.cashMovements,
    cashClosures: workshop.state.cashClosures,
    sales: workshop.state.sales,
    settings: workshop.state.settings,
    license: { type: workshop.license.type, expiresAt: workshop.license.expiresAt || null }
  };
}

function loadStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (parsed && parsed.workshops) return parsed;
  } catch (_) {}
  return { version: 1, workshops: {} };
}
let store = loadStore();
let writeQueue = Promise.resolve();
function persist() {
  const snapshot = JSON.stringify(store, null, 2);
  writeQueue = writeQueue.then(async () => {
    await fs.promises.mkdir(path.dirname(DATA_FILE), { recursive: true });
    const temporary = `${DATA_FILE}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporary, snapshot, { mode: 0o600 });
    await fs.promises.rename(temporary, DATA_FILE);
  });
  return writeQueue;
}

const sessions = new Map();
const failedAttempts = new Map();
function rateLimit(key, limit = 10, windowMs = 60_000) {
  const current = failedAttempts.get(key) || { count: 0, resetAt: now() + windowMs };
  if (current.resetAt < now()) {
    current.count = 0;
    current.resetAt = now() + windowMs;
  }
  current.count += 1;
  failedAttempts.set(key, current);
  return current.count <= limit;
}
function createSession(data) {
  const sessionToken = token(32);
  sessions.set(sessionToken, { ...data, token: sessionToken, expiresAt: now() + SESSION_TTL_MS });
  return { sessionToken, expiresAt: now() + SESSION_TTL_MS };
}
function bearer(req) {
  return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
}
function requireSession(req, res, next) {
  const session = sessions.get(bearer(req));
  if (!session || session.expiresAt <= now()) return res.status(401).json({ error: 'unauthorized' });
  const workshop = store.workshops[session.workshopId];
  if (!workshop || !workshop.members[session.deviceId] || workshop.members[session.deviceId].revoked) {
    return res.status(403).json({ error: 'device_revoked' });
  }
  req.session = session;
  req.workshop = workshop;
  return next();
}
function requireMaster(req, res, next) {
  const session = sessions.get(bearer(req));
  if (!session || session.role !== 'master' || session.expiresAt <= now()) return res.status(401).json({ error: 'master_unauthorized' });
  req.masterSession = session;
  return next();
}
function getWorkshop(req, res) {
  const id = normalizeId(req.params.workshopId);
  if (!safeId(id) || !req.workshop || id !== req.workshop.id) {
    res.status(403).json({ error: 'workshop_scope_violation' });
    return null;
  }
  return req.workshop;
}
function commitState(workshop, nextState) {
  workshop.state = { ...nextState, revision: workshop.state.revision + 1 };
  return persist();
}

app.get('/health', (_req, res) => res.json({ ok: true, mqtt: false, storage: 'server' }));

app.post('/api/master/login', (req, res) => {
  const key = `master:${req.ip}`;
  if (!rateLimit(key)) return res.status(429).json({ error: 'too_many_attempts' });
  const password = String(req.body && req.body.password || '');
  if (!masterPasswordMatches(password)) return res.status(401).json({ error: 'invalid_credentials' });
  failedAttempts.delete(key);
  res.json({ ...createSession({ role: 'master' }) });
});

app.get('/api/master/workshops', requireMaster, (_req, res) => {
  res.json({ workshops: Object.values(store.workshops).map(publicWorkshop) });
});

app.post('/api/master/workshops', requireMaster, async (req, res) => {
  const body = req.body || {};
  let workshopId = normalizeId(body.workshopId);
  if (!workshopId) workshopId = `TALLER-${Math.floor(1000 + Math.random() * 9000)}`;
  const password = String(body.password || '');
  const name = String(body.name || workshopId).trim().slice(0, 120);
  if (!safeId(workshopId) || !workshopId.startsWith('TALLER-')) return res.status(400).json({ error: 'invalid_workshop_id' });
  if (password.length < 8) return res.status(400).json({ error: 'password_min_8' });
  if (store.workshops[workshopId]) return res.status(409).json({ error: 'workshop_exists' });
  const settings = sanitizeSettings({ ...defaultSettings(name), branches: body.branches }, name);
  store.workshops[workshopId] = {
    id: workshopId,
    name,
    passwordHash: hashPassword(password),
    state: { ...emptyState(name), settings },
    members: {},
    license: { type: 'DEMO', createdAt: now() },
    createdAt: now()
  };
  await persist();
  res.status(201).json({ workshop: publicWorkshop(store.workshops[workshopId]), joinPassword: password });
});

app.post('/api/master/workshops/:workshopId/license', requireMaster, async (req, res) => {
  const id = normalizeId(req.params.workshopId);
  const workshop = store.workshops[id];
  if (!workshop) return res.status(404).json({ error: 'workshop_not_found' });
  const type = req.body && req.body.type === 'SEM6' ? 'SEM6' : 'LIFETIME';
  const key = `OL-${type}-${token(9).toUpperCase()}`;
  workshop.license = { type, keyHash: hashPassword(key), issuedAt: now(), expiresAt: type === 'SEM6' ? now() + 183 * 86400000 : null };
  await persist();
  res.json({ workshopId: id, type, key, expiresAt: workshop.license.expiresAt });
});

app.post('/api/auth/join', async (req, res) => {
  const body = req.body || {};
  const workshopId = normalizeId(body.workshopId);
  const deviceId = String(body.deviceId || '');
  const password = String(body.password || '');
  const key = `join:${req.ip}:${workshopId}`;
  if (!rateLimit(key) || !safeId(workshopId) || !safeDeviceId(deviceId) || password.length < 8) {
    return res.status(429).json({ error: 'invalid_or_rate_limited_request' });
  }
  const workshop = store.workshops[workshopId];
  if (!workshop || !verifyPassword(password, workshop.passwordHash)) {
    return res.status(401).json({ error: 'invalid_workshop_credentials' });
  }
  failedAttempts.delete(key);
  const branch = safeBranch(body.branch) && workshop.state.settings.branches.includes(body.branch) ? body.branch : workshop.state.settings.branches[0];
  const user = String(body.user || 'Admin').trim().slice(0, 80) || 'Admin';
  workshop.members[deviceId] = { deviceId, user, branch, revoked: false, joinedAt: now(), lastSeenAt: now() };
  await persist();
  res.json({
    ...createSession({ role: 'workshop_admin', workshopId, deviceId, user, branch }),
    workshopId,
    deviceId,
    user,
    branch,
    state: publicState(workshop)
  });
});

app.post('/api/auth/confirm', requireSession, (req, res) => {
  const password = String(req.body && req.body.password || '');
  if (!verifyPassword(password, req.workshop.passwordHash)) return res.status(403).json({ error: 'invalid_credentials' });
  return res.json({ ok: true });
});

app.get('/api/workshops/:workshopId/state', requireSession, (req, res) => {
  const workshop = getWorkshop(req, res);
  if (!workshop) return;
  workshop.members[req.session.deviceId].lastSeenAt = now();
  res.json({ state: publicState(workshop) });
});

app.put('/api/workshops/:workshopId/state', requireSession, async (req, res) => {
  const workshop = getWorkshop(req, res);
  if (!workshop) return;
  const baseRevision = Number(req.body && req.body.baseRevision);
  if (!Number.isInteger(baseRevision) || baseRevision !== workshop.state.revision) {
    return res.status(409).json({ error: 'state_conflict', state: publicState(workshop) });
  }
  try {
    const nextState = sanitizeState(req.body.state, workshop);
    await commitState(workshop, nextState);
    res.json({ state: publicState(workshop) });
  } catch (error) {
    res.status(400).json({ error: error.message || 'invalid_state' });
  }
});

app.post('/api/workshops/:workshopId/transactions/repair-intake', requireSession, async (req, res) => {
  const workshop = getWorkshop(req, res);
  if (!workshop) return;
  const { repair, cashMovement } = req.body || {};
  if (!repair || !repair.id || !cashMovement || !cashMovement.id) return res.status(400).json({ error: 'invalid_transaction' });
  if (workshop.state.repairs.some((item) => item.id === repair.id)) return res.json({ state: publicState(workshop), idempotent: true });
  repair.trackingToken = trackingToken(workshop.id, repair.id);
  const nextState = sanitizeState(workshop.state, workshop);
  nextState.repairs = [repair, ...nextState.repairs].slice(0, MAX_STATE_ITEMS);
  if (Number(cashMovement.amount) > 0) nextState.cashMovements = [cashMovement, ...nextState.cashMovements].slice(0, MAX_STATE_ITEMS);
  await commitState(workshop, nextState);
  res.status(201).json({ state: publicState(workshop) });
});

app.post('/api/workshops/:workshopId/transactions/sale', requireSession, async (req, res) => {
  const workshop = getWorkshop(req, res);
  if (!workshop) return;
  const { sale, cashMovement, stockDeltas } = req.body || {};
  if (!sale || !sale.id || !cashMovement || !cashMovement.id || !Array.isArray(stockDeltas)) {
    return res.status(400).json({ error: 'invalid_sale_transaction' });
  }
  if (workshop.state.sales.some((item) => item.id === sale.id)) return res.json({ state: publicState(workshop), idempotent: true });
  const nextState = sanitizeState(workshop.state, workshop);
  for (const delta of stockDeltas) {
    const item = nextState.stockItems.find((candidate) => String(candidate.code) === String(delta.code) && (candidate.branch || 'Central') === delta.branch);
    const quantity = Number(delta.quantity);
    if (!item || !Number.isInteger(quantity) || quantity < 1 || Number(item.qty) < quantity) {
      return res.status(409).json({ error: 'stock_conflict', state: publicState(workshop) });
    }
    item.qty = Number(item.qty) - quantity;
  }
  nextState.sales = [sale, ...nextState.sales].slice(0, MAX_STATE_ITEMS);
  nextState.cashMovements = [cashMovement, ...nextState.cashMovements].slice(0, MAX_STATE_ITEMS);
  await commitState(workshop, nextState);
  res.status(201).json({ state: publicState(workshop) });
});

app.post('/api/workshops/:workshopId/transactions/repair-payment', requireSession, async (req, res) => {
  const workshop = getWorkshop(req, res);
  if (!workshop) return;
  const { repairId, newAdvance, cashMovement } = req.body || {};
  const repair = workshop.state.repairs.find((item) => item.id === repairId);
  if (!repair || !cashMovement || !cashMovement.id) return res.status(404).json({ error: 'repair_not_found' });
  if (Number(newAdvance) <= Number(repair.advance || 0) || Number(newAdvance) > Number(repair.budget || 0)) {
    return res.status(409).json({ error: 'invalid_payment_amount', state: publicState(workshop) });
  }
  if (workshop.state.cashMovements.some((item) => item.id === cashMovement.id)) return res.json({ state: publicState(workshop), idempotent: true });
  const nextState = sanitizeState(workshop.state, workshop);
  const nextRepair = nextState.repairs.find((item) => item.id === repairId);
  nextRepair.advance = Number(newAdvance);
  nextState.cashMovements = [cashMovement, ...nextState.cashMovements].slice(0, MAX_STATE_ITEMS);
  await commitState(workshop, nextState);
  res.status(201).json({ state: publicState(workshop) });
});

app.get('/api/public/orders', (req, res) => {
  const workshopId = normalizeId(req.query.workshopId);
  const orderId = String(req.query.orderId || '');
  const suppliedToken = String(req.query.token || '');
  const workshop = store.workshops[workshopId];
  if (!workshop || !orderId || !equal(suppliedToken, trackingToken(workshopId, orderId))) {
    return res.status(404).json({ error: 'not_found' });
  }
  const repair = workshop.state.repairs.find((item) => item.id === orderId);
  if (!repair) return res.status(404).json({ error: 'not_found' });
  res.json({
    id: repair.id,
    status: repair.status,
    brand: repair.deviceBrand,
    model: repair.deviceModel,
    fault: repair.fault,
    repairDetails: repair.repairDetails || '',
    budget: repair.budget,
    advance: repair.advance,
    updatedAt: repair.updatedAt || repair.createdAt,
    workshopName: workshop.state.settings.name,
    workshopSubtitle: workshop.state.settings.subtitle,
    workshopPhone: workshop.state.settings.adminPhone,
    workshopLogo: workshop.state.settings.logo
  });
});

app.use(express.static(__dirname, { index: 'index.html', dotfiles: 'deny', redirect: false }));
app.use((error, _req, res, next) => {
  if (error && error.message === 'origin not allowed') return res.status(403).json({ error: 'origin_not_allowed' });
  return next(error);
});

app.listen(PORT, () => console.log(`OpenLine secure server listening on ${PORT}`));