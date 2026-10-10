const $ = s => document.querySelector(s);
const audio = $('#audio');
let station = null, enabled = false, admin = false, tracks = [], lastNonce = null;
const socket = io({ reconnection: true });
function toast(msg) { $('#message').textContent = msg; }
async function request(url, opts={}) {
  const res = await fetch(url, { credentials: 'same-origin', ...opts });
  const data = await res.json();
  if (!res.ok) throw Error(data.error || 'Ошибка сервера');
  return data;
}
function json(method, body) { return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }
function sync(s) {
  if (!s || !s.track) return;
  const changed = lastNonce !== s.current.nonce;
  station = s;
  $('#song').textContent = s.track.title;
  $('#status').textContent = socket.connected ? '● В эфире' : '○ Подключение';
  if (changed) {
    lastNonce = s.current.nonce;
    audio.src = s.track.url;
    audio.load();
    if (enabled) playSynced();
  }
  if (admin) renderTracks();
}
function jumpToLive() {
  if (!station || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
  const elapsed = Math.max(0, (Date.now() - station.current.startedAt) / 1000);
  const target = elapsed % audio.duration;
  if (Math.abs(audio.currentTime - target) > 1.7) audio.currentTime = target;
}
async function playSynced() {
  if (!station) return;
  if (audio.readyState >= 1) jumpToLive();
  try {
    await audio.play();
    $('#listen').textContent = 'Ⅱ';
    $('#mute').hidden = false;
    startVisualizer();
    $('#hint').textContent = 'В эфире';
  } catch(e) {
    $('#listen').textContent = '▶';
    $('#hint').textContent = 'Нажми ▶, чтобы слушать';
  }
}
$('#listen').onclick = () => { if (enabled && !audio.paused) {audio.pause(); $('#listen').textContent='▶'; return;} enabled = true; playSynced(); }; 
$('#mute').onclick = () => { audio.muted = !audio.muted; $('#mute').textContent = audio.muted ? '♩' : '♪'; };
audio.onloadedmetadata = () => { if (enabled) { jumpToLive(); playSynced(); } };
audio.onerror = () => { $('#status').textContent = 'Не удалось загрузить аудио. Проверьте прямую ссылку или формат.'; };
setInterval(() => {
  if (!station || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
  $('#bar').style.width = ((audio.currentTime / audio.duration) * 100) + '%';
  if (enabled && !audio.paused) jumpToLive();
}, 1000);
socket.on('station', sync);
socket.on('connect', () => { $('#status').textContent = '● Онлайн'; });
socket.on('disconnect', () => { $('#status').textContent = '○ Нет связи'; });
socket.on('listeners', n => { $('#listeners').textContent = n; });
$('#adminToggle').onclick = async () => { $('#overlay').classList.remove('hidden'); toast(''); await checkAdmin(); };
$('#close').onclick = () => $('#overlay').classList.add('hidden');
$('#overlay').onclick = e => { if (e.target === $('#overlay')) $('#overlay').classList.add('hidden'); };
async function checkAdmin() {
  try { admin = (await request('/api/me')).admin; } catch (_) { admin = false; }
  $('#loginView').hidden = admin;
  $('#dashView').hidden = !admin;
  if (admin) await refreshTracks();
}
async function refreshTracks() {
  try { const r = await request('/api/admin/tracks'); tracks = r.tracks; $('#listeners').textContent = r.listeners; renderTracks(); }
  catch(e) { toast(e.message); }
}
function renderTracks() {
  const list = $('#trackList'); list.replaceChildren();
  for (const t of tracks) {
    const row = document.createElement('div'); row.className = 'track';
    const name = document.createElement('div'); name.className = 'trackname';
    name.textContent = t.title;
    const meta = document.createElement('small'); meta.textContent = t.source === 'demo' ? 'Встроенный трек' : t.source === 'upload' ? 'Загружен' : 'Ссылка'; name.append(meta);
    const play = document.createElement('button'); play.textContent = station?.current.trackId === t.id ? '● В эфире' : '▶ Включить';
    if (station?.current.trackId === t.id) play.className = 'active';
    play.onclick = async () => { try { await request('/api/admin/play', json('POST',{id:t.id})); toast('Трек включён для всех'); } catch(e) {toast(e.message);} };
    row.append(name,play);
    if (t.source !== 'demo') {
      const del = document.createElement('button'); del.textContent = '✕'; del.title = 'Удалить';
      del.onclick = async () => { if (!confirm('Удалить трек?')) return; try { await request('/api/admin/tracks/'+encodeURIComponent(t.id),{method:'DELETE'}); await refreshTracks(); } catch(e) { toast(e.message); } };
      row.append(del);
    }
    list.append(row);
  }
}
$('#loginForm').onsubmit = async e => {
  e.preventDefault();
  try { await request('/api/login',json('POST',{password:$('#password').value})); $('#password').value=''; await checkAdmin(); socket.disconnect().connect(); toast('Вход выполнен'); }
  catch(e) { toast(e.message); }
};
$('#logout').onclick = async () => { await request('/api/logout',{method:'POST'}); admin=false; socket.disconnect().connect(); await checkAdmin(); toast('Вы вышли'); };
$('#random').onclick = async () => { try { await request('/api/admin/random',{method:'POST'}); toast('Включён случайный трек'); } catch(e) { toast(e.message); } };
$('#urlForm').onsubmit = async e => {
  e.preventDefault(); try { await request('/api/admin/url',json('POST',{title:$('#trackTitle').value,url:$('#trackUrl').value})); e.target.reset(); await refreshTracks(); toast('Трек добавлен. Нажмите «Включить».'); } catch(e) {toast(e.message);}
};
$('#uploadForm').onsubmit = async e => {
  e.preventDefault(); const file=$('#audioFile').files[0]; if(!file) return;
  const data = new FormData(); data.append('audio',file);
  try { await request('/api/admin/upload',{method:'POST',body:data}); e.target.reset(); await refreshTracks(); toast('Аудиофайл загружен. Нажмите «Включить».'); } catch(e) {toast(e.message);}
};
fetch('/api/state').then(r=>r.json()).then(sync).catch(()=>{});

// Web Audio visualizer: reacts to real playback loudness, with a gentle fallback
// for sources that cannot be analysed by the browser.
let visualizerReady = false, analyser, bins, audioContext;
function startVisualizer() {
  if (visualizerReady) { if(audioContext?.state === 'suspended') audioContext.resume().catch(()=>{}); return; }
  visualizerReady = true;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      audioContext = new AC();
      const source = audioContext.createMediaElementSource(audio);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      bins = new Uint8Array(analyser.frequencyBinCount);
      source.connect(analyser);
      analyser.connect(audioContext.destination);
      audioContext.resume().catch(()=>{});
    }
  } catch (e) { console.warn('Визуализация без анализатора:', e); }
  let energy = 0;
  function frame(time) {
    let target = 0;
    if (!audio.paused && !audio.muted) {
      if (analyser) {
        analyser.getByteFrequencyData(bins);
        let sum = 0;
        for (let i = 0; i < Math.min(40, bins.length); i++) sum += bins[i];
        target = Math.min(1, sum / (Math.min(40, bins.length) * 145));
      } else target = .25 + .25 * Math.abs(Math.sin(time / 300));
    }
    energy += (target - energy) * .22;
    document.documentElement.style.setProperty('--beat', energy.toFixed(3));
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
