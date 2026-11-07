const $ = id => document.getElementById(id);
let channels = [], version, pollBusy = false, adminToken = sessionStorage.getItem('cosmic_token') || '', filesBusy = false;
let selectedIds = new Set(), selectionKnown = false, selectionDirty = false;
let nextSourcePoll = 0;
const healthNames = { working: 'Media terbaca', failed: 'Gagal', unchecked: 'Belum diperiksa', drm: 'Perlu DRM', unsupported: 'Belum didukung' };
const date = value => value ? new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Belum diperiksa';
const notice = message => { $('notice').textContent = message; $('notice').hidden = !message; };
async function api(path, options = {}, admin = false) {
  const headers = { ...options.headers };
  if (adminToken) headers.Authorization = `Bearer ${adminToken}`;
  const response = await fetch(path, { ...options, signal: AbortSignal.timeout(25000), headers });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || data.lastError || `HTTP ${response.status}`); error.status = response.status; throw error; }
  return data;
}
function playlistUrl() {
  const origin = window.COSMIC_PUBLIC_ORIGIN || location.origin;
  const url = new URL('/playlist.m3u', origin);
  if ($('search').value.trim()) url.searchParams.set('q', $('search').value.trim());
  if ($('group').value) url.searchParams.set('group', $('group').value);
  if ($('no-drm').checked) url.searchParams.set('drm', 'exclude');
  return url.href;
}
function render() {
  const query = $('search').value.trim().toLocaleLowerCase();
  const rows = channels.filter(channel => (!query || channel.name.toLocaleLowerCase().includes(query)) && (!$('group').value || channel.group === $('group').value) && (!$('health-filter').value || channel.health === $('health-filter').value) && (!$('no-drm').checked || channel.sourceCount > channel.drmSourceCount));
  $('channels').replaceChildren();
  rows.forEach((channel, index) => {
    const row = document.createElement('tr');
    const number = row.insertCell(); number.textContent = String(index + 1).padStart(2, '0'); number.className = 'number';
    const pick = row.insertCell(); pick.className = 'pick-cell';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selectedIds.has(channel.id); checkbox.disabled = !adminToken;
    checkbox.setAttribute('aria-label', `${checkbox.checked ? 'Keluarkan' : 'Masukkan'} ${channel.name} ${checkbox.checked ? 'dari' : 'ke'} playlist final`);
    checkbox.onchange = () => { if (checkbox.checked) selectedIds.add(channel.id); else selectedIds.delete(channel.id); selectionDirty = true; updateSelectionTools(); };
    pick.append(checkbox);
    for (const [value, className] of [[channel.name, ''], [channel.group, 'category']]) {
      const cell = row.insertCell(); cell.textContent = value; cell.className = className;
    }
    const state = row.insertCell();
    const badge = document.createElement('span'); badge.className = `badge health-${channel.health}`; badge.textContent = healthNames[channel.health] || channel.health; state.append(badge);
    const details = document.createElement('small'); details.className = 'check-detail'; details.textContent = date(channel.checkedAt); details.title = channel.reason; state.append(details);
    const reason = document.createElement('details'); reason.className = 'check-reason';
    const summary = document.createElement('summary'); summary.textContent = 'Lihat alasan';
    const explanation = document.createElement('p'); explanation.textContent = channel.reason; reason.append(summary, explanation); state.append(reason);
    state.title = channel.reason;
    const count = row.insertCell(); count.className = 'sources'; count.textContent = `${channel.passedSourceCount} / ${channel.sourceCount}`;
    $('channels').append(row);
  });
  if (!rows.length) { const row = $('channels').insertRow(); const cell = row.insertCell(); cell.colSpan = 6; cell.className = 'empty'; cell.textContent = channels.length ? 'Tidak ada channel yang cocok dengan filter ini.' : 'Belum ada daftar channel. Tambahkan sumber atau tunggu proses impor.'; }
  $('results').textContent = `${rows.length} dari ${channels.length} channel dalam katalog. ${selectedIds.size} dipilih; hanya stream pilihan yang lolos pemeriksaan masuk playlist final.`;
  updateSelectionTools();
  $('playlist-url').value = playlistUrl(); $('download').href = window.COSMIC_READ_TOKEN_REQUIRED ? '/playlist.m3u' : playlistUrl();
  const tokenNote = $('token-note'); if (tokenNote) tokenNote.hidden = !window.COSMIC_READ_TOKEN_REQUIRED;
}
function updateSelectionTools() {
  $('selected-count').textContent = `${selectedIds.size} channel dipilih`;
  const save = $('save-selection');
  save.textContent = !adminToken ? 'Masuk untuk memilih' : selectionDirty ? 'Simpan pilihan' : 'Pilihan tersimpan';
  save.disabled = !!adminToken && !selectionDirty;
}
async function loadSelection() {
  const data = await api('/api/v1/selection', {}, true);
  selectedIds = new Set(data.channelIds); selectionKnown = true; selectionDirty = false;
  updateSelectionTools(); render();
}
async function saveSelection() {
  if (!adminToken) { switchTab('sources'); $('management').hidden = false; $('manage-toggle').setAttribute('aria-expanded', 'true'); $('management').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('source-token').focus(); $('source-message').textContent = 'Masukkan token admin untuk memilih dan menyimpan channel playlist.'; return; }
  if (!selectionDirty) return;
  const button = $('save-selection'); button.disabled = true;
  try {
    const data = await api('/api/v1/selection', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelIds: [...selectedIds] }) }, true);
    selectedIds = new Set(data.channelIds); selectionKnown = true; selectionDirty = false;
    channels = channels.map(channel => ({ ...channel, selected: selectedIds.has(channel.id) }));
    render(); $('source-message').textContent = `${data.includedCount} channel masuk ke playlist final. URL belum lolos pemeriksaan akan menunggu sampai lolos.`;
    await poll();
  } catch (error) { $('source-message').textContent = error.message; }
  finally { updateSelectionTools(); }
}
async function loadSources() {
  if (!adminToken) return;
  const data = await api('/api/v1/sources', {}, true);
  $('source-list').replaceChildren();
  for (const item of data.sources) {
    const row = document.createElement('div'); row.className = 'source-row';
    const info = document.createElement('div');
    const name = document.createElement('strong'); name.textContent = item.name; info.append(name);
    const detail = document.createElement('small'); detail.textContent = `${item.type === 'upload' ? 'Berkas unggahan' : item.type === 'signed' ? 'API JSON bawaan' : item.url} · ${item.channelCount} channel · ${item.enabled ? 'Aktif' : 'Nonaktif'}`; info.append(detail);
    if (item.error) { const error = document.createElement('small'); error.className = 'source-error'; error.textContent = item.error; info.append(error); }
    row.append(info);
    const toggle = document.createElement('button'); toggle.className = 'copy-button'; toggle.textContent = item.enabled ? 'Nonaktifkan' : 'Aktifkan';
    toggle.onclick = async () => { toggle.disabled = true; try { await api('/api/v1/sources/' + item.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !item.enabled }) }, true); await loadSources(); await poll(); } catch (error) { $('source-message').textContent = error.message; } finally { toggle.disabled = false; } };
    row.append(toggle);
    if (item.type !== 'signed') {
      const remove = document.createElement('button'); remove.className = 'text-button remove-source'; remove.textContent = 'Hapus';
      remove.onclick = async () => { if (!confirm(`Hapus sumber ${item.name}? Sumber dapat ditambahkan lagi.`)) return; remove.disabled = true; try { await api('/api/v1/sources/' + item.id, { method: 'DELETE' }, true); await loadSources(); await poll(); } catch (error) { $('source-message').textContent = error.message; } finally { remove.disabled = false; } };
      row.append(remove);
    }
    $('source-list').append(row);
  }
}
async function loadSettings() {
  if (!adminToken) return;
  try {
    const data = await api('/api/v1/settings', {}, true);
    $('settings-origin').value = data.publicOrigin || '';
    $('settings-refresh').value = data.refreshSeconds ?? '';
    $('settings-verify').value = data.verificationSeconds ?? '';
    $('settings-reuse').value = data.reuseSeconds ?? '';
    $('settings-timeout').value = data.upstreamTimeoutSeconds ?? '';
    $('settings-probe').checked = !!data.probeSelectedOnly;
    $('settings-ratelimit').value = data.rateLimit ?? '';
    $('settings-authfail').value = data.authFailLimit ?? '';
    $('settings-ports').value = Array.isArray(data.allowedPorts) ? data.allowedPorts.join(',') : '';
  } catch (error) { $('settings-message').textContent = error.message; }
}
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => { const active = t.dataset.tab === name; t.classList.toggle('active', active); t.setAttribute('aria-selected', String(active)); });
  document.querySelectorAll('.panel').forEach(p => { p.hidden = p.id !== `tab-${name}`; p.classList.toggle('active', p.id === `tab-${name}`); });
}
async function poll() {
  if (pollBusy) return; pollBusy = true;
  try {
    const status = await api('/api/v1/status', {}, Boolean(adminToken));
    const labels = { ready: 'Playlist terverifikasi tersedia', stale: 'Sebagian sumber bermasalah', checking: 'Memeriksa sumber', empty: 'Belum ada stream yang lolos', unavailable: 'Menunggu sumber' };
    $('connection').className = `connection ${status.state}`; $('connection').textContent = labels[status.state] || status.state;
    $('state').textContent = status.refreshing ? 'MEMERIKSA' : status.sourceCount ? 'TERSARING' : status.selectedChannelCount ? 'MENUNGGU URL VALID' : 'PILIH CHANNEL';
    $('updated').textContent = date(status.fetchedAt);
    const progress = status.progress || { phase: 'idle', done: 0, total: 0 };
    $('schedule').textContent = progress.phase === 'check' ? `${progress.done} / ${progress.total} stream diperiksa` : progress.phase === 'import' ? 'Mengambil daftar dari semua sumber…' : status.nextRefreshAt ? `Berikutnya ${date(status.nextRefreshAt)}` : 'Menunggu jadwal berikutnya';
    $('scan-progress').hidden = progress.phase !== 'check'; $('scan-progress').max = progress.total || 1; $('scan-progress').value = progress.done;
    $('refresh').disabled = status.refreshing;
    $('channel-count').textContent = status.channelCount; $('source-count').textContent = status.sourceCount;
    $('channel-count2').textContent = status.channelCount; $('source-count2').textContent = status.sourceCount;
    $('feed-count').textContent = status.enabledFeedCount || 0; $('passed-count').textContent = status.checks?.working || 0; $('failed-count').textContent = status.checks?.failed || 0;
    $('pending-count').textContent = (status.checks?.unchecked || 0) + (status.checks?.drm || 0) + (status.checks?.unsupported || 0);
    $('scan-detail').textContent = `${status.selectedChannelCount || 0} channel dipilih dari ${status.totalChannelCount || 0} di katalog. ${status.totalSourceCount || 0} URL diperiksa; hasil berlaku ${Math.round((status.verificationSeconds || 1800) / 60)} menit.`;
    $('interval').textContent = `Pembaruan tiap ${Math.round(status.refreshSeconds / 60)} menit setelah pemrosesan selesai`;
    notice(status.lastError || '');
    const revision = `${status.revision}-${status.checks?.working}-${status.checks?.unchecked}`;
    if (version !== revision) {
      try {
        const data = await api('/api/v1/catalog', {}, Boolean(adminToken)); channels = data.channels;
        if (!selectionKnown) { selectedIds = new Set(channels.filter(channel => channel.selected).map(channel => channel.id)); selectionKnown = true; }
        const selected = $('group').value; $('group').replaceChildren(new Option('Semua kategori', ''));
        [...new Set(channels.map(channel => channel.group))].sort().forEach(group => $('group').add(new Option(group, group)));
        $('group').value = [...$('group').options].some(option => option.value === selected) ? selected : '';
        version = revision; render();
      } catch (error) { if (error.status !== 503) throw error; render(); }
    }
    if (adminToken && Date.now() > nextSourcePoll && !filesBusy) { await loadSources(); nextSourcePoll = Date.now() + 15000; }
  } catch (error) {
    if (error.status === 401) {
      adminToken = ''; sessionStorage.removeItem('cosmic_token');
      $('login-overlay').classList.remove('hidden'); $('login-error').textContent = 'Sesi berakhir. Masuk lagi.';
      $('admin-toggle').textContent = 'Masuk';
      $('connection').textContent = 'Perlu login'; $('connection').className = 'connection unavailable';
    } else {
      notice(`Tidak dapat memuat status: ${error.message}`);
      $('connection').textContent = 'Koneksi terputus'; $('connection').className = 'connection unavailable';
    }
  } finally { pollBusy = false; }
}
for (const id of ['search', 'group', 'no-drm', 'health-filter']) $(id).addEventListener('input', render);
$('copy').onclick = async () => { try { await navigator.clipboard.writeText(playlistUrl()); $('copy').textContent = 'Tersalin ✓'; setTimeout(() => { $('copy').textContent = 'Salin'; }, 1800); } catch { $('playlist-url').select(); notice('Pilih dan salin URL playlist dari kolom di atas.'); } };
$('manage-toggle').onclick = () => { $('management').hidden = !$('management').hidden; $('manage-toggle').setAttribute('aria-expanded', String(!$('management').hidden)); };
$('admin-toggle').onclick = () => {
  if (adminToken) {
    if (!confirm('Kunci sesi dan keluar?')) return;
    adminToken = ''; sessionStorage.removeItem('cosmic_token');
    $('source-list').replaceChildren(); if ($('source-tools')) $('source-tools').hidden = true; if ($('source-login')) $('source-login').hidden = false;
    if ($('source-message')) $('source-message').textContent = 'Pengelolaan dikunci.';
    $('admin-toggle').textContent = 'Masuk';
    updateSelectionTools(); render(); $('login-overlay').classList.remove('hidden');
  } else {
    $('login-overlay').classList.remove('hidden'); $('login-token').focus();
  }
};
$('source-login').onsubmit = async event => {
  event.preventDefault(); adminToken = $('source-token').value.trim(); $('source-token').value = '';
  try { await loadSources(); await loadSelection(); await loadSettings(); $('source-login').hidden = true; $('source-tools').hidden = false; $('source-message').textContent = 'Kelola sumber, endpoint server, dan pilihan playlist pada tab ini. Token tidak disimpan di browser.'; $('admin-toggle').textContent = 'Kunci admin'; await poll(); }
  catch (error) { adminToken = ''; $('source-message').textContent = error.message; }
};
$('lock-admin').onclick = () => { adminToken = ''; $('source-list').replaceChildren(); $('source-tools').hidden = true; $('source-login').hidden = false; $('source-message').textContent = 'Pengelolaan dikunci.'; $('admin-toggle').textContent = 'Masuk admin'; updateSelectionTools(); render(); };
$('save-selection').onclick = saveSelection;
$('source-form').onsubmit = async event => {
  event.preventDefault(); if (filesBusy) return; filesBusy = true; $('add-source').disabled = true;
  try {
    const file = $('source-file').files[0]; const url = $('source-url').value.trim();
    if (!!file === !!url) throw new Error('Pilih satu URL atau berkas M3U/JSON.');
    if (file && file.size > 2 * 1024 * 1024) throw new Error('Berkas maksimum 2 MiB.');
    const headers = $('source-headers').value.trim() ? JSON.parse($('source-headers').value) : {};
    if (!headers || Array.isArray(headers) || typeof headers !== 'object') throw new Error('Header harus objek JSON.');
    const body = { name: $('source-name').value.trim(), headers, ...(file ? { content: await file.text() } : { url }) };
    await api('/api/v1/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, true);
    $('source-form').reset(); $('source-message').textContent = 'Sumber tersimpan. Impor dan pemeriksaan berjalan di belakang layar.'; await loadSources(); await poll();
  } catch (error) { $('source-message').textContent = error.message; }
  finally { filesBusy = false; $('add-source').disabled = false; }
};
$('settings-form').onsubmit = async event => {
  event.preventDefault();
  if (!adminToken) { $('settings-message').textContent = 'Masuk admin terlebih dahulu.'; return; }
  try {
    const body = {
      publicOrigin: $('settings-origin').value.trim(),
      refreshSeconds: Number($('settings-refresh').value),
      verificationSeconds: Number($('settings-verify').value),
      reuseSeconds: Number($('settings-reuse').value),
      upstreamTimeoutSeconds: Number($('settings-timeout').value),
      probeSelectedOnly: $('settings-probe').checked,
      rateLimit: Number($('settings-ratelimit').value),
      authFailLimit: Number($('settings-authfail').value),
      allowedPorts: $('settings-ports').value.trim(),
    };
    const data = await api('/api/v1/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, true);
    if (data.publicOrigin) window.COSMIC_PUBLIC_ORIGIN = data.publicOrigin;
    $('settings-origin').value = data.publicOrigin || '';
    render();
    $('settings-message').textContent = 'Pengaturan disimpan dan diterapkan.';
  } catch (error) { $('settings-message').textContent = error.message; }
};
$('refresh').onclick = async () => {
  if (!adminToken) return $('admin-dialog').showModal();
  try { await api('/api/v1/refresh', { method: 'POST' }, true); await poll(); } catch (error) { notice(error.message); }
};
$('login-form').onsubmit = async event => {
  event.preventDefault();
  const token = $('login-token').value.trim();
  if (!token) return;
  adminToken = token;
  $('login-error').textContent = 'Memverifikasi…';
  try {
    await api('/api/v1/settings', {}, true);
    sessionStorage.setItem('cosmic_token', token);
    $('login-overlay').classList.add('hidden');
    $('login-token').value = '';
    $('login-error').textContent = '';
    $('admin-toggle').textContent = 'Kunci sesi';
    await loadSources(); await loadSelection(); await loadSettings();
    await poll();
  } catch (error) {
    if (error.status === 401) { adminToken = ''; sessionStorage.removeItem('cosmic_token'); $('login-error').textContent = 'Token tidak valid.'; }
    else { $('login-error').textContent = error.message; }
  }
};
if (adminToken) { $('login-overlay').classList.add('hidden'); $('admin-toggle').textContent = 'Kunci sesi'; }
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
render(); void poll();
setInterval(() => { if (!document.hidden) void poll(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); });
