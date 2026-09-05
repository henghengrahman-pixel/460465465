const $ = (s) => document.querySelector(s);

let token = localStorage.getItem('sm_token');
let user = null;
let devices = [];
let offices = [];
let staff = [];
let selected = null;
let currentView = 'dashboard';
let liveTimer = null;
let liveStartedAt = 0;
let detailRefreshTimer = null;
let fleetRefreshTimer = null;
let allLoadPromise = null;
let detailLoadSeq = 0;
const DASH_CACHE_KEY = 'sm_dashboard_cache_v220';
const DASH_CACHE_MAX_AGE = 30000;

function setStats(x = {}) {
  $('#total').textContent = Number(x.total ?? 0);
  $('#online').textContent = Number(x.online ?? 0);
  $('#active').textContent = Number(x.active ?? 0);
  $('#idle').textContent = Number(x.idle ?? 0);
}
function applyOfficeOptions(selectedOffice = '') {
  $('#officeFilter').innerHTML = '<option value="">ALL OFFICE</option>' +
    offices.filter((o) => o.active).map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('');
  if ([...$('#officeFilter').options].some((o) => o.value === selectedOffice)) $('#officeFilter').value = selectedOffice;
}
function saveDashboardCache() {
  try {
    sessionStorage.setItem(DASH_CACHE_KEY, JSON.stringify({
      at: Date.now(), user, devices, offices, staff,
      stats: {
        total: Number($('#total').textContent) || devices.length,
        online: Number($('#online').textContent) || 0,
        active: Number($('#active').textContent) || 0,
        idle: Number($('#idle').textContent) || 0
      }
    }));
  } catch {}
}
function hydrateDashboardCache() {
  try {
    const c = JSON.parse(sessionStorage.getItem(DASH_CACHE_KEY) || 'null');
    if (!c || Date.now() - Number(c.at || 0) > DASH_CACHE_MAX_AGE) return false;
    user = c.user || user; devices = Array.isArray(c.devices) ? c.devices : [];
    offices = Array.isArray(c.offices) ? c.offices : []; staff = Array.isArray(c.staff) ? c.staff : [];
    $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
    if (user) $('#who').textContent = `${user.name || ''} · ${user.role || ''}`;
    applyOfficeOptions($('#officeFilter').value); setStats(c.stats || {}); renderDevices();
    $('#subtitle').textContent = 'Monitoring perangkat realtime · sinkronisasi…';
    return true;
  } catch { return false; }
}

const socket = io({ transports: ['websocket', 'polling'] });

async function api(path, opt = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opt.timeoutMs || 12000);
  try {
    const r = await fetch(path, {
      ...opt,
      signal: opt.signal || controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(opt.headers || {})
      }
    });
    if (r.status === 401 && !['/api/auth/login','/api/auth/2fa/verify'].includes(path)) {
      localStorage.removeItem('sm_token');
      token = null;
      throw new Error('Sesi login habis. Silakan login kembali.');
    }
    const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('Server terlalu lama merespons. Coba lagi.');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function esc(x) {
  return String(x ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[c]));
}
function ago(s) {
  if (!s) return '-';
  const d = Math.max(0, (Date.now() - new Date(s)) / 1000);
  if (d < 10) return 'Now';
  if (d < 60) return `${Math.floor(d)}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}
function fmtDate(s) { return s ? new Date(s).toLocaleString('id-ID') : '-'; }
function isManager() { return ['SUPER_ADMIN', 'ADMIN'].includes(user?.role); }
function option(items, valueLabel, selectedValue = '') {
  return items.map((x) => `<option value="${x.id}" ${x.id === selectedValue ? 'selected' : ''}>${esc(valueLabel(x))}</option>`).join('');
}
function setBusy(el, busy, text = 'Memproses...') {
  if (!el) return;
  if (busy) {
    el.dataset.oldText = el.textContent;
    el.textContent = text;
    el.disabled = true;
  } else {
    el.textContent = el.dataset.oldText || el.textContent;
    el.disabled = false;
  }
}
let toastTimer=null;
function notify(message,type='success'){
  const el=$('#toast');if(!el)return;
  clearTimeout(toastTimer);el.textContent=String(message||'');el.className=`toast ${type} show`;
  toastTimer=setTimeout(()=>{el.className='toast';},3200);
}
function showModal(title, body, onSubmit, onReady) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = body;
  const errBox=$('#modalError');if(errBox){errBox.textContent='';errBox.classList.add('hidden');}
  $('#modal').showModal();
  if (onReady) onReady($('#modalForm'));
  $('#modalForm').onsubmit = async (e) => {
    e.preventDefault();
    if(errBox){errBox.textContent='';errBox.classList.add('hidden');}
    setBusy($('#modalOk'), true, 'Menyimpan...');
    try {
      await onSubmit(new FormData(e.currentTarget));
      $('#modal').close();
      notify('Data berhasil disimpan.');
    } catch (err) {
      if(errBox){errBox.textContent=err.message||'Gagal menyimpan data.';errBox.classList.remove('hidden');}
      else notify(err.message||'Gagal menyimpan data.','error');
    } finally {
      setBusy($('#modalOk'), false);
    }
  };
}
$('#modalCancel').onclick = () => $('#modal').close();
$('#modalCloseX').onclick = () => $('#modal').close();

function hideViews() {
  ['dashboardView', 'deviceDetail', 'officesView', 'staffView', 'policyView', 'usersView', 'auditView']
    .forEach((id) => $('#' + id).classList.add('hidden'));
}
function markNav(view) {
  document.querySelectorAll('.nav').forEach((x) => x.classList.toggle('active', x.dataset.view === view));
}
async function stopLiveSilently() {
  if (liveTimer) {
    clearInterval(liveTimer);
    liveTimer = null;
  }
  liveStartedAt = 0;
  const d = selected;
  if (d) {
    try { await api(`/api/devices/${d.id}/live/stop`, { method: 'POST', timeoutMs: 5000 }); } catch {}
  }
  $('#liveScreen').removeAttribute('src');
}
function leaveDeviceDetail({ stopLive = true } = {}) {
  detailLoadSeq += 1;
  if (detailRefreshTimer) {
    clearTimeout(detailRefreshTimer);
    detailRefreshTimer = null;
  }
  if (selected?.id) socket.emit('unwatchDevice', selected.id);
  if (stopLive) stopLiveSilently();
  selected = null;
}

async function boot() {
  if (!token) return;
  const hadCache = hydrateDashboardCache();
  try {
    const r = await api('/api/bootstrap', { timeoutMs: 10000 });
    user = r.user;
    devices = r.devices || [];
    offices = r.offices || [];
    staff = r.staff || [];
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#who').textContent = `${user.name} · ${user.role}`;
    applyOfficeOptions($('#officeFilter').value);
    setStats(r.stats || {});
    renderDevices();
    $('#subtitle').textContent = 'Monitoring perangkat realtime';
    saveDashboardCache();
  } catch (err) {
    if (hadCache && !String(err.message || '').includes('Sesi login habis')) {
      $('#subtitle').textContent = 'Monitoring perangkat realtime · koneksi ulang…';
      scheduleFleetRefresh(1200);
      return;
    }
    localStorage.removeItem('sm_token');
    sessionStorage.removeItem(DASH_CACHE_KEY);
    token = null;
    $('#app').classList.add('hidden');
    $('#login').classList.remove('hidden');
    $('#loginErr').textContent = err.message || 'Sesi tidak valid.';
  }
}

let twoFactorChallenge = null;
function showCredentialStep(){
  twoFactorChallenge=null;
  $('#credentialStep').classList.remove('hidden');
  $('#twoFactorStep').classList.add('hidden');
  $('#twoFactorSetup').classList.add('hidden');
  $('#otpCode').value='';
  $('#otpCode').required=false;
  $('#loginSubmit').textContent='MASUK';
}
function showTwoFactorStep(result){
  twoFactorChallenge=result.challengeToken;
  $('#credentialStep').classList.add('hidden');
  $('#twoFactorStep').classList.remove('hidden');
  $('#otpCode').required=true;
  if(result.setupRequired&&result.setupSecret){
    $('#twoFactorSetup').classList.remove('hidden');
    $('#twoFactorSecret').textContent=result.setupSecret;
  }else{
    $('#twoFactorSetup').classList.add('hidden');
    $('#twoFactorSecret').textContent='';
  }
  $('#loginSubmit').textContent=result.setupRequired?'AKTIFKAN & LOGIN':'VERIFIKASI & LOGIN';
  setTimeout(()=>$('#otpCode').focus(),50);
}
$('#backLogin').onclick=()=>{showCredentialStep();$('#loginErr').textContent='';};
$('#otpCode').addEventListener('input',(e)=>{e.target.value=e.target.value.replace(/\D/g,'').slice(0,6);});
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#loginErr').textContent = '';
  const btn = $('#loginSubmit');
  setBusy(btn, true, twoFactorChallenge ? 'VERIFIKASI...' : 'LOGIN...');
  try {
    let r;
    if(twoFactorChallenge){
      r=await api('/api/auth/2fa/verify',{method:'POST',body:JSON.stringify({challengeToken:twoFactorChallenge,code:$('#otpCode').value})});
    }else{
      r=await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ loginId: $('#loginId').value, password: $('#password').value })
      });
      if(r.twoFactorRequired){showTwoFactorStep(r);return;}
    }
    token = r.token;
    localStorage.setItem('sm_token', token);
    twoFactorChallenge=null;
    await boot();
  } catch (err) {
    $('#loginErr').textContent = err.message;
  } finally {
    setBusy(btn, false);
    if(twoFactorChallenge)btn.textContent=$('#twoFactorSetup').classList.contains('hidden')?'VERIFIKASI & LOGIN':'AKTIFKAN & LOGIN';
  }
};
$('#logout').onclick = () => { localStorage.removeItem('sm_token'); sessionStorage.removeItem(DASH_CACHE_KEY); location.reload(); };

async function loadOffices() {
  const selectedOffice = $('#officeFilter').value;
  const r = await api('/api/offices');
  offices = r.items || [];
  applyOfficeOptions(selectedOffice);
  saveDashboardCache();
}
async function loadStaffData() {
  const r = await api('/api/staff');
  staff = r.items || [];
  saveDashboardCache();
}
async function loadStats() {
  const r = await api('/api/dashboard');
  setStats(r);
}
async function loadDevices() {
  const r = await api('/api/devices');
  devices = r.items || [];
  if (currentView === 'dashboard') renderDevices();
}
async function loadAll(force = false) {
  if (allLoadPromise && !force) return allLoadPromise;
  allLoadPromise = api('/api/fleet', { timeoutMs: 8000 })
    .then((r) => {
      devices = r.devices || [];
      setStats(r.stats || {});
      if (currentView === 'dashboard') renderDevices();
      saveDashboardCache();
      return r;
    })
    .finally(() => { allLoadPromise = null; });
  return allLoadPromise;
}
function scheduleFleetRefresh(delay = 900) {
  if (!token) return;
  clearTimeout(fleetRefreshTimer);
  fleetRefreshTimer = setTimeout(() => loadAll().catch(() => {}), delay);
}

function renderDevices() {
  if (currentView !== 'dashboard') return;
  const q = $('#search').value.toLowerCase();
  const office = $('#officeFilter').value;
  const list = devices.filter((d) => (!office || d.office_id === office) &&
    [d.name, d.morning_staff_name, d.night_staff_name, d.current_app, d.office_name]
      .some((v) => String(v || '').toLowerCase().includes(q)));
  $('#deviceRows').innerHTML = list.map((d) => `<tr>
    <td><button class="link device-open" data-id="${d.id}">${esc(d.name)}</button><div class="muted mono">${esc((d.device_uid || '').slice(0, 14))}…</div></td>
    <td>${esc(d.morning_staff_name || 'BELUM DISET')}<div class="muted">${esc(d.morning_staff_code || '')}</div></td>
    <td>${esc(d.night_staff_name || 'BELUM DISET')}<div class="muted">${esc(d.night_staff_code || '')}</div></td>
    <td>${esc(d.office_name || 'UNASSIGNED')}</td>
    <td><span class="badge ${esc(d.effective_status)}">${esc(d.effective_status)}</span></td>
    <td>${esc(d.current_app || (d.effective_status === 'SYSTEM_ONLY' ? 'USER AGENT BELUM AKTIF' : (d.effective_status === 'OFFLINE' ? '-' : 'Windows Desktop')))}</td>
    <td>${ago(d.effective_last_seen || d.last_seen)}</td>
    <td><button class="link edit-device" data-id="${d.id}">Edit</button> · <button class="link device-open" data-id="${d.id}">Detail</button></td>
  </tr>`).join('') || '<tr><td colspan="8">Belum ada device.</td></tr>';
}
$('#deviceRows').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-id]');
  if (!btn) return;
  if (btn.classList.contains('device-open')) openDevice(btn.dataset.id).catch((err) => alert(err.message));
  if (btn.classList.contains('edit-device')) editDevice(btn.dataset.id).catch((err) => alert(err.message));
});
$('#search').oninput = renderDevices;
$('#officeFilter').onchange = renderDevices;

function renderDeviceInfo(d) {
  $('#title').textContent = d.name;
  $('#deviceInfo').innerHTML = `<div class="info-grid">
    <div><span>Device ID</span><b class="mono">${esc(d.device_uid)}</b></div>
    <div><span>Nama PC</span><b>${esc(d.name)}</b></div>
    <div><span>Kantor</span><b>${esc(d.office_name || 'UNASSIGNED')}</b></div>
    <div><span>Shift Pagi</span><b>${esc(d.morning_staff_name || 'BELUM DISET')}</b></div>
    <div><span>Shift Malam</span><b>${esc(d.night_staff_name || 'BELUM DISET')}</b></div>
    <div><span>Status</span><b><span class="badge ${esc(d.effective_status)}">${esc(d.effective_status)}</span></b></div>
    <div><span>OS</span><b>${esc(d.os || '-')}</b></div>
    <div><span>Agent</span><b>${esc(d.agent_version || '-')}</b></div>
    <div><span>IP</span><b>${esc(d.ip || '-')}</b></div>
    <div><span>Current App</span><b>${esc(d.current_app || (d.effective_status === 'SYSTEM_ONLY' ? 'USER AGENT BELUM AKTIF' : (d.effective_status === 'OFFLINE' ? '-' : 'Windows Desktop')))}</b></div>
    <div class="wide"><span>Window</span><b>${esc(d.current_title || '-')}</b></div>
    <div><span>Last Seen</span><b>${ago(d.effective_last_seen || d.last_seen)}</b></div>
    <div><span>Enrolled</span><b>${fmtDate(d.enrolled_at)}</b></div>
  </div>`;
}
function renderTimeline(items) {
  $('#timeline').innerHTML = (items || []).map((x) => `<div class="event">
    <b>${esc(x.app_name || x.event_type)}</b><div>${esc(x.window_title || '')}</div>
    <small>${fmtDate(x.occurred_at)}${x.duration_seconds ? ` · ${x.duration_seconds}s` : ''}</small>
  </div>`).join('') || 'Belum ada aktivitas';
}
async function refreshDeviceDetail(id, { timeline = true } = {}) {
  if (currentView !== 'device' || selected?.id !== id) return;
  const seq = ++detailLoadSeq;
  const jobs = [api(`/api/devices/${id}`)];
  if (timeline) jobs.push(api(`/api/devices/${id}/activity`));
  const out = await Promise.all(jobs);
  if (seq !== detailLoadSeq || currentView !== 'device' || selected?.id !== id) return;
  selected = out[0].item;
  renderDeviceInfo(selected);
  if (timeline) renderTimeline(out[1].items);
}
async function openDevice(id) {
  const seq = ++detailLoadSeq;
  currentView = 'device';
  markNav('');
  hideViews();
  $('#deviceDetail').classList.remove('hidden');

  // FAST DETAIL: render data yang sudah ada di fleet cache seketika.
  const cached = devices.find((x) => x.id === id);
  if (cached) {
    selected = cached;
    $('#title').textContent = cached.name || 'Device';
    renderDeviceInfo(cached);
  } else {
    $('#title').textContent = 'Memuat device...';
    $('#deviceInfo').innerHTML = '<div class="loading">Memuat data device...</div>';
  }
  $('#timeline').innerHTML = '<div class="loading">Memuat aktivitas...</div>';
  socket.emit('watchDevice', id);

  // Detail dan histori tidak saling memblokir. Device tampil dulu, histori menyusul.
  const detailPromise = cached
    ? Promise.resolve({ item: cached })
    : api(`/api/devices/${id}`, { timeoutMs: 6000 });
  const activityPromise = api(`/api/devices/${id}/activity`, { timeoutMs: 10000 });

  detailPromise.then((r) => {
    if (seq !== detailLoadSeq || currentView !== 'device') return;
    selected = r.item;
    $('#title').textContent = selected.name || 'Device';
    renderDeviceInfo(selected);
  }).catch((err) => {
    if (!cached && seq === detailLoadSeq && currentView === 'device') {
      $('#deviceInfo').innerHTML = `<div class="loading">${esc(err.message || 'Gagal memuat device')}</div>`;
    }
  });

  activityPromise.then((a) => {
    if (seq !== detailLoadSeq || currentView !== 'device') return;
    renderTimeline(a.items || []);
  }).catch(() => {
    if (seq === detailLoadSeq && currentView === 'device') {
      $('#timeline').innerHTML = '<div class="loading">Histori belum tersedia. Data live tetap berjalan.</div>';
    }
  });
}
$('#back').onclick = () => {
  leaveDeviceDetail();
  currentView = 'dashboard';
  markNav('dashboard');
  hideViews();
  $('#dashboardView').classList.remove('hidden');
  $('#title').textContent = 'Dashboard';
  renderDevices();
};
$('#editDeviceBtn').onclick = () => selected && editDevice(selected.id).catch((err) => alert(err.message));

function staffOptionsForOffice(officeId, selectedId = '') {
  return '<option value="">BELUM DISET</option>' + option(
    staff.filter((s) => s.active && s.office_id === officeId),
    (x) => `${x.staff_code} - ${x.name}`,
    selectedId
  );
}
async function editDevice(id) {
  if (!isManager()) return alert('Akun ini hanya dapat melihat. Edit PC membutuhkan Admin/Super Admin.');
  const d = devices.find((x) => x.id === id) || (await api(`/api/devices/${id}`)).item;
  const officeList = offices.filter((o) => o.active);
  showModal('Edit PC & Pengguna Shift', `
    <label>Nama PC<input name="name" maxlength="200" value="${esc(d.name)}" required></label>
    <label>Kantor<select name="officeId"><option value="">UNASSIGNED</option>${option(officeList, (x) => x.name, d.office_id)}</select></label>
    <label>Staff Shift PAGI<select name="morning"></select></label>
    <label>Staff Shift MALAM<select name="night"></select></label>
    <div class="hint">Pilihan staff langsung menyesuaikan kantor. Nama PC, kantor, dan kedua shift disimpan sekaligus.</div>
  `, async (fd) => {
    const officeId = fd.get('officeId') || null;
    await api(`/api/devices/${id}/config`, {
      method: 'PUT',
      body: JSON.stringify({
        name: String(fd.get('name')).trim(),
        officeId,
        morningStaffId: fd.get('morning') || null,
        nightStaffId: fd.get('night') || null
      })
    });
    await Promise.all([loadAll(true), loadStaffData()]);
    if (currentView === 'device' && selected?.id === id) await refreshDeviceDetail(id);
  }, (form) => {
    const officeSel = form.querySelector('[name="officeId"]');
    const morningSel = form.querySelector('[name="morning"]');
    const nightSel = form.querySelector('[name="night"]');
    const rebuild = (keep = false) => {
      const officeId = officeSel.value;
      const m = keep ? morningSel.value : (officeId === d.office_id ? d.morning_staff_id : '');
      const n = keep ? nightSel.value : (officeId === d.office_id ? d.night_staff_id : '');
      morningSel.innerHTML = staffOptionsForOffice(officeId, m);
      nightSel.innerHTML = staffOptionsForOffice(officeId, n);
      morningSel.disabled = !officeId;
      nightSel.disabled = !officeId;
    };
    officeSel.addEventListener('change', () => rebuild(false));
    rebuild(false);
  });
}

async function command(type, payload) {
  if (!selected) return;
  await api(`/api/devices/${selected.id}/command`, { method: 'POST', body: JSON.stringify({ type, payload }) });
  notify('Perintah berhasil masuk antrean agent.');
}
$('#warnBtn').onclick = () => {
  const message = prompt('Pesan peringatan ke staff:', 'Mohon gunakan PC hanya untuk pekerjaan.');
  if (message) command('WARN', { message }).catch((e) => alert(e.message));
};
$('#closeBtn').onclick = () => {
  const processName = prompt('Nama process yang akan ditutup (contoh: notepad.exe):', selected?.current_app || '');
  if (processName) command('CLOSE_APP', { processName }).catch((e) => alert(e.message));
};
function parseDomains() {
  return [...new Set($('#domainInput').value.split(/[\n\r,;]+/).map((x) => x.trim()).filter(Boolean))];
}
$('#blockDomainBtn').onclick = () => {
  const domains = parseDomains();
  if (!domains.length) return alert('Isi minimal 1 domain.');
  if (domains.length > 500) return alert('Maksimal 500 domain per sekali kirim.');
  if (confirm(`Block ${domains.length} domain pada PC ini? Browser aktif juga akan ditutup agar aturan langsung berlaku.`)) {
    command(domains.length === 1 ? 'BLOCK_DOMAIN' : 'BLOCK_DOMAINS', domains.length === 1 ? { domain: domains[0], closeBrowser: true } : { domains, closeBrowser: true }).catch((e) => alert(e.message));
  }
};
$('#unblockDomainBtn').onclick = () => {
  const domains = parseDomains();
  if (!domains.length) return alert('Isi minimal 1 domain.');
  if (domains.length > 500) return alert('Maksimal 500 domain per sekali kirim.');
  command(domains.length === 1 ? 'UNBLOCK_DOMAIN' : 'UNBLOCK_DOMAINS', domains.length === 1 ? { domain: domains[0] } : { domains }).catch((e) => alert(e.message));
};

let liveFetchBusy = false;
async function fetchLiveFrame() {
  if (!selected || currentView !== 'device' || liveFetchBusy) return;
  liveFetchBusy = true;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const r = await fetch(`/api/devices/${selected.id}/live/frame?ts=${Date.now()}`, {
      cache: 'no-store', signal: controller.signal, headers: { Authorization: `Bearer ${token}` }
    }).finally(() => clearTimeout(timeout));
    if (r.status === 204) {
      const sec = Math.floor((Date.now() - liveStartedAt) / 1000);
      $('#liveStatus').textContent = sec < 15 ? `Menghubungkan ke layar PC... ${sec}s` : 'Belum menerima frame. Pastikan user Windows sudah login dan agent aktif.';
      return;
    }
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${r.status}`);
    }
    const j = await r.json();
    if (j.frame?.jpegBase64) {
      $('#liveScreen').src = 'data:image/jpeg;base64,' + j.frame.jpegBase64;
      const age = Math.max(0, Math.round((Date.now() - (j.frame.receivedAt || Date.now())) / 1000));
      $('#liveStatus').textContent = `LIVE • ${j.frame.width}×${j.frame.height} • update ${age}s lalu • ${new Date(j.frame.capturedAt || Date.now()).toLocaleTimeString('id-ID')}`;
    }
  } catch (e) {
    if (e?.name !== 'AbortError') $('#liveStatus').textContent = 'Live error: ' + e.message;
  } finally {
    liveFetchBusy = false;
  }
}
$('#liveStartBtn').onclick = async () => {
  if (!selected) return;
  const btn = $('#liveStartBtn');
  setBusy(btn, true, 'CONNECTING...');
  try {
    await api(`/api/devices/${selected.id}/live/start`, { method: 'POST' });
    liveStartedAt = Date.now();
    $('#liveScreen').removeAttribute('src');
    $('#liveStatus').textContent = 'Menghubungkan ke layar PC...';
    if (liveTimer) clearInterval(liveTimer);
    await fetchLiveFrame();
    liveTimer = setInterval(fetchLiveFrame, 1000);
  } catch (e) { alert(e.message); }
  finally { setBusy(btn, false); }
};
$('#liveStopBtn').onclick = async () => {
  if (!selected) return;
  const id = selected.id;
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  liveStartedAt = 0;
  $('#liveScreen').removeAttribute('src');
  $('#liveStatus').textContent = 'Live screen dihentikan.';
  try { await api(`/api/devices/${id}/live/stop`, { method: 'POST' }); } catch {}
};
$('#liveFullBtn').onclick = () => { const el = $('#liveScreen'); if (el.requestFullscreen) el.requestFullscreen(); };
$('#deleteDeviceBtn').onclick = async () => {
  if (user?.role !== 'SUPER_ADMIN') return alert('Hanya Super Admin yang dapat menghapus device.');
  if (!selected) return;
  const name = selected.name;
  if (!confirm(`Hapus/revoke ${name}? Agent pada PC tersebut akan ditolak server sampai diizinkan kembali.`)) return;
  const purge = confirm('Klik OK untuk HAPUS PERMANEN BESERTA HISTORY. Klik Cancel untuk revoke device saja dan mempertahankan history.');
  const typed = prompt(`Ketik HAPUS ${name} untuk konfirmasi:`, '');
  if (typed !== `HAPUS ${name}`) return alert('Konfirmasi tidak cocok.');
  const id = selected.id;
  await api(`/api/devices/${id}?mode=${purge ? 'purge' : 'revoke'}`, { method: 'DELETE' });
  leaveDeviceDetail({ stopLive: false });
  currentView = 'dashboard'; markNav('dashboard'); hideViews(); $('#dashboardView').classList.remove('hidden'); $('#title').textContent = 'Dashboard';
  await loadAll(true);
  notify('Device sudah dihapus/revoke.');
};

async function loadOfficeTable() {
  await loadOffices();
  $('#officeRows').innerHTML = offices.map((o) => `<tr><td><b>${esc(o.name)}</b></td><td><span class="badge ${o.active ? 'ACTIVE' : 'OFFLINE'}">${o.active ? 'AKTIF' : 'NONAKTIF'}</span></td><td><button class="link office-telegram" data-id="${o.id}">Atur Telegram</button></td><td>${fmtDate(o.created_at)}</td><td>${user?.role === 'SUPER_ADMIN' ? `<button class="link office-edit" data-id="${o.id}">Edit</button> · <button class="link office-toggle" data-id="${o.id}">${o.active ? 'Nonaktifkan' : 'Aktifkan'}</button>` : '-'}</td></tr>`).join('');
}
$('#officeRows').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-id]'); if (!btn) return;
  if (btn.classList.contains('office-edit')) editOffice(btn.dataset.id);
  if (btn.classList.contains('office-toggle')) toggleOffice(btn.dataset.id);
  if (btn.classList.contains('office-telegram')) configureOfficeTelegram(btn.dataset.id).catch(err=>notify(err.message||'Gagal membuka pengaturan Telegram.','error'));
});
$('#addOffice').onclick = () => {
  if (user?.role !== 'SUPER_ADMIN') return alert('Hanya Super Admin yang dapat menambah kantor.');
  showModal('Tambah Kantor', '<label>Nama Kantor<input name="name" maxlength="100" placeholder="Contoh: KANTOR D" required></label>', async (fd) => {
    await api('/api/offices', { method: 'POST', body: JSON.stringify({ name: String(fd.get('name')).trim() }) });
    await Promise.all([loadOfficeTable(), loadAll(true)]);
  });
};
function editOffice(id) {
  const o = offices.find((x) => x.id === id); if (!o) return;
  showModal('Edit Nama Kantor', `<label>Nama Kantor<input name="name" maxlength="100" value="${esc(o.name)}" required></label>`, async (fd) => {
    await api(`/api/offices/${id}`, { method: 'PATCH', body: JSON.stringify({ name: String(fd.get('name')).trim() }) });
    await Promise.all([loadOfficeTable(), loadAll(true), loadStaffData()]);
  });
}

async function configureOfficeTelegram(id) {
  const r = await api(`/api/offices/${id}/telegram`, { timeoutMs: 8000 });
  const c = r.config || {};
  const domains = Array.isArray(c.watch_domains) && c.watch_domains.length ? c.watch_domains.join('\n') : 'youtube.com\nfacebook.com\ntiktok.com\ninstagram.com';
  showModal(`Telegram Alert · ${r.office.name}`, `
    <div class="telegram-config-note">Setiap kantor bisa memakai <b>bot dan group Telegram yang berbeda</b>. Bot Token yang sudah tersimpan tidak ditampilkan kembali.</div>
    <label class="switchline"><input type="checkbox" name="enabled" ${c.enabled ? 'checked' : ''}> <b>Aktifkan Telegram Alert untuk kantor ini</b></label>
    <label>Bot Token
      <input name="botToken" type="password" autocomplete="new-password" placeholder="${c.has_bot_token ? 'Token sudah tersimpan — kosongkan jika tidak ingin mengganti' : 'Contoh: 123456789:AA...'}">
      <small>${c.has_bot_token ? 'Token terenkripsi sudah tersimpan. Isi hanya jika ingin mengganti bot.' : 'Buat bot melalui BotFather lalu masukkan token di sini.'}</small>
    </label>
    <label>Chat / Group ID
      <input name="chatId" value="${esc(c.chat_id || '')}" placeholder="Contoh: -1001234567890" required>
      <small>Bot harus sudah ditambahkan ke group tujuan dan memiliki izin mengirim pesan.</small>
    </label>
    <label>Cooldown notifikasi
      <select name="cooldownSeconds">
        ${[[60,'1 menit'],[300,'5 menit'],[600,'10 menit'],[900,'15 menit'],[1800,'30 menit'],[3600,'1 jam']].map(([v,l])=>`<option value="${v}" ${Number(c.cooldown_seconds||600)===v?'selected':''}>${l}</option>`).join('')}
      </select>
      <small>Satu PC + satu domain tidak akan mengirim alert berulang selama cooldown.</small>
    </label>
    <label>Domain yang dipantau
      <textarea name="watchDomains" rows="7" required>${esc(domains)}</textarea>
      <small>Satu domain per baris. Contoh: youtube.com, facebook.com, tiktok.com.</small>
    </label>
    <div class="telegram-modal-actions"><button type="button" id="telegramTestBtn" class="ghost">Test Telegram</button><span id="telegramTestStatus" class="muted"></span></div>
  `, async (fd) => {
    const watchDomains=[...new Set(String(fd.get('watchDomains')||'').split(/[\n\r,;]+/).map(x=>x.trim()).filter(Boolean))];
    await api(`/api/offices/${id}/telegram`, { method:'PUT', timeoutMs:12000, body:JSON.stringify({
      enabled:fd.get('enabled')==='on', botToken:String(fd.get('botToken')||'').trim(), chatId:String(fd.get('chatId')||'').trim(),
      cooldownSeconds:Number(fd.get('cooldownSeconds')||600), watchDomains
    })});
    notify(`Telegram Alert ${r.office.name} berhasil disimpan.`);
  }, () => {
    const btn=$('#telegramTestBtn'), st=$('#telegramTestStatus');
    btn.onclick=async()=>{
      setBusy(btn,true,'MENGIRIM...'); st.textContent='';
      try{await api(`/api/offices/${id}/telegram/test`,{method:'POST',timeoutMs:12000});st.textContent='Pesan test berhasil dikirim.';notify('Telegram test berhasil.');}
      catch(e){st.textContent=e.message||'Test gagal.';notify(e.message||'Test Telegram gagal.','error');}
      finally{setBusy(btn,false);}
    };
  });
}
async function toggleOffice(id) {
  const o = offices.find((x) => x.id === id);
  if (!o || !confirm(`${o.active ? 'Nonaktifkan' : 'Aktifkan'} ${o.name}?`)) return;
  try {
    await api(`/api/offices/${id}`, { method: 'PATCH', body: JSON.stringify({ active: !o.active }) });
    await Promise.all([loadOfficeTable(), loadAll(true)]);
  } catch (e) { alert(e.message); }
}

async function loadStaff() {
  await loadStaffData();
  $('#staffRows').innerHTML = staff.map((x) => `<tr><td>${esc(x.staff_code)}</td><td>${esc(x.name)}</td><td>${esc(x.office_name)}</td><td>${esc(x.department_name || '-')}</td><td><span class="badge ${x.active ? 'ACTIVE' : 'OFFLINE'}">${x.active ? 'AKTIF' : 'NONAKTIF'}</span></td><td>${isManager() ? `<button class="link staff-edit" data-id="${x.id}">Edit</button>` : '-'}</td></tr>`).join('');
}
$('#staffRows').addEventListener('click', (e) => { const btn = e.target.closest('.staff-edit'); if (btn) editStaff(btn.dataset.id); });
$('#addStaff').onclick = () => {
  if (!isManager()) return alert('Hanya Admin/Super Admin yang dapat menambah staff.');
  const officeList = offices.filter((o) => o.active);
  showModal('Tambah Staff', `<label>ID / Kode Staff<input name="staffCode" required></label><label>Nama Staff<input name="name" required></label><label>Kantor<select name="officeId" required>${option(officeList, (x) => x.name)}</select></label>`, async (fd) => {
    await api('/api/staff', { method: 'POST', body: JSON.stringify({ staffCode: String(fd.get('staffCode')).trim(), name: String(fd.get('name')).trim(), officeId: fd.get('officeId') }) });
    await loadStaff();
  });
};
function editStaff(id) {
  const s = staff.find((x) => x.id === id); if (!s) return;
  const officeList = offices.filter((o) => o.active);
  showModal('Edit Staff', `<label>ID / Kode Staff<input name="staffCode" value="${esc(s.staff_code)}" required></label><label>Nama Staff<input name="name" value="${esc(s.name)}" required></label><label>Kantor<select name="officeId">${option(officeList, (x) => x.name, s.office_id)}</select></label><label>Status<select name="active"><option value="true" ${s.active ? 'selected' : ''}>AKTIF</option><option value="false" ${!s.active ? 'selected' : ''}>NONAKTIF</option></select></label>`, async (fd) => {
    await api(`/api/staff/${id}`, { method: 'PATCH', body: JSON.stringify({ staffCode: String(fd.get('staffCode')).trim(), name: String(fd.get('name')).trim(), officeId: fd.get('officeId'), active: fd.get('active') === 'true' }) });
    await Promise.all([loadStaff(), loadAll(true)]);
  });
}

async function loadUsers() {
  try {
    const r = await api('/api/users');
    $('#userRows').innerHTML = r.items.map((x) => `<tr><td>${esc(x.login_id)}</td><td>${esc(x.display_name)}</td><td>${esc(x.role)}</td><td>${esc(x.office_name || 'ALL OFFICE')}</td><td>${x.active ? 'AKTIF' : 'NONAKTIF'}</td><td>${fmtDate(x.last_login_at)}</td></tr>`).join('');
  } catch (e) { $('#userRows').innerHTML = `<tr><td colspan="6">${esc(e.message)}</td></tr>`; }
}
$('#addUser').onclick = () => {
  if (user?.role !== 'SUPER_ADMIN') return alert('Hanya Super Admin yang dapat membuat user.');
  showModal('Tambah Admin User', `<label>ID Login<input name="loginId" minlength="3" required></label><label>Password<input name="password" type="password" minlength="8" required></label><label>Nama Admin<input name="displayName" required></label><label>Role<select name="role"><option>ADMIN</option><option>SUPERVISOR</option><option>VIEWER</option><option>SUPER_ADMIN</option></select></label><label>Kantor<select name="officeId"><option value="">ALL OFFICE</option>${option(offices.filter((o) => o.active), (x) => x.name)}</select></label>`, async (fd) => {
    await api('/api/users', { method: 'POST', body: JSON.stringify({ loginId: fd.get('loginId'), password: fd.get('password'), displayName: fd.get('displayName'), role: fd.get('role'), officeId: fd.get('officeId') || null }) });
    await loadUsers();
  });
};

let webPolicy = null;
function parsePolicyDomains() {
  return [...new Set($('#policyDomains').value.split(/[\n\r,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
}
function policyScopeOptions() {
  const el = $('#policyScope');
  const current = el.value || 'ALL';
  const officeRows = (offices || []).filter((o) => o.active && (user?.role === 'SUPER_ADMIN' || o.id === user?.officeId));
  const pcRows = (devices || []).filter((d) => !d.disabled && (user?.role === 'SUPER_ADMIN' || !user?.officeId || d.office_id === user.officeId));
  const allowAll = user?.role === 'SUPER_ADMIN';
  let html = allowAll ? '<optgroup label="MASSAL"><option value="ALL">ALL OFFICE</option></optgroup>' : '';
  html += `<optgroup label="KANTOR">${officeRows.map((o) => `<option value="${o.id}">KANTOR · ${esc(o.name)}</option>`).join('')}</optgroup>`;
  html += `<optgroup label="PC">${pcRows.map((d) => `<option value="PC:${d.id}">PC · ${esc(d.name)}${d.office_name ? ` · ${esc(d.office_name)}` : ''}</option>`).join('')}</optgroup>`;
  el.innerHTML = html;
  if ([...el.options].some((o) => o.value === current)) el.value = current;
  else if (!allowAll && user?.officeId) el.value = user.officeId;
  else el.value = 'ALL';
}

function selectedExceptionIds() {
  return [...document.querySelectorAll('#policyStaffList input[type="checkbox"]:checked')].map((x) => x.value);
}
function addPolicyPreset(domains) {
  const merged = [...new Set([...parsePolicyDomains(), ...domains])];
  $('#policyDomains').value = merged.join('\n');
}
async function loadWebPolicy() {
  policyScopeOptions();
  const scope = $('#policyScope').value || (user?.officeId || 'ALL');
  $('#policyStatus').textContent = 'Memuat policy…';
  const r = await api(`/api/web-policy?scope=${encodeURIComponent(scope)}`, { timeoutMs: 8000 });
  webPolicy = r;
  $('#policyEnabled').checked = !!r.enabled;
  $('#policyDomains').value = (r.domains || []).join('\n');
  const except = new Set((r.exceptions || []).map((x) => x.staff_id));
  $('#policyStaffList').innerHTML = (r.staff || []).map((st) => `<label class="staff-check"><input type="checkbox" value="${st.id}" ${except.has(st.id) ? 'checked' : ''}><span><b>${esc(st.name)}</b><small>${esc(st.staff_code)} · ${esc(st.office_name || '')}</small></span></label>`).join('') || '<div class="muted">Tidak ada staff aktif pada target ini.</div>';
  $('#policyStatDevices').textContent = r.stats?.devices ?? 0;
  $('#policyStatBlocked').textContent = r.stats?.blocked ?? 0;
  $('#policyStatExempt').textContent = r.stats?.exempt ?? 0;
  $('#policyStatPending').textContent = r.stats?.pending ?? 0;
  $('#policyStatus').textContent = r.updatedAt ? `Versi ${r.version} · update ${fmtDate(r.updatedAt)}` : 'Policy belum pernah disimpan.';
}
async function saveWebPolicy(enabled) {
  const domains = parsePolicyDomains();
  if (enabled && !domains.length) return alert('Isi minimal 1 domain sebelum mengaktifkan policy.');
  if (domains.length > 500) return alert('Maksimal 500 domain.');
  const scope = $('#policyScope').value || (user?.officeId || 'ALL');
  const exceptionStaffIds = selectedExceptionIds();
  const targetText = scope.startsWith('PC:') ? 'PC yang dipilih' : 'semua PC target';
  const msg = enabled ? `Terapkan blokir ${domains.length} domain ke ${targetText}?\n\n${exceptionStaffIds.length} staff dikecualikan. Browser/tab tidak akan ditutup.` : 'Buka blokir global untuk semua PC target?';
  if (!confirm(msg)) return;
  const btn = enabled ? $('#policySaveBtn') : $('#policyUnlockBtn');
  setBusy(btn, true, enabled ? 'MENERAPKAN...' : 'MEMBUKA...');
  try {
    const r = await api('/api/web-policy', { method: 'PUT', timeoutMs: 15000, body: JSON.stringify({ scope, enabled, domains, exceptionStaffIds }) });
    $('#policyEnabled').checked = enabled;
    $('#policyStatus').textContent = `Versi ${r.version} · ${r.fanout?.queued || 0} PC dikirim policy.`;
    await loadWebPolicy();
    notify(enabled ? `Policy aktif. Dikirim ke ${r.fanout?.queued || 0} PC; ${r.fanout?.exempt || 0} PC dikecualikan.` : `Blokir dibuka. Perintah unlock dikirim ke ${r.fanout?.queued || 0} PC.`);
  } finally { setBusy(btn, false); }
}
$('#policyScope').onchange = () => loadWebPolicy().catch((e) => alert(e.message));
$('#policyReloadBtn').onclick = () => loadWebPolicy().catch((e) => alert(e.message));
$('#policySaveBtn').onclick = () => saveWebPolicy(true).catch((e) => alert(e.message));
$('#policyUnlockBtn').onclick = () => saveWebPolicy(false).catch((e) => alert(e.message));
$('#policyReapplyBtn').onclick = async () => {
  const scope = $('#policyScope').value || (user?.officeId || 'ALL');
  const btn = $('#policyReapplyBtn'); setBusy(btn, true, 'MENGIRIM...');
  try { const r = await api('/api/web-policy/reapply', { method: 'POST', timeoutMs: 15000, body: JSON.stringify({ scope }) }); $('#policyStatus').textContent = `Policy dikirim ulang ke ${r.fanout?.queued || 0} PC.`; await loadWebPolicy(); } finally { setBusy(btn, false); }
};
$('#presetTelegramWeb').onclick = () => addPolicyPreset(['web.telegram.org','t.me','telegram.me']);
$('#presetSocial').onclick = () => addPolicyPreset(['youtube.com','tiktok.com','facebook.com','instagram.com','x.com','twitter.com']);

async function loadAudit() {
  try {
    const r = await api('/api/audit');
    $('#auditList').innerHTML = r.items.map((x) => `<div class="event"><b>${esc(x.action)}</b> · ${esc(x.target || '-')}<div>${esc(x.display_name || x.login_id || 'system')}</div><small>${fmtDate(x.created_at)}</small></div>`).join('');
  } catch (e) { $('#auditList').textContent = e.message; }
}

async function navigate(view) {
  if (currentView === 'device') leaveDeviceDetail();
  currentView = view;
  markNav(view);
  hideViews();
  if (view === 'dashboard') { $('#dashboardView').classList.remove('hidden'); $('#title').textContent = 'Dashboard'; renderDevices(); await loadAll(); }
  if (view === 'offices') { $('#officesView').classList.remove('hidden'); $('#title').textContent = 'Kantor'; await loadOfficeTable(); }
  if (view === 'staff') { $('#staffView').classList.remove('hidden'); $('#title').textContent = 'Staff'; await loadStaff(); }
  if (view === 'policy') { $('#policyView').classList.remove('hidden'); $('#title').textContent = 'Web Policy'; await loadWebPolicy(); }
  if (view === 'users') { $('#usersView').classList.remove('hidden'); $('#title').textContent = 'Admin Users'; await loadUsers(); }
  if (view === 'audit') { $('#auditView').classList.remove('hidden'); $('#title').textContent = 'Audit Logs'; await loadAudit(); }
}
document.querySelectorAll('.nav').forEach((b) => b.onclick = () => navigate(b.dataset.view).catch((e) => alert(e.message)));

socket.on('fleet.changed', () => {
  if (!token) return;
  scheduleFleetRefresh(currentView === 'dashboard' ? 500 : 1800);
});
socket.on('device.status', (evt) => {
  if (!evt?.deviceId) return;
  const i = devices.findIndex((d) => d.id === evt.deviceId);
  if (i >= 0) {
    devices[i] = {
      ...devices[i],
      status: evt.status || devices[i].status,
      effective_status: evt.status || devices[i].effective_status,
      current_app: evt.currentApp ?? devices[i].current_app,
      current_title: evt.currentTitle ?? devices[i].current_title,
      last_seen: evt.lastSeen || devices[i].last_seen,
      effective_last_seen: evt.lastSeen || devices[i].effective_last_seen
    };
    renderDevices();
  }
  if (currentView === 'device' && selected?.id === evt.deviceId) {
    selected = { ...selected, status: evt.status || selected.status, effective_status: evt.status || selected.effective_status, current_app: evt.currentApp ?? selected.current_app, current_title: evt.currentTitle ?? selected.current_title, last_seen: evt.lastSeen || selected.last_seen, effective_last_seen: evt.lastSeen || selected.effective_last_seen };
    renderDeviceInfo(selected);
  }
});
socket.on('device.activity', (evt) => {
  if (!evt?.deviceId) return;
  if (currentView === 'device' && selected?.id === evt.deviceId) {
    clearTimeout(detailRefreshTimer);
    detailRefreshTimer = setTimeout(() => refreshDeviceDetail(evt.deviceId).catch(() => {}), 700);
  } else if (currentView === 'dashboard') {
    scheduleFleetRefresh(800);
  }
});

setInterval(() => {
  if (!token) return;
  if (currentView === 'dashboard') loadAll().catch(() => {});
  else if (currentView === 'device' && selected?.id) refreshDeviceDetail(selected.id, { timeline: false }).catch(() => {});
}, 20000);

boot();
