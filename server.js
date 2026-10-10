'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const helmet = require('helmet');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });
const ROOT = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS = path.join(ROOT, 'uploads');
const STATE_FILE = path.join(ROOT, 'state.json');
fs.mkdirSync(UPLOADS, { recursive: true });
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || '';
if (process.env.NODE_ENV === 'production' && (PASSWORD.length < 20 || SECRET.length < 32)) {
  console.error('Set ADMIN_PASSWORD (20+ characters) and SESSION_SECRET (32+ characters).');
  process.exit(1);
}
if (!PASSWORD || !SECRET) console.warn('WARNING: configure ADMIN_PASSWORD and SESSION_SECRET before internet deployment.');
const passwordHash = bcrypt.hashSync(PASSWORD, 12);
const defaultTracks = [
  { id: 'demo-1', title: 'Midnight Signals', url: '/music/midnight.wav', source: 'demo' },
  { id: 'demo-2', title: 'Neon Drift', url: '/music/neon.wav', source: 'demo' }
];
let tracks = defaultTracks.slice();
let current = { trackId: tracks[Math.floor(Math.random() * tracks.length)].id, startedAt: Date.now(), nonce: crypto.randomUUID() };
try {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  if (Array.isArray(saved.tracks)) tracks = [...defaultTracks, ...saved.tracks.filter(t => t && typeof t.id === 'string' && typeof t.title === 'string' && typeof t.url === 'string' && t.source !== 'demo')];
  if (saved.current && tracks.some(t => t.id === saved.current.trackId)) current = saved.current;
} catch (_) { /* new installation */ }
function persist() {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ tracks: tracks.filter(t => t.source !== 'demo'), current }, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}
function publicState() { return { current, track: tracks.find(t => t.id === current.trackId), serverTime: Date.now() }; }
function broadcast() { io.emit('station', publicState()); io.to('admin').emit('listeners', io.engine.clientsCount); }
const sign = value => crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
function makeToken() { const value = `${Date.now() + 12 * 3600000}.${crypto.randomBytes(16).toString('hex')}`; return value + '.' + sign(value); }
function isAdmin(req) {
  const token = req.cookies.sw_admin;
  if (typeof token !== 'string') return false;
  const point = token.lastIndexOf('.');
  if (point < 0) return false;
  const raw = token.slice(0, point), signature = token.slice(point + 1);
  const expected = sign(raw);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  const expire = Number(raw.split('.')[0]);
  return Number.isFinite(expire) && expire > Date.now();
}
function requireAdmin(req, res, next) { if (!isAdmin(req)) return res.status(401).json({ error: 'Требуется вход в админку' }); next(); }
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '16kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/music', express.static(path.join(__dirname, 'music'), { maxAge: '7d' }));
app.use('/uploads', express.static(UPLOADS, { maxAge: '1d', setHeaders(res) { res.setHeader('X-Content-Type-Options', 'nosniff'); } }));
app.get('/api/state', (req,res) => res.json(publicState()));
app.get('/api/me', (req,res) => res.json({ admin: isAdmin(req) }));
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Слишком много попыток. Попробуйте позже.' } });
app.post('/api/login', loginLimiter, (req,res) => {
  if (typeof req.body.password !== 'string' || !bcrypt.compareSync(req.body.password, passwordHash)) return res.status(401).json({ error: 'Неверный пароль' });
  res.cookie('sw_admin', makeToken(), { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 12 * 3600000, path: '/' });
  res.json({ ok: true });
});
app.post('/api/logout', (req,res) => { res.clearCookie('sw_admin', { path: '/' }); res.json({ ok: true }); });
app.get('/api/admin/tracks', requireAdmin, (req,res) => res.json({ tracks, listeners: io.engine.clientsCount }));
function setTrack(id) {
  if (!tracks.some(t => t.id === id)) return false;
  current = { trackId: id, startedAt: Date.now(), nonce: crypto.randomUUID() };
  persist(); broadcast(); return true;
}
app.post('/api/admin/play', requireAdmin, (req,res) => {
  if (typeof req.body.id !== 'string' || !setTrack(req.body.id)) return res.status(400).json({ error: 'Трек не найден' });
  res.json(publicState());
});
app.post('/api/admin/random', requireAdmin, (req,res) => {
  const choices = tracks.length > 1 ? tracks.filter(t => t.id !== current.trackId) : tracks;
  const chosen = choices[Math.floor(Math.random() * choices.length)];
  setTrack(chosen.id); res.json(publicState());
});
app.post('/api/admin/url', requireAdmin, (req,res) => {
  const title = typeof req.body.title === 'string' ? req.body.title.trim().slice(0, 90) : '';
  const url = typeof req.body.url === 'string' ? req.body.url.trim() : '';
  let parsed;
  try { parsed = new URL(url); } catch (_) { return res.status(400).json({ error: 'Некорректная ссылка' }); }
  if (!title || parsed.protocol !== 'https:' || parsed.username || parsed.password || url.length > 2048) return res.status(400).json({ error: 'Укажите название и прямую HTTPS-ссылку на аудиофайл' });
  const track = { id: crypto.randomUUID(), title, url, source: 'url' };
  tracks.push(track); persist(); res.status(201).json(track);
});
const storage = multer.diskStorage({
  destination: UPLOADS,
  filename: (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase())
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 }, fileFilter: (req,file,cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!['.mp3','.ogg','.wav','.m4a','.webm'].includes(ext)) return cb(new Error('Разрешены MP3, OGG, WAV, M4A, WebM'));
  cb(null, true);
} });
app.post('/api/admin/upload', requireAdmin, (req,res,next) => upload.single('audio')(req,res,next), (req,res) => {
  if (!req.file) return res.status(400).json({ error: 'Выберите аудиофайл' });
  const track = { id: crypto.randomUUID(), title: path.parse(req.file.originalname).name.slice(0,90), url: '/uploads/' + req.file.filename, source: 'upload' };
  tracks.push(track); persist(); res.status(201).json(track);
});
app.delete('/api/admin/tracks/:id', requireAdmin, (req,res) => {
  const track = tracks.find(t => t.id === req.params.id);
  if (!track || track.source === 'demo') return res.status(400).json({ error: 'Нельзя удалить этот трек' });
  if (current.trackId === track.id) return res.status(400).json({ error: 'Сначала включите другой трек' });
  tracks = tracks.filter(t => t.id !== track.id);
  if (track.source === 'upload') fs.rmSync(path.join(UPLOADS, path.basename(track.url)), { force: true });
  persist(); res.json({ ok: true });
});
io.use((socket,next) => {
  const header = socket.handshake.headers.cookie || '';
  const cookies = Object.fromEntries(header.split(';').map(part => { const i=part.indexOf('='); return i >= 0 ? [part.slice(0,i).trim(), decodeURIComponent(part.slice(i+1))] : ['', '']; }));
  socket.data.admin = isAdmin({ cookies }); next();
});
io.on('connection', socket => {
  if (socket.data.admin) socket.join('admin');
  socket.emit('station', publicState());
  io.to('admin').emit('listeners', io.engine.clientsCount);
  socket.on('disconnect', () => io.to('admin').emit('listeners', io.engine.clientsCount));
});
app.use((err,req,res,next) => { console.error(err.message); res.status(err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.message || 'Ошибка запроса' }); });
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`SyncWave on port ${PORT}`));
