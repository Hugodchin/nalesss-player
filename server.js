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
  shuffle: false,
  radioMode: false,
  users: {},
  chat: []
};

// duelos activos: { duelId: { challenger, opponent, choices, stickers } }
let duels = {};

// partidas tower defense versus: { tdId: {...} }
let tdGames = {};
let tdWaiting = null; // jugador esperando rival

// envia el estado actual de la partida a ambos jugadores
function broadcastTd(tdId) {
  const g = tdGames[tdId];
  if (!g) return;
  const snapshot = {
    players: Object.entries(g.players).map(([id, p]) => ({
      userId: id, name: p.name, hp: p.hp, gold: p.gold, side: p.side, towers: p.towers
    })),
    enemies: g.enemies,
    tick: g.tick
  };
  for (const p of Object.values(g.players)) {
    io.to(p.socketId).emit('td_state', snapshot);
  }
}

// bucle principal del juego (corre en el servidor)
function startTdLoop(tdId) {
  const g = tdGames[tdId];
  if (!g) return;
  const TICK_MS = 100; // 10 ticks por segundo

  g.loop = setInterval(() => {
    const game = tdGames[tdId];
    if (!game) return;
    game.tick++;

    // oro pasivo cada segundo (cada 10 ticks)
    if (game.tick % 10 === 0) {
      for (const p of Object.values(game.players)) p.gold += 8;
    }

    const playerIds = Object.keys(game.players);

    // mover tropas y resolver torres
    for (const enemy of game.enemies) {
      enemy.progress += enemy.speed;
    }

    // las torres disparan a tropas enemigas en su lado
    for (const [ownerId, p] of Object.entries(game.players)) {
      for (const tower of p.towers) {
        const dmgMap = { basic: 6, fast: 3, heavy: 14 };
        const rateMap = { basic: 5, fast: 2, heavy: 9 }; // ticks entre disparos
        const range = 18;
        if (game.tick - (tower.lastShot || 0) < (rateMap[tower.type] || 5)) continue;
        // objetivos: tropas que vienen hacia MI lado (las del rival)
        const incoming = game.enemies.filter(e => e.targetSide === p.side && e.hp > 0);
        // tower.x esta en 0-100 sobre el ancho; la tropa progress 0-100 mapea segun lado
        let target = null;
        for (const e of incoming) {
          const epos = e.targetSide === 'right' ? e.progress : (100 - e.progress);
          if (Math.abs(epos - tower.x) <= range) { target = e; break; }
        }
        if (target) {
          target.hp -= (dmgMap[tower.type] || 6);
          tower.lastShot = game.tick;
          if (target.hp <= 0) {
            // recompensa al dueno de la torre
            p.gold += 5;
          }
        }
      }
    }

    // quitar tropas muertas
    game.enemies = game.enemies.filter(e => e.hp > 0);

    // tropas que llegaron a la base rival (progress >= 100) hacen dano
    const arrived = game.enemies.filter(e => e.progress >= 100);
    for (const e of arrived) {
      // restar vida al jugador de targetSide
      const victim = Object.values(game.players).find(p => p.side === e.targetSide);
      if (victim) {
        const dmg = { soldier: 8, runner: 5, tank: 18 }[e.type] || 8;
        victim.hp -= dmg;
      }
    }
    game.enemies = game.enemies.filter(e => e.progress < 100);

    // condicion de victoria
    let loser = null, winner = null;
    for (const [id, p] of Object.entries(game.players)) {
      if (p.hp <= 0) {
        loser = id;
        winner = playerIds.find(o => o !== id);
      }
    }

    broadcastTd(tdId);

    if (loser) {
      const winnerName = game.players[winner]?.name || '?';
      for (const p of Object.values(game.players)) {
        io.to(p.socketId).emit('td_gameover', { winnerName });
      }
      clearInterval(game.loop);
      delete tdGames[tdId];
    }
  }, TICK_MS);
}


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
    sharedState.users[userId] = { userId, username, socketId: socket.id };
    io.emit('users_updated', Object.values(sharedState.users).map(u => ({ userId: u.userId, username: u.username })));
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

  socket.on('toggle_shuffle', () => {
    sharedState.shuffle = !sharedState.shuffle;
    io.emit('modes_updated', { shuffle: sharedState.shuffle, radioMode: sharedState.radioMode });
    io.emit('notification', { message: sharedState.shuffle ? 'Shuffle activado 🔀' : 'Shuffle desactivado', type: 'mode' });
  });

  socket.on('toggle_radio', () => {
    sharedState.radioMode = !sharedState.radioMode;
    io.emit('modes_updated', { shuffle: sharedState.shuffle, radioMode: sharedState.radioMode });
    io.emit('notification', { message: sharedState.radioMode ? 'Modo Radio activado 📻' : 'Modo Radio desactivado', type: 'mode' });
  });

  // el cliente encontro una recomendacion de spotify y la manda a reproducir para todos
  socket.on('radio_play', (track) => {
    startPlaying({ ...track, id: generateId(), addedBy: 'Radio 📻' });
  });

  socket.on('next_track', () => {
    if (sharedState.queue.length > 0) {
      let idx = 0;
      if (sharedState.shuffle) {
        idx = Math.floor(Math.random() * sharedState.queue.length);
      }
      const next = sharedState.queue.splice(idx, 1)[0];
      startPlaying(next);
    } else if (sharedState.radioMode && sharedState.currentTrack) {
      // modo radio: pedir al cliente que continue con recomendaciones de spotify
      io.emit('radio_continue', sharedState.currentTrack);
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

  // ===== BATALLA DE STICKERS (piedra-papel-tijera) =====
  socket.on('duel_challenge', ({ targetUserId, challengerSticker }) => {
    const challenger = sharedState.users[userId];
    const opponent = sharedState.users[targetUserId];
    if (!challenger || !opponent) return;
    const duelId = generateId();
    duels[duelId] = {
      challengerId: userId,
      opponentId: targetUserId,
      challengerName: challenger.username,
      opponentName: opponent.username,
      challengerSticker,
      opponentSticker: null,
      choices: {}
    };
    // avisar al retado
    io.to(opponent.socketId).emit('duel_invite', {
      duelId,
      fromName: challenger.username,
      challengerSticker
    });
    io.to(socket.id).emit('duel_waiting', { duelId, opponentName: opponent.username });
  });

  socket.on('duel_accept', ({ duelId, opponentSticker }) => {
    const d = duels[duelId];
    if (!d) return;
    d.opponentSticker = opponentSticker;
    const cSock = sharedState.users[d.challengerId]?.socketId;
    const oSock = sharedState.users[d.opponentId]?.socketId;
    const payload = {
      duelId,
      challengerName: d.challengerName, opponentName: d.opponentName,
      challengerSticker: d.challengerSticker, opponentSticker: d.opponentSticker
    };
    // todos ven la batalla
    io.emit('duel_start', payload);
  });

  socket.on('duel_decline', ({ duelId }) => {
    const d = duels[duelId];
    if (!d) return;
    const cSock = sharedState.users[d.challengerId]?.socketId;
    if (cSock) io.to(cSock).emit('duel_declined', { opponentName: d.opponentName });
    delete duels[duelId];
  });

  socket.on('duel_choice', ({ duelId, choice }) => {
    const d = duels[duelId];
    if (!d) return;
    d.choices[userId] = choice; // 'piedra' | 'papel' | 'tijera'
    // cuando ambos eligieron, resolver
    if (d.choices[d.challengerId] && d.choices[d.opponentId]) {
      const c1 = d.choices[d.challengerId];
      const c2 = d.choices[d.opponentId];
      let winner = 'empate';
      if (c1 !== c2) {
        const beats = { piedra: 'tijera', papel: 'piedra', tijera: 'papel' };
        winner = (beats[c1] === c2) ? d.challengerName : d.opponentName;
      }
      io.emit('duel_result', {
        duelId,
        challengerName: d.challengerName, opponentName: d.opponentName,
        challengerChoice: c1, opponentChoice: c2,
        winner
      });
      delete duels[duelId];
    }
  });

  // ===== TOWER DEFENSE VERSUS =====
  socket.on('td_join', () => {
    const user = sharedState.users[userId];
    const myName = user?.username || 'Jugador';

    if (tdWaiting && tdWaiting.userId !== userId && sharedState.users[tdWaiting.userId]) {
      // emparejar con el que esperaba
      const tdId = generateId();
      const p1 = tdWaiting;
      const p2 = { userId, socketId: socket.id, name: myName };
      tdWaiting = null;

      tdGames[tdId] = {
        id: tdId,
        players: {
          [p1.userId]: { name: p1.name, socketId: p1.socketId, hp: 100, gold: 150, towers: [], side: 'left' },
          [p2.userId]: { name: p2.name, socketId: p2.socketId, hp: 100, gold: 150, towers: [], side: 'right' }
        },
        enemies: [],
        tick: 0,
        started: Date.now(),
        loop: null
      };

      const playersInfo = Object.entries(tdGames[tdId].players).map(([id, p]) => ({ userId: id, name: p.name, side: p.side }));
      io.to(p1.socketId).emit('td_start', { tdId, you: p1.userId, players: playersInfo });
      io.to(p2.socketId).emit('td_start', { tdId, you: p2.userId, players: playersInfo });

      startTdLoop(tdId);
    } else {
      // ponerse a esperar
      tdWaiting = { userId, socketId: socket.id, name: myName };
      socket.emit('td_waiting');
    }
  });

  socket.on('td_cancel', () => {
    if (tdWaiting && tdWaiting.userId === userId) tdWaiting = null;
  });

  socket.on('td_place_tower', ({ tdId, x, y, towerType }) => {
    const g = tdGames[tdId];
    if (!g || !g.players[userId]) return;
    const costs = { basic: 50, fast: 75, heavy: 100 };
    const cost = costs[towerType] || 50;
    const p = g.players[userId];
    if (p.gold < cost) return;
    p.gold -= cost;
    p.towers.push({ x, y, type: towerType, lastShot: 0 });
    broadcastTd(tdId);
  });

  socket.on('td_send_troop', ({ tdId, troopType }) => {
    const g = tdGames[tdId];
    if (!g || !g.players[userId]) return;
    const costs = { soldier: 30, runner: 40, tank: 80 };
    const cost = costs[troopType] || 30;
    const p = g.players[userId];
    if (p.gold < cost) return;
    p.gold -= cost;
    // la tropa va hacia la base del rival
    const targetSide = p.side === 'left' ? 'right' : 'left';
    const hpMap = { soldier: 30, runner: 18, tank: 70 };
    const spdMap = { soldier: 0.4, runner: 0.8, tank: 0.25 };
    g.enemies.push({
      id: generateId(),
      owner: userId,
      targetSide,
      type: troopType,
      hp: hpMap[troopType] || 30,
      maxHp: hpMap[troopType] || 30,
      speed: spdMap[troopType] || 0.4,
      progress: 0 // 0 a 100, recorre el camino hacia la base rival
    });
    broadcastTd(tdId);
  });

  socket.on('disconnect', () => {
    if (tdWaiting && tdWaiting.userId === userId) tdWaiting = null;
    // terminar partidas td donde estaba
    for (const [tdId, g] of Object.entries(tdGames)) {
      if (g.players[userId]) {
        const other = Object.keys(g.players).find(id => id !== userId);
        if (other && sharedState.users[other]) {
          io.to(g.players[other].socketId).emit('td_opponent_left');
        }
        if (g.loop) clearInterval(g.loop);
        delete tdGames[tdId];
      }
    }
    delete sharedState.users[userId];
    io.emit('users_updated', Object.values(sharedState.users).map(u => ({ userId: u.userId, username: u.username })));
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
