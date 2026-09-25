const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const mqtt = require('mqtt');

const app = express();
app.use(cors({
  origin: process.env.CORS_ORIGIN || true,
  credentials: true
}));
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 3000);
const SERVER_SECRET = process.env.OPENLINE_SERVER_SECRET;
const ADMIN_PIN = process.env.OPENLINE_ADMIN_PIN;
const MQTT_URL = process.env.MQTT_URL;
const MQTT_USERNAME = process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;
const sessions = new Map();
const cache = new Map();

if (!SERVER_SECRET || !ADMIN_PIN || !MQTT_URL || !MQTT_USERNAME || !MQTT_PASSWORD) {
  throw new Error('Missing OPENLINE_SERVER_SECRET, OPENLINE_ADMIN_PIN, MQTT_URL, MQTT_USERNAME or MQTT_PASSWORD');
}

const mqttClient = mqtt.connect(MQTT_URL, {
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
  protocolVersion: 5,
  clean: true,
  reconnectPeriod: 5000,
  connectTimeout: 10000
});

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function token() {
  return crypto.randomBytes(32).toString('hex');
}

function topic(workshop, channel) {
  return `openline/${workshop}/state/${channel}`;
}

function safeId(value) {
  return /^[A-Z0-9_-]{3,48}$/.test(String(value || '').toUpperCase());
}

function equal(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function auth(req, res) {
  const deviceId = String(req.headers['x-device-id'] || '');
  const sessionHeader = req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
  const record = sessions.get(deviceId);

  if (!record || !equal(record.session, sessionHeader) || record.expires < Date.now()) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }

  return record;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, mqtt: mqttClient.connected });
});

app.post('/api/authorize', (req, res) => {
  const { workshopId, deviceId, user = 'Admin', branch = 'Central', adminPin } = req.body || {};

  if (!safeId(workshopId) || !safeId(deviceId) || !adminPin) {
    return res.status(400).json({ error: 'invalid request' });
  }

  if (!equal(hash(adminPin), hash(ADMIN_PIN))) {
    return res.status(403).json({ error: 'invalid credentials' });
  }

  const record = {
    workshopId: String(workshopId).toUpperCase(),
    deviceId: String(deviceId),
    user,
    branch,
    session: token(),
    expires: Date.now() + 7 * 86400000
  };

  sessions.set(record.deviceId, record);
  return res.json({
    workshopId: record.workshopId,
    deviceId: record.deviceId,
    sessionToken: record.session,
    expiresAt: record.expires
  });
});

app.post('/api/sync/:channel', (req, res) => {
  const record = auth(req, res);
  if (!record) return;

  const allowed = ['repairs', 'stock', 'sales', 'cash', 'settings'];
  if (!allowed.includes(req.params.channel)) {
    return res.status(400).json({ error: 'invalid channel' });
  }

  if (!mqttClient.connected) {
    return res.status(503).json({ error: 'broker unavailable' });
  }

  const payload = { sender: record.deviceId, ts: Date.now(), data: req.body };
  mqttClient.publish(topic(record.workshopId, req.params.channel), JSON.stringify(payload), { qos: 1, retain: true }, (error) => {
    if (error) return res.status(502).json({ error: 'publish failed' });
    return res.json({ ok: true, ts: payload.ts });
  });
});

app.get('/api/sync/:channel', (req, res) => {
  const record = auth(req, res);
  if (!record) return;

  const allowed = ['repairs', 'stock', 'sales', 'cash', 'settings'];
  if (!allowed.includes(req.params.channel)) {
    return res.status(400).json({ error: 'invalid channel' });
  }

  const key = `${record.workshopId}/${req.params.channel}`;
  return res.json({ ok: true, data: cache.get(key) || null });
});

mqttClient.on('connect', () => {
  mqttClient.subscribe('openline/+/state/+', { qos: 1 });
});

mqttClient.on('message', (rawTopic, message) => {
  const match = rawTopic.match(/^openline\/([A-Z0-9_-]{3,48})\/state\/(repairs|stock|sales|cash|settings)$/);
  if (!match) return;

  try {
    cache.set(`${match[1]}/${match[2]}`, JSON.parse(message.toString()));
  } catch (_) {}
});

app.listen(PORT, () => {
  console.log(`OpenLine secure gateway listening on ${PORT}`);
});
