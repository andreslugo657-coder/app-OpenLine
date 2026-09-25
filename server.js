const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const mqtt = require('mqtt');

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 3000);
const SERVER_SECRET = process.env.OPENLINE_SERVER_SECRET;
const ADMIN_PIN = process.env.OPENLINE_ADMIN_PIN;
const MQTT_URL = process.env.MQTT_URL;
const MQTT_USERNAME = process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;
const sessions = new Map();

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

function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function token() { return crypto.randomBytes(32).toString('hex'); }
function topic(workshop, channel) { return `openline/${workshop}/state/${channel}`; }
function safeId(value) { return /^[A-Z0-9_-]{3,48}$/.test(value); }
function equal(a, b) { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function auth(req, res) {
  const id = req.headers['x-device-id'];
  const session = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const record = sessions.get(id);
  if (!record || !equal(record.session, session) || record.expires < Date.now()) return res.status(401).json({ error: 'unauthorized' });
  return record;
}

app.get('/health', (_req, res) => res.json({ ok: true, mqtt: mqttClient.connected }));

app.post('/api/authorize', (req, res) => {
  const { workshopId, deviceId, user = 'Admin', branch = 'Central', adminPin } = req.body || {};
  if (!safeId(String(workshopId || '').toUpperCase()) || !safeId(String(deviceId || '')) || !adminPin) return res.status(400).json({ error: 'invalid request' });
  if (!equal(hash(adminPin), hash(ADMIN_PIN))) return res.status(403).json({ error: 'invalid credentials' });
  const record = { workshopId: String(workshopId).toUpperCase(), deviceId, user, branch, session: token(), expires: Date.now() + 7 * 86400000 };
  sessions.set(deviceId, record);
  res.json({ workshopId: record.workshopId, deviceId, sessionToken: record.session, expiresAt: record.expires });
});

app.post('/api/sync/:channel', (req, res) => {
  const record = auth(req, res); if (!record) return;
  const allowed = ['repairs', 'stock', 'sales', 'cash', 'settings'];
  if (!allowed.includes(req.params.channel)) return res.status(400).json({ error: 'invalid channel' });
  if (!mqttClient.connected) return res.status(503).json({ error: 'broker unavailable' });
  const payload = { sender: record.deviceId, ts: Date.now(), data: req.body };
  mqttClient.publish(topic(record.workshopId, req.params.channel), JSON.stringify(payload), { qos: 1, retain: true }, (error) => {
    if (error) return res.status(502).json({ error: 'publish failed' });
    res.json({ ok: true, ts: payload.ts });
  });
});

app.get('/api/sync/:channel', (req, res) => {
  const record = auth(req, res); if (!record) return;
  const allowed = ['repairs', 'stock', 'sales', 'cash', 'settings'];
  if (!allowed.includes(req.params.channel)) return res.status(400).json({ error: 'invalid channel' });
  const key = `${record.workshopId}/${req.params.channel}`;
  res.json({ ok: true, data: cache.get(key) || null });
});

const cache = new Map();
mqttClient.on('connect', () => {
  mqttClient.subscribe('openline/+/state/+', { qos: 1 });
});
mqttClient.on('message', (rawTopic, message) => {
  const match = rawTopic.match(/^openline\/([A-Z0-9_-]{3,48})\/state\/(repairs|stock|sales|cash|settings)$/);
  if (!match) return;
  try { cache.set(`${match[1]}/${match[2]}`, JSON.parse(message.toString())); } catch (_) {}
});

app.listen(PORT, () => console.log(`OpenLine secure gateway listening on ${PORT}`));
