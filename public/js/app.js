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
  showNotif('Usuario: ' + val);
}

function togglePlay() {
  const newState = !isPlaying;
  socket.emit('toggle_play', newState);
  if (currentTrack?.type === 'spotify' && spotifyPlayer) {
    newState ? spotifyPlayer.resume() : spotifyPlayer.pause();
  } else if (currentTrack?.type === 'local' && audioElement) {
    newState ? audioElement.play() : audioElement.pause();
  }
}

function nextTrack() {
  socket.emit('next_track');
}

function prevTrack() {
  if (audioElement) { audioElement.currentTime = 0; }
  if (spotifyPlayer) { spotifyPlayer.seek(0); }
}

function setVolume(val) {
  document.getElementById('volLabel').textContent = val;
  if (audioElement) audioElement.volume = val / 100;
  if (spotifyPlayer) spotifyPlayer.setVolume(val / 100);
}

function playTrack(track) {
  currentTrack = track;

  if (audioElement) {
    audioElement.pause();
    audioElement.src = '';
    audioElement = null;
  }

  clearInterval(progressInterval);

  if (track.type === 'spotify') {
    if (isSpotifyReady && spotifyDeviceId) {
      spotifyApi('/me/player/play', 'PUT', { uris: [track.uri] });
    }
  } else if (track.type === 'local') {
    audioElement = new Audio(track.url);
    audioElement.volume = document.getElementById('volumeSlider').value / 100;
    audioElement.play().catch(e => console.log('Audio play error:', e));
    audioElement.addEventListener('timeupdate', () => {
      const pct = (audioElement.currentTime / audioElement.duration) * 100 || 0;
      updateProgress(pct, audioElement.currentTime * 1000, audioElement.duration * 1000);
      socket.emit('update_progress', pct);
    });
    audioElement.addEventListener('ended', () => {
      socket.emit('next_track');
    });
  }

  updateNowPlayingUI(track);
  updatePlayBtn(true);
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
  if (track.cover) {
    coverImg.src = track.cover;
    coverImg.onerror = () => { coverImg.src = '/assets/default-cover.svg'; };
  } else {
    coverImg.src = '/assets/default-cover.svg';
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
        <div class="queue-item-meta">${escHtml(track.artist)} · <span class="queue-item-type type-${track.type}">${track.type === 'spotify' ? 'spotify' : 'mp3'}</span></div>
        <div style="font-family:var(--font-pixel);font-size:7px;color:var(--text3);margin-top:2px">por ${escHtml(track.addedBy || 'Anon')}</div>
      </div>
      <button class="queue-remove" onclick="removeFromQueue('${track.id}')" title="quitar">✕</button>
    `;
    list.appendChild(div);
  });
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

document.getElementById('progressWrap').addEventListener('click', (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  if (currentTrack?.type === 'local' && audioElement) {
    audioElement.currentTime = pct * audioElement.duration;
  } else if (currentTrack?.type === 'spotify' && spotifyPlayer) {
    spotifyPlayer.getCurrentState().then(state => {
      if (state) spotifyPlayer.seek(pct * state.duration);
    });
  }
});

socket.on('user_id', (id) => { myUserId = id; });

socket.on('state_sync', (state) => {
  renderQueue(state.queue);
  if (state.currentTrack) updateNowPlayingUI(state.currentTrack);
  updatePlayBtn(state.isPlaying);
  showStatus('Conectado', true);
});

socket.on('queue_updated', renderQueue);

socket.on('track_changed', (track) => {
  playTrack(track);
});

socket.on('playback_state', ({ isPlaying: playing }) => {
  updatePlayBtn(playing);
  if (!playing && audioElement) audioElement.pause();
  if (playing && audioElement) audioElement.play().catch(() => {});
});

socket.on('progress_update', (pct) => {
  if (currentTrack?.type === 'local' && audioElement) return;
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressStar').style.left = pct + '%';
});

socket.on('users_updated', (users) => {
  document.getElementById('userCount').textContent = users.length || 1;
});

socket.on('notification', ({ message }) => {
  showNotif(message);
});

socket.on('disconnect', () => { showStatus('Desconectado', false); });
socket.on('connect', () => {
  showStatus('Conectado', true);
  if (myUsername) socket.emit('set_username', myUsername);
});

if (myUsername) {
  document.getElementById('usernameInput').value = myUsername;
  socket.emit('set_username', myUsername);
}

initStars();
initSpotify();
