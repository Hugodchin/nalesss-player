require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const safeName = Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, safeName);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

let sharedState = {
  queue: [],
  currentTrack: null,
  isPlaying: false,
  progress: 0,
  startedAt: null,
  pausedProgressMs: 0,
  users: {},
  chat: []
};

const generateId = () => Math.random().toString(36).substr(2, 9);

app.get('/login', (req, res) => {
  const scopes = [
    'streaming',
    'user-read-email',
    'user-read-private',
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing',
    'playlist-read-private',
    'playlist-read-collaborative'
  ].join(' ');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.SPOTIFY_CLIENT_ID,
    scope: scopes,
    redirect_uri: process.env.REDIRECT_URI,
    state: generateId()
  });

  res.redirect('https://accounts.spotify.com/authorize?' + params.toString());
});

app.get('/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?error=' + error);

  try {
    const response = await axios.post('https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.REDIRECT_URI,
        client_id: process.env.SPOTIFY_CLIENT_ID,
        client_secret: process.env.SPOTIFY_CLIENT_SECRET
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, expires_in } = response.data;
    res.cookie('access_token', access_token, { maxAge: expires_in * 1000 });
    res.cookie('refresh_token', refresh_token, { maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.redirect('/');
  } catch (err) {
    console.error('Callback error:', err.response?.data || err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.post('/refresh', async (req, res) => {
  const refresh_token = req.cookies.refresh_token;
  if (!refresh_token) return res.status(401).json({ error: 'No refresh token' });

  try {
    const response = await axios.post('https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token,
        client_id: process.env.SPOTIFY_CLIENT_ID,
        client_secret: process.env.SPOTIFY_CLIENT_SECRET
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, expires_in } = response.data;
    res.cookie('access_token', access_token, { maxAge: expires_in * 1000 });
    res.json({ access_token });
  } catch (err) {
    res.status(500).json({ error: 'Refresh failed' });
  }
});

app.get('/token', (req, res) => {
  const token = req.cookies.access_token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ access_token: token });
});

app.post('/upload', upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const track = {
    id: generateId(),
    type: 'local',
    name: req.body.name || req.file.originalname.replace(/\.[^/.]+$/, ''),
    artist: req.body.artist || 'Archivo local',
    url: '/uploads/' + req.file.filename,
    cover: null,
    addedBy: req.body.username || 'Anon',
    duration: 0
  };

  sharedState.queue.push(track);
  io.emit('queue_updated', sharedState.queue);
  res.json({ success: true, track });
});

app.get('/state', (req, res) => res.json(sharedState));

app.get('/youtube/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'No query' });
  if (!process.env.YOUTUBE_API_KEY) {
    return res.status(503).json({ error: 'no_api_key' });
  }
  try {
    const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet',
        q,
        type: 'video',
        maxResults: 8,
        videoEmbeddable: 'true',
        key: process.env.YOUTUBE_API_KEY
      }
    });
    const items = response.data.items.map(it => ({
      videoId: it.id.videoId,
      title: it.snippet.title,
      channel: it.snippet.channelTitle,
      thumb: it.snippet.thumbnails?.default?.url || ''
    }));
    res.json({ items });
  } catch (err) {
    console.error('YouTube search error:', err.response?.data || err.message);
    res.status(500).json({ error: 'search_failed' });
  }
});

io.on('connection', (socket) => {
  const userId = generateId();
  console.log('Usuario conectado:', userId);

  // calcular progreso real en ms para sincronizar a quien entra
  function currentPositionMs() {
    if (!sharedState.currentTrack) return 0;
    if (sharedState.isPlaying && sharedState.startedAt) {
      return sharedState.pausedProgressMs + (Date.now() - sharedState.startedAt);
    }
    return sharedState.pausedProgressMs;
  }

  function startPlaying(track) {
    sharedState.currentTrack = track;
    sharedState.isPlaying = true;
    sharedState.pausedProgressMs = 0;
    sharedState.startedAt = Date.now();
    io.emit('queue_updated', sharedState.queue);
    io.emit('track_changed', { track, positionMs: 0 });
  }

  socket.emit('state_sync', {
    ...sharedState,
    positionMs: currentPositionMs()
  });
  socket.emit('user_id', userId);

  socket.on('set_username', (username) => {
    sharedState.users[userId] = { username, socketId: socket.id };
    io.emit('users_updated', Object.values(sharedState.users));
  });

  socket.on('add_to_queue', (track) => {
    const newTrack = { ...track, id: track.id || generateId(), addedBy: track.addedBy || 'Anon' };
    sharedState.queue.push(newTrack);
    io.emit('queue_updated', sharedState.queue);
    io.emit('notification', { message: `${newTrack.addedBy} agregó "${newTrack.name}"`, type: 'add' });

    if (!sharedState.currentTrack) {
      const next = sharedState.queue.shift();
      startPlaying(next);
    }
  });

  socket.on('play_from_queue', (trackId) => {
    const idx = sharedState.queue.findIndex(t => t.id === trackId);
    if (idx === -1) return;
    const track = sharedState.queue.splice(idx, 1)[0];
    startPlaying(track);
  });

  socket.on('remove_from_queue', (trackId) => {
    sharedState.queue = sharedState.queue.filter(t => t.id !== trackId);
    io.emit('queue_updated', sharedState.queue);
  });

  socket.on('stop_track', () => {
    sharedState.currentTrack = null;
    sharedState.isPlaying = false;
    sharedState.pausedProgressMs = 0;
    sharedState.startedAt = null;
    io.emit('track_stopped');
  });

  socket.on('toggle_play', (isPlaying) => {
    if (isPlaying && !sharedState.isPlaying) {
      sharedState.startedAt = Date.now();
      sharedState.isPlaying = true;
    } else if (!isPlaying && sharedState.isPlaying) {
      sharedState.pausedProgressMs = currentPositionMs();
      sharedState.isPlaying = false;
      sharedState.startedAt = null;
    }
    io.emit('playback_state', { isPlaying: sharedState.isPlaying, positionMs: currentPositionMs() });
  });

  // seek: alguien adelanta/retrasa la barra
  socket.on('seek', (positionMs) => {
    sharedState.pausedProgressMs = positionMs;
    sharedState.startedAt = sharedState.isPlaying ? Date.now() : null;
    io.emit('seek_to', { positionMs, isPlaying: sharedState.isPlaying });
  });

  socket.on('next_track', () => {
    if (sharedState.queue.length > 0) {
      const next = sharedState.queue.shift();
      startPlaying(next);
    } else {
      sharedState.currentTrack = null;
      sharedState.isPlaying = false;
      sharedState.pausedProgressMs = 0;
      sharedState.startedAt = null;
      io.emit('track_stopped');
    }
  });

  // CHAT - solo usuarios con nombre
  socket.on('chat_message', (text) => {
    const user = sharedState.users[userId];
    if (!user || !user.username) return; // sin nombre, no entra al chat
    const msg = {
      id: generateId(),
      user: user.username,
      text: String(text).slice(0, 300),
      time: Date.now()
    };
    sharedState.chat.push(msg);
    if (sharedState.chat.length > 100) sharedState.chat.shift();
    io.emit('chat_message', msg);
  });

  socket.on('disconnect', () => {
    delete sharedState.users[userId];
    io.emit('users_updated', Object.values(sharedState.users));
    console.log('Usuario desconectado:', userId);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════╗
║   NalessS♫♫  corriendo!       ║
║   http://localhost:${PORT}       ║
╚════════════════════════════════╝
  `);
});
