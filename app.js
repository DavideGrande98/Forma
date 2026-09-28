'use strict';
/* ================= Forma — logica dell'app ================= */
const KEY = 'forma.v1';
const WEEKDAY = ['domenica','lunedì','martedì','mercoledì','giovedì','venerdì','sabato'];

/* ---------- utilità ---------- */
const clone = o => JSON.parse(JSON.stringify(o));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = v => { const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : NaN; };
const fmt = n => Math.round(n).toLocaleString('it-IT');
const fmt1 = n => (Math.round(n*10)/10).toLocaleString('it-IT');
const pad = n => String(n).padStart(2,'0');
const dstr = d => d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
const today = () => dstr(new Date());
const parseD = s => { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); };
const toMin = t => { const m = String(t||'').match(/(\d{1,2})[:.](\d{2})/); return m ? (+m[1])*60 + (+m[2]) : NaN; };
const fromMin = m => { m = ((Math.round(m) % 1440) + 1440) % 1440; return Math.floor(m/60) + ':' + pad(m%60); };
const nowHM = () => { const d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const norm = s => String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();
const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const fdate = (ds, o) => parseD(ds).toLocaleDateString('it-IT', o || {day:'numeric', month:'short'});
const secTxt = s => s >= 60 ? Math.floor(s/60) + ':' + pad(s%60) : s + ' s';

/* ---------- stato ---------- */
function blank(){ return {v:2, profile:null, plan:null, nextIdx:0, history:[], weights:[], active:null, days:{}, meals:{train:{},rest:{}}, diet:null, dietChoice:{}, settings:{notify:false}, ui:{tab:'oggi', pianoType:null, progTab:'peso', dietVar:null}}; }
function migrate(s){
  const p = s.profile;
  if (p) {
    if (!p.birth) { p.birth = (new Date().getFullYear() - (p.age || 30)) + '-01-01'; }
    if (p.weeklyTarget == null) p.weeklyTarget = (p.days && p.days.length) || 3;
    if (!p.defaultTime) p.defaultTime = p.time || '18:30';
    delete p.days; delete p.time; delete p.age;
  }
  s.days = s.days || {};
  if (s.overrides) { for (const [d, v] of Object.entries(s.overrides)) s.days[d] = {train: v === 'train', time: p ? p.defaultTime : '18:30'}; delete s.overrides; }
  s.ui = Object.assign(blank().ui, s.ui || {}); s.ui.editPlan = false;
  s.settings = s.settings || {notify:false};
  s.dietChoice = s.dietChoice || {};
  s.v = 2;
  return s;
}
let S;
try { S = migrate(Object.assign(blank(), JSON.parse(localStorage.getItem(KEY) || 'null') || {})); } catch(e){ S = blank(); }
function save(){ try { const {draft, pdraft, ...rest} = S; localStorage.setItem(KEY, JSON.stringify(rest)); } catch(e){} }

/* ---------- archivio PDF (IndexedDB) ---------- */
function idb(){ return new Promise((res, rej) => { const r = indexedDB.open('forma', 1); r.onupgradeneeded = () => r.result.createObjectStore('files'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function idbPut(k, v){ const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction('files','readwrite'); tx.objectStore('files').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }
async function idbGet(k){ const db = await idb(); return new Promise((res, rej) => { const r = db.transaction('files').objectStore('files').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function idbDel(k){ const db = await idb(); return new Promise(res => { const tx = db.transaction('files','readwrite'); tx.objectStore('files').delete(k); tx.oncomplete = res; }); }

/* ================= Calcoli dieta ================= */
function ageOf(birth){ const b = parseD(birth), n = new Date(); let a = n.getFullYear() - b.getFullYear(); if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--; return a; }
function weightNow(){ const w = S.weights; return w.length ? w[w.length-1].kg : (S.profile ? S.profile.weight : 70); }
function dayInfo(ds){ return S.days[ds] || null; }
function isTrainDay(ds){ const d = dayInfo(ds); if (d) return !!d.train; return S.history.some(h => h.date === ds); }
function dayType(ds){ return isTrainDay(ds) ? 'train' : 'rest'; }
function dayTime(ds){ const d = dayInfo(ds); const t = d && d.time ? d.time : S.profile.defaultTime; return toMin(t) || 1110; }

function targets(type){
  const p = S.profile, w = weightNow();
  const bmr = 10*w + 6.25*p.height - 5*ageOf(p.birth) + (p.sex === 'f' ? -161 : 5);
  const neat = {low:1.3, mid:1.45, high:1.6}[p.activity] || 1.45;
  const base = bmr * neat;
  const workout = 5 * w * (p.duration/60);
  const goalF = {cut:0.85, keep:1, bulk:1.08}[p.goal];
  const kcal = (base + (type === 'train' ? workout : 0)) * goalF;
  const prot = Math.min((p.goal === 'cut' ? 2.1 : 1.8) * w, 230);
  const fat = (type === 'train' ? 0.75 : 0.9) * w;
  const carb = Math.max(60, (kcal - prot*4 - fat*9) / 4);
  return {kcal: prot*4 + carb*4 + fat*9, p: prot, c: carb, f: fat};
}

function slots(type, T){
  if (type === 'rest') return [
    {id:'colazione', label:'Colazione', t:450, sh:[25,25,25], list:'colazione'},
    {id:'pranzo', label:'Pranzo', t:780, sh:[30,35,35], list:'pranzo'},
    {id:'spuntino', label:'Spuntino', t:990, sh:[15,15,15], list:'spuntino'},
    {id:'cena', label:'Cena', t:1200, sh:[30,25,25], list:'cena'}
  ];
  const end = T + S.profile.duration;
  const s = [
    {id:'colazione', label:'Colazione', t:450, sh:[20,20,30], list:'colazione'},
    {id:'pranzo', label:'Pranzo', t:780, sh:[30,30,35], list:'pranzo'},
    {id:'pre', label:'Pre-allenamento', t:T-90, sh:[15,20,10], list:'pre', accent:'red'},
    {id:'cena', label: end > 1080 ? 'Cena di recupero' : 'Cena', t: Math.max(1200, end + 45), sh:[35,30,25], list:'cena', accent: end > 1080 ? 'green' : null}
  ];
  if (end <= 720) { s[1].label = 'Pranzo di recupero'; s[1].accent = 'green'; }
  if (T < 600) { s[2].t = T - 60; s[0].t = Math.max(s[0].t, end + 30); s[0].label = 'Colazione di recupero'; s[0].accent = 'green'; }
  return s.sort((a,b) => a.t - b.t);
}

function solveMeal(tpl, tg){
  const items = [], rem = {p:tg.p, c:tg.c, f:tg.f};
  const fixed = (tpl.fixed || []).slice();
  if (tpl.veg) fixed.push(['verdure', 200]);
  fixed.forEach(([id,g]) => { const F = FOODS[id]; rem.p -= F.p*g/100; rem.c -= F.c*g/100; rem.f -= F.f*g/100; });
  const C = FOODS[tpl.c], P = FOODS[tpl.p], Fa = FOODS[tpl.f];
  let gc = 0, gp = 0, gf = 0;
  for (let i = 0; i < 25; i++){
    gc = Math.max(0, (rem.c - gp*P.c/100 - gf*Fa.c/100) / C.c * 100);
    gp = Math.max(0, (rem.p - gc*C.p/100 - gf*Fa.p/100) / P.p * 100);
    gf = Math.max(0, (rem.f - gc*C.f/100 - gp*P.f/100) / Fa.f * 100);
  }
  const excess = gc*C.f/100 + gp*P.f/100 + gf*Fa.f/100 - rem.f;
  if (excess > 1 && gf === 0) gc = Math.max(0, gc - (excess*9/4) / C.c * 100);
  const round = (id, g) => { const F = FOODS[id]; return F.unit ? Math.max(1, Math.round(g / F.unit)) * F.unit : Math.round(g / 5) * 5; };
  [[tpl.c,gc],[tpl.p,gp],[tpl.f,gf]].forEach(([id,g]) => { const r = round(id, g); if (r >= 5) items.push([id, r]); });
  fixed.forEach(x => items.push(x));
  const tot = {p:0,c:0,f:0};
  items.forEach(([id,g]) => { const F = FOODS[id]; tot.p += F.p*g/100; tot.c += F.c*g/100; tot.f += F.f*g/100; });
  tot.kcal = tot.p*4 + tot.c*4 + tot.f*9;
  return {items, tot};
}
function calcPlan(type, T){
  const tg = targets(type), choice = S.meals[type] || (S.meals[type] = {});
  return slots(type, T).map(sl => {
    const list = MEALS[sl.list], idx = (choice[sl.id] || 0) % list.length, tpl = list[idx];
    return Object.assign({}, sl, {tpl, count:list.length}, solveMeal(tpl, {p: tg.p*sl.sh[0]/100, c: tg.c*sl.sh[1]/100, f: tg.f*sl.sh[2]/100}));
  });
}
function itemText(id, g){
  const F = FOODS[id];
  if (F.unit) { const n = Math.round(g / F.unit); return [n + ' ' + F.uname[n === 1 ? 0 : 1], '~' + g + ' g']; }
  if (F.oil) { const cc = g/5; return [F.n, g + ' g · ' + (cc === 1 ? '1 cucchiaino' : fmt1(cc) + ' cucchiaini')]; }
  if (id === 'verdure') return [F.n, g + ' g o più'];
  if (id === 'banana') { const n = Math.max(0.5, Math.round(g/120*2)/2); return [F.n, g + ' g · ~' + fmt1(n) + (n > 1 ? ' banane' : ' banana')]; }
  return [F.n, g + ' g'];
}

/* ---------- dieta importata ---------- */
function dietVariantFor(type){
  const v = S.diet.variants; let i = v.findIndex(x => x.use === type);
  if (i < 0) i = v.findIndex(x => x.use === 'all');
  return i < 0 ? 0 : i;
}
function guessTime(name, i, n, T){
  const s = norm(name);
  if (/colaz/.test(s)) return 450;
  if (/pranzo/.test(s)) return 780;
  if (/pre (allen|work)|prima (dell )?allen|pre$/.test(s) || /^pre\b/.test(s)) return T - 90;
  if (/post|dopo (l )?allen/.test(s)) return T + 75;
  if (/dopo cena/.test(s)) return 1290;
  if (/cena/.test(s)) return 1200;
  if (/spunt|merend/.test(s)) return /pomer|merend/.test(s) || i >= n/2 ? 990 : 630;
  return 450 + i * (750 / Math.max(1, n - 1));
}
function dietMeals(vi, T){
  const v = S.diet.variants[vi];
  return v.meals.map((m, mi) => {
    const k = vi + ':' + mi, oi = (S.dietChoice[k] || 0) % m.options.length;
    return Object.assign({}, m, {mi, oi, k, opt: m.options[oi], t: toMin(m.time) || guessTime(m.name, mi, v.meals.length, T)});
  });
}

/* ================= Allenamento ================= */
function findLib(name){
  const n = norm(name); if (!n) return null;
  let best = null, bestScore = 0;
  for (const e of EXLIB) {
    const names = [e.n].concat(e.al || []).map(norm);
    if (names.includes(n)) return e;
    for (const x of names) {
      if (x.length > 3 && (n === x || n.startsWith(x + ' ') || n.endsWith(' ' + x))) { const sc = 0.8 + x.length/100; if (sc > bestScore) { best = e; bestScore = sc; } }
      const a = new Set(n.split(' ').filter(w => w.length > 2)), b = new Set(x.split(' ').filter(w => w.length > 2));
      if (!a.size || !b.size) continue;
      let inter = 0; a.forEach(w => { if (b.has(w)) inter++; });
      const j = inter / (a.size + b.size - inter);
      if (j > bestScore && j >= 0.5) { best = e; bestScore = j; }
    }
  }
  return best;
}
const libKey = name => { const l = findLib(name); return l ? 'lib:' + l.id : 'n:' + norm(name); };
function ensurePlan(){ if (!S.plan) { S.plan = clone(PLANS[S.profile.weeklyTarget >= 4 ? 'upperlower' : 'fullbody']); S.nextIdx = 0; } }
function nextSession(){ ensurePlan(); const n = S.plan.sessions.length; if (!n) return {i:-1, s:null}; return {i: S.nextIdx % n, s: S.plan.sessions[S.nextIdx % n]}; }
function lastFor(name){
  const k = libKey(name);
  for (let i = S.history.length-1; i >= 0; i--){ const e = S.history[i].ex.find(x => libKey(x.name) === k); if (e && e.sets.length) return e.sets; }
  return null;
}
const epley = (kg, r) => kg > 0 && r > 0 ? (r === 1 ? kg : kg * (1 + r/30)) : 0;
function bestsFrom(sets){ const b = {kg:0, kgReps:0, e1:0, reps:0, has:false}; sets.forEach(s => { b.has = true; if (s.kg > b.kg || (s.kg === b.kg && s.reps > b.kgReps)) { b.kg = s.kg; b.kgReps = s.reps; } b.e1 = Math.max(b.e1, epley(s.kg, s.reps)); if (!(s.kg > 0)) b.reps = Math.max(b.reps, s.reps); }); return b; }
function historySets(name){ const k = libKey(name), out = []; S.history.forEach(h => h.ex.forEach(e => { if (libKey(e.name) === k) e.sets.forEach(s => out.push(s)); })); return out; }
function weekCount(){ const n = new Date(), mon = new Date(n); mon.setDate(n.getDate() - ((n.getDay()+6)%7)); const m = dstr(mon); return S.history.filter(h => h.date >= m).length; }

function planWeekRaw(){ const p = S.plan; if (!p || !p.weeks) return null; const st = p.start || today(); return Math.floor((parseD(today()) - parseD(st)) / (7*864e5)) + 1; }
function planWeek(){ const w = planWeekRaw(); return w === null ? null : Math.max(1, Math.min(S.plan.weeks, w)); }
function exTarget(e){ const w = planWeek(); if (e.weeks && e.weeks.length && w) { const x = e.weeks[Math.min(w, e.weeks.length) - 1]; return {sets: x.sets, reps: String(x.reps)}; } return {sets: e.sets, reps: String(e.reps)}; }
const progTxt = e => e.weeks && e.weeks.length ? e.weeks.map(w => w.sets + '×' + w.reps).join(', ') : '';
function repsFor(e, si){ const parts = String(e.reps).split('-'); return parts.length > 2 && parts.length === e.log.length ? parts[si] : String(e.reps); }
function autoReps(t){ t = String(t); if (/^\d+(\s*-\s*\d+)?$/.test(t)) return t.split('-').pop().trim(); return ''; }
function mkEx(name, sets, reps, rest, extra){
  const last = lastFor(name) || [];
  return {name, reps: String(reps), rest: rest === 0 ? 0 : (+rest || 90), note: extra && extra.note || '', weeks: extra && extra.weeks || null, base: extra && extra.base || null, log: Array.from({length: Math.max(1, sets)}, (_, k) => ({kg: last[k] && last[k].kg ? String(last[k].kg).replace('.', ',') : '', reps: last[k] ? String(last[k].reps) : '', done:false}))};
}
function startWorkout(si){
  const ds = today();
  if (!isTrainDay(ds)) S.days[ds] = {train:true, time: nowHM()};
  if (si >= 0) { const s = S.plan.sessions[si]; S.active = {date: ds, sIdx: si, name: s.name, start: Date.now(), changed:false, ex: s.ex.map(e => { const t = exTarget(e); return mkEx(e.name, t.sets, t.reps, e.rest, {note: e.note, weeks: e.weeks, base: {sets: e.sets, reps: e.reps}}); })}; }
  else S.active = {date: ds, sIdx: -1, name: 'Allenamento libero', start: Date.now(), changed:false, ex: []};
  save(); keepAwake();
}
let wakeLock = null;
async function keepAwake(){ try { if ('wakeLock' in navigator && S.active) wakeLock = await navigator.wakeLock.request('screen'); } catch(e){} }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { keepAwake(); tickTimer(); } });

/* record personale sulla serie appena completata */
function checkPR(ei, si){
  const a = S.active, e = a.ex[ei], l = e.log[si];
  const kg = num(l.kg) || 0, reps = num(l.reps) || 0;
  if (!reps) return null;
  const k = libKey(e.name), prevSets = historySets(e.name);
  a.ex.forEach((x, xi) => { if (libKey(x.name) === k) x.log.forEach((y, yi) => { if (y.done && !(xi === ei && yi === si)) prevSets.push({kg: num(y.kg) || 0, reps: num(y.reps) || 0}); }); });
  if (!prevSets.length) return null;
  const b = bestsFrom(prevSets);
  if (kg > 0) {
    if (kg > b.kg) return {kind:'kg', text: `Nuovo massimale di carico: ${fmt1(kg)} kg × ${reps}`, prev: b.kg ? `prima ${fmt1(b.kg)} kg` : ''};
    const e1 = epley(kg, reps);
    if (e1 > b.e1 + 0.05) return {kind:'e1', text: `Nuovo record: ${fmt1(kg)} kg × ${reps} (massimale stimato ${fmt1(e1)} kg)`, prev: `prima ${fmt1(b.e1)} kg`};
  } else if (reps > b.reps && b.reps > 0) return {kind:'reps', text: `Nuovo record: ${reps} ripetizioni`, prev: `prima ${b.reps}`};
  return null;
}

/* ---------- timer, suoni, notifiche ---------- */
let timer = null, audio = null;
function unlockAudio(){ try { if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === 'suspended') audio.resume(); } catch(e){} }
function tone(freqs, gap){ try { if (!audio) return; freqs.forEach((f, i) => { const t = audio.currentTime + i*gap, o = audio.createOscillator(), g = audio.createGain(); o.frequency.value = f; o.connect(g); g.connect(audio.destination); g.gain.setValueAtTime(.25, t); g.gain.exponentialRampToValueAtTime(.001, t + gap*.9); o.start(t); o.stop(t + gap); }); } catch(e){} }
function startTimer(sec){ if (sec > 0) { timer = {end: Date.now() + sec*1000}; tickTimer(); } }
function tickTimer(){
  const el = document.getElementById('timer');
  if (!timer) { el.classList.remove('show'); return; }
  const left = Math.ceil((timer.end - Date.now())/1000);
  if (left <= 0) { timer = null; el.classList.remove('show'); tone([880,880,880], .25); return; }
  el.classList.add('show');
  document.getElementById('timerTxt').textContent = Math.floor(left/60) + ':' + pad(left%60);
}
setInterval(tickTimer, 500);
let toastT = null;
function toast(title, sub){
  const el = document.getElementById('toast');
  el.innerHTML = `<span class="trophy">${I.trophy}</span><div class="col"><b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div>`;
  el.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 4500);
}
function sysNotify(title, body){
  try {
    if (!S.settings.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
    const opt = {body, icon:'icons/icon-192.png', tag:'forma-pr'};
    if (navigator.serviceWorker) navigator.serviceWorker.getRegistration().then(r => r ? r.showNotification(title, opt) : new Notification(title, opt)).catch(() => {});
    else new Notification(title, opt);
  } catch(e){}
}

/* ================= Import PDF / file ================= */
let pdfjs = null;
async function loadPdfJs(){
  if (pdfjs) return pdfjs;
  pdfjs = await import('./lib/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.mjs', location.href).href;
  return pdfjs;
}
async function pdfLines(buf){
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({data: buf}).promise, lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p), tc = await page.getTextContent(), rows = [];
    tc.items.forEach(it => {
      if (!it.str || !it.str.trim()) return;
      const y = it.transform[5], x = it.transform[4];
      let r = rows.find(r => Math.abs(r.y - y) < 3.5);
      if (!r) { r = {y, parts:[]}; rows.push(r); }
      r.parts.push({x, s: it.str, w: it.width || 0});
    });
    rows.sort((a,b) => b.y - a.y).forEach(r => {
      r.parts.sort((a,b) => a.x - b.x);
      let out = '', lastEnd = null;
      r.parts.forEach(pt => { if (lastEnd !== null) out += (pt.x - lastEnd > 12 ? '  |  ' : (pt.x - lastEnd > 1 ? ' ' : '')); out += pt.s; lastEnd = pt.x + pt.w; });
      const t = out.replace(/\s+/g, ' ').replace(/(\s*\|\s*)+/g, ' | ').replace(/^\s*\|\s*|\s*\|\s*$/g, '').trim();
      if (t) lines.push(t);
    });
  }
  return lines;
}

/* --- scheda --- */
function parseRest(s){
  s = String(s || '').trim();
  let b = s.match(/^(\d{1,2})[.,](\d{2})$/); if (b && +b[2] < 60) return (+b[1])*60 + (+b[2]);
  b = s.match(/^(\d{1,3})$/); if (b) return +b[1] <= 5 ? +b[1]*60 : +b[1];
  let m = s.match(/(\d{1,2})\s*[:']\s*(\d{2})\s*(?:''|"|″)?/); if (m && +m[2] < 60) return (+m[1])*60 + (+m[2]);
  m = s.match(/(\d{1,3})\s*(?:''|"|″|sec\b|secondi|s\b)/i); if (m) return +m[1];
  m = s.match(/(\d{1,2}(?:[.,]5)?)\s*(?:'|′|min\b|minut)/i); if (m) return Math.round(num(m[1])*60);
  m = s.match(/(?:rec(?:upero)?|pausa|riposo|rest)\.?\s*:?\s*(\d{1,3})/i); if (m) return +m[1] <= 5 ? +m[1]*60 : +m[1];
  return null;
}
const SR = /(\d{1,2})\s*(?:x|×|\*|serie da|sets? of)\s*(\d{1,3}(?:\s*[-–\/+]\s*\d{1,3})*|max(?:\s*\+\s*max)?|cedimento|amrap)/i;
function parseExLine(line){
  const l = line.replace(/\s+/g, ' ').trim();
  if (!l) return null;
  const parts = l.split('|').map(x => x.trim());
  if (parts.length >= 2 && SR.test(parts[1]) && parts[0] && !SR.test(parts[0])) {
    const m = parts[1].match(SR);
    return {name: cleanName(parts[0]), sets: +m[1], reps: m[2].replace(/\s/g,'').replace(/[–\/]/g,'-').toLowerCase(), rest: parts[2] ? (parseRest(parts[2]) ?? 90) : (parseRest(parts.slice(2).join(' ')) ?? 90)};
  }
  const m = l.match(SR); if (!m) return null;
  let name = cleanName(l.slice(0, m.index));
  const after = l.slice(m.index + m[0].length);
  if (!name) name = cleanName(after.replace(/(rec(?:upero)?|pausa)\.?\s*:?\s*[\d:'"″.,]+\s*(sec|s|min)?/ig, '').replace(/\d+\s*(''|"|sec|s|'|min)\b/g, ''));
  if (!name || name.length < 2) return null;
  return {name, sets: +m[1], reps: m[2].replace(/\s/g,'').replace(/[–\/]/g,'-').toLowerCase(), rest: parseRest(after) ?? parseRest(l.slice(0, m.index)) ?? 90};
}
function cleanName(s){ s = String(s); if (/[A-Z]{3}/.test(s) && s === s.toUpperCase()) s = s.toLowerCase(); return cap(String(s).replace(/\|/g, ' ').replace(/^[\s\d.)\-•*·]+/, '').replace(/[\s:\-–|.,]+$/, '').replace(/\s+/g, ' ').trim()); }
const isHeading = l => { const t = l.replace(/\|/g, ' ').trim(); return t.length >= 2 && t.length <= 42 && /[a-zà-ú]/i.test(t) && !/pagina|page|www\.|@|\.com|tel\b/i.test(t) && (t.match(/\d/g) || []).length <= 3; };
function workoutMarkupFromLines(lines){
  const out = []; let pending = null, any = false;
  lines.forEach(l => {
    const ex = parseExLine(l);
    if (ex) { if (pending) { out.push('# ' + pending); pending = null; } else if (!any) out.push('# Allenamento A'); out.push(`${ex.name} | ${ex.sets} x ${ex.reps} | ${ex.rest}`); any = true; }
    else if (isHeading(l)) pending = cleanName(l);
  });
  return out.join('\n');
}
function parseWorkoutMarkup(text){
  const sessions = []; let cur = null;
  text.split(/\r?\n/).forEach(raw => {
    const l = raw.trim(); if (!l) return;
    if (l.startsWith('#')) { cur = {name: cleanName(l.replace(/^#+/, '')) || 'Sessione ' + (sessions.length+1), ex:[]}; sessions.push(cur); return; }
    const ex = parseExLine(l);
    if (ex) { if (!cur) { cur = {name:'Allenamento A', ex:[]}; sessions.push(cur); } cur.ex.push({name: ex.name, sets: Math.min(ex.sets, 12), reps: ex.reps, rest: Math.min(ex.rest, 600)}); }
  });
  return sessions.filter(s => s.ex.length);
}

/* --- dieta --- */
const MEAL_RE = /^(prima colazione|colazione|spuntino[\w ]{0,20}|merenda|pranzo|cena|pre[\s-]?(allenamento|workout|nanna)|post[\s-]?(allenamento|workout)|dopo cena|prima di dormire)\b/i;
const VAR_RE = /^(giorn[oi]|day|giornata|schema)?\s*(di|con|senza|non)?\s*(di)?\s*(allenamento|riposo|training|off|on|workout|palestra)\b/i;
const QTY = '(\\d+(?:[.,]\\d+)?\\s*(?:-\\s*\\d+\\s*)?(?:g|gr|grammi|ml|cl|l|kg|pz|pezz[oi]|fett[ae]|cucchia\\w*|vasett[oi]|uov[oa]|porzion\\w*|tazz\\w*|bicchier\\w*|scatolett\\w*|confezion\\w*|frutt[oi])\\b\\.?)';
function splitQty(text){
  const t = text.replace(/^[-•*·\s]+/, '').trim();
  if (t.includes('|')) { const [a, ...b] = t.split('|'); return {food: cap(a.trim()), qty: b.join(' ').trim()}; }
  let m = t.match(new RegExp(QTY + '\\s*$', 'i'));
  if (m && m.index > 0) return {food: cap(t.slice(0, m.index).replace(/[\s:\-–,]+$/, '')), qty: m[1].trim()};
  m = t.match(/^(.*[^\d\s])\s+(\d{1,3})$/); if (m) return {food: cap(m[1]), qty: m[2]};
  m = t.match(new RegExp('^' + QTY + '\\s*(?:di\\s+|d\')?', 'i'));
  if (m) return {food: cap(t.slice(m[0].length).trim()), qty: m[1].trim()};
  return {food: cap(t), qty: ''};
}
function detectUse(label){ const n = norm(label); if (/ripos|\boff\b|\brest\b|non allen|senza allen/.test(n)) return 'rest'; if (/allen|train|workout|\bon\b|palestra/.test(n)) return 'train'; return 'all'; }
function dietMarkupFromLines(lines){
  const out = []; let inMeal = false;
  lines.forEach(raw => {
    const l = raw.replace(/\s*\|\s*/g, ' | ').trim(); if (!l) return;
    const flat = l.replace(/\|/g, ' ').replace(/\s+/g, ' ');
    if (VAR_RE.test(flat) && flat.length < 50) { out.push('# ' + cleanName(flat)); inMeal = false; return; }
    const mm = flat.match(MEAL_RE);
    if (mm) {
      const rest = flat.slice(mm[0].length).replace(/^[\s:–\-]+/, '');
      const time = rest.match(/^\(?(\d{1,2}[:.]\d{2})\)?/);
      out.push('## ' + cap(mm[0].trim().toLowerCase()) + (time ? ' (' + time[1].replace('.', ':') + ')' : ''));
      const r2 = time ? rest.slice(time[0].length).replace(/^[\s:–\-]+/, '') : rest;
      if (r2) out.push('- ' + r2);
      inMeal = true; return;
    }
    if (/^(oppure|in alternativa|o in alternativa|alternativa|o)\b[\s:]*/i.test(flat) && inMeal) {
      const r = flat.replace(/^(oppure|in alternativa|o in alternativa|alternativa|o)\b[\s:]*/i, '');
      out.push('oppure'); if (r) out.push('- ' + r); return;
    }
    if (inMeal) out.push('- ' + l.replace(/^[-•*·]\s*/, '').replace(/\s\|\s/, ' | '));
    else out.push('> ' + flat);
  });
  return out.join('\n');
}
function parseDietMarkup(text){
  const variants = [], notes = []; let v = null, meal = null;
  const newMeal = name => { if (!v) { v = {label:'Tutti i giorni', use:'all', meals:[]}; variants.push(v); } const t = name.match(/\(?(\d{1,2})[:.](\d{2})\)?/); meal = {name: cap(name.replace(/\(?\d{1,2}[:.]\d{2}\)?/, '').trim()), time: t ? t[1] + ':' + t[2] : '', options:[{items:[]}], notes:[]}; v.meals.push(meal); };
  text.split(/\r?\n/).forEach(raw => {
    const l = raw.trim(); if (!l) return;
    if (/^###/.test(l)) { if (!meal) return; const lab = l.replace(/^#+/, '').trim(); const cur = meal.options[meal.options.length-1]; if (cur.items.length) meal.options.push({label: lab, items:[]}); else cur.label = lab; return; }
    if (/^\*/.test(l) && meal) { const cur = meal.options[meal.options.length-1], it = cur.items[cur.items.length-1]; if (it) { (it.choose = it.choose || []).push(splitQty(l.replace(/^\*\s*/, ''))); } return; }
    const wd = l.match(/^@\s*(dom|lun|mar|mer|gio|ven|sab)\w*\s*:?\s*(.+)$/i); if (wd && meal) { (meal.today = meal.today || {})[wd[1].toLowerCase()] = wd[2].trim(); return; }
    if (/^##/.test(l)) { newMeal(l.replace(/^#+/, '').trim() || 'Pasto'); return; }
    if (/^#/.test(l)) { const label = cleanName(l.replace(/^#+/, '')) || 'Piano'; v = {label, use: detectUse(label), meals:[]}; variants.push(v); meal = null; return; }
    if (/^oppure\b/i.test(l)) { if (meal && meal.options[meal.options.length-1].items.length) meal.options.push({items:[]}); const r = l.replace(/^oppure\b[\s:]*/i, ''); if (r && meal) meal.options[meal.options.length-1].items.push(splitQty(r)); return; }
    if (l.startsWith('>')) { const t = l.replace(/^>\s*/, ''); if (!t) return; if (meal) meal.notes.push(t); else notes.push(t); return; }
    if (meal) meal.options[meal.options.length-1].items.push(splitQty(l));
    else notes.push(l);
  });
  variants.forEach(x => { x.meals.forEach(m => m.options = m.options.filter(o => o.items.length)); x.meals = x.meals.filter(m => m.options.length); });
  return {variants: variants.filter(x => x.meals.length), notes};
}
function validDiet(d){ return d && Array.isArray(d.variants) && d.variants.length && d.variants.every(v => Array.isArray(v.meals) && v.meals.every(m => Array.isArray(m.options) && m.options.length)); }
function validPlan(p){ return p && Array.isArray(p.sessions) && p.sessions.length && p.sessions.every(s => Array.isArray(s.ex)); }
function normItem(i){ if (typeof i === 'string') return splitQty(i); const x = {food: String(i.food || ''), qty: String(i.qty || '')}; if (Array.isArray(i.choose) && i.choose.length) x.choose = i.choose.map(c => typeof c === 'string' ? splitQty(c) : {food: String(c.food || ''), qty: String(c.qty || '')}); return x; }
function normDiet(d){
  return {name: String(d.name || 'La mia dieta'), notes: (d.notes || []).map(String), variants: d.variants.map(v => ({label: String(v.label || 'Piano'), use: ['train','rest','all'].includes(v.use) ? v.use : detectUse(v.label), meals: v.meals.map(m => { const x = {name: String(m.name || 'Pasto'), time: m.time || '', notes: (m.notes || (m.note ? [m.note] : [])).map(String), options: m.options.map(o => ({label: String(o.label || ''), items: (o.items || []).map(normItem)}))}; if (m.today && typeof m.today === 'object') { x.today = {}; WD_KEYS.forEach(k => { if (m.today[k]) x.today[k] = String(m.today[k]); }); } return x; })}))};
}
function normPlan(p){
  const sessions = p.sessions.map((s, i) => ({name: String(s.name || 'Sessione ' + (i+1)), ex: s.ex.map(e => {
    const x = {name: String(e.name), sets: Math.max(1, Math.min(12, parseInt(e.sets) || 3)), reps: String(e.reps || '10'), rest: e.rest === 0 || e.rest === '0' ? 0 : Math.max(0, Math.min(600, parseInt(e.rest) || 90)), note: e.note ? String(e.note) : ''};
    if (Array.isArray(e.weeks) && e.weeks.length) x.weeks = e.weeks.map(w => ({sets: Math.max(1, Math.min(12, parseInt(w.sets) || x.sets)), reps: String(w.reps || x.reps)}));
    return x; })}));
  const weeks = Math.max(0, ...sessions.flatMap(s => s.ex.map(e => e.weeks ? e.weeks.length : 0)));
  return {name: String(p.name || 'La mia scheda'), sessions, weeks, start: weeks ? (p.start || today()) : undefined};
}

/* ================= Icone ================= */
const I = {
  back:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 6l-6 6 6 6"/></svg>',
  user:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  check:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  play:'<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4l13 8-13 8z"/></svg>',
  swap:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13l-3-3M20 16H7l3 3"/></svg>',
  x:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  dumb:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 7v10M3 9v6M18 7v10M21 9v6M6 12h12"/></svg>',
  moon:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
  info:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>',
  trophy:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20h7M10 17h4v3h-4z"/></svg>',
  up:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  file:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 18v-6M9 15l3 3 3-3"/></svg>',
  book:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5M8 7h7"/></svg>',
  plus:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  minus:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14"/></svg>',
  trash:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>'
};

/* ================= Componenti ================= */
function macroBars(t){
  const tot = t.p*4 + t.c*4 + t.f*9;
  const m = (label, g, kc, color) => `<div class="macro col"><span class="sub">${label}</span><b>${fmt(g)} g</b><div class="bar" aria-hidden="true"><i style="background:${color}"></i></div><span class="sub small">${Math.round(kc/tot*100)}% delle kcal</span></div>`;
  return `<div class="macros">${m('Proteine', t.p, t.p*4, 'var(--green)')}${m('Carboidrati', t.c, t.c*4, 'var(--red)')}${m('Grassi', t.f, t.f*9, 'var(--ochre)')}</div>`;
}
const accentCls = a => a === 'red' ? 'red' : a === 'green' ? 'green' : '';
function calcMealCard(m, swap){
  return `<article class="meal">
    <div class="between top"><div class="col"><span class="tag ${accentCls(m.accent)}">${esc(m.label)} · ${fromMin(m.t)}</span><h3>${esc(m.tpl.n)}</h3></div>
    ${swap && m.count > 1 ? `<button class="btn ghost small" data-a="swap" data-s="${m.id}" aria-label="Cambia proposta per ${esc(m.label)}">${I.swap}Cambia</button>` : ''}</div>
    <ul class="items">${m.items.map(([id,g]) => { const [a,b] = itemText(id,g); return `<li><span>${esc(a)}</span><span>${esc(b)}</span></li>`; }).join('')}</ul>
    <div class="foot">${fmt(m.tot.kcal)} kcal · P ${fmt(m.tot.p)} g · C ${fmt(m.tot.c)} g · G ${fmt(m.tot.f)} g</div></article>`;
}
const WD_KEYS = ['dom','lun','mar','mer','gio','ven','sab'];
function dietItemHtml(m, i, ii){
  if (!i.choose || !i.choose.length) return `<li><span>${esc(i.food)}</span><span>${esc(i.qty)}</span></li>`;
  const k = 'c:' + m.k + ':' + m.oi + ':' + ii, ci = (S.dietChoice[k] || 0) % i.choose.length, c = i.choose[ci];
  return `<li class="choose"><button data-a="chooseOpen" data-k="${k}" data-m="${esc(m.k)}" data-o="${m.oi}" data-i="${ii}" aria-label="Scegli ${esc(i.food)}"><span class="col"><span class="tag">${esc(i.food)} · ${i.choose.length} scelte</span><span class="cf">${esc(c.food)}</span></span><span class="cq">${esc(c.qty)}</span><span class="chev">${I.swap}</span></button></li>`;
}
function dietMealCard(m, swap){
  const n = m.options.length, s = norm(m.name);
  const hint = m.today ? m.today[WD_KEYS[new Date().getDay()]] : '';
  const acc = /^pre\b|pre allen/.test(s) ? 'red' : /post|recupero/.test(s) ? 'green' : '';
  return `<article class="meal">
    <div class="between top"><div class="col"><span class="tag ${acc}">${esc(m.name)}${m.time ? ' · ' + esc(m.time) : ''}</span>${n > 1 ? `<h3>${m.opt.label ? esc(m.opt.label) : 'Opzione ' + (m.oi+1)}</h3><span class="sub">${m.oi+1} di ${n}</span>` : ''}</div>
    ${swap && n > 1 ? `<button class="btn ghost small" data-a="dietSwap" data-k="${m.k}" data-n="${n}" aria-label="Opzione successiva per ${esc(m.name)}">${I.swap}Cambia</button>` : ''}</div>
    ${hint ? `<div class="hint">Suggerito per oggi (${WEEKDAY[new Date().getDay()]}): <b>${esc(hint)}</b></div>` : ''}
    <ul class="items">${m.opt.items.map((i, ii) => dietItemHtml(m, i, ii)).join('')}</ul>
    ${m.notes && m.notes.length ? `<details class="mnotes"><summary>Note (${m.notes.length})</summary><div class="foot">${m.notes.map(esc).join('<br>')}</div></details>` : ''}</article>`;
}

/* ================= Viste ================= */
function vOggi(){
  const ds = today(), d = new Date(), info = dayInfo(ds), type = dayType(ds), T = dayTime(ds);
  const now = d.getHours()*60 + d.getMinutes();
  const asked = !!info || S.history.some(h => h.date === ds);
  const dayCard = `<section class="card">
    <div class="between"><h3>Oggi ti alleni?</h3><span class="sub">Settimana: ${weekCount()}/${S.profile.weeklyTarget}</span></div>
    <div class="seg" role="radiogroup" aria-label="Oggi ti alleni?">
      <button role="radio" aria-checked="${asked && type==='train'}" class="${asked && type==='train'?'on':''}" data-a="setDay" data-v="train">${I.dumb} Sì</button>
      <button role="radio" aria-checked="${asked && type==='rest'}" class="${asked && type==='rest'?'on':''}" data-a="setDay" data-v="rest">${I.moon} No, riposo</button></div>
    ${type === 'train' ? `<div class="row"><label class="flabel" for="dayTime" style="flex:1">A che ora?</label><input id="dayTime" class="time" type="time" value="${fromMin(T).padStart(5,'0')}" data-c="dayTime"></div>` : ''}
    ${!asked ? `<span class="note">Finché non scegli, il piano è quello del giorno di riposo.</span>` : ''}
  </section>`;

  let food = '', next = null;
  if (S.diet) {
    const vi = dietVariantFor(type), meals = dietMeals(vi, T).sort((a,b) => a.t - b.t);
    next = meals.find(m => m.t >= now - 45);
    food = `<section class="card"><span class="sub">La tua dieta</span><h3>${esc(S.diet.name)}</h3><span class="chip ${S.diet.variants[vi].use}" style="align-self:flex-start">${esc(S.diet.variants[vi].label)}</span></section>`;
    next = next ? `<div class="between"><h2>Prossimo pasto</h2><button class="btn ghost small" data-a="tab" data-t="piano">Tutti i pasti</button></div>${dietMealCard(next, true)}` : '';
  } else {
    const t = targets(type), other = targets(type === 'train' ? 'rest' : 'train'), diffK = t.kcal - other.kcal;
    const plan = calcPlan(type, T); const nm = plan.find(m => m.t >= now - 45);
    food = `<section class="card">
      <div class="between bottom"><div class="col"><span class="sub">Da mangiare oggi</span><span class="big">${fmt(t.kcal)} <span class="unit">kcal</span></span></div>
      <span class="sub right">${diffK >= 0 ? '+' : '−'}${fmt(Math.abs(diffK))} kcal<br>rispetto al ${type === 'train' ? 'riposo' : 'giorno di allenamento'}</span></div>
      ${macroBars(t)}</section>`;
    next = nm ? `<div class="between"><h2>Prossimo pasto</h2><button class="btn ghost small" data-a="tab" data-t="piano">Tutto il piano</button></div>${calcMealCard(nm, false)}` : '';
  }
  let work = '';
  if (S.active) work = `<section class="card green"><span class="sub">Allenamento in corso</span><h3 class="disp">${esc(S.active.name)}</h3><button class="btn white" data-a="tab" data-t="work">${I.play}Continua</button></section>`;
  else if (S.history.some(h => h.date === ds)) work = `<section class="card green"><span class="sub">Allenamento di oggi</span><h3 class="disp">Fatto. Ottimo lavoro.</h3><span class="sub">Ora punta sul pasto di recupero.</span></section>`;
  else if (type === 'train') { const {i, s} = nextSession(); if (s) work = `<section class="card green"><div class="col"><span class="sub">Prossima sessione · ${fromMin(T)}</span><h3 class="disp">${esc(s.name)}</h3><span class="sub">${s.ex.length} esercizi</span></div><button class="btn white" data-a="startWork" data-i="${i}">${I.play}Inizia allenamento</button></section>`; }
  const wToday = S.weights.some(w => w.d === ds);
  return `
  <header class="between"><div class="col"><span class="sub">${cap(WEEKDAY[d.getDay()])} ${d.getDate()} ${d.toLocaleDateString('it-IT',{month:'long'})}</span><h1>Ciao${S.profile.name ? ', ' + esc(S.profile.name) : ''}</h1></div>
  <button class="icon-btn" data-a="tab" data-t="profilo" aria-label="Profilo e impostazioni">${I.user}</button></header>
  ${dayCard}${work}${food}${next || `<div class="empty">Pasti di oggi completati.</div>`}
  ${!wToday ? `<button class="li btnrow" data-a="tab" data-t="prog"><span>Registra il peso di oggi</span><span class="r">Progressi ›</span></button>` : ''}`;
}

function vPiano(){
  const ds = today(), todayType = dayType(ds), T = dayTime(ds);
  if (S.diet) {
    const vars = S.diet.variants, def = dietVariantFor(todayType);
    const vi = S.ui.dietVar != null && S.ui.dietVar < vars.length ? S.ui.dietVar : def;
    const meals = dietMeals(vi, T).sort((a,b) => a.t - b.t);
    return `
    <header class="between"><div class="col"><h1>Piano pasti</h1><span class="sub">${esc(S.diet.name)}</span></div><button class="icon-btn" data-a="openImport" data-k="diet" aria-label="Importa una dieta">${I.file}</button></header>
    ${vars.length > 1 ? `<div class="seg wrap" role="tablist">${vars.map((v, i) => `<button role="tab" aria-selected="${i===vi}" class="${i===vi?'on':''}" data-a="dietVar" data-v="${i}">${esc(v.label)}${i===def?' · oggi':''}</button>`).join('')}</div>` : ''}
    ${meals.map(m => dietMealCard(m, true)).join('')}
    ${S.diet.notes.length ? `<section class="card"><h2>Note della dieta</h2><ul class="dnotes">${S.diet.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></section>` : ''}
    <div class="grid2"><button class="btn ghost" data-a="viewPdf" data-k="dietPdf">Vedi il PDF</button><button class="btn ghost" data-a="editDiet">Correggi</button></div>`;
  }
  const type = S.ui.pianoType || todayType;
  const t = targets(type), plan = calcPlan(type, T);
  const tot = plan.reduce((a,m) => ({kcal:a.kcal+m.tot.kcal, p:a.p+m.tot.p, c:a.c+m.tot.c, f:a.f+m.tot.f}), {kcal:0,p:0,c:0,f:0});
  return `
  <header class="col"><h1>Piano pasti</h1><span class="sub">Cosa e quanto mangiare, calcolato sui tuoi dati.</span></header>
  <button class="li btnrow" data-a="openImport" data-k="diet"><span class="row">${I.file}<span>Hai la dieta del nutrizionista? Importa il PDF</span></span><span class="r">›</span></button>
  <div class="seg" role="tablist"><button role="tab" aria-selected="${type==='train'}" class="${type==='train'?'on':''}" data-a="pianoType" data-v="train">Allenamento${todayType==='train'?' · oggi':''}</button><button role="tab" aria-selected="${type==='rest'}" class="${type==='rest'?'on':''}" data-a="pianoType" data-v="rest">Riposo${todayType==='rest'?' · oggi':''}</button></div>
  <section class="card tight"><div class="between"><span class="big mid">${fmt(tot.kcal)} <span class="unit">kcal</span></span><span class="sub">obiettivo ${fmt(t.kcal)}</span></div>
  <span class="sub">P ${fmt(tot.p)} g · C ${fmt(tot.c)} g · G ${fmt(tot.f)} g</span></section>
  ${plan.map(m => calcMealCard(m, true)).join('')}
  <p class="note">Pesi a crudo per pasta, riso, farro, carne e pesce. Le verdure sono libere: 200 g è il minimo. «Cambia» propone un'alternativa con gli stessi macro.</p>`;
}

function vWork(){
  ensurePlan();
  if (S.active) return vActive();
  if (S.ui.editPlan) return vEditPlan();
  const {i, s} = nextSession();
  return `
  <header class="between"><div class="col"><h1>Allenamento</h1><span class="sub">${esc(S.plan.name)} · settimana ${weekCount()}/${S.profile.weeklyTarget}</span></div>
  <button class="icon-btn" data-a="openImport" data-k="workout" aria-label="Importa una scheda">${I.file}</button></header>
  ${S.plan.weeks ? (() => { const raw = planWeekRaw(), w = planWeek(); return `<section class="card tight"><div class="between"><span class="col"><span class="sub">Progressione della scheda</span><b class="n20">Settimana ${w} di ${S.plan.weeks}</b></span><div class="stepper"><button data-a="planWeek" data-d="-1" aria-label="Settimana precedente">${I.minus}</button><button data-a="planWeek" data-d="1" aria-label="Settimana successiva">${I.plus}</button></div></div>${raw > S.plan.weeks ? `<span class="note">Hai completato le ${S.plan.weeks} settimane. <button class="linkbtn" data-a="planRestart">Ricomincia dalla 1</button></span>` : `<span class="note">Serie e ripetizioni degli esercizi con progressione cambiano da sole ogni settimana.</span>`}</section>`; })() : ''}
  ${s ? `<section class="card green"><div class="col"><span class="sub">Prossima sessione</span><h3 class="disp">${esc(s.name)}</h3><span class="sub">${s.ex.length} esercizi</span></div>
  <ol class="plain light">${s.ex.map(e => { const t = exTarget(e); return `<li>${esc(e.name)} — ${t.sets} × ${esc(t.reps)} · ${e.rest ? 'rec. ' + secTxt(e.rest) : 'superserie'}</li>`; }).join('')}</ol>
  <button class="btn white" data-a="startWork" data-i="${i}">${I.play}Inizia</button></section>` : ''}
  <div class="between"><h2>Tutte le sessioni</h2><button class="btn ghost small" data-a="editPlan">Modifica scheda</button></div>
  ${S.plan.sessions.map((x, k) => `<details class="sess"><summary><span>${esc(x.name)}${k === i ? ' <span class="tag green">· prossima</span>' : ''}</span><span class="sub">${x.ex.length} esercizi</span></summary>
    <ol class="plain">${x.ex.map(e => { const t = exTarget(e); return `<li><b class="ink">${esc(e.name)}</b> — ${t.sets} × ${esc(t.reps)}, ${e.rest ? 'rec. ' + secTxt(e.rest) : 'superserie col successivo'}${e.weeks ? '<br><span class="small">Progressione: ' + esc(progTxt(e)) + '</span>' : ''}${e.note ? '<br><span class="small">' + esc(e.note) + '</span>' : ''}</li>`; }).join('')}</ol>
    <button class="btn dark small" data-a="startWork" data-i="${k}" style="margin-top:10px">${I.play}Inizia questa</button></details>`).join('')}
  <div class="grid2"><button class="btn ghost" data-a="startWork" data-i="-1">${I.plus}Allenamento libero</button><button class="btn ghost" data-a="openPicker" data-m="browse">${I.book}Esercizi</button></div>
  <button class="li btnrow" data-a="progTo" data-v="work"><span>Storico e record personali</span><span class="r">›</span></button>`;
}

function vActive(){
  const a = S.active;
  const done = a.ex.reduce((n,e) => n + e.log.filter(l => l.done).length, 0), all = a.ex.reduce((n,e) => n + e.log.length, 0);
  const mins = Math.floor((Date.now() - a.start)/60000);
  return `
  <header class="col"><span class="sub">In corso da ${mins} min · ${done}/${all} serie</span><h1 class="mid">${esc(a.name)}</h1></header>
  ${a.ex.length ? '' : `<div class="empty">Aggiungi il primo esercizio.</div>`}
  ${a.ex.map((e, ei) => { const last = lastFor(e.name), lib = findLib(e.name); return `<section class="ex">
    <div class="between top"><div class="col"><h3>${esc(e.name)}</h3><span class="sub">${e.log.length} × ${esc(e.reps)}</span></div>
      <div class="row gap6">${lib ? `<button class="icon-btn sm" data-a="info" data-n="${esc(e.name)}" aria-label="Come si esegue">${I.info}</button>` : ''}<button class="icon-btn sm" data-a="exMenu" data-e="${ei}" aria-label="Altre azioni per ${esc(e.name)}">⋯</button></div></div>
    ${e.note ? `<div class="callout sm">${esc(e.note)}</div>` : ''}
    <div class="restrow"><span class="flabel">${e.rest === 0 ? 'Recupero (superserie)' : 'Recupero'}</span><div class="stepper"><button data-a="rest" data-e="${ei}" data-d="-15" aria-label="Meno 15 secondi">${I.minus}</button><b>${secTxt(e.rest)}</b><button data-a="rest" data-e="${ei}" data-d="15" aria-label="Più 15 secondi">${I.plus}</button></div></div>
    <span class="sub">${last ? 'Ultima volta: ' + last.map(l => (l.kg ? fmt1(l.kg) + '×' : '') + l.reps).join(' · ') : 'Prima volta: scegli un carico che ti lasci 1–2 ripetizioni di margine.'}</span>
    <div class="sethead"><span>#</span><span>kg</span><span>Rip</span><span></span></div>
    <div class="sets">${e.log.map((l, si) => `<div class="set ${l.done?'done':''}">
      <span class="n">${l.pr ? `<span class="prmark" title="Record">${I.trophy}</span>` : si+1}</span>
      <input inputmode="decimal" aria-label="Chili serie ${si+1}" value="${esc(l.kg)}" placeholder="kg" data-c="kg" data-e="${ei}" data-s="${si}">
      <input inputmode="numeric" aria-label="Ripetizioni serie ${si+1}" value="${esc(l.reps)}" placeholder="${esc(repsFor(e, si))}" data-c="reps" data-e="${ei}" data-s="${si}">
      <button class="chk" data-a="toggleSet" data-e="${ei}" data-s="${si}" aria-label="${l.done ? 'Annulla' : 'Completa'} serie ${si+1}">${I.check}</button></div>`).join('')}</div>
    <div class="row"><button class="btn ghost small" data-a="addSet" data-e="${ei}">${I.plus}Serie</button>${e.log.length > 1 ? `<button class="btn ghost small" data-a="delSet" data-e="${ei}">${I.minus}Serie</button>` : ''}</div>
  </section>`; }).join('')}
  <button class="btn ghost full" data-a="openPicker" data-m="add">${I.plus}Aggiungi esercizio</button>
  <button class="btn dark full" data-a="finishWork">Termina e salva</button>
  <button class="btn danger full" data-a="cancelWork">Annulla allenamento</button>`;
}

function vEditPlan(){
  const P = S.draft;
  return `
  <header class="between"><button class="icon-btn" data-a="closeEdit" aria-label="Chiudi senza salvare">${I.back}</button><h1 class="small">Modifica scheda</h1><span style="width:44px"></span></header>
  <div class="field"><label for="pname">Nome della scheda</label><input id="pname" value="${esc(P.name)}" data-c="pname"></div>
  <div class="field"><label for="preset">Oppure parti da una scheda pronta</label><select id="preset" data-c="preset"><option value="">— mantieni questa —</option>${Object.entries(PLANS).map(([k,p]) => `<option value="${k}">${esc(p.name)}</option>`).join('')}</select></div>
  ${P.sessions.map((s, si) => `<section class="card">
    <div class="field"><label>Nome sessione</label><input value="${esc(s.name)}" data-c="sname" data-s="${si}"></div>
    <div class="edit-ex head"><span>Serie</span><span>Ripetizioni</span><span>Recupero (s)</span><span></span></div>
    ${s.ex.map((e, ei) => `<div class="edit-ex">
      <input class="nm" value="${esc(e.name)}" aria-label="Nome esercizio" data-c="ename" data-s="${si}" data-e="${ei}">
      <input inputmode="numeric" value="${e.sets}" aria-label="Serie" data-c="esets" data-s="${si}" data-e="${ei}">
      <input value="${esc(e.reps)}" aria-label="Ripetizioni" data-c="ereps" data-s="${si}" data-e="${ei}">
      <input inputmode="numeric" value="${e.rest}" aria-label="Recupero in secondi" data-c="erest" data-s="${si}" data-e="${ei}">
      <button class="x" data-a="delEx" data-s="${si}" data-e="${ei}" aria-label="Elimina ${esc(e.name)}">${I.x}</button>
      ${e.weeks ? `<input class="nm" value="${esc(progTxt(e))}" aria-label="Progressione per settimana" data-c="eprog" data-s="${si}" data-e="${ei}" title="Progressione">` : ''}
      <input class="nm note-in" value="${esc(e.note || '')}" placeholder="Nota (facoltativa)" aria-label="Nota" data-c="enote" data-s="${si}" data-e="${ei}"></div>`).join('')}
    <div class="row wrap"><button class="btn ghost small" data-a="openPicker" data-m="plan" data-s="${si}">${I.book}Dalla libreria</button><button class="btn ghost small" data-a="addEx" data-s="${si}">${I.plus}Vuoto</button>${P.sessions.length > 1 ? `<button class="btn danger small" data-a="delSess" data-s="${si}">Elimina sessione</button>` : ''}</div>
  </section>`).join('')}
  <button class="btn ghost full" data-a="addSess">${I.plus}Aggiungi sessione</button>
  <button class="btn dark full" data-a="savePlan">Salva scheda</button>`;
}

function weightChart(w){
  if (w.length < 2) return `<div class="empty">Pesati anche nei prossimi giorni per vedere l'andamento.</div>`;
  const W = 320, H = 120, min = Math.min(...w.map(x=>x.kg)) - .5, max = Math.max(...w.map(x=>x.kg)) + .5;
  const t0 = parseD(w[0].d).getTime(), t1 = parseD(w[w.length-1].d).getTime();
  const X = d => 8 + (W-16) * ((parseD(d).getTime() - t0) / Math.max(1, t1 - t0));
  const Y = kg => 10 + (H-20) * (1 - (kg - min) / (max - min));
  const last = w[w.length-1];
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Andamento del peso"><line x1="0" x2="${W}" y1="${H-1}" y2="${H-1}" stroke="var(--track)"/><polyline points="${w.map(x => X(x.d).toFixed(1) + ',' + Y(x.kg).toFixed(1)).join(' ')}" fill="none" stroke="var(--green)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${X(last.d)}" cy="${Y(last.kg)}" r="4" fill="var(--green)"/></svg>
  <div class="between sub"><span>${fdate(w[0].d)}</span><span>min ${fmt1(min+.5)} · max ${fmt1(max-.5)} kg</span><span>${fdate(last.d)}</span></div>`;
}
function recordsList(){
  const map = new Map();
  S.history.forEach(h => h.ex.forEach(e => { if (!e.sets.length) return; const k = libKey(e.name); if (!map.has(k)) map.set(k, {name: e.name, sets: [], last: h.date}); const r = map.get(k); r.sets.push(...e.sets); r.last = h.date; r.name = e.name; }));
  return [...map.values()].map(r => Object.assign(r, bestsFrom(r.sets))).sort((a,b) => a.name.localeCompare(b.name, 'it'));
}
function vProg(){
  const tab = S.ui.progTab || 'peso';
  const seg = `<div class="seg" role="tablist">${[['peso','Peso'],['work','Allenamenti'],['rec','Record']].map(([k,l]) => `<button role="tab" aria-selected="${tab===k}" class="${tab===k?'on':''}" data-a="progTo" data-v="${k}">${l}</button>`).join('')}</div>`;
  let body = '';
  if (tab === 'peso') {
    const w = S.weights, d = w.length >= 2 ? w[w.length-1].kg - w[0].kg : null;
    const list = S.ui.allW ? w.slice().reverse() : w.slice(-10).reverse();
    body = `<section class="card"><div class="between"><div class="col"><span class="sub">Peso attuale</span><span class="big">${fmt1(weightNow())} <span class="unit">kg</span></span></div>${d !== null ? `<span class="chip soft">${d > 0 ? '+' : d < 0 ? '−' : ''}${fmt1(Math.abs(d))} kg dall'inizio</span>` : ''}</div>
    ${weightChart(w.slice(-90))}
    <div class="row"><div class="field" style="flex:1"><label for="wIn">Peso di oggi (kg)</label><input id="wIn" inputmode="decimal" placeholder="es. 78,4"></div><button class="btn dark" data-a="addWeight" style="align-self:flex-end">Salva</button></div>
    <span class="note">Pesati al mattino, a digiuno. I calcoli usano il peso più recente.</span></section>
    ${w.length ? `<h2>Storico pesate</h2><div class="list">${list.map(x => `<div class="li"><span>${fdate(x.d, {weekday:'short', day:'numeric', month:'short', year:'2-digit'})}</span><span class="row"><b>${fmt1(x.kg)} kg</b><button class="icon-btn sm plain-x" data-a="delWeight" data-d="${x.d}" aria-label="Elimina pesata">${I.x}</button></span></div>`).join('')}</div>
    ${w.length > 10 && !S.ui.allW ? `<button class="btn ghost full" data-a="allW">Mostra tutte (${w.length})</button>` : ''}` : ''}`;
  } else if (tab === 'work') {
    const h = S.history.map((x, i) => Object.assign({i}, x)).reverse();
    const vol = x => x.ex.reduce((a, e) => a + e.sets.reduce((b, s) => b + (s.kg || 0) * (s.reps || 0), 0), 0);
    body = `<div class="grid3"><div class="stat"><span class="sub">Settimana</span><b>${weekCount()}/${S.profile.weeklyTarget}</b></div><div class="stat"><span class="sub">Totale</span><b>${S.history.length}</b></div><div class="stat"><span class="sub">Record</span><b>${S.history.reduce((a, x) => a + (x.prs ? x.prs.length : 0), 0)}</b></div></div>
    ${h.length ? `<div class="list">${h.map(x => `<button class="li btnrow" data-a="workDetail" data-i="${x.i}"><span class="col"><b>${esc(x.name)}</b><span class="sub">${fdate(x.date, {weekday:'short', day:'numeric', month:'short'})} · ${x.dur || '–'} min · ${x.ex.reduce((a,e)=>a+e.sets.length,0)} serie${vol(x) ? ' · ' + fmt(vol(x)) + ' kg sollevati' : ''}</span></span><span class="row">${x.prs && x.prs.length ? `<span class="prbadge">${I.trophy}${x.prs.length}</span>` : ''}<span class="r">›</span></span></button>`).join('')}</div>` : `<div class="empty">Ancora nessun allenamento salvato.</div>`}`;
  } else {
    const r = recordsList();
    body = r.length ? `<p class="note">Il massimale stimato (1RM) è calcolato con la formula di Epley dal miglior rapporto carico/ripetizioni.</p><div class="list">${r.map(x => `<button class="li btnrow" data-a="recDetail" data-n="${esc(x.name)}"><span class="col"><b>${esc(x.name)}</b><span class="sub">${x.kg > 0 ? `Max ${fmt1(x.kg)} kg × ${x.kgReps} · 1RM stimato ${fmt1(x.e1)} kg` : `Max ${x.reps} ripetizioni`}</span></span><span class="r">›</span></button>`).join('')}</div>` : `<div class="empty">I record compaiono dopo il primo allenamento salvato.</div>`;
  }
  return `<header class="col"><h1>Progressi</h1></header>${seg}${body}`;
}

function vProfilo(first){
  const p = S.profile || {name:'', sex:'m', birth:'', height:'', weight:'', activity:'mid', goal:'cut', weeklyTarget:3, defaultTime:'18:30', duration:60};
  if (!S.pdraft) { S.pdraft = clone(p); if (S.profile) S.pdraft.weight = weightNow(); }
  const d = S.pdraft, opt = (v, cur, label) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`;
  const notifOk = 'Notification' in window;
  return `
  ${first ? `<header class="col gap8 pt"><h1 class="xl">Forma</h1><span class="lead">Dieta e allenamento in un'unica app. Inserisci i tuoi dati: calcolo quanto mangiare nei giorni di allenamento e di riposo, e ti preparo una scheda. Potrai importare anche la tua dieta e la tua scheda in PDF.</span></header>`
  : `<header class="between"><button class="icon-btn" data-a="tab" data-t="oggi" aria-label="Indietro">${I.back}</button><h1 class="small">Profilo</h1><span style="width:44px"></span></header>`}
  <section class="card">
    <div class="field"><label for="pName">Nome</label><input id="pName" value="${esc(d.name)}" data-c="p" data-k="name" autocomplete="given-name"></div>
    <div class="grid2">
      <div class="field"><label for="pSex">Sesso</label><select id="pSex" data-c="p" data-k="sex">${opt('m',d.sex,'Uomo')}${opt('f',d.sex,'Donna')}</select></div>
      <div class="field"><label for="pBirth">Data di nascita</label><input id="pBirth" type="date" value="${esc(d.birth)}" max="${today()}" data-c="p" data-k="birth"></div>
      <div class="field"><label for="pH">Altezza (cm)</label><input id="pH" inputmode="numeric" value="${esc(d.height)}" data-c="p" data-k="height"></div>
      <div class="field"><label for="pW">Peso (kg)</label><input id="pW" inputmode="decimal" value="${esc(String(d.weight).replace('.', ','))}" data-c="p" data-k="weight"></div>
    </div>
    <span class="sub" id="ageTxt">${d.birth && parseD(d.birth) < new Date() ? ageOf(d.birth) + ' anni' : ''}</span>
    <div class="field"><label for="pAct">Attività fuori dalla palestra</label><select id="pAct" data-c="p" data-k="activity">${opt('low',d.activity,'Sedentaria (da seduto)')}${opt('mid',d.activity,'Moderata (spesso in piedi)')}${opt('high',d.activity,'Alta (lavoro fisico)')}</select></div>
    <div class="field"><label for="pGoal">Obiettivo</label><select id="pGoal" data-c="p" data-k="goal">${opt('cut',d.goal,'Perdere grasso')}${opt('keep',d.goal,'Mantenere il peso')}${opt('bulk',d.goal,'Aumentare massa muscolare')}</select></div>
  </section>
  <section class="card">
    <span class="flabel">Allenamento</span>
    <div class="grid3">
      <div class="field"><label for="pWk">Volte a settimana</label><input id="pWk" inputmode="numeric" value="${esc(d.weeklyTarget)}" data-c="p" data-k="weeklyTarget"></div>
      <div class="field"><label for="pT">Ora abituale</label><input id="pT" type="time" value="${esc(d.defaultTime)}" data-c="p" data-k="defaultTime"></div>
      <div class="field"><label for="pDur">Durata (min)</label><input id="pDur" inputmode="numeric" value="${esc(d.duration)}" data-c="p" data-k="duration"></div>
    </div>
    <span class="note">Orari variabili? Nessun problema: ogni giorno in «Oggi» scegli se e a che ora ti alleni. L'ora abituale è solo il valore proposto.</span>
  </section>
  <div id="calc"></div>
  <button class="btn dark full" data-a="saveProfile">${first ? 'Crea il mio piano' : 'Salva'}</button>
  ${first ? '' : `
  <h2 class="mt">Notifiche</h2>
  <section class="card tight"><div class="between"><span>Avvisami quando batto un record</span><button class="switch ${S.settings.notify ? 'on' : ''}" role="switch" aria-checked="${!!S.settings.notify}" data-a="toggleNotify" aria-label="Notifiche record"><i></i></button></div>
  <span class="note">${notifOk ? 'Durante l\'allenamento vedi sempre il messaggio del record con un suono. Attivando questa opzione arriva anche la notifica di iPhone (serve l\'app aggiunta alla schermata Home, iOS 16.4 o successivo).' : 'Le notifiche di sistema funzionano solo con l\'app aggiunta alla schermata Home (iOS 16.4 o successivo). Il messaggio del record nell\'app c\'è sempre.'}</span></section>
  <h2 class="mt">Dieta e scheda</h2>
  <section class="card tight">
    <div class="between"><span class="col"><b>Dieta</b><span class="sub">${S.diet ? esc(S.diet.name) : 'Piano calcolato da Forma'}</span></span>${S.diet ? `<button class="btn danger small" data-a="removeDiet">Rimuovi</button>` : ''}</div>
    <button class="btn ghost" data-a="openImport" data-k="diet">${I.file}Importa dieta (PDF o file)</button>
    <div class="between"><span class="col"><b>Scheda</b><span class="sub">${esc(S.plan ? S.plan.name : '')}</span></span></div>
    <button class="btn ghost" data-a="openImport" data-k="workout">${I.file}Importa scheda (PDF o file)</button>
  </section>
  <h2 class="mt">Backup</h2>
  <span class="note">I dati restano solo su questo iPhone. Esporta un backup ogni tanto: se cancelli l'app o i dati di Safari, lo puoi reimportare.</span>
  <div class="grid2"><button class="btn ghost" data-a="export">Esporta backup</button><button class="btn ghost" data-a="openImport" data-k="backup">Importa backup</button></div>
  <button class="btn danger full" data-a="reset">Cancella tutti i dati</button>`}
  <p class="note">Le calorie sono stime: metabolismo con la formula di Mifflin-St Jeor, moltiplicato per l'attività quotidiana, più il consumo stimato dell'allenamento. Controlla il peso per 2–3 settimane e, se non si muove come vuoi, cambia l'obiettivo. Non sostituisce il parere di un medico o di un nutrizionista.</p>`;
}
function normProfile(d){ return {name: String(d.name||'').trim(), sex: d.sex, birth: d.birth, height: num(d.height), weight: num(d.weight), activity: d.activity, goal: d.goal, weeklyTarget: Math.max(1, Math.min(7, parseInt(d.weeklyTarget) || 3)), defaultTime: d.defaultTime || '18:30', duration: num(d.duration) || 60}; }
function validProfile(d){ if (!d.birth) return false; const a = ageOf(d.birth), h = num(d.height), w = num(d.weight); return a >= 14 && a <= 99 && h >= 120 && h <= 230 && w >= 35 && w <= 250; }
function renderCalc(){
  const el = document.getElementById('calc'); if (!el) return;
  const d = S.pdraft, at = document.getElementById('ageTxt');
  if (at) at.textContent = d.birth && parseD(d.birth) < new Date() ? ageOf(d.birth) + ' anni' : '';
  if (!validProfile(d)) { el.innerHTML = ''; return; }
  const keep = S.profile, keepW = S.weights; S.profile = normProfile(d); S.weights = [];
  const tr = targets('train'), rs = targets('rest');
  S.profile = keep; S.weights = keepW;
  el.innerHTML = `<section class="card tight"><span class="flabel">Anteprima del piano calcolato</span>
    <div class="grid2"><div class="col"><span class="sub">Giorno di allenamento</span><b class="n20">${fmt(tr.kcal)} kcal</b><span class="sub">P ${fmt(tr.p)} · C ${fmt(tr.c)} · G ${fmt(tr.f)} g</span></div>
    <div class="col"><span class="sub">Giorno di riposo</span><b class="n20">${fmt(rs.kcal)} kcal</b><span class="sub">P ${fmt(rs.p)} · C ${fmt(rs.c)} · G ${fmt(rs.f)} g</span></div></div>
    ${S.diet ? '<span class="note">Stai usando la dieta importata: questi numeri servono solo come riferimento.</span>' : ''}</section>`;
}

/* ================= Fogli (pannelli dal basso) ================= */
let sheetBack = null;
function openSheet(title, html, back){
  sheetBack = back || null;
  document.getElementById('sheetTitle').textContent = title;
  document.getElementById('sheetBody').innerHTML = html;
  document.getElementById('sheetBackBtn').classList.toggle('hidden', !back);
  const sh = document.getElementById('sheet'); sh.classList.remove('hidden');
  document.body.classList.add('lock');
  document.getElementById('sheetBody').scrollTop = 0;
}
function closeSheet(){ document.getElementById('sheet').classList.add('hidden'); document.body.classList.remove('lock'); sheetBack = null; S.pick = null; }

function libInfoHtml(name){
  const l = findLib(name), sets = historySets(name), b = bestsFrom(sets);
  return `${l ? `<span class="sub">${esc(l.g)} · ${esc(l.eq)}</span>
    <h2>Come si esegue</h2><ol class="steps">${l.how.map(x => `<li>${esc(x)}</li>`).join('')}</ol>
    <div class="callout"><b>Attenzione:</b> ${esc(l.tip)}</div>` : `<p class="note">Esercizio personalizzato: non ci sono istruzioni in libreria.</p>`}
    ${b.has ? `<h2>I tuoi record</h2><div class="grid2"><div class="stat"><span class="sub">${b.kg > 0 ? 'Carico massimo' : 'Ripetizioni massime'}</span><b>${b.kg > 0 ? fmt1(b.kg) + ' kg × ' + b.kgReps : b.reps + ' rip.'}</b></div><div class="stat"><span class="sub">1RM stimato</span><b>${b.e1 ? fmt1(b.e1) + ' kg' : '–'}</b></div></div>` : ''}`;
}
function pickerHtml(){ return `<div class="field"><input id="pickQ" type="search" placeholder="Cerca un esercizio" autocomplete="off" data-c="pickQ" aria-label="Cerca un esercizio"></div>
  <div class="chips" id="pickG">${['Tutti'].concat(EXGROUPS).map(g => `<button class="chipbtn ${g==='Tutti'?'on':''}" data-a="pickGroup" data-g="${g}">${g}</button>`).join('')}</div>
  <div id="pickList" class="list"></div>`; }
function renderPickList(){
  const el = document.getElementById('pickList'); if (!el || !S.pick) return;
  const q = norm(S.pick.q || ''), g = S.pick.g || 'Tutti';
  const res = EXLIB.filter(e => (g === 'Tutti' || e.g === g) && (!q || [e.n].concat(e.al || []).some(x => norm(x).includes(q))));
  const browse = S.pick.mode === 'browse';
  el.innerHTML = (q && !browse && !EXLIB.some(e => norm(e.n) === q) ? `<button class="li btnrow" data-a="pickCustom"><span>Usa «${esc(S.pick.q.trim())}»</span><span class="r">${I.plus}</span></button>` : '') +
    res.map(e => `<div class="li pickrow"><button class="grow" data-a="${browse ? 'info' : 'pick'}" data-n="${esc(e.n)}"><span class="col"><b>${esc(e.n)}</b><span class="sub">${esc(e.g)} · ${esc(e.eq)}</span></span></button>${browse ? '' : `<button class="icon-btn sm" data-a="info" data-n="${esc(e.n)}" aria-label="Istruzioni ${esc(e.n)}">${I.info}</button>`}</div>`).join('') +
    (!res.length && !q ? '' : !res.length ? '<div class="empty">Nessun esercizio trovato.</div>' : '');
}
function openPicker(mode, extra){
  S.pick = Object.assign({mode, q:'', g:'Tutti'}, extra || {});
  const title = mode === 'replace' ? 'Sostituisci esercizio' : mode === 'browse' ? 'Libreria esercizi' : 'Aggiungi esercizio';
  const pick = S.pick;
  openSheet(title, pickerHtml());
  S.pick = pick; renderPickList();
}
function applyPick(name){
  const p = S.pick; if (!p) return;
  if (p.mode === 'add') { S.active.ex.push(mkEx(name, 3, '10', 90)); S.active.changed = true; }
  if (p.mode === 'replace') { const e = S.active.ex[p.ei]; const n = mkEx(name, e.log.length, e.reps, e.rest); S.active.ex[p.ei] = n; S.active.changed = true; }
  if (p.mode === 'plan') S.draft.sessions[p.si].ex.push(E(name, 3, '10', 90));
  closeSheet(); save(); render();
}

/* ---------- import ---------- */
function openImport(kind){
  const txt = {
    diet: ['Importa dieta', 'Scegli il PDF della dieta (o un file .json preparato da Claude). L\'app prova a riconoscere pasti, alimenti e quantità: poi controlli e correggi prima di salvare.'],
    workout: ['Importa scheda', 'Scegli il PDF della scheda (o un file .json preparato da Claude). L\'app riconosce righe come «Panca piana 4x8 rec 90\'\'»: poi controlli e correggi prima di salvare.'],
    backup: ['Importa backup', 'Scegli un file di backup di Forma (.json). Sostituisce i dati attuali.']
  }[kind];
  S.importKind = kind;
  openSheet(txt[0], `<p class="note">${txt[1]}</p>
    <button class="btn dark full" data-a="pickFile">${I.file}Scegli file</button>
    ${kind !== 'backup' ? `<div class="callout"><b>PDF scansionato o letto male?</b> Mandalo a Claude nella chat: ti prepara un file .json da importare qui con un tocco.</div>` : ''}
    ${kind === 'diet' ? `<button class="btn ghost full" data-a="writeMarkup">Oppure scrivila a mano</button>` : kind === 'workout' ? `<button class="btn ghost full" data-a="writeMarkup">Oppure scrivila a mano</button>` : ''}
    <p id="impStatus" class="note" role="status"></p>`);
}
function reviewHtml(kind, markup){
  const legend = kind === 'diet'
    ? `<b># Titolo</b> = tipo di giorno (es. <i># Giorno di allenamento</i>, <i># Giorno di riposo</i>)<br><b>## Pasto</b> = pasto, con orario facoltativo (es. <i>## Colazione (7:30)</i>)<br><b>- Alimento | quantità</b> = un alimento<br><b>oppure</b> (o <b>### Nome</b>) = alternativa per lo stesso pasto<br><b>&nbsp;&nbsp;* Alimento | quantità</b> sotto un alimento = scelte possibili<br><b>@lun: testo</b> = suggerimento per quel giorno<br><b>&gt; testo</b> = nota`
    : `<b># Nome</b> = sessione (es. <i># Giorno A</i>)<br><b>Esercizio | 4 x 8-10 | 90</b> = serie × ripetizioni e recupero in secondi`;
  return `<p class="note">Controlla il testo riconosciuto e correggilo se serve. L'anteprima sotto si aggiorna mentre scrivi.</p>
  <details class="legend"><summary>Come si scrive</summary><p class="note">${legend}</p></details>
  <textarea id="mk" data-c="mk" spellcheck="false" autocapitalize="off">${esc(markup)}</textarea>
  <div id="mkPrev"></div>
  ${kind === 'diet' ? `<div class="field"><label for="mkName">Nome della dieta</label><input id="mkName" value="${esc(S.impName || 'La mia dieta')}"></div>` : `<div class="field"><label for="mkName">Nome della scheda</label><input id="mkName" value="${esc(S.impName || 'La mia scheda')}"></div>`}
  <button class="btn dark full" data-a="confirmImport">Salva nell'app</button>`;
}
function renderPreview(){
  const el = document.getElementById('mkPrev'), ta = document.getElementById('mk'); if (!el || !ta) return;
  if (S.importKind === 'diet') {
    const d = parseDietMarkup(ta.value);
    el.innerHTML = d.variants.length ? `<div class="prev">${d.variants.map(v => `<b>${esc(v.label)}</b> <span class="tag ${v.use==='train'?'green':''}">${v.use === 'train' ? 'allenamento' : v.use === 'rest' ? 'riposo' : 'tutti i giorni'}</span><ul>${v.meals.map(m => `<li>${esc(m.name)}${m.time ? ' (' + esc(m.time) + ')' : ''}: ${m.options[0].items.length} alimenti${m.options.length > 1 ? ', ' + m.options.length + ' opzioni' : ''}</li>`).join('')}</ul>`).join('')}</div>` : `<div class="empty">Nessun pasto riconosciuto: usa «## Nome pasto» e «- alimento | quantità».</div>`;
  } else {
    const s = parseWorkoutMarkup(ta.value);
    el.innerHTML = s.length ? `<div class="prev">${s.map(x => `<b>${esc(x.name)}</b><ul>${x.ex.map(e => `<li>${esc(e.name)} — ${e.sets}×${esc(e.reps)}, rec. ${secTxt(e.rest)}${findLib(e.name) ? '' : ' <span class="tag">senza istruzioni</span>'}</li>`).join('')}</ul>`).join('')}</div>` : `<div class="empty">Nessun esercizio riconosciuto: scrivi righe come «Panca piana | 4 x 8 | 90».</div>`;
  }
}
async function handleFile(f){
  const st = document.getElementById('impStatus'); const say = t => { if (st) st.textContent = t; };
  const kind = S.importKind, name = f.name.replace(/\.[^.]+$/, '');
  try {
    if (/\.json$/i.test(f.name) || f.type === 'application/json') {
      const data = JSON.parse(await f.text());
      if (data && data.profile && (kind === 'backup' || confirm('Questo è un backup completo: sostituisce tutti i dati attuali. Continuare?'))) { S = migrate(Object.assign(blank(), data)); S.ui.tab = 'oggi'; save(); closeSheet(); render(); toast('Backup importato'); return; }
      if (data && (data.type === 'forma-diet' || (validDiet(data) && kind === 'diet'))) { if (!validDiet(data)) throw new Error('dieta'); S.diet = normDiet(data); S.dietChoice = {}; S.ui.dietVar = null; await idbDel('dietPdf').catch(()=>{}); save(); closeSheet(); S.ui.tab = 'piano'; render(); toast('Dieta importata', S.diet.name); return; }
      if (data && (data.type === 'forma-workout' || (validPlan(data) && kind === 'workout'))) { if (!validPlan(data)) throw new Error('scheda'); S.plan = normPlan(data); S.nextIdx = 0; save(); closeSheet(); S.ui.tab = 'work'; render(); toast('Scheda importata', S.plan.name); return; }
      throw new Error('formato');
    }
    if (kind === 'backup') throw new Error('formato');
    let lines;
    if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
      say('Leggo il PDF…');
      const buf = await f.arrayBuffer();
      S.impPdf = kind === 'diet' ? new Blob([buf], {type:'application/pdf'}) : null;
      lines = await pdfLines(buf.slice(0));
      if (!lines.length) { say('Non trovo testo in questo PDF: probabilmente è una scansione o una foto. Mandalo a Claude nella chat e importa il file che ti prepara.'); return; }
    } else lines = (await f.text()).split(/\r?\n/);
    S.impName = name;
    const markup = kind === 'diet' ? dietMarkupFromLines(lines) : workoutMarkupFromLines(lines);
    openSheet(kind === 'diet' ? 'Controlla la dieta' : 'Controlla la scheda', reviewHtml(kind, markup), () => openImport(kind));
    renderPreview();
  } catch(e) { console.error(e); say('Non riesco a leggere questo file. ' + (e && e.message === 'formato' ? 'Il file .json non è di Forma.' : 'Prova con un altro file o mandalo a Claude nella chat.')); }
}

/* ================= Render ================= */
function render(){
  const view = document.getElementById('view'), tabs = document.getElementById('tabs');
  let tab = S.ui.tab; const first = !S.profile;
  if (first) tab = 'profilo';
  if (tab !== 'profilo') S.pdraft = null;
  view.innerHTML = first ? vProfilo(true) : tab === 'oggi' ? vOggi() : tab === 'piano' ? vPiano() : tab === 'work' ? vWork() : tab === 'prog' ? vProg() : vProfilo(false);
  const noNav = first || tab === 'profilo' || (tab === 'work' && S.ui.editPlan && !S.active);
  tabs.classList.toggle('hidden', noNav); view.classList.toggle('no-nav', noNav);
  tabs.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.t === tab));
  if (tab === 'profilo' || first) renderCalc();
}

/* ================= Azioni ================= */
const A = {
  tab(el){ S.ui.tab = el.dataset.t; S.ui.editPlan = false; save(); render(); window.scrollTo(0,0); },
  setDay(el){ const ds = today(), cur = S.days[ds] || {}; S.days[ds] = {train: el.dataset.v === 'train', time: cur.time || S.profile.defaultTime}; S.ui.pianoType = null; S.ui.dietVar = null; save(); render(); },
  pianoType(el){ S.ui.pianoType = el.dataset.v; render(); },
  dietVar(el){ S.ui.dietVar = +el.dataset.v; render(); },
  swap(el){ const type = S.ui.pianoType || dayType(today()); const c = S.meals[type] || (S.meals[type] = {}); c[el.dataset.s] = (c[el.dataset.s] || 0) + 1; save(); render(); },
  chooseOpen(el){
    const k = el.dataset.k, [vi, mi] = el.dataset.m.split(':').map(Number), m = S.diet.variants[vi].meals[mi], item = m.options[+el.dataset.o].items[+el.dataset.i], cur = (S.dietChoice[k] || 0) % item.choose.length;
    openSheet(item.food, `<p class="note">Scegli un alimento: la quantità è già quella giusta per questo pasto.</p><div class="list">${item.choose.map((c, ci) => `<button class="li btnrow ${ci === cur ? 'sel' : ''}" data-a="choosePick" data-k="${k}" data-v="${ci}" aria-pressed="${ci === cur}"><span>${esc(c.food)}</span><span class="r"><b>${esc(c.qty)}</b></span></button>`).join('')}</div>`);
  },
  choosePick(el){ S.dietChoice[el.dataset.k] = +el.dataset.v; save(); closeSheet(); render(); },
  dietSwap(el){ const k = el.dataset.k; S.dietChoice[k] = ((S.dietChoice[k] || 0) + 1) % (+el.dataset.n); save(); render(); },
  startWork(el){ unlockAudio(); if (S.active && !confirm('C\'è già un allenamento in corso. Vuoi riprenderlo?')) return; if (!S.active) startWorkout(+el.dataset.i); S.ui.tab = 'work'; S.ui.editPlan = false; render(); window.scrollTo(0,0); },
  toggleSet(el){
    unlockAudio();
    const ei = +el.dataset.e, si = +el.dataset.s, e = S.active.ex[ei], l = e.log[si];
    l.done = !l.done; l.pr = null;
    if (l.done && !l.reps) l.reps = autoReps(repsFor(e, si));
    let pr = null;
    if (l.done) { pr = checkPR(ei, si); if (pr) l.pr = pr.text; const nx = e.log[si+1]; if (nx && !nx.done && !nx.kg && l.kg) nx.kg = l.kg; }
    save(); render();
    if (l.done) { startTimer(e.rest); if (pr) { toast(pr.text, e.name + (pr.prev ? ' · ' + pr.prev : '')); tone([660, 880, 1175], .14); sysNotify('Nuovo record! ' + e.name, pr.text); } }
    else { timer = null; tickTimer(); }
  },
  addSet(el){ const e = S.active.ex[+el.dataset.e], last = e.log[e.log.length-1] || {}; e.log.push({kg: last.kg || '', reps: last.reps || '', done:false}); S.active.changed = true; save(); render(); },
  delSet(el){ const e = S.active.ex[+el.dataset.e]; if (e.log.length > 1) { e.log.pop(); S.active.changed = true; save(); render(); } },
  rest(el){ const e = S.active.ex[+el.dataset.e]; e.rest = Math.max(0, Math.min(600, e.rest + (+el.dataset.d))); S.active.changed = true; save(); render(); },
  exMenu(el){
    const ei = +el.dataset.e, e = S.active.ex[ei];
    openSheet(e.name, `<div class="list">
      <button class="li btnrow" data-a="exReplace" data-e="${ei}"><span class="row">${I.swap}Sostituisci con un altro esercizio</span></button>
      ${ei > 0 ? `<button class="li btnrow" data-a="exMove" data-e="${ei}" data-d="-1"><span class="row">${I.up}Sposta più su</span></button>` : ''}
      ${findLib(e.name) ? `<button class="li btnrow" data-a="info" data-n="${esc(e.name)}"><span class="row">${I.info}Come si esegue</span></button>` : ''}
      <button class="li btnrow danger-t" data-a="exDel" data-e="${ei}"><span class="row">${I.trash}Togli dall'allenamento</span></button></div>`);
  },
  exReplace(el){ openPicker('replace', {ei: +el.dataset.e}); },
  exMove(el){ const i = +el.dataset.e, a = S.active.ex; [a[i-1], a[i]] = [a[i], a[i-1]]; S.active.changed = true; closeSheet(); save(); render(); },
  exDel(el){ S.active.ex.splice(+el.dataset.e, 1); S.active.changed = true; closeSheet(); save(); render(); },
  openPicker(el){ openPicker(el.dataset.m, {si: el.dataset.s != null ? +el.dataset.s : null}); },
  pickGroup(el){ S.pick.g = el.dataset.g; document.querySelectorAll('#pickG button').forEach(b => b.classList.toggle('on', b === el)); renderPickList(); },
  pick(el){ applyPick(el.dataset.n); },
  pickCustom(){ applyPick(cap(S.pick.q.trim())); },
  info(el){
    const back = S.pick ? (p => () => { openSheet(p.mode === 'replace' ? 'Sostituisci esercizio' : p.mode === 'browse' ? 'Libreria esercizi' : 'Aggiungi esercizio', pickerHtml()); S.pick = p; const q = document.getElementById('pickQ'); q.value = p.q; document.querySelectorAll('#pickG button').forEach(b => b.classList.toggle('on', b.dataset.g === p.g)); renderPickList(); })(S.pick) : null;
    const pk = S.pick; openSheet(el.dataset.n, libInfoHtml(el.dataset.n), back); S.pick = pk;
  },
  sheetBack(){ if (sheetBack) sheetBack(); },
  closeSheet(){ closeSheet(); },
  finishWork(){
    const a = S.active;
    const doneSets = a.ex.reduce((n, e) => n + e.log.filter(l => l.done).length, 0);
    const prs = []; a.ex.forEach(e => e.log.forEach(l => { if (l.done && l.pr) prs.push(e.name + ': ' + l.pr); }));
    const mins = Math.round((Date.now() - a.start)/60000);
    openSheet('Termina allenamento', `<div class="grid3"><div class="stat"><span class="sub">Durata</span><b>${mins} min</b></div><div class="stat"><span class="sub">Serie</span><b>${doneSets}</b></div><div class="stat"><span class="sub">Record</span><b>${prs.length}</b></div></div>
      ${prs.length ? `<div class="callout green">${prs.map(esc).join('<br>')}</div>` : ''}
      ${a.changed && a.sIdx >= 0 ? `<label class="checkrow"><input type="checkbox" id="updPlan" checked> Aggiorna la scheda «${esc(a.name)}» con le modifiche di oggi (esercizi, serie, recuperi)</label>` : ''}
      ${a.changed && a.sIdx < 0 && a.ex.length ? `<label class="checkrow"><input type="checkbox" id="newSess"> Salva come nuova sessione nella scheda</label>` : ''}
      ${doneSets ? '' : '<p class="note">Non hai completato nessuna serie: l\'allenamento non verrà salvato.</p>'}
      <button class="btn dark full" data-a="confirmFinish">${doneSets ? 'Salva allenamento' : 'Chiudi senza salvare'}</button>
      <button class="btn ghost full" data-a="closeSheet">Continua ad allenarti</button>`);
  },
  confirmFinish(){
    const a = S.active, upd = document.getElementById('updPlan'), ns = document.getElementById('newSess');
    const ex = a.ex.map(e => ({name: e.name, sets: e.log.filter(l => l.done).map(l => ({kg: num(l.kg) || 0, reps: num(l.reps) || 0}))})).filter(e => e.sets.length);
    const prs = []; a.ex.forEach(e => e.log.forEach(l => { if (l.done && l.pr) prs.push({ex: e.name, text: l.pr}); }));
    const structure = a.ex.map(e => e.weeks ? {name: e.name, sets: e.base ? e.base.sets : e.log.length, reps: e.base ? e.base.reps : e.reps, rest: e.rest, note: e.note || '', weeks: e.weeks} : {name: e.name, sets: e.log.length, reps: e.reps, rest: e.rest, note: e.note || ''});
    if (upd && upd.checked) S.plan.sessions[a.sIdx].ex = structure;
    if (ns && ns.checked) S.plan.sessions.push({name: 'Sessione ' + (S.plan.sessions.length + 1), ex: structure});
    if (ex.length) { S.history.push({date: a.date, name: a.name, dur: Math.round((Date.now() - a.start)/60000), ex, prs}); if (a.sIdx >= 0) S.nextIdx = a.sIdx + 1; }
    S.active = null; timer = null; tickTimer(); try { wakeLock && wakeLock.release(); } catch(e){}
    closeSheet(); save(); render(); window.scrollTo(0,0);
    if (ex.length) toast('Allenamento salvato', prs.length ? prs.length + (prs.length === 1 ? ' nuovo record' : ' nuovi record') : '');
  },
  cancelWork(){ if (!confirm('Annullare l\'allenamento? Le serie non verranno salvate.')) return; S.active = null; timer = null; tickTimer(); save(); render(); },
  planWeek(el){ const d = new Date(parseD(S.plan.start || today())); d.setDate(d.getDate() - 7 * (+el.dataset.d)); const w = Math.floor((parseD(today()) - d) / (7*864e5)) + 1; if (w < 1 || w > S.plan.weeks) return; S.plan.start = dstr(d); save(); render(); },
  planRestart(){ S.plan.start = today(); save(); render(); },
  timerAdd(){ if (timer) { timer.end += 15000; tickTimer(); } },
  timerStop(){ timer = null; tickTimer(); },
  editPlan(){ S.draft = clone(S.plan); S.ui.editPlan = true; render(); window.scrollTo(0,0); },
  closeEdit(){ S.ui.editPlan = false; S.draft = null; render(); },
  addEx(el){ S.draft.sessions[+el.dataset.s].ex.push(E('Nuovo esercizio',3,'10',90)); render(); },
  delEx(el){ S.draft.sessions[+el.dataset.s].ex.splice(+el.dataset.e, 1); render(); },
  addSess(){ S.draft.sessions.push({name:'Sessione ' + (S.draft.sessions.length+1), ex:[]}); render(); },
  delSess(el){ if (!confirm('Eliminare questa sessione?')) return; S.draft.sessions.splice(+el.dataset.s, 1); render(); },
  savePlan(){ const mx = Math.max(0, ...S.draft.sessions.flatMap(x => x.ex.map(e => e.weeks ? e.weeks.length : 0))); S.draft.weeks = mx || 0; if (mx && !S.draft.start) S.draft.start = today(); S.draft.sessions.forEach(s => s.ex = s.ex.filter(e => e.name.trim())); S.draft.sessions = S.draft.sessions.filter(s => s.ex.length); if (!S.draft.sessions.length) { alert('La scheda deve avere almeno una sessione con un esercizio.'); return; } S.plan = S.draft; S.plan.name = S.plan.name || 'La mia scheda'; S.draft = null; S.ui.editPlan = false; S.nextIdx = S.nextIdx % S.plan.sessions.length; save(); render(); },
  progTo(el){ S.ui.progTab = el.dataset.v; S.ui.tab = 'prog'; save(); render(); },
  allW(){ S.ui.allW = true; render(); },
  addWeight(){
    const v = num(document.getElementById('wIn').value);
    if (!(v >= 30 && v <= 300)) { alert('Inserisci un peso valido, per esempio 78,4'); return; }
    const d = today(); S.weights = S.weights.filter(x => x.d !== d); S.weights.push({d, kg: Math.round(v*10)/10}); S.weights.sort((a,b) => a.d < b.d ? -1 : 1);
    save(); render();
  },
  delWeight(el){ if (!confirm('Eliminare questa pesata?')) return; S.weights = S.weights.filter(x => x.d !== el.dataset.d); save(); render(); },
  workDetail(el){
    const i = +el.dataset.i, h = S.history[i];
    openSheet(h.name, `<span class="sub">${fdate(h.date, {weekday:'long', day:'numeric', month:'long', year:'numeric'})} · ${h.dur || '–'} min</span>
      ${h.prs && h.prs.length ? `<div class="callout green">${h.prs.map(p => `<b>${esc(p.ex)}</b>: ${esc(p.text)}`).join('<br>')}</div>` : ''}
      ${h.ex.map(e => `<div class="exd"><b>${esc(e.name)}</b><span class="sub">${e.sets.map(s => (s.kg ? fmt1(s.kg) + ' kg × ' : '') + s.reps).join(' · ')}</span></div>`).join('')}
      <button class="btn danger full" data-a="delWork" data-i="${i}">${I.trash}Elimina questo allenamento</button>`);
  },
  delWork(el){ if (!confirm('Eliminare questo allenamento dallo storico?')) return; S.history.splice(+el.dataset.i, 1); closeSheet(); save(); render(); },
  recDetail(el){
    const name = el.dataset.n, k = libKey(name), rows = [];
    S.history.forEach(h => h.ex.forEach(e => { if (libKey(e.name) === k && e.sets.length) { const b = bestsFrom(e.sets); rows.push({d: h.date, b}); } }));
    const pts = rows.filter(r => r.b.e1 > 0);
    let chart = '';
    if (pts.length >= 2) {
      const W = 320, H = 110, mn = Math.min(...pts.map(r => r.b.e1)) * .97, mx = Math.max(...pts.map(r => r.b.e1)) * 1.03;
      const X = i => 8 + (W-16) * i / (pts.length - 1), Y = v => 8 + (H-16) * (1 - (v - mn) / (mx - mn || 1));
      chart = `<h2>Massimale stimato nel tempo</h2><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Andamento del massimale stimato"><polyline points="${pts.map((r, i) => X(i).toFixed(1) + ',' + Y(r.b.e1).toFixed(1)).join(' ')}" fill="none" stroke="var(--green)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>${pts.map((r, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(r.b.e1).toFixed(1)}" r="3" fill="var(--green)"/>`).join('')}</svg>`;
    }
    openSheet(name, libInfoHtml(name).replace(/<h2>Come si esegue[\s\S]*?<\/div>/, '') + chart + `<h2>Sessioni</h2><div class="list">${rows.slice().reverse().map(r => `<div class="li"><span>${fdate(r.d, {day:'numeric', month:'short', year:'2-digit'})}</span><span class="r">${r.b.kg > 0 ? `${fmt1(r.b.kg)} kg × ${r.b.kgReps}` : `${r.b.reps} rip.`}</span></div>`).join('')}</div>
      ${findLib(name) ? `<button class="btn ghost full" data-a="info" data-n="${esc(name)}">${I.info}Come si esegue</button>` : ''}`);
  },
  toggleNotify(el){
    if (S.settings.notify) { S.settings.notify = false; save(); render(); return; }
    if (!('Notification' in window)) { alert('Su questo dispositivo le notifiche funzionano solo con l\'app aggiunta alla schermata Home (iOS 16.4 o successivo). Il messaggio del record dentro l\'app funziona comunque.'); return; }
    Notification.requestPermission().then(p => { S.settings.notify = p === 'granted'; save(); render(); if (p !== 'granted') alert('Permesso non concesso. Puoi attivarlo in Impostazioni › Notifiche › Forma.'); });
  },
  pday(){},
  saveProfile(){
    const d = S.pdraft;
    if (!validProfile(d)) { alert('Controlla data di nascita, altezza in cm e peso in kg.'); return; }
    const np = normProfile(d);
    if (!S.weights.length || S.weights[S.weights.length-1].kg !== np.weight) {
      S.weights = S.weights.filter(x => x.d !== today()); S.weights.push({d: today(), kg: Math.round(np.weight*10)/10}); S.weights.sort((a,b) => a.d < b.d ? -1 : 1);
    }
    S.profile = np; ensurePlan(); S.pdraft = null; S.ui.tab = 'oggi'; save(); render(); window.scrollTo(0,0);
  },
  openImport(el){ openImport(el.dataset.k); },
  pickFile(){ const inp = document.getElementById('importFile'); inp.accept = S.importKind === 'backup' ? 'application/json,.json' : 'application/pdf,.pdf,application/json,.json,text/plain,.txt'; inp.click(); },
  writeMarkup(){
    const kind = S.importKind; S.impName = kind === 'diet' ? (S.diet ? S.diet.name : 'La mia dieta') : 'La mia scheda'; S.impPdf = null;
    const ex = kind === 'diet' ? '# Giorno di allenamento\n## Colazione (7:30)\n- Yogurt greco | 170 g\n- Fiocchi d\'avena | 40 g\noppure\n- Pane integrale | 60 g\n- Uova | 2\n## Pranzo\n- Riso basmati | 90 g\n- Petto di pollo | 150 g\n\n# Giorno di riposo\n## Colazione\n- Yogurt greco | 170 g'
      : '# Giorno A\nPanca piana | 4 x 8 | 120\nRematore con bilanciere | 3 x 10 | 90\n\n# Giorno B\nSquat | 4 x 6-8 | 150';
    openSheet(kind === 'diet' ? 'Scrivi la dieta' : 'Scrivi la scheda', reviewHtml(kind, ex), () => openImport(kind)); renderPreview();
  },
  editDiet(){
    S.importKind = 'diet'; S.impName = S.diet.name; S.impPdf = null; S.keepPdf = true;
    const it = i => '- ' + i.food + (i.qty ? ' | ' + i.qty : '') + (i.choose ? '\n' + i.choose.map(c => '  * ' + c.food + (c.qty ? ' | ' + c.qty : '')).join('\n') : '');
    const opt = (o, oi) => (o.label ? '### ' + o.label + '\n' : (oi ? 'oppure\n' : '')) + o.items.map(it).join('\n');
    const mk = S.diet.variants.map(v => '# ' + v.label + '\n' + v.meals.map(m => '## ' + m.name + (m.time ? ' (' + m.time + ')' : '') + '\n' + m.options.map(opt).join('\n') + (m.today ? '\n' + Object.entries(m.today).map(([k, t]) => '@' + k + ': ' + t).join('\n') : '') + (m.notes.length ? '\n' + m.notes.map(n => '> ' + n).join('\n') : '')).join('\n')).join('\n\n') + (S.diet.notes.length ? '\n\n' + S.diet.notes.map(n => '> ' + n).join('\n') : '');
    openSheet('Correggi la dieta', reviewHtml('diet', mk)); renderPreview();
  },
  async confirmImport(){
    const ta = document.getElementById('mk'), nm = (document.getElementById('mkName').value || '').trim();
    if (S.importKind === 'diet') {
      const d = parseDietMarkup(ta.value); if (!d.variants.length) { alert('Nessun pasto riconosciuto.'); return; }
      S.diet = normDiet({name: nm || 'La mia dieta', variants: d.variants, notes: d.notes}); S.dietChoice = {}; S.ui.dietVar = null;
      if (S.impPdf) await idbPut('dietPdf', S.impPdf).catch(()=>{}); else if (!S.keepPdf) await idbDel('dietPdf').catch(()=>{});
      S.keepPdf = false; S.impPdf = null; save(); closeSheet(); S.ui.tab = 'piano'; render(); window.scrollTo(0,0); toast('Dieta salvata', S.diet.name);
    } else {
      const s = parseWorkoutMarkup(ta.value); if (!s.length) { alert('Nessun esercizio riconosciuto.'); return; }
      S.plan = normPlan({name: nm || 'La mia scheda', sessions: s}); S.nextIdx = 0; save(); closeSheet(); S.ui.tab = 'work'; S.ui.editPlan = false; render(); window.scrollTo(0,0); toast('Scheda salvata', S.plan.name);
    }
  },
  removeDiet(){ if (!confirm('Rimuovere la dieta importata? Torni al piano calcolato da Forma.')) return; S.diet = null; S.dietChoice = {}; idbDel('dietPdf').catch(()=>{}); save(); S.pdraft = null; render(); },
  async viewPdf(){
    const blob = await idbGet('dietPdf').catch(() => null);
    if (!blob) { alert('Il PDF originale non è salvato (la dieta è stata importata da file o scritta a mano).'); return; }
    openSheet('PDF della dieta', '<p class="note" id="pdfSt">Carico il PDF…</p><div id="pdfPages" class="pdfpages"></div>');
    try {
      const lib = await loadPdfJs(), doc = await lib.getDocument({data: await blob.arrayBuffer()}).promise, box = document.getElementById('pdfPages');
      const w = Math.min(box.clientWidth || 340, 900), dpr = Math.min(window.devicePixelRatio || 1, 2);
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p), vp0 = page.getViewport({scale:1}), vp = page.getViewport({scale: w / vp0.width * dpr});
        const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height; c.style.width = '100%';
        box.appendChild(c); await page.render({canvasContext: c.getContext('2d'), viewport: vp}).promise;
      }
      document.getElementById('pdfSt').remove();
    } catch(e) { const s = document.getElementById('pdfSt'); if (s) s.textContent = 'Non riesco a mostrare il PDF.'; }
  },
  export(){
    const {draft, pdraft, pick, impPdf, ...data} = S;
    const blob = new Blob([JSON.stringify(data, null, 1)], {type:'application/json'});
    const name = 'forma-backup-' + today() + '.json', file = new File([blob], name, {type:'application/json'});
    if (navigator.canShare && navigator.canShare({files:[file]})) { navigator.share({files:[file], title:'Backup Forma'}).catch(()=>{}); return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },
  reset(){ if (!confirm('Cancellare profilo, pesate, allenamenti, dieta e scheda da questo iPhone?')) return; localStorage.removeItem(KEY); idbDel('dietPdf').catch(()=>{}); S = blank(); render(); }
};

document.addEventListener('click', ev => {
  const el = ev.target.closest('[data-a]'); if (!el) return;
  const f = A[el.dataset.a]; if (f) { ev.preventDefault(); f(el); }
});
document.addEventListener('input', ev => {
  const el = ev.target, c = el.dataset.c; if (!c) return;
  if (c === 'p') { S.pdraft[el.dataset.k] = el.value; renderCalc(); return; }
  if (c === 'kg' || c === 'reps') { S.active.ex[+el.dataset.e].log[+el.dataset.s][c] = el.value; save(); return; }
  if (c === 'pickQ') { S.pick.q = el.value; renderPickList(); return; }
  if (c === 'mk') { renderPreview(); return; }
  if (c === 'pname') { S.draft.name = el.value; return; }
  const s = S.draft && S.draft.sessions[+el.dataset.s]; if (!s) return;
  if (c === 'sname') s.name = el.value;
  if (c === 'ename') s.ex[+el.dataset.e].name = el.value;
  if (c === 'esets') s.ex[+el.dataset.e].sets = Math.max(1, Math.min(12, parseInt(el.value) || 1));
  if (c === 'ereps') s.ex[+el.dataset.e].reps = el.value;
  if (c === 'enote') s.ex[+el.dataset.e].note = el.value;
  if (c === 'eprog') { const w = el.value.split(/[,;]/).map(x => x.trim().match(/^(\d+)\s*[x×]\s*(.+)$/i)).filter(Boolean).map(m => ({sets: +m[1], reps: m[2].trim()})); s.ex[+el.dataset.e].weeks = w.length ? w : null; }
  if (c === 'erest') s.ex[+el.dataset.e].rest = Math.max(0, Math.min(600, parseInt(el.value) || 0));
});
document.addEventListener('change', ev => {
  const el = ev.target;
  if (el.dataset.c === 'p') { S.pdraft[el.dataset.k] = el.value; renderCalc(); }
  if (el.dataset.c === 'preset' && el.value) { S.draft = clone(PLANS[el.value]); render(); }
  if (el.dataset.c === 'dayTime' && el.value) { const ds = today(); S.days[ds] = {train: true, time: el.value}; save(); render(); }
});
document.getElementById('importFile').addEventListener('change', ev => { const f = ev.target.files[0]; ev.target.value = ''; if (f) handleFile(f); });
document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && !document.getElementById('sheet').classList.contains('hidden')) closeSheet(); });

if (S.active) keepAwake();
render();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(()=>{});
