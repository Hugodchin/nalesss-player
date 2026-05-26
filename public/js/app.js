const socket = io();

let myUserId = null;
let myUsername = localStorage.getItem('nalesss_username') || '';
let accessToken = null;
let spotifyPlayer = null;
let spotifyDeviceId = null;
let isSpotifyReady = false;
let currentTrack = null;
let isPlaying = false;
let audioElement = null;
let progressInterval = null;
let currentTrackDuration = 0;
let ytPlayer = null;
let ytReady = false;
let ytProgressTimer = null;
let videoVisible = false;
let seekingLocal = false;
let spotifyWasPlaying = false;
let connectedUsers = [];
let currentDuelId = null;
let tdState = null;
let tdId = null;
let tdMe = null;
let tdMySide = null;
let tdSelectedTower = 'basic';

const getCookie = (name) => {
  const val = document.cookie.split('; ').find(r => r.startsWith(name + '='));
  return val ? val.split('=')[1] : null;
};

async function initSpotify() {
  const token = getCookie('access_token');
  if (!token) return;

  accessToken = token;
  document.getElementById('loginBtn').style.display = 'none';
  document.getElementById('spotifyWrap').style.display = 'block';

  window.onSpotifyWebPlaybackSDKReady = () => {
    spotifyPlayer = new Spotify.Player({
      name: 'NalessS♫♫',
      getOAuthToken: cb => cb(accessToken),
      volume: 0.8
    });

    spotifyPlayer.addListener('ready', ({ device_id }) => {
      spotifyDeviceId = device_id;
      isSpotifyReady = true;
      transferPlayback(device_id);
      showStatus('Spotify listo', true);
    });

    spotifyPlayer.addListener('not_ready', () => {
      isSpotifyReady = false;
      showStatus('Spotify desconectado', false);
    });

    spotifyPlayer.addListener('player_state_changed', (state) => {
      if (!state) return;
      const track = state.track_window.current_track;
      currentTrackDuration = state.duration;
      updateProgress(state.position / state.duration * 100, state.position, state.duration);

      // Detectar fin de cancion en Spotify para avanzar la cola automaticamente
      if (state.paused && state.position === 0 && spotifyWasPlaying) {
        spotifyWasPlaying = false;
        if (currentTrack?.type === 'spotify') {
          socket.emit('next_track');
        }
      }
      if (!state.paused) spotifyWasPlaying = true;
    });

    spotifyPlayer.connect();
  };

  const script = document.createElement('script');
  script.src = 'https://sdk.scdn.co/spotify-player.js';
  document.head.appendChild(script);
}

async function transferPlayback(deviceId) {
  if (!accessToken) return;
  try {
    await fetch('https://api.spotify.com/v1/me/player', {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_ids: [deviceId], play: false })
    });
  } catch (e) { console.log('Transfer error:', e); }
}

async function refreshToken() {
  try {
    const res = await fetch('/refresh', { method: 'POST' });
    const data = await res.json();
    if (data.access_token) {
      accessToken = data.access_token;
      return true;
    }
  } catch (e) {}
  return false;
}

async function spotifyApi(endpoint, method = 'GET', body = null) {
  if (!accessToken) return null;
  const opts = {
    method,
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' }
  };
  if (body) opts.body = JSON.stringify(body);
  let res = await fetch('https://api.spotify.com/v1' + endpoint, opts);
  if (res.status === 401) {
    const refreshed = await refreshToken();
    if (refreshed) {
      opts.headers['Authorization'] = 'Bearer ' + accessToken;
      res = await fetch('https://api.spotify.com/v1' + endpoint, opts);
    }
  }
  if (res.status === 204 || res.status === 202) return {};
  return res.json().catch(() => ({}));
}

function onYouTubeIframeAPIReady() {
  ytPlayer = new YT.Player('ytPlayer', {
    height: '180',
    width: '320',
    playerVars: { autoplay: 0, controls: 1, rel: 0 },
    events: {
      onReady: () => { ytReady = true; },
      onStateChange: onYtStateChange
    }
  });
}

function onYtStateChange(e) {
  if (e.data === YT.PlayerState.ENDED) {
    socket.emit('next_track');
  }
  if (e.data === YT.PlayerState.PLAYING) {
    startYtProgress();
  } else {
    clearInterval(ytProgressTimer);
  }
}

function startYtProgress() {
  clearInterval(ytProgressTimer);
  ytProgressTimer = setInterval(() => {
    if (!ytPlayer || !ytPlayer.getDuration) return;
    const dur = ytPlayer.getDuration() * 1000;
    const pos = ytPlayer.getCurrentTime() * 1000;
    const pct = dur ? (pos / dur) * 100 : 0;
    updateProgress(pct, pos, dur);
  }, 1000);
}

function parseYouTube(input) {
  const text = input.trim();
  let videoId = null;
  let playlistId = null;

  const listMatch = text.match(/[?&]list=([a-zA-Z0-9_-]+)/);
  if (listMatch) playlistId = listMatch[1];

  const vMatch = text.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  const shortMatch = text.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  const embedMatch = text.match(/embed\/([a-zA-Z0-9_-]{11})/);
  if (vMatch) videoId = vMatch[1];
  else if (shortMatch) videoId = shortMatch[1];
  else if (embedMatch) videoId = embedMatch[1];
  else if (/^[a-zA-Z0-9_-]{11}$/.test(text)) videoId = text;

  return { videoId, playlistId, isUrl: text.includes('youtu') };
}

async function handleYouTube() {
  const input = document.getElementById('ytSearchInput');
  const val = input.value.trim();
  if (!val) return;

  const parsed = parseYouTube(val);

  if (parsed.playlistId) {
    addToQueue({
      type: 'youtube',
      ytType: 'playlist',
      playlistId: parsed.playlistId,
      videoId: parsed.videoId || null,
      name: 'Playlist de YouTube',
      artist: 'YouTube',
      cover: null
    });
    input.value = '';
    return;
  }

  if (parsed.videoId) {
    addToQueue({
      type: 'youtube',
      ytType: 'video',
      videoId: parsed.videoId,
      name: 'Video de YouTube',
      artist: 'YouTube',
      cover: `https://i.ytimg.com/vi/${parsed.videoId}/default.jpg`
    });
    input.value = '';
    return;
  }

  ytSearch(val);
}

async function ytSearch(query) {
  const resultsEl = document.getElementById('ytResults');
  resultsEl.innerHTML = '<div style="font-family:var(--font-pixel);font-size:8px;color:var(--text3);padding:12px">Buscando...</div>';

  try {
    const res = await fetch('/youtube/search?q=' + encodeURIComponent(query));
    if (res.status === 503) {
      resultsEl.innerHTML = '<div style="font-family:var(--font-retro);font-size:15px;color:var(--text3);padding:12px">La búsqueda necesita una API key de YouTube. Por ahora pega un link directo del video.</div>';
      return;
    }
    const data = await res.json();
    if (!data.items || !data.items.length) {
      resultsEl.innerHTML = '<div style="font-family:var(--font-pixel);font-size:8px;color:var(--pixel-red);padding:12px">Sin resultados</div>';
      return;
    }
    resultsEl.innerHTML = '';
    data.items.forEach(item => {
      const div = document.createElement('div');
      div.className = 'search-item';
      div.innerHTML = `
        <img class="yt-result-thumb" src="${item.thumb}" alt="" />
        <div class="search-item-info">
          <div class="search-item-name">${escHtml(item.title)}</div>
          <div class="search-item-artist">${escHtml(item.channel)}</div>
        </div>
        <button class="search-item-add yt-add" onclick='addToQueue(${JSON.stringify({
          type: 'youtube', ytType: 'video', videoId: item.videoId,
          name: item.title, artist: item.channel,
          cover: item.thumb
        }).replace(/'/g, "&#39;")})'>+ Cola</button>
      `;
      resultsEl.appendChild(div);
    });
  } catch (e) {
    resultsEl.innerHTML = '<div style="font-family:var(--font-pixel);font-size:8px;color:var(--pixel-red);padding:12px">Error al buscar</div>';
  }
}

async function searchSpotify() {
  const query = document.getElementById('searchInput').value.trim();
  if (!query) return;
  if (!accessToken) { showNotif('Conecta Spotify primero', 'error'); return; }

  const resultsEl = document.getElementById('searchResults');
  resultsEl.innerHTML = '<div style="font-family:var(--font-pixel);font-size:8px;color:var(--text3);padding:12px">Buscando...</div>';

  const data = await spotifyApi(`/search?q=${encodeURIComponent(query)}&type=track&limit=8`);
  if (!data || !data.tracks) {
    resultsEl.innerHTML = '<div style="font-family:var(--font-pixel);font-size:8px;color:var(--pixel-red);padding:12px">Error al buscar</div>';
    return;
  }

  resultsEl.innerHTML = '';
  data.tracks.items.forEach(track => {
    const cover = track.album.images[2]?.url || track.album.images[0]?.url || '';
    const div = document.createElement('div');
    div.className = 'search-item';
    div.innerHTML = `
      <img class="search-item-cover" src="${cover}" alt="" />
      <div class="search-item-info">
        <div class="search-item-name">${escHtml(track.name)}</div>
        <div class="search-item-artist">${escHtml(track.artists.map(a => a.name).join(', '))}</div>
      </div>
      <button class="search-item-add" onclick="openAddModal(${JSON.stringify({
        id: track.id,
        type: 'spotify',
        name: track.name,
        artist: track.artists.map(a => a.name).join(', '),
        uri: track.uri,
        cover: cover,
        duration: track.duration_ms
      }).replace(/"/g, '&quot;')})">+ Cola</button>
    `;
    resultsEl.appendChild(div);
  });
}

function openAddModal(track) {
  const overlay = document.getElementById('modalOverlay');
  const body = document.getElementById('modalBody');
  body.innerHTML = `
    <div class="track-preview">
      <img src="${track.cover || ''}" alt="" onerror="this.style.display='none'" />
      <div>
        <div class="preview-name">${escHtml(track.name)}</div>
        <div class="preview-artist">${escHtml(track.artist)}</div>
      </div>
    </div>
  `;
  overlay.style.display = 'flex';
  document.getElementById('modalConfirm').onclick = () => {
    addToQueue(track);
    closeModal();
  };
}

function closeModal() {
  document.getElementById('modalOverlay').style.display = 'none';
}

function addToQueue(track) {
  const enriched = { ...track, addedBy: myUsername || 'Anon' };
  socket.emit('add_to_queue', enriched);
}

function setUsername() {
  const val = document.getElementById('usernameInput').value.trim();
  if (!val) return;
  myUsername = val;
  localStorage.setItem('nalesss_username', val);
  socket.emit('set_username', val);
  unlockChat();
  showNotif('Usuario: ' + val);
}

function togglePlay() {
  const newState = !isPlaying;
  socket.emit('toggle_play', newState);
}

function stopTrack() {
  socket.emit('stop_track');
}

function nextTrack() {
  socket.emit('next_track');
}

function toggleShuffle() {
  socket.emit('toggle_shuffle');
}

function toggleRadio() {
  socket.emit('toggle_radio');
}

// Modo radio: buscar una cancion recomendada de Spotify basada en la actual
async function findRadioTrack(seedTrack) {
  if (!accessToken) { socket.emit('next_track'); return; }
  try {
    // intentar obtener recomendaciones segun la cancion actual
    let seedId = seedTrack?.spotifyId || seedTrack?.uri?.split(':').pop();
    if (!seedId) {
      // si no hay semilla valida, no continuar
      socket.emit('track_stopped');
      return;
    }
    const data = await spotifyApi('/recommendations?limit=1&seed_tracks=' + seedId);
    if (data && data.tracks && data.tracks.length) {
      const t = data.tracks[0];
      socket.emit('radio_play', {
        type: 'spotify',
        name: t.name,
        artist: t.artists.map(a => a.name).join(', '),
        uri: t.uri,
        spotifyId: t.id,
        cover: t.album.images[0]?.url || null,
        duration: t.duration_ms
      });
    } else {
      socket.emit('track_stopped');
    }
  } catch (e) {
    console.log('Radio error:', e);
    socket.emit('track_stopped');
  }
}

function prevTrack() {
  socket.emit('seek', 0);
}

function setVolume(val) {
  document.getElementById('volLabel').textContent = val;
  if (audioElement) audioElement.volume = val / 100;
  if (spotifyPlayer) spotifyPlayer.setVolume(val / 100);
  if (ytPlayer && ytReady) ytPlayer.setVolume(parseInt(val));
}

function stopEverything() {
  if (audioElement) {
    audioElement.pause();
    audioElement.src = '';
    audioElement = null;
  }
  clearInterval(progressInterval);
  clearInterval(ytProgressTimer);
  if (ytReady && ytPlayer) { try { ytPlayer.stopVideo(); } catch(e){} }
  if (spotifyPlayer) { try { spotifyPlayer.pause(); } catch(e){} }
  const ytEl = document.getElementById('ytPlayer');
  if (ytEl) ytEl.classList.remove('active');
}

function playTrack(track, positionMs = 0) {
  currentTrack = track;
  stopEverything();

  const ytEl = document.getElementById('ytPlayer');
  const startSec = (positionMs || 0) / 1000;

  if (track.type === 'spotify') {
    if (isSpotifyReady && spotifyDeviceId) {
      spotifyApi('/me/player/play', 'PUT', { uris: [track.uri], position_ms: positionMs || 0 });
    }
  } else if (track.type === 'youtube') {
    if (videoVisible) ytEl.classList.add('active');
    if (ytReady && ytPlayer) {
      if (track.ytType === 'playlist') {
        ytPlayer.loadPlaylist({ list: track.playlistId, listType: 'playlist', index: 0, startSeconds: startSec });
      } else {
        ytPlayer.loadVideoById({ videoId: track.videoId, startSeconds: startSec });
      }
      ytPlayer.setVolume(document.getElementById('volumeSlider').value);
    }
  } else if (track.type === 'local') {
    audioElement = new Audio(track.url);
    audioElement.volume = document.getElementById('volumeSlider').value / 100;
    audioElement.currentTime = startSec;
    audioElement.play().catch(e => console.log('Audio play error:', e));
    audioElement.addEventListener('timeupdate', () => {
      if (seekingLocal) return;
      const pct = (audioElement.currentTime / audioElement.duration) * 100 || 0;
      updateProgress(pct, audioElement.currentTime * 1000, audioElement.duration * 1000);
    });
    audioElement.addEventListener('ended', () => socket.emit('next_track'));
  }

  updateNowPlayingUI(track);
  updatePlayBtn(true);
}

function pauseCurrent() {
  if (audioElement) audioElement.pause();
  if (spotifyPlayer && currentTrack?.type === 'spotify') spotifyPlayer.pause();
  if (ytPlayer && ytReady && currentTrack?.type === 'youtube') ytPlayer.pauseVideo();
  clearInterval(ytProgressTimer);
}

function resumeCurrent(positionMs) {
  if (audioElement) audioElement.play().catch(() => {});
  if (spotifyPlayer && currentTrack?.type === 'spotify') spotifyPlayer.resume();
  if (ytPlayer && ytReady && currentTrack?.type === 'youtube') ytPlayer.playVideo();
}

function seekCurrent(positionMs) {
  const sec = positionMs / 1000;
  if (audioElement) audioElement.currentTime = sec;
  if (ytPlayer && ytReady && currentTrack?.type === 'youtube') ytPlayer.seekTo(sec, true);
  if (spotifyPlayer && currentTrack?.type === 'spotify') spotifyPlayer.seek(positionMs);
}

function updateNowPlayingUI(track) {
  document.getElementById('trackName').textContent = track.name;
  document.getElementById('trackArtist').textContent = track.artist;

  const addedBadge = document.getElementById('addedByBadge');
  if (track.addedBy) {
    addedBadge.style.display = 'inline-block';
    document.getElementById('addedByName').textContent = track.addedBy;
  } else {
    addedBadge.style.display = 'none';
  }

  const coverImg = document.getElementById('coverImg');
  const coverPlaceholder = document.getElementById('coverPlaceholder');
  if (track.cover) {
    coverImg.src = track.cover;
    coverImg.style.display = 'block';
    coverPlaceholder.style.display = 'none';
    coverImg.onerror = () => {
      coverImg.style.display = 'none';
      coverPlaceholder.style.display = 'flex';
    };
  } else {
    coverImg.style.display = 'none';
    coverPlaceholder.style.display = 'flex';
  }

  const coverFrame = document.querySelector('.cover-frame');
  coverFrame.classList.add('playing');
  document.getElementById('vinylRing').classList.add('active');

  const nameEl = document.getElementById('trackName');
  if (track.name.length > 20) nameEl.classList.add('scrolling');
  else nameEl.classList.remove('scrolling');
}

function updateProgress(pct, posMs, durMs) {
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressStar').style.left = pct + '%';
  document.getElementById('timeElapsed').textContent = msToTime(posMs);
  document.getElementById('timeDuration').textContent = msToTime(durMs);
}

function updatePlayBtn(playing) {
  isPlaying = playing;
  const btn = document.getElementById('playBtn');
  const playIcon = document.getElementById('playIcon');
  const pauseIcon = document.getElementById('pauseIcon');
  if (playing) {
    btn.classList.add('playing');
    playIcon.style.display = 'none';
    pauseIcon.style.display = 'block';
  } else {
    btn.classList.remove('playing');
    playIcon.style.display = 'block';
    pauseIcon.style.display = 'none';
  }
  setCreaturesDancing(playing);
}

function setCreaturesDancing(active) {
  ['creature1', 'creature2', 'creature3'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('dancing', active);
  });
  const eq = document.getElementById('eqBars');
  if (eq) eq.classList.toggle('playing-active', active);
  document.body.classList.toggle('music-playing', active);
}

function renderQueue(queue) {
  const list = document.getElementById('queueList');
  document.getElementById('queueCount').textContent = queue.length;

  if (!queue.length) {
    list.innerHTML = `
      <div class="queue-empty">
        <div class="queue-empty-icon">♪</div>
        <p>La cola está vacía</p>
        <p class="queue-empty-sub">¡Agrega canciones!</p>
      </div>`;
    return;
  }

  list.innerHTML = '';
  queue.forEach((track, i) => {
    const div = document.createElement('div');
    div.className = 'queue-item';
    div.innerHTML = `
      <span class="queue-num">${i + 1}</span>
      ${track.cover ? `<img class="queue-item-cover" src="${track.cover}" alt="" onerror="this.style.display='none'" />` : '<div style="width:34px;height:34px;background:var(--bg2);border:2px solid var(--border);flex-shrink:0;display:flex;align-items:center;justify-content:center;color:var(--accent3);font-size:18px">♪</div>'}
      <div class="queue-item-info">
        <div class="queue-item-name">${escHtml(track.name)}</div>
        <div class="queue-item-meta">${escHtml(track.artist)} · <span class="queue-item-type type-${track.type}">${track.type === 'spotify' ? 'spotify' : (track.type === 'youtube' ? 'yt' : 'mp3')}</span></div>
        <div style="font-family:var(--font-pixel);font-size:7px;color:var(--text3);margin-top:2px">por ${escHtml(track.addedBy || 'Anon')}</div>
      </div>
      <button class="queue-play" onclick="playFromQueue('${track.id}')" title="reproducir">▶</button>
      <button class="queue-remove" onclick="removeFromQueue('${track.id}')" title="quitar">✕</button>
    `;
    list.appendChild(div);
  });
}

function playFromQueue(trackId) {
  socket.emit('play_from_queue', trackId);
}

function removeFromQueue(trackId) {
  socket.emit('remove_from_queue', trackId);
}

function showNotif(message, type = 'add') {
  const bar = document.getElementById('notifBar');
  bar.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'notif-item';
  el.textContent = '♪ ' + message;
  bar.appendChild(el);
  setTimeout(() => { if (bar.contains(el)) bar.removeChild(el); }, 4000);
}

function showStatus(msg, ok) {
  document.getElementById('statusText').textContent = msg;
  const dot = document.getElementById('statusDot');
  dot.style.background = ok ? '#27ae60' : '#e74c3c';
}

function msToTime(ms) {
  if (!ms || isNaN(ms)) return '0:00';
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function uploadFile(file) {
  if (!file) return;
  const progressWrap = document.getElementById('uploadProgress');
  const fill = document.getElementById('uploadProgressFill');
  const text = document.getElementById('uploadProgressText');
  progressWrap.style.display = 'block';

  const formData = new FormData();
  formData.append('audio', file);
  formData.append('name', file.name.replace(/\.[^/.]+$/, ''));
  formData.append('username', myUsername || 'Anon');

  const xhr = new XMLHttpRequest();
  xhr.upload.addEventListener('progress', (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      fill.style.width = pct + '%';
      text.textContent = 'Subiendo... ' + pct + '%';
    }
  });

  xhr.addEventListener('load', () => {
    progressWrap.style.display = 'none';
    if (xhr.status === 200) {
      showNotif('MP3 subido a la cola');
    } else {
      showNotif('Error al subir', 'error');
    }
  });

  xhr.open('POST', '/upload');
  xhr.send(formData);
}

function handleDrop(e) {
  e.preventDefault();
  document.getElementById('uploadArea').classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('audio/')) {
    uploadFile(file);
  }
}

function toggleVideo() {
  videoVisible = !videoVisible;
  const ytEl = document.getElementById('ytPlayer');
  const txt = document.getElementById('ytToggleText');
  const btn = document.getElementById('ytToggleBtn');
  if (videoVisible && currentTrack?.type === 'youtube') {
    ytEl.classList.add('active');
  } else {
    ytEl.classList.remove('active');
  }
  txt.textContent = videoVisible ? '■ Ocultar video' : '▶ Mostrar video';
  btn.classList.toggle('active', videoVisible);
}

// ===== CHAT =====
function unlockChat() {
  document.getElementById('chatLocked').style.display = 'none';
  document.getElementById('chatArea').style.display = 'flex';
}

function sendChat() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;
  if (!myUsername) { showNotif('Pon tu nombre primero'); return; }
  socket.emit('chat_message', text);
  input.value = '';
}

function appendChatMessage(msg) {
  const box = document.getElementById('chatMessages');
  const mine = msg.user === myUsername;
  const div = document.createElement('div');
  div.className = 'chat-msg' + (mine ? ' mine' : '');
  div.innerHTML = `
    <span class="chat-msg-user">${escHtml(msg.user)}</span>
    <span class="chat-msg-text">${escHtml(msg.text)}</span>
  `;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function renderChatHistory(history) {
  const box = document.getElementById('chatMessages');
  box.innerHTML = '';
  history.forEach(appendChatMessage);
}

// ===== STICKERS DE IMAGEN POR TEMA =====
const IMAGE_STICKERS = {
  nintendo: { base: '/assets/Sprites/', ext: '.jpg', prefix: 'Sticker', count: 7 },
  dark: { base: '/assets/Sprites/', ext: '.jpg', prefix: 'Sticker', count: 7 },
  aero: { base: '/assets/Sprites/', ext: '.jpg', prefix: 'Sticker', count: 7 }
};

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function renderImageStickers(theme) {
  const layer = document.getElementById('stickersLayer');
  if (!layer) return;
  layer.innerHTML = '';
  const cfg = IMAGE_STICKERS[theme];
  if (!cfg) return false;

  // posiciones repartidas por los bordes (evitando el centro donde van las tarjetas)
  const positions = [
    { left: '2%', top: '12%', rot: -6 },
    { right: '2%', top: '11%', rot: 5 },
    { left: '2.5%', top: '38%', rot: 4 },
    { right: '2%', top: '37%', rot: -5 },
    { left: '2.5%', top: '63%', rot: 7 },
    { right: '2.5%', top: '64%', rot: -4 },
    { left: '2%', bottom: '6%', rot: 3 }
  ];
  const shapes = ['shape-polaroid', 'shape-circle', 'shape-blob', 'shape-diamond', 'shape-polaroid', 'shape-hexagon', 'shape-circle'];
  const anims = ['', 'anim-pulse', '', 'anim-wobble', 'anim-pulse', 'anim-spin', ''];

  // orden aleatorio cada vez para dar variedad
  const order = shuffleArray([1, 2, 3, 4, 5, 6, 7]);
  const shuffledShapes = shuffleArray(shapes);
  const shuffledAnims = shuffleArray(anims);

  let shown = 0;
  for (let p = 0; p < cfg.count; p++) {
    const stickerNum = order[p];
    const url = cfg.base + cfg.prefix + stickerNum + cfg.ext;
    const ok = await spriteExists(url);
    if (!ok) continue;
    const pos = positions[p % positions.length];
    const shape = shuffledShapes[p % shuffledShapes.length];
    const anim = shuffledAnims[p % shuffledAnims.length];
    const el = document.createElement('div');
    el.className = 'img-sticker themed-sticker ' + shape + (anim ? ' ' + anim : '');
    el.style.setProperty('--rot', pos.rot + 'deg');
    el.style.animationDelay = (p * 0.4) + 's';
    Object.assign(el.style, { left: pos.left, right: pos.right, top: pos.top, bottom: pos.bottom });
    const img = document.createElement('img');
    img.src = url;
    img.loading = 'lazy';
    el.appendChild(img);
    layer.appendChild(el);
    shown++;
  }
  return shown > 0;
}

// ===== PERSONAJES ANIMADOS (sprites por frames) =====
const CHARACTERS = {
  dark: [],
  aero: [],
  nintendo: []
};

let charTimers = [];

function spriteExists(url) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

async function renderCharacters(theme) {
  const stage = document.getElementById('characterStage');
  if (!stage) return;
  charTimers.forEach(t => clearInterval(t));
  charTimers = [];
  stage.innerHTML = '';

  const chars = CHARACTERS[theme] || [];
  if (!chars.length) return;

  // probar si los sprites existen (carpeta Sprites con mayuscula)
  const base = '/assets/Sprites/';
  for (const ch of chars) {
    const firstUrl = base + ch.name + '1.png';
    const ok = await spriteExists(firstUrl);
    if (!ok) continue;

    const el = document.createElement('div');
    el.className = 'game-char' + (ch.float ? ' floating' : '') + (ch.fly ? ' flying' : '');
    el.style.height = ch.height + 'px';
    Object.assign(el.style, ch.pos);

    const imgEl = document.createElement('img');
    imgEl.src = firstUrl;
    imgEl.style.height = '100%';
    el.appendChild(imgEl);
    stage.appendChild(el);

    // animacion cuadro por cuadro
    let frame = 1;
    const baseFps = ch.fps;
    const timer = setInterval(() => {
      frame = (frame % ch.frames) + 1;
      imgEl.src = base + ch.name + frame + '.png';
    }, 1000 / baseFps);
    charTimers.push(timer);
  }
}

// ===== FONDO DE IMAGEN POR TEMA =====
async function renderBgImage(theme) {
  const el = document.getElementById('themeBgImage');
  if (!el) return;
  const map = { dark: 'fondo-dark.png', aero: 'fondo-aero.png', nintendo: 'fondo-nintendo.png' };
  const file = map[theme];
  if (!file) { el.style.backgroundImage = ''; el.classList.remove('active'); return; }
  const url = '/assets/backgrounds/' + file;
  const ok = await spriteExists(url);
  if (ok) {
    el.style.backgroundImage = `url('${url}')`;
    el.classList.add('active');
  } else {
    el.style.backgroundImage = '';
    el.classList.remove('active');
  }
}

// ===== ESCENA DE FONDO POR TEMA =====
const SCENES = {
  dark: `<svg viewBox="0 0 1200 400" preserveAspectRatio="xMidYMax slice" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="dsky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#1a1228"/><stop offset="100%" stop-color="#2d2147"/>
      </linearGradient>
      <linearGradient id="dfog" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="transparent"/><stop offset="100%" stop-color="#6b4ea8" stop-opacity="0.25"/>
      </linearGradient>
    </defs>
    <rect width="1200" height="400" fill="url(#dsky)"/>
    <!-- montanas lejanas -->
    <polygon points="0,400 0,260 120,180 240,260 360,160 480,260 600,200 720,150 840,250 960,180 1080,260 1200,200 1200,400" fill="#241a38" opacity="0.7"/>
    <!-- castillo central -->
    <g opacity="0.85">
      <rect x="540" y="200" width="120" height="200" fill="#1c1530"/>
      <rect x="560" y="140" width="30" height="260" fill="#15101f"/>
      <rect x="610" y="140" width="30" height="260" fill="#15101f"/>
      <polygon points="560,140 575,110 590,140" fill="#3a2f52"/>
      <polygon points="610,140 625,110 640,140" fill="#3a2f52"/>
      <rect x="568" y="180" width="14" height="20" fill="#9d6bf0" opacity="0.8"><animate attributeName="opacity" values="0.4;0.9;0.4" dur="4s" repeatCount="indefinite"/></rect>
      <rect x="618" y="180" width="14" height="20" fill="#9d6bf0" opacity="0.6"><animate attributeName="opacity" values="0.9;0.4;0.9" dur="4s" repeatCount="indefinite"/></rect>
      <rect x="585" y="260" width="30" height="140" fill="#0a0612"/>
    </g>
    <!-- torres laterales -->
    <rect x="180" y="240" width="50" height="160" fill="#1c1530" opacity="0.7"/>
    <polygon points="180,240 205,210 230,240" fill="#3a2f52" opacity="0.7"/>
    <rect x="970" y="230" width="50" height="170" fill="#1c1530" opacity="0.7"/>
    <polygon points="970,230 995,200 1020,230" fill="#3a2f52" opacity="0.7"/>
    <!-- arboles muertos -->
    <g stroke="#15101f" stroke-width="3" fill="none" opacity="0.6">
      <path d="M80,400 L80,320 M80,340 L60,320 M80,350 L100,330"/>
      <path d="M1130,400 L1130,310 M1130,335 L1110,315 M1130,345 L1150,325"/>
    </g>
    <rect width="1200" height="400" fill="url(#dfog)"/>
  </svg>`,
  aero: `<svg viewBox="0 0 1200 400" preserveAspectRatio="xMidYMax slice" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="asky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#5ec0e8"/><stop offset="60%" stop-color="#aee6ff"/><stop offset="100%" stop-color="#d4f5ff"/>
      </linearGradient>
      <radialGradient id="asun" cx="50%" cy="50%">
        <stop offset="0%" stop-color="#fff"/><stop offset="100%" stop-color="#fff" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="1200" height="400" fill="url(#asky)"/>
    <!-- sol brillante -->
    <circle cx="950" cy="80" r="90" fill="url(#asun)"><animate attributeName="r" values="85;100;85" dur="5s" repeatCount="indefinite"/></circle>
    <circle cx="950" cy="80" r="30" fill="#fff"/>
    <!-- nubes -->
    <g fill="#fff" opacity="0.92">
      <ellipse cx="200" cy="70" rx="55" ry="24"/><ellipse cx="250" cy="60" rx="45" ry="26"/><ellipse cx="160" cy="62" rx="38" ry="20"/>
      <ellipse cx="600" cy="110" rx="50" ry="22"/><ellipse cx="650" cy="100" rx="40" ry="22"/>
    </g>
    <g fill="#fff" opacity="0.6">
      <ellipse cx="420" cy="50" rx="45" ry="18"><animate attributeName="cx" values="420;460;420" dur="12s" repeatCount="indefinite"/></ellipse>
    </g>
    <!-- colinas estilo Bliss -->
    <path d="M0,400 L0,300 Q300,230 600,285 Q900,335 1200,260 L1200,400 Z" fill="#6dd88a"/>
    <path d="M0,400 L0,335 Q400,295 800,335 Q1000,355 1200,320 L1200,400 Z" fill="#4ec46f"/>
    <!-- reflejo de agua abajo -->
    <rect x="0" y="370" width="1200" height="30" fill="#1899d6" opacity="0.2"/>
    <!-- peces nadando -->
    <g>
      <g><animateTransform attributeName="transform" type="translate" values="-60,0;1260,0" dur="22s" repeatCount="indefinite"/><ellipse cx="0" cy="350" rx="14" ry="8" fill="#ff8c42"/><polygon points="-14,350 -24,344 -24,356" fill="#ff8c42"/><rect x="-6" y="344" width="3" height="12" fill="#fff"/></g>
      <g><animateTransform attributeName="transform" type="translate" values="1260,0;-60,0" dur="28s" repeatCount="indefinite"/><ellipse cx="0" cy="320" rx="11" ry="6" fill="#ffd24a"/><polygon points="11,320 20,315 20,325" fill="#ffd24a"/></g>
    </g>
  </svg>`,
  nintendo: `<svg viewBox="0 0 1200 400" preserveAspectRatio="xMidYMax slice" xmlns="http://www.w3.org/2000/svg">
    <rect width="1200" height="400" fill="transparent"/>
    <!-- colinas -->
    <path d="M0,400 L0,330 Q200,290 400,320 Q600,350 800,310 Q1000,280 1200,320 L1200,400 Z" fill="#7ab648" opacity="0.4"/>
    <!-- arboles pixel -->
    <g opacity="0.55">
      <rect x="140" y="300" width="10" height="30" fill="#6b4423"/><polygon points="145,270 125,310 165,310" fill="#4a7c3f"/><polygon points="145,285 128,315 162,315" fill="#5a8c4f"/>
      <rect x="1040" y="295" width="10" height="32" fill="#6b4423"/><polygon points="1045,262 1022,308 1068,308" fill="#4a7c3f"/>
    </g>
    <!-- setas -->
    <g opacity="0.6">
      <rect x="300" y="345" width="8" height="12" fill="#f0e6d0"/><ellipse cx="304" cy="345" rx="12" ry="7" fill="#c0392b"/><circle cx="300" cy="343" r="2" fill="#fff"/><circle cx="308" cy="346" r="1.5" fill="#fff"/>
      <rect x="900" y="350" width="7" height="10" fill="#f0e6d0"/><ellipse cx="903" cy="350" rx="10" ry="6" fill="#c0392b"/><circle cx="900" cy="349" r="1.5" fill="#fff"/>
    </g>
  </svg>`
};

function renderScene(theme) {
  const el = document.getElementById('themeScene');
  if (!el) return;
  el.innerHTML = SCENES[theme] || '';
}

// ===== STICKERS POR TEMA =====
const STICKERS = {
  nintendo: [
    // Heroe aventurero con gorra (estilo plataformero, original)
    '<svg viewBox="0 0 48 56"><rect x="16" y="6" width="16" height="6" fill="#c0392b"/><rect x="14" y="10" width="4" height="4" fill="#c0392b"/><rect x="16" y="12" width="16" height="10" fill="#f0c8a0"/><rect x="20" y="16" width="3" height="3" fill="#15202a"/><rect x="26" y="16" width="3" height="3" fill="#15202a"/><rect x="18" y="22" width="12" height="14" fill="#2980b9"/><rect x="14" y="24" width="4" height="10" fill="#f0c8a0"/><rect x="30" y="24" width="4" height="10" fill="#f0c8a0"/><rect x="18" y="36" width="5" height="12" fill="#1a5276"/><rect x="25" y="36" width="5" height="12" fill="#1a5276"/><rect x="16" y="48" width="8" height="4" fill="#5a3a1a"/><rect x="24" y="48" width="8" height="4" fill="#5a3a1a"/></svg>',
    // Slime saltarin
    '<svg viewBox="0 0 48 56"><path d="M8 44 Q8 24 24 24 Q40 24 40 44 Z" fill="#27ae60"/><ellipse cx="24" cy="44" rx="16" ry="5" fill="#1e8449"/><rect x="18" y="32" width="4" height="5" fill="#15202a"/><rect x="26" y="32" width="4" height="5" fill="#15202a"/><ellipse cx="24" cy="40" rx="4" ry="2" fill="#1e8449"/><circle cx="16" cy="30" r="3" fill="#7ae6a0" opacity="0.6"/></svg>',
    // Criatura coleccionable (monito original)
    '<svg viewBox="0 0 48 56"><circle cx="24" cy="26" r="15" fill="#f1c40f"/><polygon points="12,16 8,4 20,12" fill="#f1c40f"/><polygon points="36,16 40,4 28,12" fill="#f1c40f"/><polygon points="13,15 11,8 18,13" fill="#e67e22"/><polygon points="35,15 37,8 30,13" fill="#e67e22"/><circle cx="19" cy="24" r="2.5" fill="#15202a"/><circle cx="29" cy="24" r="2.5" fill="#15202a"/><circle cx="16" cy="30" r="3" fill="#e74c3c" opacity="0.6"/><circle cx="32" cy="30" r="3" fill="#e74c3c" opacity="0.6"/><path d="M20 30 Q24 34 28 30" stroke="#15202a" stroke-width="2" fill="none"/><rect x="20" y="40" width="4" height="8" fill="#d4ac0d"/><rect x="24" y="40" width="4" height="8" fill="#d4ac0d"/></svg>',
    // Consola portatil retro (original)
    '<svg viewBox="0 0 48 56"><rect x="12" y="8" width="24" height="40" rx="3" fill="#7f8c8d"/><rect x="16" y="12" width="16" height="14" fill="#1a3a2a"/><rect x="18" y="14" width="12" height="10" fill="#5ab552"/><circle cx="30" cy="34" r="3" fill="#c0392b"/><circle cx="24" cy="36" r="3" fill="#c0392b"/><rect x="15" y="32" width="3" height="8" fill="#34495e"/><rect x="12" y="35" width="8" height="3" fill="#34495e"/></svg>',
    // Control / mando retro
    '<svg viewBox="0 0 48 56"><rect x="8" y="22" width="32" height="16" rx="8" fill="#bdc3c7"/><rect x="14" y="26" width="3" height="8" fill="#34495e"/><rect x="11" y="29" width="9" height="3" fill="#34495e"/><circle cx="30" cy="28" r="2.5" fill="#c0392b"/><circle cx="35" cy="31" r="2.5" fill="#27ae60"/><circle cx="24" cy="33" r="2" fill="#2980b9"/></svg>',
    // Cofre del tesoro
    '<svg viewBox="0 0 48 56"><rect x="12" y="24" width="24" height="18" fill="#8a6d3b"/><path d="M12 24 Q12 14 24 14 Q36 14 36 24 Z" fill="#a07d4b"/><rect x="12" y="28" width="24" height="4" fill="#5a3a1a"/><rect x="22" y="30" width="4" height="6" fill="#f1c40f"/><circle cx="24" cy="31" r="2" fill="#d4ac0d"/><rect x="14" y="38" width="20" height="2" fill="#f1c40f" opacity="0.6"/></svg>',
    // Corazon de vida
    '<svg viewBox="0 0 48 56"><path d="M24 40 L12 26 Q8 20 14 16 Q20 14 24 20 Q28 14 34 16 Q40 20 36 26 Z" fill="#e74c3c"/><rect x="18" y="20" width="4" height="4" fill="#fff" opacity="0.7"/></svg>',
    // TV CRT retro
    '<svg viewBox="0 0 48 56"><rect x="6" y="14" width="36" height="28" rx="3" fill="#6b6b6b"/><rect x="10" y="18" width="24" height="20" fill="#1a2a3a"/><rect x="12" y="20" width="20" height="16" fill="#4a90c0"/><rect x="13" y="21" width="18" height="3" fill="#7ab0e0" opacity="0.5"><animate attributeName="y" values="21;33;21" dur="3s" repeatCount="indefinite"/></rect><rect x="36" y="20" width="4" height="4" fill="#c0392b"/><rect x="36" y="28" width="4" height="4" fill="#34495e"/><rect x="14" y="42" width="4" height="6" fill="#5a5a5a"/><rect x="30" y="42" width="4" height="6" fill="#5a5a5a"/></svg>',
    // Consola de sobremesa (original)
    '<svg viewBox="0 0 48 56"><rect x="8" y="24" width="32" height="18" rx="2" fill="#4a4a4a"/><rect x="8" y="24" width="32" height="6" fill="#5a5a5a"/><rect x="12" y="32" width="24" height="3" fill="#2a2a2a"/><rect x="14" y="37" width="8" height="2" fill="#27ae60"/><circle cx="33" cy="38" r="2" fill="#c0392b"/><rect x="18" y="18" width="12" height="8" fill="#3a3a3a"/></svg>',
    // Cartucho de juego
    '<svg viewBox="0 0 48 56"><rect x="14" y="12" width="20" height="32" rx="2" fill="#34495e"/><rect x="14" y="12" width="20" height="8" fill="#2c3e50"/><rect x="18" y="22" width="12" height="10" fill="#ecf0f1"/><rect x="19" y="24" width="10" height="6" fill="#e67e22"/><rect x="16" y="40" width="4" height="4" fill="#2c3e50"/><rect x="22" y="40" width="4" height="4" fill="#2c3e50"/><rect x="28" y="40" width="4" height="4" fill="#2c3e50"/></svg>',
    // Moneda / coin
    '<svg viewBox="0 0 48 56"><ellipse cx="24" cy="28" rx="12" ry="14" fill="#f1c40f"><animate attributeName="rx" values="12;3;12" dur="1.5s" repeatCount="indefinite"/></ellipse><ellipse cx="24" cy="28" rx="8" ry="10" fill="#f39c12"><animate attributeName="rx" values="8;2;8" dur="1.5s" repeatCount="indefinite"/></ellipse></svg>'
  ],
  dark: [
    // Mago hechicero con pipa larga y humo místico
    '<svg viewBox="0 0 48 56"><rect x="18" y="2" width="12" height="4" fill="#4a3478"/><rect x="16" y="6" width="16" height="4" fill="#4a3478"/><polygon points="24,0 14,12 34,12" fill="#6b4ea8"/><rect x="20" y="4" width="3" height="3" fill="#e0c04a"/><rect x="14" y="12" width="20" height="6" fill="#d9c8a0"/><rect x="18" y="14" width="3" height="3" fill="#5b8fe0"/><rect x="26" y="14" width="3" height="3" fill="#5b8fe0"/><rect x="16" y="18" width="16" height="4" fill="#cfcfcf"/><rect x="12" y="22" width="24" height="24" fill="#6b4ea8"/><rect x="12" y="22" width="24" height="24" fill="none" stroke="#4a3478" stroke-width="2"/><rect x="20" y="28" width="8" height="3" fill="#9d6bf0"/><rect x="22" y="31" width="4" height="10" fill="#9d6bf0"/><rect x="32" y="24" width="8" height="3" fill="#8a6d3b"/><circle cx="41" cy="25" r="3" fill="#3a2a1a"/><circle cx="42" cy="20" r="2" fill="#c9a3ff" opacity="0.7"><animate attributeName="cy" values="22;14" dur="2s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.7;0" dur="2s" repeatCount="indefinite"/></circle><circle cx="44" cy="17" r="1.5" fill="#c9a3ff" opacity="0.5"><animate attributeName="cy" values="19;10" dur="2.4s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.5;0" dur="2.4s" repeatCount="indefinite"/></circle><rect x="6" y="10" width="3" height="36" fill="#5a4030"/><circle cx="7" cy="8" r="5" fill="#c9a3ff"><animate attributeName="opacity" values="0.6;1;0.6" dur="2s" repeatCount="indefinite"/></circle></svg>',
    // Caballero con armadura, casco y espada
    '<svg viewBox="0 0 48 56"><rect x="18" y="4" width="12" height="12" fill="#8a93a8"/><rect x="18" y="4" width="12" height="12" fill="none" stroke="#5a6378" stroke-width="2"/><rect x="22" y="2" width="4" height="4" fill="#e0457b"/><rect x="20" y="9" width="8" height="2" fill="#2d2147"/><rect x="14" y="16" width="20" height="22" fill="#9aa3b8"/><rect x="14" y="16" width="20" height="22" fill="none" stroke="#5a6378" stroke-width="2"/><rect x="22" y="20" width="4" height="14" fill="#e0457b"/><rect x="18" y="24" width="12" height="3" fill="#e0457b"/><rect x="36" y="6" width="4" height="30" fill="#dfe6f0"/><rect x="34" y="34" width="8" height="3" fill="#e0c04a"/><rect x="37" y="36" width="2" height="6" fill="#8a6d3b"/><rect x="14" y="38" width="6" height="14" fill="#8a93a8"/><rect x="28" y="38" width="6" height="14" fill="#8a93a8"/></svg>',
    // Dragon
    '<svg viewBox="0 0 48 56"><polygon points="6,30 2,20 12,26" fill="#5bc99d"/><polygon points="42,30 46,20 36,26" fill="#5bc99d"/><ellipse cx="24" cy="34" rx="14" ry="10" fill="#2d8a5f"/><rect x="20" y="14" width="8" height="14" fill="#2d8a5f"/><polygon points="18,14 24,6 30,14" fill="#2d8a5f"/><rect x="19" y="4" width="2" height="5" fill="#1a5a3a"/><rect x="27" y="4" width="2" height="5" fill="#1a5a3a"/><rect x="21" y="18" width="2" height="2" fill="#e0c04a"/><rect x="25" y="18" width="2" height="2" fill="#e0c04a"/><circle cx="24" cy="30" r="3" fill="#e0457b"><animate attributeName="r" values="2;4;2" dur="1.5s" repeatCount="indefinite"/></circle><rect x="22" y="44" width="4" height="8" fill="#2d8a5f"/></svg>',
    // Castillo / torre
    '<svg viewBox="0 0 48 56"><rect x="14" y="18" width="20" height="34" fill="#3a2f52"/><rect x="12" y="14" width="4" height="6" fill="#2d2147"/><rect x="22" y="14" width="4" height="6" fill="#2d2147"/><rect x="32" y="14" width="4" height="6" fill="#2d2147"/><rect x="20" y="26" width="6" height="8" fill="#9d6bf0"><animate attributeName="fill" values="#9d6bf0;#c9a3ff;#9d6bf0" dur="3s" repeatCount="indefinite"/></rect><rect x="18" y="40" width="8" height="12" fill="#15101f"/><polygon points="24,2 18,14 30,14" fill="#6b4ea8"/></svg>',
    // Pocion magica
    '<svg viewBox="0 0 48 56"><rect x="20" y="8" width="8" height="6" fill="#8a6d3b"/><path d="M18 14 L18 22 L14 44 Q14 50 24 50 Q34 50 34 44 L30 22 L30 14 Z" fill="#2d2147" stroke="#6b4ea8" stroke-width="2"/><path d="M16 34 L32 34 L30 44 Q30 48 24 48 Q18 48 18 44 Z" fill="#9d6bf0"><animate attributeName="fill" values="#9d6bf0;#e0457b;#5bc99d;#9d6bf0" dur="4s" repeatCount="indefinite"/></path><circle cx="21" cy="40" r="1.5" fill="#fff" opacity="0.8"><animate attributeName="cy" values="44;36" dur="2s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.8;0" dur="2s" repeatCount="indefinite"/></circle></svg>'
  ],
  aero: [
    // Pez payaso pixel
    '<svg viewBox="0 0 48 56"><ellipse cx="22" cy="30" rx="16" ry="11" fill="#ff8c42"/><rect x="14" y="22" width="4" height="16" fill="#fff"/><rect x="24" y="20" width="5" height="20" fill="#fff"/><polygon points="38,30 48,22 48,38" fill="#ff8c42"/><polygon points="20,19 26,8 30,20" fill="#ff6b1a"/><circle cx="12" cy="28" r="3" fill="#fff"/><circle cx="11" cy="28" r="1.5" fill="#15202a"/><circle cx="40" cy="14" r="3" fill="#fff" opacity="0.7"><animate attributeName="cy" values="16;4" dur="3s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.7;0" dur="3s" repeatCount="indefinite"/></circle></svg>',
    // Medusa
    '<svg viewBox="0 0 48 56"><path d="M10 24 Q10 8 24 8 Q38 8 38 24 Q38 28 34 28 L14 28 Q10 28 10 24 Z" fill="#5ed0a8" opacity="0.75"/><path d="M10 24 Q10 8 24 8 Q38 8 38 24" fill="none" stroke="#fff" stroke-width="2" opacity="0.6"/><g stroke="#5ed0a8" stroke-width="2" fill="none" opacity="0.7"><path d="M16,28 Q14,40 18,50"><animate attributeName="d" values="M16,28 Q14,40 18,50;M16,28 Q18,40 14,50;M16,28 Q14,40 18,50" dur="3s" repeatCount="indefinite"/></path><path d="M24,28 Q22,42 26,52"><animate attributeName="d" values="M24,28 Q22,42 26,52;M24,28 Q26,42 22,52;M24,28 Q22,42 26,52" dur="3.5s" repeatCount="indefinite"/></path><path d="M32,28 Q34,40 30,50"><animate attributeName="d" values="M32,28 Q34,40 30,50;M32,28 Q30,40 34,50;M32,28 Q34,40 30,50" dur="3.2s" repeatCount="indefinite"/></path></g><circle cx="18" cy="18" r="3" fill="#fff" opacity="0.8"/></svg>',
    // Burbuja glossy grande
    '<svg viewBox="0 0 48 56"><defs><radialGradient id="gb" cx="35%" cy="30%"><stop offset="0%" stop-color="#fff"/><stop offset="60%" stop-color="#5ed0a8" stop-opacity="0.5"/><stop offset="100%" stop-color="#1899d6" stop-opacity="0.6"/></radialGradient></defs><circle cx="24" cy="28" r="18" fill="url(#gb)"/><ellipse cx="17" cy="20" rx="6" ry="4" fill="#fff" opacity="0.85"/><circle cx="32" cy="34" r="2" fill="#fff" opacity="0.6"/></svg>',
    // Flor / planta acuatica
    '<svg viewBox="0 0 48 56"><rect x="22" y="28" width="4" height="24" fill="#3ddb95"/><g fill="#ffd24a"><ellipse cx="24" cy="14" rx="5" ry="9"/><ellipse cx="14" cy="20" rx="5" ry="9" transform="rotate(-50 14 20)"/><ellipse cx="34" cy="20" rx="5" ry="9" transform="rotate(50 34 20)"/><ellipse cx="17" cy="28" rx="5" ry="8" transform="rotate(-100 17 28)"/><ellipse cx="31" cy="28" rx="5" ry="8" transform="rotate(100 31 28)"/></g><circle cx="24" cy="22" r="6" fill="#ff8c42"/><circle cx="24" cy="22" r="3" fill="#fff"/></svg>',
    // Hoja / brote eco
    '<svg viewBox="0 0 48 56"><path d="M24 50 Q8 40 10 18 Q24 22 24 50" fill="#3ddb95"/><path d="M24 50 Q40 40 38 18 Q24 22 24 50" fill="#5ed0a8"/><path d="M24 50 L24 22" stroke="#2d9a6f" stroke-width="2"/><circle cx="30" cy="14" r="4" fill="#fff" opacity="0.7"><animate attributeName="cy" values="16;6" dur="3s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.7;0" dur="3s" repeatCount="indefinite"/></circle></svg>'
  ]
};

function renderStickers(theme) {
  const layer = document.getElementById('stickersLayer');
  if (!layer) return;
  layer.innerHTML = '';
  const set = STICKERS[theme] || STICKERS.nintendo;
  const positions = [
    { left: '2%', top: '20%' }, { right: '2%', top: '35%' },
    { left: '4%', bottom: '12%' }, { right: '3%', bottom: '18%' },
    { left: '1%', top: '60%' }, { right: '1%', top: '70%' }
  ];
  positions.forEach((pos, i) => {
    const s = document.createElement('div');
    s.className = 'sticker';
    s.innerHTML = set[i % set.length];
    Object.assign(s.style, pos);
    s.style.animationDelay = (i * 0.4) + 's';
    layer.appendChild(s);
  });
}

// ===== BATALLA DE STICKERS =====
function randomSticker() {
  const n = Math.floor(Math.random() * 7) + 1;
  return '/assets/Sprites/Sticker' + n + '.jpg';
}

function openBattleMenu() {
  if (!myUsername) { showNotif('Pon tu nombre para jugar'); return; }
  const others = connectedUsers.filter(u => u.userId !== myUserId && u.username);
  const content = document.getElementById('battleContent');
  if (!others.length) {
    content.innerHTML = '<p class="battle-msg">No hay nadie más en línea para retar.<br>Espera a que entre alguien con nombre.</p>';
  } else {
    content.innerHTML = '<p class="battle-msg">Elige a quién retar:</p><div class="battle-rivals">' +
      others.map(u => `<button class="battle-rival" onclick="challengeUser('${u.userId}')">⚔ ${escHtml(u.username)}</button>`).join('') +
      '</div>';
  }
  document.getElementById('battleOverlay').style.display = 'flex';
}

function closeBattle() {
  document.getElementById('battleOverlay').style.display = 'none';
}

function challengeUser(targetUserId) {
  const myStick = randomSticker();
  socket.emit('duel_challenge', { targetUserId, challengerSticker: myStick });
}

function showChoiceUI(duelId, myStickerUrl, rivalName, rivalStickerUrl) {
  currentDuelId = duelId;
  const content = document.getElementById('battleContent');
  content.innerHTML = `
    <div class="battle-arena">
      <div class="battle-fighter"><img src="${myStickerUrl}" class="shape-circle"/><span>Tú</span></div>
      <div class="battle-vs">VS</div>
      <div class="battle-fighter"><img src="${rivalStickerUrl}" class="shape-circle"/><span>${escHtml(rivalName)}</span></div>
    </div>
    <p class="battle-msg">¡Elige tu jugada!</p>
    <div class="battle-choices">
      <button class="battle-choice" onclick="makeChoice('piedra')">✊<br>Piedra</button>
      <button class="battle-choice" onclick="makeChoice('papel')">✋<br>Papel</button>
      <button class="battle-choice" onclick="makeChoice('tijera')">✌️<br>Tijera</button>
    </div>
    <p class="battle-status" id="battleStatus"></p>
  `;
  document.getElementById('battleOverlay').style.display = 'flex';
}

function makeChoice(choice) {
  if (!currentDuelId) return;
  socket.emit('duel_choice', { duelId: currentDuelId, choice });
  document.querySelectorAll('.battle-choice').forEach(b => b.disabled = true);
  const st = document.getElementById('battleStatus');
  if (st) st.textContent = 'Esperando al rival...';
}

// listeners de batalla
socket.on('duel_invite', ({ duelId, fromName, challengerSticker }) => {
  currentDuelId = duelId;
  const myStick = randomSticker();
  const content = document.getElementById('battleContent');
  content.innerHTML = `
    <p class="battle-msg"><b>${escHtml(fromName)}</b> te ha retado a una batalla ⚔</p>
    <div class="battle-arena">
      <div class="battle-fighter"><img src="${challengerSticker}" class="shape-circle"/><span>${escHtml(fromName)}</span></div>
      <div class="battle-vs">VS</div>
      <div class="battle-fighter"><img src="${myStick}" class="shape-circle"/><span>Tú</span></div>
    </div>
    <div class="battle-rivals">
      <button class="battle-rival" onclick="acceptDuel('${duelId}','${myStick}')">✅ Aceptar</button>
      <button class="battle-rival decline" onclick="declineDuel('${duelId}')">❌ Rechazar</button>
    </div>
  `;
  document.getElementById('battleOverlay').style.display = 'flex';
});

function acceptDuel(duelId, myStick) {
  socket.emit('duel_accept', { duelId, opponentSticker: myStick });
}
function declineDuel(duelId) {
  socket.emit('duel_decline', { duelId });
  closeBattle();
}

socket.on('duel_waiting', ({ opponentName }) => {
  const content = document.getElementById('battleContent');
  content.innerHTML = `<p class="battle-msg">Esperando que <b>${escHtml(opponentName)}</b> acepte el reto...</p><div class="battle-spinner">⚔</div>`;
  document.getElementById('battleOverlay').style.display = 'flex';
});

socket.on('duel_declined', ({ opponentName }) => {
  const content = document.getElementById('battleContent');
  content.innerHTML = `<p class="battle-msg">${escHtml(opponentName)} rechazó el reto 🙅</p>`;
  setTimeout(closeBattle, 2000);
});

socket.on('duel_start', ({ duelId, challengerName, opponentName, challengerSticker, opponentSticker }) => {
  const amChallenger = (challengerName === myUsername);
  const amOpponent = (opponentName === myUsername);
  if (amChallenger) {
    showChoiceUI(duelId, challengerSticker, opponentName, opponentSticker);
  } else if (amOpponent) {
    showChoiceUI(duelId, opponentSticker, challengerName, challengerSticker);
  } else {
    // espectador
    showSpectator(duelId, challengerName, challengerSticker, opponentName, opponentSticker);
  }
});

function showSpectator(duelId, cName, cStick, oName, oStick) {
  const content = document.getElementById('battleContent');
  content.innerHTML = `
    <p class="battle-msg">⚔ ${escHtml(cName)} vs ${escHtml(oName)}</p>
    <div class="battle-arena">
      <div class="battle-fighter"><img src="${cStick}" class="shape-circle"/><span>${escHtml(cName)}</span></div>
      <div class="battle-vs">VS</div>
      <div class="battle-fighter"><img src="${oStick}" class="shape-circle"/><span>${escHtml(oName)}</span></div>
    </div>
    <p class="battle-status">Batalla en curso...</p>
  `;
  document.getElementById('battleOverlay').style.display = 'flex';
}

socket.on('duel_result', ({ challengerName, opponentName, challengerChoice, opponentChoice, winner }) => {
  const content = document.getElementById('battleContent');
  const emoji = { piedra: '✊', papel: '✋', tijera: '✌️' };
  let resultText = winner === 'empate' ? '🤝 ¡EMPATE!' : '🏆 ¡Ganó ' + escHtml(winner) + '!';
  content.innerHTML = `
    <div class="battle-arena result">
      <div class="battle-fighter"><div class="battle-emoji">${emoji[challengerChoice]}</div><span>${escHtml(challengerName)}</span></div>
      <div class="battle-vs">VS</div>
      <div class="battle-fighter"><div class="battle-emoji">${emoji[opponentChoice]}</div><span>${escHtml(opponentName)}</span></div>
    </div>
    <p class="battle-winner">${resultText}</p>
    <button class="battle-rival" onclick="closeBattle()">Cerrar</button>
  `;
  currentDuelId = null;
  if (winner !== 'empate') showNotif('🏆 ' + winner + ' ganó la batalla');
});

// ===== TOWER DEFENSE VERSUS =====
function openTdMenu() {
  if (!myUsername) { showNotif('Pon tu nombre para jugar'); return; }
  const game = document.getElementById('tdGame');
  game.innerHTML = `
    <div class="td-menu">
      <p class="td-msg">Tower Defense 1 vs 1</p>
      <p class="td-sub">Defiende tu base y envía tropas a destruir la del rival.</p>
      <button class="td-btn" onclick="tdFindMatch()">🎮 Buscar partida</button>
    </div>
  `;
  document.getElementById('tdOverlay').style.display = 'flex';
}

function closeTd() {
  document.getElementById('tdOverlay').style.display = 'none';
  if (tdId) { socket.emit('td_cancel'); }
  tdId = null; tdState = null;
}

function tdFindMatch() {
  socket.emit('td_join');
  const game = document.getElementById('tdGame');
  game.innerHTML = `<div class="td-menu"><p class="td-msg">Buscando rival...</p><div class="battle-spinner">🏰</div><button class="td-btn decline" onclick="closeTd()">Cancelar</button></div>`;
}

socket.on('td_waiting', () => {
  const game = document.getElementById('tdGame');
  game.innerHTML = `<div class="td-menu"><p class="td-msg">Esperando que entre otro jugador...</p><div class="battle-spinner">🏰</div><button class="td-btn decline" onclick="closeTd()">Cancelar</button></div>`;
  document.getElementById('tdOverlay').style.display = 'flex';
});

socket.on('td_start', ({ tdId: id, you, players }) => {
  tdId = id;
  tdMe = you;
  tdMySide = players.find(p => p.userId === you)?.side || 'left';
  buildTdBoard(players);
  document.getElementById('tdOverlay').style.display = 'flex';
});

function buildTdBoard(players) {
  const me = players.find(p => p.userId === tdMe);
  const rival = players.find(p => p.userId !== tdMe);
  const game = document.getElementById('tdGame');
  game.innerHTML = `
    <div class="td-hud">
      <div class="td-player-info">🛡️ ${escHtml(me.name)} (tú) · <span id="tdMyHp">100</span>❤ · <span id="tdMyGold">150</span>🟡</div>
      <div class="td-player-info">⚔ ${escHtml(rival.name)} · <span id="tdRivalHp">100</span>❤</div>
    </div>
    <canvas id="tdCanvas" width="600" height="300"></canvas>
    <div class="td-controls">
      <div class="td-control-group">
        <span class="td-label">Torres:</span>
        <button class="td-tower-btn active" data-tower="basic" onclick="selectTower('basic')">🔫 Básica 50</button>
        <button class="td-tower-btn" data-tower="fast" onclick="selectTower('fast')">⚡ Rápida 75</button>
        <button class="td-tower-btn" data-tower="heavy" onclick="selectTower('heavy')">💥 Pesada 100</button>
      </div>
      <div class="td-control-group">
        <span class="td-label">Tropas:</span>
        <button class="td-troop-btn" onclick="sendTroop('soldier')">👷 Soldado 30</button>
        <button class="td-troop-btn" onclick="sendTroop('runner')">🏃 Corredor 40</button>
        <button class="td-troop-btn" onclick="sendTroop('tank')">🛡️ Tanque 80</button>
      </div>
      <p class="td-hint">Haz clic en TU lado del mapa para poner torres</p>
    </div>
  `;
  const canvas = document.getElementById('tdCanvas');
  canvas.addEventListener('click', onTdCanvasClick);
}

function selectTower(type) {
  tdSelectedTower = type;
  document.querySelectorAll('.td-tower-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-tower') === type);
  });
}

function onTdCanvasClick(e) {
  if (!tdId || !tdState) return;
  const canvas = document.getElementById('tdCanvas');
  const rect = canvas.getBoundingClientRect();
  const xPct = ((e.clientX - rect.left) / rect.width) * 100;
  const yPct = ((e.clientY - rect.top) / rect.height) * 100;
  // solo puedo poner torres en MI mitad
  const myHalf = tdMySide === 'left' ? (xPct < 50) : (xPct >= 50);
  if (!myHalf) { showNotif('Solo en tu lado del mapa'); return; }
  socket.emit('td_place_tower', { tdId, x: xPct, y: yPct, towerType: tdSelectedTower });
}

function sendTroop(type) {
  if (!tdId) return;
  socket.emit('td_send_troop', { tdId, troopType: type });
}

socket.on('td_state', (state) => {
  tdState = state;
  renderTdCanvas();
  // actualizar HUD
  const me = state.players.find(p => p.userId === tdMe);
  const rival = state.players.find(p => p.userId !== tdMe);
  if (me) {
    const hpEl = document.getElementById('tdMyHp');
    const goldEl = document.getElementById('tdMyGold');
    if (hpEl) hpEl.textContent = Math.max(0, Math.round(me.hp));
    if (goldEl) goldEl.textContent = Math.round(me.gold);
  }
  if (rival) {
    const rHp = document.getElementById('tdRivalHp');
    if (rHp) rHp.textContent = Math.max(0, Math.round(rival.hp));
  }
});

function renderTdCanvas() {
  const canvas = document.getElementById('tdCanvas');
  if (!canvas || !tdState) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  // fondo
  ctx.fillStyle = '#1a2a1a';
  ctx.fillRect(0, 0, W, H);
  // linea media
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.setLineDash([6, 6]);
  ctx.beginPath(); ctx.moveTo(W/2, 0); ctx.lineTo(W/2, H); ctx.stroke();
  ctx.setLineDash([]);
  // camino horizontal
  ctx.fillStyle = '#3a3a2a';
  ctx.fillRect(0, H/2 - 24, W, 48);

  // bases
  const myLeft = tdMySide === 'left';
  // base izquierda
  ctx.fillStyle = myLeft ? '#2980b9' : '#c0392b';
  ctx.fillRect(4, H/2 - 36, 30, 72);
  // base derecha
  ctx.fillStyle = myLeft ? '#c0392b' : '#2980b9';
  ctx.fillRect(W - 34, H/2 - 36, 30, 72);

  // torres
  for (const p of tdState.players) {
    const isMine = p.userId === tdMe;
    ctx.fillStyle = isMine ? '#5dade2' : '#e74c3c';
    for (const t of p.towers) {
      const tx = (t.x / 100) * W;
      const ty = (t.y / 100) * H;
      ctx.beginPath();
      ctx.arc(tx, ty, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '10px monospace';
      const icon = t.type === 'basic' ? 'B' : (t.type === 'fast' ? 'F' : 'H');
      ctx.fillText(icon, tx - 3, ty + 3);
      ctx.fillStyle = isMine ? '#5dade2' : '#e74c3c';
    }
  }

  // tropas (enemies)
  for (const e of tdState.enemies) {
    // progress 0-100; si va a 'right', avanza de izq a der; si va a 'left', de der a izq
    let xPct = e.targetSide === 'right' ? e.progress : (100 - e.progress);
    const ex = (xPct / 100) * W;
    const ey = H/2;
    const isMine = e.owner === tdMe;
    ctx.fillStyle = isMine ? '#58d68d' : '#f39c12';
    const size = e.type === 'tank' ? 11 : (e.type === 'runner' ? 6 : 8);
    ctx.fillRect(ex - size/2, ey - size/2, size, size);
    // barra de vida
    ctx.fillStyle = '#000';
    ctx.fillRect(ex - 8, ey - size/2 - 6, 16, 3);
    ctx.fillStyle = '#2ecc71';
    ctx.fillRect(ex - 8, ey - size/2 - 6, 16 * (e.hp / e.maxHp), 3);
  }
}

socket.on('td_gameover', ({ winnerName }) => {
  const game = document.getElementById('tdGame');
  const won = winnerName === myUsername;
  game.innerHTML = `<div class="td-menu">
    <p class="td-result">${won ? '🏆 ¡GANASTE!' : '💀 Perdiste'}</p>
    <p class="td-msg">Ganó ${escHtml(winnerName)}</p>
    <button class="td-btn" onclick="tdFindMatch()">Jugar de nuevo</button>
    <button class="td-btn decline" onclick="closeTd()">Salir</button>
  </div>`;
  tdId = null; tdState = null;
  showNotif(won ? '🏆 Ganaste el Tower Defense' : '💀 Perdiste el Tower Defense');
});

socket.on('td_opponent_left', () => {
  const game = document.getElementById('tdGame');
  game.innerHTML = `<div class="td-menu"><p class="td-result">🏆 ¡Ganaste!</p><p class="td-msg">Tu rival se fue.</p><button class="td-btn decline" onclick="closeTd()">Salir</button></div>`;
  tdId = null; tdState = null;
});

function initStars() {
  const container = document.getElementById('stars');
  for (let i = 0; i < 20; i++) {
    const star = document.createElement('div');
    star.className = 'star-float';
    star.textContent = ['★', '✦', '♪', '♫'][Math.floor(Math.random() * 4)];
    star.style.left = Math.random() * 100 + '%';
    star.style.top = Math.random() * 100 + '%';
    star.style.animationDuration = (4 + Math.random() * 8) + 's';
    star.style.animationDelay = (Math.random() * 6) + 's';
    star.style.fontSize = (10 + Math.random() * 10) + 'px';
    container.appendChild(star);
  }
}

function initParticles() {
  const container = document.getElementById('particles');
  if (!container) return;
  container.innerHTML = '';
  const count = 24;
  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    const size = 6 + Math.random() * 26;
    p.style.width = size + 'px';
    p.style.height = size + 'px';
    p.style.left = Math.random() * 100 + '%';
    p.style.animationDuration = (8 + Math.random() * 12) + 's';
    p.style.animationDelay = (Math.random() * 10) + 's';
    container.appendChild(p);
  }
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('nalesss_theme', theme);
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-set') === theme);
  });
  initParticles();
  renderBgImage(theme);
  renderScene(theme);
  renderCharacters(theme);
  renderImageStickers(theme);
  const names = { nintendo: 'Old Nintendo', dark: 'Dark Fantasy', aero: 'Frutiger Aero' };
  showNotif('Tema: ' + (names[theme] || theme));
}

function loadSavedTheme() {
  const saved = localStorage.getItem('nalesss_theme') || 'nintendo';
  setTheme(saved);
}

document.getElementById('progressWrap').addEventListener('click', (e) => {
  if (!currentTrack) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  let durMs = 0;
  if (currentTrack.type === 'local' && audioElement) durMs = audioElement.duration * 1000;
  else if (currentTrack.type === 'youtube' && ytPlayer && ytReady) durMs = ytPlayer.getDuration() * 1000;
  else if (currentTrack.type === 'spotify' && spotifyPlayer) {
    spotifyPlayer.getCurrentState().then(state => {
      if (state) socket.emit('seek', pct * state.duration);
    });
    return;
  }
  if (durMs) socket.emit('seek', pct * durMs);
});

socket.on('user_id', (id) => { myUserId = id; });

socket.on('state_sync', (state) => {
  renderQueue(state.queue);
  if (state.chat) renderChatHistory(state.chat);
  if (state.currentTrack) {
    playTrack(state.currentTrack, state.positionMs || 0);
    updatePlayBtn(state.isPlaying);
    if (!state.isPlaying) pauseCurrent();
  }
  showStatus('Conectado', true);
});

socket.on('queue_updated', renderQueue);

socket.on('track_changed', ({ track, positionMs }) => {
  playTrack(track, positionMs || 0);
});

socket.on('track_stopped', () => {
  stopEverything();
  currentTrack = null;
  document.getElementById('trackName').textContent = '— sin reproducir —';
  document.getElementById('trackArtist').textContent = 'NalessS♫♫';
  document.getElementById('coverImg').style.display = 'none';
  document.getElementById('coverPlaceholder').style.display = 'flex';
  document.getElementById('addedByBadge').style.display = 'none';
  document.querySelector('.cover-frame').classList.remove('playing');
  document.getElementById('vinylRing').classList.remove('active');
  updatePlayBtn(false);
  updateProgress(0, 0, 0);
});

socket.on('playback_state', ({ isPlaying: playing, positionMs }) => {
  updatePlayBtn(playing);
  if (playing) resumeCurrent(positionMs);
  else pauseCurrent();
});

socket.on('seek_to', ({ positionMs, isPlaying: playing }) => {
  seekCurrent(positionMs);
  updatePlayBtn(playing);
});

socket.on('users_updated', (users) => {
  document.getElementById('userCount').textContent = users.length || 1;
  connectedUsers = users;
});

socket.on('notification', ({ message }) => {
  showNotif(message);
});

socket.on('chat_message', (msg) => {
  appendChatMessage(msg);
});

socket.on('modes_updated', ({ shuffle, radioMode }) => {
  const sb = document.getElementById('shuffleBtn');
  const rb = document.getElementById('radioBtn');
  if (sb) sb.classList.toggle('mode-active', shuffle);
  if (rb) rb.classList.toggle('mode-active', radioMode);
});

// solo UN cliente (el que tenga spotify) busca la recomendacion para evitar duplicados
socket.on('radio_continue', (seedTrack) => {
  if (accessToken && isSpotifyReady) {
    findRadioTrack(seedTrack);
  }
});

socket.on('disconnect', () => { showStatus('Desconectado', false); });
socket.on('connect', () => {
  showStatus('Conectado', true);
  if (myUsername) socket.emit('set_username', myUsername);
});

if (myUsername) {
  document.getElementById('usernameInput').value = myUsername;
  socket.emit('set_username', myUsername);
  unlockChat();
}

initStars();
initParticles();
loadSavedTheme();
initSpotify();
