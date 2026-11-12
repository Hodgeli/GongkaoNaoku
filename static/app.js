/* 考公脑库 · 间隔重复学习系统 - 前端 SPA (vanilla) */

/* ---------- 版本自愈 ----------
   旧版页面被浏览器 / CDN 边缘节点用 max-age=86400 强缓存，导致"改了代码但打开还是旧界面"。
   这里让脚本核对页面里的版本标记：不一致就一次性跳到带版本号的新地址，
   绕过浏览器与边缘节点的两层缓存。kg_healed 防止极端情况下死循环。
   版本号取自本脚本自己的 src（服务端按 app.js/style.css 指纹注入），无需手改。 */
const APP_VER = (function () {
  try {
    const s = document.currentScript || document.querySelector('script[src*="/static/app.js"]');
    const m = s && s.src ? s.src.match(/[?&]v=([^&#]+)/) : null;
    if (m) return decodeURIComponent(m[1]);
  } catch (e) { }
  return '20261023a';
})();
let HEALING = false;
(function selfHeal() {
  try {
    const meta = document.querySelector('meta[name="kg-app-ver"]');
    if ((meta && meta.getAttribute('content')) === APP_VER) return;
    if (sessionStorage.getItem('kg_healed') === APP_VER) return;
    sessionStorage.setItem('kg_healed', APP_VER);
    HEALING = true;
    location.replace('/index.html?v=' + APP_VER + (location.hash || ''));
  } catch (e) { }
})();

/* 注册 Service Worker：让页面导航与 js/css 一律重新校验网络，
   彻底摆脱本机 HTTP 缓存里的旧版本（仅 https 下生效，失败不影响正常使用）。 */
(function regSW() {
  try {
    if (!('serviceWorker' in navigator) || location.protocol !== 'https:') return;
    navigator.serviceWorker.register('/sw.js').catch(() => { });
  } catch (e) { }
})();

/* ---------- 账号：用户名 + 密码登录，token 鉴权（服务端按账号隔离数据） ---------- */
let TOKEN = '';
let ME = null;   // 当前登录账号 {id,name,username}
try { TOKEN = localStorage.getItem('kg_token') || ''; } catch (e) { }
function tok() { return TOKEN || ''; }
function setTok(t) {
  TOKEN = t || '';
  try { if (t) localStorage.setItem('kg_token', t); else localStorage.removeItem('kg_token'); } catch (e) { }
}
/* 令牌只走请求头，不再拼进 URL 或 body：
   URL 会留在浏览器历史、代理/服务器访问日志、以及跨站请求的 Referer 里，
   等于把登录凭证写进日志。服务端仍兼容旧的 ?token= / body.token，仅作过渡。 */
function authHeaders(extra) {
  const h = Object.assign({}, extra || {});
  const t = tok();
  if (t) h['Authorization'] = 'Bearer ' + t;
  return h;
}
function withU(p) { return p; }

/* 统一的失败语义：接口不通就抛异常，交给 nav() 的 catch 显示"重试"。
   以前这里返回 {}，调用方直接取字段就抛 TypeError，而异常没人接，
   页面永远停在"加载中…"——这正是线上偶发空白的真实原因。 */
class ApiError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}
async function API(p) {
  netBegin();
  try {
    let r;
    try { r = await fetch(p, { headers: authHeaders() }); }
    catch (e) { throw new ApiError('网络连接失败，请检查网络后重试', 0); }
    if (r.status === 401) { onExpired(); throw new ApiError('登录已失效', 401); }
    if (!r.ok) throw new ApiError('服务器返回 ' + r.status + '，请稍后重试', r.status);
    try { return await r.json(); }
    catch (e) { throw new ApiError('服务器返回数据异常，请重试', r.status); }
  } finally { netEnd(); }
}
async function POST(p, b) {
  netBegin();
  try {
    let r;
    try {
      r = await fetch(p, {
        method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(b || {}),
      });
    } catch (e) { throw new ApiError('网络连接失败，请检查网络后重试', 0); }
    if (r.status === 401) { onExpired(); throw new ApiError('登录已失效', 401); }
    if (!r.ok) throw new ApiError('服务器返回 ' + r.status + '，请稍后重试', r.status);
    try { return await r.json(); }
    catch (e) { throw new ApiError('服务器返回数据异常，请重试', r.status); }
  } finally { netEnd(); }
}
function onExpired() { setTok(''); showLogin('登录已失效，请重新登录'); }
const esc = (s) => (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const app = document.getElementById('app');
let BOOT = null;

const state = { session: null, exam: null, papers: null };

/* ---------- 功能2：限时模式配置 ---------- */
const LIMIT_DEFAULT = {
  '言语理解与表达': 45, '判断推理': 40, '数量关系': 90,
  '资料分析': 60, '常识判断': 30, '政治理论': 45,
};
function loadLimits() {
  try { return Object.assign({}, LIMIT_DEFAULT, JSON.parse(localStorage.getItem('kg_limits') || '{}')); }
  catch (e) { return Object.assign({}, LIMIT_DEFAULT); }
}
function saveLimits(o) { try { localStorage.setItem('kg_limits', JSON.stringify(o)); } catch (e) { } }
let LIMIT_ON = false;
try { LIMIT_ON = localStorage.getItem('kg_limit_on') === '1'; } catch (e) { }

/* ---------- 功能4：搜索历史（最近 5 条） ---------- */
function loadSearchHist() {
  try { const a = JSON.parse(localStorage.getItem('kg_search_hist') || '[]'); return Array.isArray(a) ? a.slice(0, 5) : []; }
  catch (e) { return []; }
}
function pushSearchHist(kw) {
  try {
    const a = loadSearchHist().filter(x => x !== kw); a.unshift(kw);
    localStorage.setItem('kg_search_hist', JSON.stringify(a.slice(0, 5)));
  } catch (e) { }
}

/* ---------- 功能5：下载 Markdown ---------- */
function downloadMd(filename, text) {
  const blob = new Blob([text || ''], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

const MODE_LABEL = { new: '新题', mix: '智能复习', review: '复习', wrong: '错题重练', wrongredo: '错题重练', fav: '收藏练习', material: '材料组题' };

/* due 有两种格式：长间隔是「2026-11-13」，学习步是「2026-11-12T16:03:00」。
   直接字符串比较会漏判（'...T16:03' <= '2026-11-12' 为假），所以统一先截到日期再比。 */
function isDue(d) { return !!d && String(d).slice(0, 10) <= BOOT.today; }
function fmtDue(d) {
  if (!d) return '—';
  const s = String(d);
  return s.length > 10 ? s.slice(0, 10) + ' ' + s.slice(11, 16) : s;
}
const GRADE_LABEL = { 1: '忘记', 3: '困难', 4: '一般', 5: '熟悉' };

/* ---------- 练习 session 本地快照（继续上次刷题） ---------- */
const SS_KEY = 'kg_session_v1';
function saveSession() {
  try {
    const S = state.session; if (!S || !S.queue || !S.queue.length) return;
    localStorage.setItem(SS_KEY, JSON.stringify({
      mode: S.mode, cfg: S.cfg, queue: S.queue, idx: S.idx,
      tally: S.tally, marked: Array.from(S.marked || []),
      kind: 'study', savedAt: Date.now(),
    }));
  } catch (e) { /* localStorage 不可用（隐私模式等）时静默降级 */ }
}
function loadSession() {
  try {
    const s = localStorage.getItem(SS_KEY); if (!s) return null;
    const o = JSON.parse(s);
    if (!o || o.kind !== 'study' || !o.queue || !o.queue.length) return null;
    if (o.idx >= o.queue.length) return null; // 已全部做完
    return o;
  } catch (e) { return null; }
}
function loadSeen() {
  try { const a = JSON.parse(localStorage.getItem('kg_seen') || '[]'); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}
function addSeen(qids) {
  try {
    const s = new Set(loadSeen());
    qids.forEach(q => s.add(String(q)));
    localStorage.setItem('kg_seen', JSON.stringify(Array.from(s).slice(-800))); // 仅保留近期 800 个
  } catch (e) { /* 隐私模式降级 */ }
}

/* 只有「会抽新题」的池才需要跨次去重（避免反复做同一批新题）。
   复习到期/错题重练/收藏练习的题本来就是你练过的题，一旦套上去重就会永远为空 ——
   这正是「总览显示今日待复习 3 道、点进复习到期却是 0 道」的根因。 */
const EXCL_MODES = new Set(['new', 'study', 'mix']);
const needExcl = mode => EXCL_MODES.has(mode);

function clearSession() { try { localStorage.removeItem(SS_KEY); } catch (e) { } }
function resumeSession() {
  const o = loadSession();
  if (!o) { clearSession(); return; }
  // 修复「继续上次刷题」按了没反应：恢复路径必须补齐 session 全部字段，
  // 否则 renderCard 里 S.marked.has() / S.times.push() 抛 TypeError，页面停在原地。
  state.session = {
    mode: o.mode, cfg: o.cfg || {}, queue: o.queue, idx: o.idx,
    phase: 'question', chosen: null, full: null,
    tally: o.tally || { done: 0, right: 0, wrong: 0 },
    marked: new Set(o.marked || []),
    limitOn: !!(o.cfg && o.cfg.limitOn),
    limits: (o.cfg && o.cfg.limits) || loadLimits(),
    ids: (o.cfg && o.cfg.ids) || null,
    startTs: Date.now(), times: [], timeoutN: 0, qStart: Date.now(),
  };
  try {
    renderCard();
  } catch (e) {
    // 快照损坏 / 结构不兼容：清理后回总览，保证按钮永远不会「没反应」
    console.error('恢复练习失败，已清理本地快照', e);
    state.session = null;
    clearSession();
    try { viewDashboard(); } catch (e2) { location.hash = '#/'; }
  }
}
function resumeAgo(ts) {
  if (!ts) return '—';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return '刚刚';
  if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前';
  if (sec < 86400) return Math.floor(sec / 3600) + ' 小时前';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------- router ---------- */
/* 任何视图抛错都不能让页面停在"加载中…"：统一兜住并给重试入口。 */
async function nav() {
  clearNextBar();
  abandonExam();   // 离开模考页就停表：否则后台到点会自动交卷，把当前页面整个覆盖掉
  try {
    return await route();
  } catch (e) {
    if (e && e.status === 401) return;          // 已跳登录，无需重复提示
    console.error('[nav]', e);
    fatal((e && e.message) || e);
  }
}
function route() {
  const h = (location.hash || '#/').split('?')[0];
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.getAttribute('href').split('?')[0] === h));
  if (h === '#/') return viewDashboard();
  if (h === '#/study') return viewStudy();
  if (h === '#/review') return startSession({ mode: 'review' });
  if (h === '#/browse') return viewBrowse();
  if (h === '#/kadian') return viewKadian();
  if (h === '#/wrongbook') return viewWrongbook();
  if (h === '#/favorites') return viewFavorites();
  if (h === '#/exam') return viewExam();
  if (h === '#/materials') return viewMaterials();
  if (h === '#/search') return viewSearch();
  if (h === '#/doubts') return viewDoubts();
  if (h === '#/stats') return viewStats();
  if (h === '#/settings') return viewSettings();
  if (h === '#/detail') return viewDetail(+new URLSearchParams(location.hash.split('?')[1]).get('id'));
  viewDashboard();
}
window.addEventListener('hashchange', () => { nav(); });

/* ---------- side stats ---------- */
/* pre：调用方已经拿到的 /api/stats 结果，直接复用，避免同一屏请求两次 */
async function refreshSide(pre) {
  try {
    const s = pre || await API('/api/stats');
    document.getElementById('side-stats').innerHTML = `
      <div class="stat-chip" title="学习步里的题会在 1~10 分钟后自己回来，不计入当前待复习">
        <span>待复习</span><b style="color:var(--warn)">${s.due_review}</b>
        ${s.due_soon ? `<i style="font-style:normal;font-size:11px;color:var(--ink-3);margin-left:4px">+${s.due_soon}</i>` : ''}</div>
      <div class="stat-chip"><span>未学新题</span><b style="color:var(--brand)">${s.new}</b></div>
      <div class="stat-chip"><span>已学</span><b>${s.learned}</b></div>
      <div class="stat-chip"><span>今日已练</span><b style="color:var(--ok)">${s.studied_today}</b></div>
      <div class="stat-chip"><span>错题本</span><b style="color:var(--bad)">${s.wrong}</b></div>
      <div class="stat-chip"><span>收藏</span><b style="color:var(--purple)">${s.fav}</b></div>`;
    return s;
  } catch (e) { return null; }
}

/* 评分、收藏这类高频操作会连续触发侧栏刷新，每题都打一遍 /api/stats 太浪费
   （它要跑七条聚合查询）。这里做 700ms 合并 + 单飞，最后一次操作结束后补刷一次。 */
let SIDE_T = null, SIDE_BUSY = false, SIDE_DIRTY = false;
function scheduleSide(delay) {
  SIDE_DIRTY = true;
  clearTimeout(SIDE_T);
  SIDE_T = setTimeout(runSide, delay == null ? 700 : delay);
}
async function runSide() {
  if (SIDE_BUSY || !SIDE_DIRTY) return;
  SIDE_DIRTY = false; SIDE_BUSY = true;
  try { await refreshSide(); }
  finally {
    SIDE_BUSY = false;
    if (SIDE_DIRTY) scheduleSide(250);
  }
}

/* 离开模考（路由切换）时清理计时器与状态。
   模考的 timer 是挂在 state.exam 上的 setInterval，不随 DOM 重建消失；
   以前切到别的页面后到点仍会触发 examSubmit，把当前页面替换成交卷结果。 */
function abandonExam() {
  const E = state.exam;
  if (!E) return;
  if (E.timer) { clearInterval(E.timer); E.timer = null; }
  state.exam = null;   // 已交卷的也清掉：否则在别的页面按 ←/→ 还会被 examGoto 抢走视图
}

function loading(t) { loadingView(t); }
function fatal(e) { app.innerHTML = `<div class="card" style="border-color:var(--bad)">出错了：${esc(String(e))}
  <div class="row" style="margin-top:14px"><button class="btn ghost" onclick="location.reload()">重试</button></div></div>`; }

/* ---------- 统一的加载反馈 ----------
   Pi 上单个接口可能要几百毫秒到数秒。任何一次点击都必须在 100ms 内出现可见变化，
   否则用户无法判断"是不是点上了"。这里提供四档反馈，按操作阻塞程度选用：
   1) netBegin/netEnd —— 顶部细进度条（所有 api 请求自动触发，静默兜底）
   2) loadingView      —— 整页骨架（切换视图）
   3) showMask         —— 半透明遮罩 + 转圈（阻塞式操作：取下一组题、交卷）
   4) busyBtn          —— 按钮内联转圈 + 禁用（局部操作：评分、收藏、保存）
   失败一律 toast 出来，不再静默吞掉（静默失败＝用户以为成功，数据却丢了）。 */
let NET_DEPTH = 0, NET_TIMER = null, NET_LABEL = '';
function netBarEl() {
  let b = document.getElementById('netbar');
  if (!b) {
    b = document.createElement('div');
    b.id = 'netbar';
    b.innerHTML = '<i></i><span class="netbar-txt"></span>';
    document.body.appendChild(b);
  }
  return b;
}
function netBegin(label) {
  NET_DEPTH++;
  if (label) NET_LABEL = label;
  if (NET_DEPTH === 1) {
    clearTimeout(NET_TIMER);
    NET_TIMER = setTimeout(() => {
      const b = netBarEl(); b.classList.add('on');
      const t = b.querySelector('.netbar-txt');
      if (t && NET_LABEL) { t.textContent = NET_LABEL; t.classList.add('on'); }
    }, 140);
  }
}
function netEnd() {
  NET_DEPTH = Math.max(0, NET_DEPTH - 1);
  if (NET_DEPTH > 0) return;
  clearTimeout(NET_TIMER); NET_TIMER = null;
  const b = document.getElementById('netbar');
  if (b) { b.classList.remove('on'); const t = b.querySelector('.netbar-txt'); if (t) t.classList.remove('on'); }
  NET_LABEL = '';
}

let LOADING_TIMER = null;
function loadingView(t) {
  const t0 = Date.now();
  clearInterval(LOADING_TIMER);
  app.innerHTML = `<div class="loading"><div class="spinner"></div>
    <div class="loading-txt">${esc(t || '加载中…')}</div>
    <div class="loading-sub" id="loading-sub"></div></div>`;
  LOADING_TIMER = setInterval(() => {
    const sub = document.getElementById('loading-sub');
    if (!sub) { clearInterval(LOADING_TIMER); return; }
    const sec = Math.floor((Date.now() - t0) / 1000);
    if (sec >= 2) sub.textContent = `已等待 ${sec} 秒，设备正在处理，请不要重复点击`;
  }, 1000);
}

let MASK_N = 0;
function showMask(text) {
  MASK_N++;
  let m = document.getElementById('kg-mask');
  if (!m) {
    m = document.createElement('div');
    m.id = 'kg-mask'; m.className = 'kg-mask';
    m.innerHTML = '<div class="kg-mask-box"><div class="spinner"></div><div class="kg-mask-txt"></div><div class="kg-mask-sub">请稍候，不要重复点击</div></div>';
    document.body.appendChild(m);
  }
  m.querySelector('.kg-mask-txt').textContent = text || '正在处理…';
  m.querySelector('.kg-mask-sub').textContent = '请稍候，不要重复点击';
  m.classList.add('on');
  clearTimeout(m._slow);
  m._slow = setTimeout(() => {
    const s = m.querySelector('.kg-mask-sub');
    if (s) s.textContent = '设备响应较慢，仍在处理，请不要刷新页面';
  }, 3000);
  return hideMask;
}
function hideMask() {
  MASK_N = Math.max(0, MASK_N - 1);
  if (MASK_N > 0) return;
  const m = document.getElementById('kg-mask');
  if (!m) return;
  clearTimeout(m._slow); m.classList.remove('on');
}

function busyBtn(btn, label) {
  if (!btn) return () => { };
  const html = btn.innerHTML, dis = btn.disabled;
  btn.disabled = true; btn.classList.add('busy');
  btn.innerHTML = `<span class="spinner sm"></span><span>${esc(label || '处理中…')}</span>`;
  return () => { btn.innerHTML = html; btn.disabled = dis; btn.classList.remove('busy'); };
}

function toast(msg, kind, act) {
  let box = document.getElementById('toast-box');
  if (!box) { box = document.createElement('div'); box.id = 'toast-box'; document.body.appendChild(box); }
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  const txt = document.createElement('span');
  txt.textContent = msg;                 // 用 textContent 而不是 innerHTML：提示文案里可能有用户内容
  el.appendChild(txt);
  let timer = null;
  const close = () => { if (timer) clearTimeout(timer); el.classList.add('out'); setTimeout(() => el.remove(), 300); };
  if (act && act.label) {
    const b = document.createElement('button');
    b.className = 't-act';
    b.type = 'button';
    b.textContent = act.label;
    b.onclick = () => { close(); try { act.onClick && act.onClick(); } catch (e) { console.error(e); } };
    el.appendChild(b);
  }
  box.appendChild(el);
  timer = setTimeout(close, (act && act.ttl) || (kind === 'bad' ? 4500 : 2600));
}

/* 题干/材料里的 <img> 由后端直接下发 HTML，本身没有 loading 属性：
   一道资料分析题可能带几十张公式图，不懒加载就会在进题瞬间全部请求。 */
function lazyImgs(root) {
  const box = root || app;
  if (!box || !box.querySelectorAll) return;
  box.querySelectorAll('img').forEach(img => {
    if (!img.getAttribute('loading')) img.setAttribute('loading', 'lazy');
    if (!img.getAttribute('decoding')) img.setAttribute('decoding', 'async');
  });
}

/* 兜底：任何没被 catch 的请求异常都要让人看见，而不是只在控制台里 */
window.addEventListener('unhandledrejection', (e) => {
  const r = e && e.reason;
  if (r && r.status === 401) return;
  console.error('[unhandled]', r);
  toast(r instanceof ApiError ? r.message : ('操作没有完成：' + ((r && r.message) || r)), 'bad');
});
window.addEventListener('offline', () => toast('网络已断开，暂时无法保存，恢复后请重试', 'bad'));
window.addEventListener('online', () => toast('网络已恢复'));

/* 选项区「正在调取解析」提示：点到选项后 0 毫秒就有反馈，并显示已等待秒数 */
let OPT_SLOW = null;
function optionBusy(label) {
  const box = document.getElementById('opts'); if (!box) return;
  const S = state.session;
  box.querySelectorAll('.opt').forEach(el => {
    el.classList.add('pending');
    if (S && S.chosen && el.dataset.key === S.chosen) el.classList.add('sel');
  });
  if (document.getElementById('opt-loading')) return;
  box.insertAdjacentHTML('beforeend',
    `<div class="opt-loading" id="opt-loading"><span class="spinner sm"></span><span id="opt-loading-txt">${esc(label || '正在调取本题解析…')}</span></div>`);
  const t0 = Date.now();
  clearInterval(OPT_SLOW);
  OPT_SLOW = setInterval(() => {
    const t = document.getElementById('opt-loading-txt');
    if (!t) { clearInterval(OPT_SLOW); OPT_SLOW = null; return; }
    const sec = Math.floor((Date.now() - t0) / 1000);
    if (sec >= 8) t.textContent = `题库响应较慢，已等待 ${sec} 秒，仍在加载，请勿刷新`;
    else if (sec >= 1) t.textContent = `正在调取本题解析…已等待 ${sec} 秒`;
  }, 500);
}
function optionBusyEnd() {
  clearInterval(OPT_SLOW); OPT_SLOW = null;
  const box = document.getElementById('opts'); if (!box) return;
  const ld = box.querySelector('.opt-loading'); if (ld) ld.remove();
  box.querySelectorAll('.opt').forEach(el => el.classList.remove('pending', 'sel'));
}

/* ---------- dashboard ---------- */
async function viewDashboard() {
  loading();
  const s = await API('/api/stats');
  await refreshSide(s);   // 复用上面这次结果，不再重复请求 /api/stats
  const resumeBtn = (() => {
    try {
      const o = loadSession();
      if (!o || o.idx >= o.queue.length) return '';
      const left = o.queue.length - o.idx;
      const label = MODE_LABEL[o.mode] || '练习';
      const t = resumeAgo(o.savedAt);
      return `<a class="btn big resume" href="#" onclick="try{resumeSession()}catch(e){console.error(e)};return false;">⏯ 继续上次刷题（${label} · 剩 ${left} 题）· 上次 ${t}</a>`;
    } catch (e) { return ''; }
  })();
  const dueMod = {}; (s.due_by_module || []).forEach(d => dueMod[d.m] = d.n);
  const mastery = s.mastery || {}; const mkeys = ['学习中', '初记', '短期', '长期', '稳固'];
  const maxM = Math.max(1, ...mkeys.map(k => mastery[k] || 0));
  app.innerHTML = `
  <h1>总览面板</h1><p class="sub">共 ${BOOT.total.toLocaleString()} 道行测真题 · 逐题深度标注 · 按记忆曲线安排复习</p>
  <div class="grid g4">
    <div class="card kpi warn"><div class="n">${s.due_review}</div><div class="l">🔔 今日待复习</div>
      ${s.due_soon ? `<div class="sub" style="margin-top:6px">另有 ${s.due_soon} 道 30 分钟内到期</div>` : ''}</div>
    <div class="card kpi brand"><div class="n">${s.new.toLocaleString()}</div><div class="l">✨ 未学新题</div></div>
    <div class="card kpi ok"><div class="n">${s.studied_today}</div><div class="l">✅ 今日已练习</div></div>
    <div class="card kpi purple"><div class="n">${s.learned.toLocaleString()}</div><div class="l">📈 已纳入复习</div></div>
  </div>
  <div class="grid g4" style="margin-top:16px">
    <a class="card kpi" href="#/wrongbook" style="text-decoration:none"><div class="n" style="color:var(--bad)">${s.wrong}</div><div class="l">📕 错题本</div></a>
    <a class="card kpi" href="#/favorites" style="text-decoration:none"><div class="n" style="color:var(--purple)">${s.fav}</div><div class="l">⭐ 我的收藏</div></a>
    <a class="card kpi" href="#/exam" style="text-decoration:none"><div class="n" style="color:var(--brand)">📝</div><div class="l">模拟考试</div></a>
    <a class="card kpi" href="#/stats" style="text-decoration:none"><div class="n" style="color:var(--warn)">📊</div><div class="l">数据统计</div></a>
  </div>
  <div class="center" style="padding:24px">
    ${resumeBtn}
    <div class="row">
      <a class="btn big ok" href="#/review">开始复习到期 (${s.due_review})</a>
      <a class="btn big" href="#/study">练习新题</a>
      <a class="btn big ghost" href="#/browse">浏览真题库</a>
      <a class="btn big ghost" href="#/kadian">考点导航</a>
      <a class="btn big ghost" href="#/materials">材料组题</a>
      <a class="btn big ghost" href="#/doubts">疑点复核</a>
    </div>
    <div class="sub" style="margin-top:12px">
      今日新题 <b>${s.today_new}</b>/${s.limit_new || '不限'} · 今日复习 <b>${s.today_review}</b>/${s.limit_review || '不限'}
      <a href="#/settings" style="margin-left:6px">调整上限</a>
    </div>
  </div>
  <h2>各模块进度</h2>
  <div class="grid g2">
    ${s.by_module.map(m => {
      const pct = Math.round(m.learned / m.total * 100);
      return `<div class="card"><div class="row" style="justify-content:space-between">
        <b>${esc(m.m)}</b><span class="tag">已学 ${m.learned}/${m.total} (${pct}%)</span></div>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div class="sub" style="margin:8px 0 0">今日待复习：${dueMod[m.m] || 0}</div>
        <div class="row" style="margin-top:12px">
          <a class="btn ghost" href="#/study?module=${encodeURIComponent(m.m)}">练习该模块</a></div>
      </div>`;
    }).join('')}
  </div>
  <h2>掌握度分布（按复习间隔）</h2>
  <div class="card">
    ${mkeys.map(k => `<div class="row" style="justify-content:space-between;margin:6px 0">
      <span>${k}</span><span><b>${(mastery[k] || 0).toLocaleString()}</b>
      <span style="display:inline-block;vertical-align:middle;width:180px;height:8px;background:var(--panel2);border-radius:9px;margin-left:10px">
      <span style="display:block;height:100%;width:${(mastery[k] || 0) / maxM * 100}%;background:linear-gradient(90deg,var(--brand),var(--purple));border-radius:9px"></span></span></span>
    </div>`).join('')}
  </div>
  <div class="footer">FSRS-5 间隔重复 · 忘记/困难/一般/熟悉 四档自评 · 图片全程离线</div>`;
}

/* ---------- study setup ---------- */
function viewStudy() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const msel = q.get('module') || '';
  const csel = q.get('category') || '';
  const ksel = q.get('kadian') || '';
  const cats = BOOT.categories.filter(c => !msel || c.module === msel);
  app.innerHTML = `
  <h1>练习新题</h1><p class="sub">选择范围后开始，系统按记忆曲线自动排入复习计划</p>
  ${ksel ? `<div class="askmodel" style="margin-bottom:14px">🎯 锁定考点：<b>${esc(ksel.split('/').pop())}</b> · <a class="linkback" href="#/study">清除筛选</a></div>` : ''}
  <div class="card" style="max-width:640px">
    <div class="filters">
      <label class="fld">模块<select id="s-mod">
        <option value="">全部</option>
        ${BOOT.modules.map(m => `<option ${m.module === msel ? 'selected' : ''} value="${esc(m.module)}">${esc(m.module)} (${m.n})</option>`).join('')}
      </select></label>
      <label class="fld">大类<select id="s-cat"><option value="">全部大类</option>
        ${cats.map(c => `<option ${c.category === csel ? 'selected' : ''} value="${esc(c.category)}">${esc(c.category)} (${c.n})</option>`).join('')}
      </select></label>
      <label class="fld">考点关键字<input id="s-kd" placeholder="如 增长率 / 图形推理" size="18" value="${esc(ksel)}"></label>
    </div>
    <div class="row"><button class="btn big ok" id="s-go">开始练习 →</button></div>
    <p class="sub" style="margin:14px 0 0">提示：新题会先以「点击作答→自评」方式学习，答错/忘记的题目会更频繁地回来。作答后可收藏、写笔记。</p>
  </div>
  <div class="card" style="max-width:640px;margin-top:16px">
    <h2 style="margin-top:0">⏱ 单题限时训练（可选）</h2>
    <div class="row" style="justify-content:space-between;margin-bottom:10px">
      <span>开启后每题倒计时，超时自动记为「超时答错」并进入错题本</span>
      <label class="switch"><input type="checkbox" id="s-limit" ${LIMIT_ON ? 'checked' : ''}><span class="slider"></span></label>
    </div>
    <div id="s-limit-box" style="${LIMIT_ON ? '' : 'display:none'}">
      <div class="grid g3">
        ${Object.entries(loadLimits()).map(([m, sec]) => `<label class="fld">${esc(m)}<input type="number" min="5" max="600" value="${sec}" data-mod="${esc(m)}" class="s-lim"></label>`).join('')}
      </div>
      <p class="sub" style="margin:10px 0 0">单位：秒。建议：言语45 / 判断40 / 数量90 / 资料60 / 常识30。</p>
    </div>
  </div>`;
  const modSel = document.getElementById('s-mod');
  modSel.onchange = () => {
    const c = document.getElementById('s-cat'); const mv = modSel.value;
    c.innerHTML = '<option value="">全部大类</option>' + BOOT.categories.filter(x => !mv || x.module === mv)
      .map(x => `<option value="${esc(x.category)}">${esc(x.category)} (${x.n})</option>`).join('');
  };
  const sLimit = document.getElementById('s-limit');
  if (sLimit) sLimit.onchange = () => {
    const box = document.getElementById('s-limit-box');
    if (box) box.style.display = sLimit.checked ? '' : 'none';
  };
  document.getElementById('s-go').onclick = () => {
    const on = sLimit ? sLimit.checked : false;
    const limits = {};
    document.querySelectorAll('.s-lim').forEach(i => { limits[i.dataset.mod] = Math.max(5, +i.value || 30); });
    saveLimits(limits); LIMIT_ON = on;
    try { localStorage.setItem('kg_limit_on', on ? '1' : '0'); } catch (e) { }
    startSession({
      mode: 'mix', module: modSel.value, category: document.getElementById('s-cat').value,
      kadian: document.getElementById('s-kd').value.trim(),
      limitOn: on, limits,
    });
  };
}

/* ---------- session ---------- */
async function startSession(cfg) {
  loading('拉取题目…');
  const p = new URLSearchParams();
  p.set('mode', cfg.mode); p.set('size', cfg.size || '20');
  if (needExcl(cfg.mode)) p.set('exclude', loadSeen().join(','));
  if (cfg.module) p.set('module', cfg.module);
  if (cfg.category) p.set('category', cfg.category);
  if (cfg.kadian) p.set('kadian', cfg.kadian);
  if (cfg.ref) p.set('ref', cfg.ref);
  if (cfg.mid) p.set('mid', cfg.mid);
  if (cfg.region) p.set('region', cfg.region);
  if (cfg.year) p.set('year', cfg.year);
  if (cfg.ids && cfg.ids.length) p.set('ids', cfg.ids.join(','));
  let res;
  try { res = await API('/api/next?' + p); } catch (e) { return fatal(e); }
  if (!res.cards.length) {
    /* 每日额度用完：这不是「没题了」，必须说清楚，否则用户会以为题库抽空/程序坏了 */
    const q = (res.quota || {})[res.limited] || [];
    const emptyMsg = res.limited ? {
      new: [`今天的 ${q[1] || ''} 道新题已经刷完了`, `留着明天继续——一天刷太多，第二天会被积压的复习题埋掉。想多刷可到「设置 → 每日上限」调高。`],
      review: [`今天的 ${q[1] || ''} 道复习额度已经用完`, `休息一下，剩下的题明天再来。想继续可到「设置 → 每日上限」调高。`],
    }[res.limited] : null;
    const msg = emptyMsg
      || (cfg.mode === 'review' && res.due_soon
        ? [`还有 ${res.due_soon} 道题在几分钟内到期`, '刚评过「忘记」的题要过 1~10 分钟才会回到队列，稍等一下再进来。']
        : null)
      || ({
        review: ['没有到期需要复习的题目', '去练习一些新题，或换个范围。'],
        wrong: ['错题本是空的', '先去练习，答错的题会自动收集到这里。'],
        fav: ['还没有收藏任何题目', '练习时在答案页点「⭐ 收藏」即可加入。'],
        material: ['这组材料没有更多题目了', '回到材料组题页选别的材料。'],
      }[cfg.mode] || ['这个范围的题都学过啦', '换个模块/大类试试。']);
    app.innerHTML = `<div class="empty"><div class="big">${res.limited ? '🌙' : '🎉'}</div>
      <h2>${msg[0]}</h2><p>${msg[1]}</p>
      <div class="row">
        ${res.limited ? '<a class="btn" href="#/settings">调整每日上限</a>' : '<a class="btn" href="#/study">练习新题</a>'}
        <a class="btn ghost" href="#/">返回总览</a></div></div>`;
    return;
  }
  state.session = {
    mode: cfg.mode, cfg, queue: res.cards, idx: 0,
    phase: 'question', chosen: null, full: null,
    tally: { done: 0, right: 0, wrong: 0 },
    marked: new Set(), limitOn: !!cfg.limitOn, limits: cfg.limits || loadLimits(),
    ids: cfg.ids || null, startTs: Date.now(), times: [], timeoutN: 0, qStart: Date.now(),
  };
  /* 只把「新题」写进近期已练名单：复习/错题题不该占用新题去重名额 */
  if (needExcl(cfg.mode)) addSeen(res.cards.filter(c => c.is_new !== false).map(c => c.qid));
  renderCard();
  saveSession();
}

function renderCard() {
  const S = state.session; const c = S.queue[S.idx];
  clearNextBar();
  if (!c) { clearSession(); return finishSession().catch(e => { hideMask(); fatal(e); }); }
  S.phase = 'question'; S.chosen = null; S.full = null; S.graded = 0; S.qStart = Date.now();
  const hasMat = !!c.material; window.__curMatRaw = c.material;
  app.innerHTML = `
  <div class="progress"><div class="pp-main"><span id="pp-txt">${S.idx + 1} / ${S.queue.length} &nbsp;·&nbsp; ${MODE_LABEL[S.mode] || '练习'}模式
    &nbsp;·&nbsp; 本次对 <b style="color:var(--ok)">${S.tally.right}</b> 错 <b style="color:var(--bad)">${S.tally.wrong}</b>${S.timeoutN ? ` &nbsp;·&nbsp; <b style="color:var(--warn)">超时 ${S.timeoutN}</b>` : ''}</span>
    <div class="pbar"><i style="width:${S.idx / S.queue.length * 100}%"></i></div></div>
    <div id="ctime-box"></div></div>
  <div class="qhead">
    <span class="tag">${esc(c.module)}/${esc(c.category)}</span>
    <span class="tag">${esc(c.region || '?')} ${esc(c.year || '')}</span>
    <span class="tag" title="${esc(c.kadian)}">${esc((c.kadian || '').split('/').pop().slice(0, 22))}</span>
    <button class="qtool ${S.marked.has(c.id) ? 'on' : ''}" id="t-mark" title="临时标记本题（仅本组有效，便于复盘）">⚑ ${S.marked.has(c.id) ? '已标记' : '标记'}</button>
    <a class="linkback" href="#/detail?id=${c.id}">查看完整标注</a>
    ${c.verified ? `<span class="tag vbadge" title="该题答案已经过联网权威来源核实，可信">✅ 已联网复核</span>` : ''}
    ${c.leech ? `<span class="tag" style="color:var(--warn)" title="这道题已经遗忘 ${c.srs_lapses} 次。反复重刷收益很低，建议看完解析后写一条自己的笔记，或者换个记法">🔁 顽固题 · 已忘 ${c.srs_lapses} 次</span>` : ''}
  </div>
  ${c.module === '资料分析' && !hasMat ? `<div class="material-wrap mat-missing">⚠️ 本题材料缺失（原始数据未收录），可到「材料组题」模式换其他材料组练习</div>` : ''}
  ${hasMat ? `<details class="material-wrap" open><summary style="cursor:pointer;color:var(--brand);margin-bottom:8px">📄 给定材料 <span class="m-hint">（疑点提示将在作答后显示）</span></summary><div class="material" id="mat-stripped">${stripCallouts(c.material)}</div></details>` : ''}
  ${c.ask_model ? `<div class="askmodel">💡 问法模型：${esc(c.ask_model)}</div>` : ''}
  <div class="stem">${c.stem || '<i>（题干为图片，见下方选项）</i>'}</div>
  <div id="opts"></div>
  <div id="act"></div>`;
  renderOptions();
  // 功能3：临时标记按钮（就地切换，不重渲染以免丢失已揭示答案）
  const mb = document.getElementById('t-mark');
  if (mb) mb.onclick = (e) => {
    const on = S.marked.has(c.id);
    if (on) S.marked.delete(c.id); else S.marked.add(c.id);
    e.currentTarget.classList.toggle('on', !on);
    e.currentTarget.textContent = on ? '⚑ 标记' : '⚑ 已标记';
  };
  // 功能2：单题限时倒计时（复习到期也要自己作答，因此和新题一样受单题限时约束）
  if (S.limitOn && S.phase === 'question') {
    const sec = (S.limits && S.limits[c.module]) || LIMIT_DEFAULT[c.module] || 45;
    startLimitTimer(sec);
  } else {
    const cb = document.getElementById('ctime-box'); if (cb) cb.innerHTML = '';
    stopLimitTimer();
  }
  bindSwipe();
  lazyImgs();
}

function renderOptions() {
  const S = state.session, c = S.queue[S.idx], box = document.getElementById('opts');
  const rev = S.full;
  const opts = rev ? rev.options : c.options;
  /* 所有模式（含复习到期）都是「先看选项、自己作答、再看答案解析」：
     复习流程与新题完全一致，记忆更新仍只由四档自评决定，选项只用于判对错展示。 */
  if (!opts || !opts.length) { box.innerHTML = ''; }
  else {
    box.innerHTML = `<div class="opts">` + opts.map(o => {
      let cls = 'opt';
      if (S.phase === 'answer') {
        if (o.is_answer) cls += ' show-ans';
        if (S.chosen === o.key && !o.is_answer) cls += ' wrong';
        if (S.chosen === o.key && o.is_answer) cls += ' correct';
      }
      const clickable = (S.phase === 'question');
      return `<div class="${cls}" ${clickable ? `data-key="${o.key}"` : ''}>
        <span class="k">${o.key}</span><span class="body">${o.html || esc(o.label)}</span>
        ${S.phase === 'answer' && o.is_answer ? '<span style="color:var(--ok);font-weight:800">✔ 正确</span>' : ''}
      </div>`;
    }).join('') + `</div>`;
    if (S.phase === 'question') {
      box.querySelectorAll('.opt').forEach(el => el.onclick = () => { S.chosen = el.dataset.key; doReveal(); });
    }
  }
  renderAct();
}

function renderAct() {
  const S = state.session; const act = document.getElementById('act'); if (!act) return;
  if (S.phase === 'question') {
    act.innerHTML = `<p class="sub" style="margin-top:14px">👆 点击上方选项作答</p>`;
    return;
  }
  const f = S.full;
  const isRight = S.chosen === f.answer;
  S.tally.done++; if (isRight) S.tally.right++; else S.tally.wrong++;
  act.innerHTML = `
    <div class="qtools">
      <button class="qtool ${f.fav ? 'on' : ''}" id="t-fav">${f.fav ? '★ 已收藏' : '☆ 收藏'}</button>
      <button class="qtool" id="t-note">📝 笔记</button>
      <button class="qtool" id="t-detail">🔍 完整标注</button>
    </div>
    <div class="answer-line ${isRight ? 'right' : 'wrong'}">
      ${isRight ? '✓ 答对了，正确答案 ' + esc(f.answer) : '✗ 答错了，正确答案是 ' + esc(f.answer) + '，你选了 ' + esc(S.chosen || '—')}
    </div>
    <div id="note-area"></div>
    <div class="reveal">
      ${f.mother ? `<div class="sec mother"><h4>🧩 母题抽象</h4>${inlineMd(f.mother)}</div>` : ''}
      ${f.reasoning ? `<div class="sec"><h4>🔗 推理链</h4>${inlineMd(f.reasoning)}</div>` : ''}
      ${f.fastest ? `<div class="sec fastest"><h4>⚡ 最快解法</h4>${inlineMd(f.fastest)}</div>` : ''}
      ${f.pitfalls ? `<div class="sec pitfalls"><h4>⚠ 易错点</h4>${inlineMd(f.pitfalls)}</div>` : ''}
      ${f.analysis ? `<div class="sec"><h4>📘 官方解析</h4>${f.analysis}</div>` : ''}
      ${f.doubt ? `<div class="sec doubt"><h4>❓ 疑点待复核</h4>${inlineMd(f.doubt)}</div>` : ''}
      ${f.verified ? `<div class="sec verified">
        <h4>✅ 联网复核结论${f.verified.status === 'confirmed' ? '（官方答案确认无误）' : ''}</h4>
        <p>经权威来源核实，本题正确答案为 <b>${esc(f.verified.answer || '')}</b>。</p>
        ${f.verified.supplement ? `<p><b>补全的数据链</b>：${esc(f.verified.supplement)}</p>` : ''}
        ${f.verified.reasoning ? `<p>${esc(f.verified.reasoning)}</p>` : ''}
        ${f.verified.source_url ? `<p class="vsrc">来源：<a href="${esc(f.verified.source_url)}" target="_blank" rel="noopener">${esc(f.verified.source_name || '查看来源')}</a></p>` : ''}
      </div>` : ''}
    </div>
    <div id="grade-zone">
    <div class="grade">
      <button class="g-again" data-g="1">忘记<small>again · 马上重来</small></button>
      <button class="g-hard" data-g="3">困难<small>hard</small></button>
      <button class="g-good" data-g="4">一般<small>good · 记住了</small></button>
      <button class="g-easy" data-g="5">熟悉<small>easy · 轻松</small></button>
    </div>
    <p class="sub" style="margin-top:10px">按你的真实记忆强度自评（键盘 1/2/3/4 亦可）。系统将据此计算下次复习间隔。</p>
    </div>`;
  act.querySelectorAll('.grade button').forEach(b => b.onclick = () => doGrade(+b.dataset.g));
  document.getElementById('t-fav').onclick = async (e) => {
    const btn = e.currentTarget;
    if (btn.classList.contains('busy')) return;
    const on = !f.fav;
    const restore = busyBtn(btn, on ? '收藏中…' : '取消中…');
    let ok = false;
    try { await POST('/api/fav', { id: c2id(), on }); ok = true; }
    catch (err) { toast('收藏没保存成功：' + (err && err.message ? err.message : err), 'bad'); }
    finally { restore(); }
    if (!ok) return;
    f.fav = on ? 1 : 0;
    btn.classList.toggle('on', !!on); btn.textContent = on ? '★ 已收藏' : '☆ 收藏';
    scheduleSide();
  };
  document.getElementById('t-note').onclick = () => toggleNote();
  document.getElementById('t-detail').onclick = () => { location.hash = '#/detail?id=' + c2id(); };
  lazyImgs(act);
}
function c2id() { return state.session.queue[state.session.idx].id; }

function toggleNote() {
  const area = document.getElementById('note-area'); if (!area) return;
  if (area.dataset.open === '1') { area.innerHTML = ''; area.dataset.open = '0'; return; }
  const f = state.session.full;
  area.dataset.open = '1';
  area.innerHTML = `<div class="note-box"><h4>📝 我的笔记</h4>
    <textarea id="note-ta" placeholder="写下你的思路、易错提醒、秒杀技巧…">${esc(f.note || '')}</textarea>
    <div class="row"><span class="note-saved" id="note-saved">${f.note_updated ? '上次保存 ' + esc(f.note_updated) : ''}</span>
    <button class="btn sm ok" id="note-save">保存笔记</button></div></div>`;
  document.getElementById('note-save').onclick = async (e) => {
    const btn = e.currentTarget;
    if (btn.classList.contains('busy')) return;
    const text = document.getElementById('note-ta').value.trim();
    const restore = busyBtn(btn, '保存中…');
    let ok = false;
    try { await POST('/api/note', { id: c2id(), text }); ok = true; }
    catch (err) { toast('笔记保存失败：' + (err && err.message ? err.message : err), 'bad'); }
    finally { restore(); }
    if (!ok) return;
    f.note = text;
    document.getElementById('note-saved').textContent = text ? '已保存 ✓' : '已清空笔记';
  };
}

async function doReveal() {
  const S = state.session; if (!S) return;
  /* 连点/键盘连按防护：加载中再点一次会重复拉取同一题 */
  if (S.revealing || S.phase !== 'question') return;
  const c = S.queue[S.idx];
  S.revealing = true;
  stopLimitTimer();
  optionBusy();
  try {
    const d = await API('/api/question?id=' + c.id);
    S.full = d.card;
    S.phase = 'answer';
    renderOptions();
  } catch (e) {
    optionBusyEnd();
    toast('解析没能加载出来：' + (e && e.message ? e.message : e) + '　请再点一次选项', 'bad');
  } finally {
    clearInterval(OPT_SLOW); OPT_SLOW = null;
    S.revealing = false;
  }
}

async function doGrade(g) {
  const S = state.session, c = S && S.queue[S.idx];
  if (!S || !c || S.grading || S.graded) return;   // 连点只记一次分
  S.grading = true;
  const dur = Date.now() - (S.qStart || Date.now());
  stopLimitTimer();
  const btns = Array.from(document.querySelectorAll('.grade button'));
  btns.forEach(b => { b.disabled = true; });
  const restore = busyBtn(document.querySelector(`.grade button[data-g="${g}"]`), '记录中…');
  let ok = false;
  try {
    await POST('/api/grade', { id: c.id, grade: g, choice: S.chosen || '' });
    S.times.push(dur);
    ok = true;
  } catch (e) {
    toast('评分没保存成功：' + (e && e.message ? e.message : e) + '　请重新点一次', 'bad');
  } finally {
    S.grading = false;
    restore(); btns.forEach(b => { b.disabled = false; });
  }
  if (!ok) return;   // 保留评分按钮，让用户重试，避免"以为记下了其实丢了"
  /* 记下这次评分对应的题与对错：撤销时要把本轮 tally 一起退回去，否则结算数字会多算 */
  LAST_GRADE = { qid: c.qid, right: S.chosen === (S.full && S.full.answer) };
  /* 忘记 → 服务端已按学习步把它排到 1 分钟后再到期。当前这组题里也排回队列，
     否则「忘记」的题要等下次开新组才会再出现，学习步就白设了。
     位置放在 3 题之后，大致对应 1~2 分钟，和 1 分钟学习步对得上。 */
  if (g < 3 && S.queue && S.queue.length) {
    const rest = S.queue.length - S.idx - 1;
    S.queue.splice(S.idx + Math.min(3, Math.max(1, rest)), 0, c);
    LAST_GRADE.requeued = true;
  }
  scheduleSide();
  // 前进方式见 autoNextSec()：默认评分后立即切题；设为「不自动」时才停在原题看解析
  S.graded = g;
  renderNextBar();
  saveSession();
  /* 误点「忘记/熟悉」在立即模式下已经没有回头路（题都换了），给 6 秒撤销窗口 */
  toast('已记录：' + (GRADE_LABEL[g] || g), '', { label: '撤销', ttl: 6000, onClick: undoLastGrade });
}

/* 撤销最近一次评分：服务端用 reviews.prev_json 的快照把 srs 写回并删掉那条流水。
   如果刚评的那道题还在当前队列里，就跳回去重做，省得用户去题库里翻。 */
async function undoLastGrade() {
  let r;
  try { r = await POST('/api/grade/undo', {}); }
  catch (e) { toast('撤销失败：' + (e && e.message ? e.message : e), 'bad'); return; }
  if (!r || !r.ok) { toast((r && r.error) || '撤销失败', 'bad'); return; }
  const S = state.session;
  /* 忘记时把这道题排回了队列；撤销后要把它去掉，否则同一题会在队列里出现两次。
     按对象引用去重：只有 splice 插入的那一份是同一个引用。 */
  const wasRequeued = !!(LAST_GRADE && LAST_GRADE.requeued);
  if (S && LAST_GRADE && LAST_GRADE.qid === r.qid && S.tally) {
    S.tally.done = Math.max(0, S.tally.done - 1);
    if (LAST_GRADE.right) S.tally.right = Math.max(0, S.tally.right - 1);
    else S.tally.wrong = Math.max(0, S.tally.wrong - 1);
    LAST_GRADE = null;
  }
  if (S && S.queue && r.qid) {
    if (wasRequeued) {
      const uniq = [];
      for (const x of S.queue) if (uniq.indexOf(x) < 0) uniq.push(x);
      S.queue = uniq;
    }
    const at = S.queue.findIndex(x => x.qid === r.qid);
    if (at >= 0) {
      S.idx = at; S.graded = 0; S.phase = 'question'; S.chosen = null; S.full = null;
      renderCard(); saveSession();
    }
  }
  scheduleSide(200);
  toast('已撤销上一次评分，可以重新作答');
}

function nextCard() {
  const S = state.session; if (!S || S.nxBusy) return;
  clearNextBar();
  S.graded = 0;
  if (S.idx + 1 < S.queue.length) { S.idx++; renderCard(); saveSession(); return; }
  /* 本组题用完了：需要向服务端再要一组，这一段在 Pi 上可能明显卡顿 → 必须有遮罩 */
  S.nxBusy = true;
  showMask('正在取下一组题目…');
  moreCards().then(got => {
    if (got) renderCard();
    else { S.idx = S.queue.length; renderCard(); }   // 没有更多题 → 结算页
  }).catch(e => {
    toast('取下一题失败：' + (e && e.message ? e.message : e) + '　请再点一次「下一题」', 'bad');
  }).finally(() => { S.nxBusy = false; hideMask(); saveSession(); });
}

/* ---------- 评分后的前进方式 ----------
   -1 = 立即切题（默认，与 Anki 一致：评完直接下一张）
    0 = 不自动，留在原题看完解析再手动点「下一题」
   >0 = 延迟 N 秒自动切题，期间可点按钮提前继续 */
let NX_TIMER = null;
let LAST_GRADE = null;   // {qid, right}：最近一次评分，供撤销时回退本轮统计
function autoNextSec() {
  try {
    const v = localStorage.getItem('kg_autonext');
    if (v === null || v === '') return -1;   // 没设置过 → 默认评分后立即下一题
    const n = +v;
    if (!isFinite(n) || n < 0) return -1;
    return Math.min(60, Math.floor(n));
  } catch (e) { return -1; }
}
function setAutoNext(v) { try { localStorage.setItem('kg_autonext', String(v)); } catch (e) { } }
/* 操作条是移动端的固定底栏，切题/离开页面时必须撤掉，否则会盖在别的页面上 */
function clearNextBar() {
  if (NX_TIMER) { clearInterval(NX_TIMER); NX_TIMER = null; }
  document.documentElement.removeAttribute('data-nextbar');
}

function renderNextBar() {
  const box = document.getElementById('act'); if (!box) return;
  const S = state.session;
  const auto = autoNextSec();
  /* 立即切题：不留操作条，评分落地后直接进下一题（解析在评分前就已经看过） */
  if (auto < 0) { clearNextBar(); nextCard(); return; }
  const last = S.idx >= S.queue.length - 1;
  const html = `<div class="grade nextbar">
    <span class="nx-tip" id="nx-tip">已记录 · 看完解析再继续</span>
    <button class="btn ok nx-go">${last ? '完成本组 →' : '下一题 →'} <small>空格</small></button>
  </div>`;
  /* 只替换评分区。此前整块覆写 #act，会把答案行、解析、笔记一起清掉 ——
     「不自动」模式下评完就看不到解析了，与设计说明 §9.2 的描述不符。 */
  const zone = document.getElementById('grade-zone');
  const host = zone || box;              // 兜底：超时等路径可能已重建 #act
  host.innerHTML = html;
  document.documentElement.setAttribute('data-nextbar', '1');
  host.querySelector('.nx-go').onclick = nextCard;
  host.querySelector('.nx-go').focus({ preventScroll: true });
  if (NX_TIMER) { clearInterval(NX_TIMER); NX_TIMER = null; }
  if (auto) {
    let left = auto;
    const tip = document.getElementById('nx-tip');
    const paint = () => { if (tip) tip.textContent = `${left} 秒后自动下一题 · 点按钮立即继续`; };
    paint();
    NX_TIMER = setInterval(() => {
      left--;
      if (left <= 0) { clearNextBar(); nextCard(); return; }
      paint();
    }, 1000);
  }
}

/* 手机兜底：评分后向左滑 = 下一题（按钮被底栏/系统界面挡住时仍能前进） */
function bindSwipe() {
  let x0 = 0, y0 = 0, t0 = 0;
  app.ontouchstart = (e) => {
    if (!e.touches || e.touches.length !== 1) return;
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
  };
  app.ontouchend = (e) => {
    const S = state.session, t = e.changedTouches && e.changedTouches[0];
    if (!S || !S.graded || !t) return;
    if (Date.now() - t0 > 800) return;
    if (t.clientX - x0 < -60 && Math.abs(t.clientY - y0) < 60) nextCard();
  };
}

/* ---------- 功能2：限时模式倒计时 / 超时自动判错 ---------- */
function startLimitTimer(sec) {
  stopLimitTimer();
  const S = state.session; if (!S) return;
  S.limitSec = sec; S.limitDeadline = Date.now() + sec * 1000;
  const box = document.getElementById('ctime-box'); if (!box) return;
  box.innerHTML = `<div class="ctime" id="ctime"><span id="ctime-n">${sec}</span></div>`;
  tickLimit();
  S.limitInterval = setInterval(tickLimit, 200);
}
function stopLimitTimer() {
  const S = state.session;
  if (S && S.limitInterval) { clearInterval(S.limitInterval); S.limitInterval = null; }
  if (S) S.limitDeadline = 0;
}
function tickLimit() {
  const S = state.session; if (!S || !S.limitDeadline) return;
  const remain = Math.max(0, (S.limitDeadline - Date.now()) / 1000);
  const el = document.getElementById('ctime'); if (!el) return;
  const pct = Math.max(0, Math.min(100, remain / (S.limitSec || 1) * 100));
  el.style.setProperty('--v', pct.toFixed(1));
  el.classList.toggle('low', remain <= 10);
  const n = document.getElementById('ctime-n'); if (n) n.textContent = Math.ceil(remain);
  if (remain <= 0) { stopLimitTimer(); timeoutCurrent(); }
}
async function timeoutCurrent() {
  const S = state.session, c = S && S.queue[S.idx];
  if (!S || !c || S.timeoutBusy) return;
  S.timeoutBusy = true;
  const act = document.getElementById('act');
  if (act) act.innerHTML = `<div class="opt-loading"><span class="spinner sm"></span>时间到，正在记为超时…</div>`;
  const dur = Date.now() - (S.qStart || Date.now());
  S.times.push(dur); stopLimitTimer();
  try {
    await POST('/api/grade', { id: c.id, grade: 1, timeout: 1, choice: '' });
  } catch (e) {
    toast('超时记录没保存成功：' + (e && e.message ? e.message : e) + '　请在「错题本」核对', 'bad');
  } finally {
    S.timeoutBusy = false;
  }
  S.tally.done++; S.tally.wrong++; S.timeoutN = (S.timeoutN || 0) + 1;
  scheduleSide();
  S.graded = 1;
  renderNextBar();
  saveSession();
}

async function moreCards() {
  const S = state.session, p = new URLSearchParams();
  p.set('mode', S.mode); p.set('size', '20');
  const cfg = S.cfg || {};
  if (cfg.module) p.set('module', cfg.module);
  if (cfg.category) p.set('category', cfg.category);
  if (cfg.kadian) p.set('kadian', cfg.kadian);
  if (cfg.ref) p.set('ref', cfg.ref);
  if (needExcl(S.mode)) p.set('exclude', loadSeen().join(','));
  const res = await API('/api/next?' + p);
  if (res.cards.length) {
    if (needExcl(S.mode)) addSeen(res.cards.filter(c => c.is_new !== false).map(c => c.qid));
    S.queue = res.cards; S.idx = 0; return true;
  }
  if (res.limited) {
    toast(res.limited === 'new' ? '今日新题额度已用完，明天继续（可在设置里调高）'
      : '今日复习额度已用完，明天继续（可在设置里调高）', '', { ttl: 6000 });
  }
  return false;
}

async function finishSession() {
  showMask('正在汇总本组结果…');
  const S = state.session;
  const total = S.tally.done, right = S.tally.right, wrong = S.tally.wrong;
  const acc = total ? Math.round(right / total * 100) : 0;
  const marked = S.marked ? Array.from(S.marked) : [];
  let timing = '';
  if (S.limitOn && S.times && S.times.length) {
    const sum = S.times.reduce((a, b) => a + b, 0);
    const avg = sum / S.times.length / 1000;
    const tm = Math.floor(sum / 1000 / 60), ts = Math.round(sum / 1000 % 60);
    // 功能2：正确率对比（本次限时 vs 平时不限时整体）
    let cmp = '';
    try {
      const accData = await API('/api/accuracy');
      let c = 0, w = 0;
      (accData.module || []).forEach(m => { c += (m.c || 0); w += (m.w || 0); });
      const baseAcc = (c + w) ? Math.round(c / (c + w) * 100) : null;
      if (baseAcc !== null) {
        const diff = acc - baseAcc;
        const cls = diff >= 0 ? 'var(--ok)' : 'var(--bad)';
        cmp = `<p style="margin-top:6px">平时不限时正确率 <b style="color:var(--muted)">${baseAcc}%</b> · 本次限时 <b style="color:${cls}">${acc}%</b>（${diff >= 0 ? '+' : ''}${diff}）</p>`;
      }
    } catch (e) { }
    timing = `<p>总用时 ${tm} 分 ${ts} 秒 · 平均单题 ${avg.toFixed(1)}s · 本组正确率 <b style="color:${acc >= 60 ? 'var(--ok)' : 'var(--warn)'}">${acc}%</b>${S.timeoutN ? ` · 超时 <b style="color:var(--bad)">${S.timeoutN}</b> 次` : ''}</p>${cmp}`;
  }
  hideMask();
  app.innerHTML = `<div class="empty"><div class="big">🏁</div>
    <h2>本组完成！</h2>
    <p>本轮练习 ${total} 题 · 对 ${right} · 错 ${wrong}</p>
    ${timing}
    ${marked.length ? `<div class="card" style="max-width:560px;margin:10px auto 0;text-align:left">
      <h3 style="margin:0 0 6px">⚑ 本组标记的题（${marked.length}）</h3>
      <p class="sub" style="margin:0 0 12px">这些标记仅在本组有效，退出后清除。可一键进入复盘模式单独重做。</p>
      <button class="btn warn" onclick="startSession({mode:'ids',ids:[${marked.join(',')}]})">▶ 复盘标记题（${marked.length}）</button>
    </div>` : ''}
    <div class="row"><a class="btn ok" href="#/review">继续复习到期</a>
      <a class="btn" href="#/study">练习更多新题</a>
      <a class="btn ghost" href="#/wrongbook">看错题本</a>
      <a class="btn ghost" href="#/">返回总览</a></div></div>`;
}

/* keyboard */
document.addEventListener('keydown', (e) => {
  const S = state.session;
  if (S && document.getElementById('opts')) {
    if (e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT')) return;
    /* 复习到期与新题一致：A/B/C/D 选答案（空格只用于「已评分后进入下一题」） */
    if (S.phase === 'question') {
      if ('ABCD'.includes(e.key.toUpperCase())) {
        const o = S.queue[S.idx].options.find(x => x.key.toUpperCase() === e.key.toUpperCase());
        if (o) { S.chosen = o.key; doReveal(); }
      }
    } else if (S.phase === 'answer') {
      if (S.graded) {   // 已评分：空格/回车进入下一题
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); nextCard(); }
      } else {
        const map = { '1': 1, '2': 3, '3': 4, '4': 5 };
        if (map[e.key]) { e.preventDefault(); doGrade(map[e.key]); }
      }
    }
  }
  if (state.exam && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    const E = state.exam; const dir = e.key === 'ArrowRight' ? 1 : -1;
    examGoto(E.cur + dir);
  }
});

/* ---------- browse ---------- */
async function viewBrowse(extra) {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const f = { module: q.get('module') || '', category: q.get('category') || '', kadian: q.get('kadian') || '', region: q.get('region') || '', year: q.get('year') || '', q: q.get('q') || '', only: q.get('only') || '', page: +(q.get('page') || 1) };
  loading('查询中…');
  const [fac, res] = await Promise.all([API('/api/facets'), API('/api/browse?' + buildQ(f))]);
  const heading = f.only === 'wrong' ? '错题本' : f.only === 'fav' ? '我的收藏' : '真题浏览';
  const actionBtn = f.only === 'wrong' ? `<a class="btn ok" href="#" onclick="startSession({mode:'wrong'});return false;">▶ 只练错题</a>`
    : f.only === 'fav' ? `<a class="btn ok" href="#" onclick="startSession({mode:'fav'});return false;">▶ 只练收藏</a>` : '';
  app.innerHTML = `
  <h1>${heading}</h1><p class="sub">共匹配 ${res.total.toLocaleString()} 题 · 点击查看全部深度标注</p>
  <div class="card" style="margin-bottom:16px">
    <h2 style="margin-top:0">🔍 题干关键词搜题</h2>
    <div class="filters">
      <label class="fld">模块<select id="s-mod"><option value="">全部</option>
        ${BOOT.modules.map(m => `<option ${f.module === m.module ? 'selected' : ''}>${esc(m.module)}</option>`).join('')}</select></label>
      <label class="fld">大类<select id="s-cat"><option value="">全部</option>
        ${BOOT.categories.map(c => `<option ${f.category === c.category ? 'selected' : ''} value="${esc(c.category)}">${esc(c.category)}</option>`).join('')}</select></label>
      <label class="fld">关键词<input id="s-q" size="22" placeholder="如 增长率 / 下列表述正确" value="${esc(f.q)}"></label>
      <button class="btn" id="s-search">搜索</button>
    </div>
    <div id="search-hist" class="chipset" style="margin:6px 0 12px"></div>
    <div id="search-results"></div>
  </div>
  ${actionBtn ? `<div class="row" style="margin-bottom:14px">${actionBtn}</div>` : ''}
  <div class="card" style="margin-bottom:16px"><div class="filters">
    <label class="fld">模块<select id="b-mod"><option value="">全部</option>
      ${BOOT.modules.map(m => `<option ${f.module === m.module ? 'selected' : ''}>${esc(m.module)}</option>`).join('')}</select></label>
    <label class="fld">大类<select id="b-cat"><option value="">全部</option>
      ${BOOT.categories.map(c => `<option ${f.category === c.category ? 'selected' : ''} value="${esc(c.category)}">${esc(c.category)}</option>`).join('')}</select></label>
    <label class="fld">地区<select id="b-region"><option value="">全部</option>
      ${fac.regions.map(r => `<option ${f.region === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></label>
    <label class="fld">年份<select id="b-year"><option value="">全部</option>
      ${fac.years.map(y => `<option ${f.year === y ? 'selected' : ''}>${esc(y)}</option>`).join('')}</select></label>
    <label class="fld">考点/题干<input id="b-q" size="18" placeholder="关键字" value="${esc(f.q)}"></label>
    <label class="fld">考点名<input id="b-kd" size="16" value="${esc(f.kadian)}"></label>
    <button class="btn" id="b-go">筛选</button>
  </div></div>
  <div class="card" style="padding:0;overflow:auto"><table><thead><tr>
    <th>考点 / 大类</th><th>地区</th><th>年份</th><th>答</th><th>对错</th><th>状态</th><th>下次复习</th><th>★</th><th></th></tr></thead><tbody>
    ${res.rows.map(r => `<tr>
      <td><b>${esc((r.kadian || '').split('/').pop().slice(0, 30))}</b><br><span class="tag">${esc(r.module)}/${esc(r.category)}</span></td>
      <td>${esc(r.region)}</td><td>${esc(r.year)}</td><td style="color:var(--ok);font-weight:800">${esc(r.answer)}</td>
      <td><span style="color:var(--ok)">${r.correct || 0}</span>/<span style="color:var(--bad)">${r.wrong || 0}</span></td>
      <td><span class="tag ${esc(r.status)}">${{ new: '未学', learning: '学习中', review: '复习中' }[r.status] || r.status}</span></td>
      <td>${r.status === 'new' ? '—' : esc(fmtDue(r.due)) + (isDue(r.due) ? ' ⏰' : '')} ${r.interval ? '<span class="tag">' + r.interval + 'd</span>' : ''}</td>
      <td>${r.fav ? '★' : ''}</td>
      <td><a class="linkback" href="#/detail?id=${r.id}">详情</a></td></tr>`).join('')}
  </tbody></table></div>
  ${pager(res.total, f.page, f)}`;
  document.getElementById('b-go').onclick = () => goBrowse({ module: val('b-mod'), category: val('b-cat'), region: val('b-region'), year: val('b-year'), q: val('b-q'), kadian: val('b-kd'), only: f.only, page: 1 });
  document.getElementById('s-search').onclick = runSearch;
  const sq = document.getElementById('s-q');
  if (sq) sq.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });
  renderSearchHist();
  if (f.q) runSearch();
}
/* ---------- 功能4：题干关键词搜题 ---------- */
function jq(s) { return JSON.stringify(s); }
async function runSearch() {
  const kw = (document.getElementById('s-q') || {}).value;
  if (!kw || !kw.trim()) { const b = document.getElementById('search-results'); if (b) b.innerHTML = '<div class="sub">输入关键词后回车或点击搜索</div>'; return; }
  const term = kw.trim();
  pushSearchHist(term); renderSearchHist();
  const m = val('s-mod'), c = val('s-cat');
  const p = new URLSearchParams(); p.set('q', term); if (m) p.set('module', m); if (c) p.set('category', c); p.set('size', '30');
  const box = document.getElementById('search-results');
  const btn = document.getElementById('s-search');
  if (btn && btn.classList.contains('busy')) return;
  const restore = busyBtn(btn, '搜索中…');
  if (box) box.innerHTML = '<div class="opt-loading"><span class="spinner sm"></span>正在检索题干…</div>';
  let res;
  try { res = await API('/api/search?' + p); }
  catch (e) {
    if (box) box.innerHTML = '';
    toast('搜索失败：' + (e && e.message ? e.message : e) + '　请重试', 'bad');
    return;
  } finally { restore(); }
  if (!box) return;
  if (!res.rows.length) { box.innerHTML = `<div class="empty" style="padding:20px">没有匹配「${esc(term)}」的题干</div>`; return; }
  box.innerHTML = `<p class="sub">匹配 ${res.total} 题（显示前 ${res.rows.length} 条）· 点击卡片看完整标注</p>` +
    res.rows.map(r => `<div class="card kd-card" style="margin-bottom:10px;cursor:pointer" onclick="location.hash='#/detail?id=${r.id}'">
      <div class="row" style="justify-content:space-between"><b>${esc((r.kadian || '').split('/').pop().slice(0, 30))}</b>
        <span class="tag">${esc(r.module)}/${esc(r.category)}</span></div>
      <div class="sub" style="margin:6px 0">${esc(r.snippet)}…</div>
      <div class="row" style="gap:6px">
        <span class="tag ${r.status === 'new' ? 'new' : r.status}">${{ new: '未学', learning: '学习中', review: '复习中' }[r.status] || r.status}</span>
        ${r.wrong ? '<span class="tag learning">曾答错</span>' : ''}${r.fav ? '<span class="tag review">★</span>' : ''}
        <span class="sub" style="margin:0">正确答案 ${esc(r.answer)}</span></div>
    </div>`).join('');
}
function renderSearchHist() {
  const box = document.getElementById('search-hist'); if (!box) return;
  const h = loadSearchHist();
  box.innerHTML = h.length ? ('<span class="sub" style="margin:0 8px 0 0">最近搜索：</span>' + h.map(k => `<button class="qtool" onclick="fillSearch(${jq(k)})">${esc(k)}</button>`).join('')) : '';
}
function fillSearch(k) { const i = document.getElementById('s-q'); if (i) i.value = k; runSearch(); }

async function viewWrongbook() {
  loading();
  const st = await API('/api/wrongbook/stats');
  const list = await API('/api/browse?only=wrong&size=8').catch(() => ({ rows: [] }));
  const mkList = (rows) => rows.map(r => `<tr>
    <td><b>${esc((r.kadian || '').split('/').pop().slice(0, 30))}</b><br><span class="tag">${esc(r.module)}/${esc(r.category)}</span></td>
    <td>${esc(r.region)}</td><td>${esc(r.year)}</td>
    <td style="color:var(--ok);font-weight:800">${esc(r.answer)}</td>
    <td><span class="tag learning">错 ${r.wrong || 0}</span></td>
    <td>${r.status === 'new' ? '—' : esc(fmtDue(r.due)) + (isDue(r.due) ? ' ⏰' : '')}</td>
    <td><a class="linkback" href="#/detail?id=${r.id}">详情</a></td></tr>`).join('');
  app.innerHTML = `
  <h1>错题本</h1><p class="sub">答错的题会自动收集到这里。连续两次自评「一般/熟悉」将自动移出待重练队列。</p>
  <div class="grid g3">
    <div class="card kpi bad"><div class="n">${st.total}</div><div class="l">📕 错题总数</div></div>
    <div class="card kpi ok"><div class="n">${st.mastered}</div><div class="l">✅ 已掌握</div></div>
    <div class="card kpi warn"><div class="n">${st.pending}</div><div class="l">🔁 待重练</div></div>
  </div>
  <div class="center" style="padding:26px">
    <div class="row">
      <button class="btn big ok" id="wb-redo">▶ 开始错题重练</button>
      <a class="btn big ghost" href="#/browse?only=wrong">查看错题明细列表</a>
    </div>
  </div>
  <h2>待重练预览（最近 ${Math.min(8, (list.rows || []).length)} 题）</h2>
  ${ (list.rows && list.rows.length) ? `<div class="card" style="padding:0;overflow:auto"><table><thead><tr>
    <th>考点 / 大类</th><th>地区</th><th>年份</th><th>答</th><th>状态</th><th>下次复习</th><th></th></tr></thead><tbody>
    ${mkList(list.rows)}</tbody></table></div>` : '<div class="empty">还没有错题，先去练习吧</div>' }
  `;
  const rb = document.getElementById('wb-redo');
  if (rb) rb.onclick = () => startSession({ mode: 'wrongredo' });
}
function viewFavorites() {
  if (!location.hash.includes('only=fav')) { location.hash = '#/browse?only=fav'; return; }
  return viewBrowse();
}
function val(id) { const e = document.getElementById(id); return e ? e.value.trim() : ''; }
function buildQ(f) { const p = new URLSearchParams(); Object.entries(f).forEach(([k, v]) => { if (v) p.set(k, v); }); return p; }
function goBrowse(f) { location.hash = '#/browse?' + buildQ(f); }
function pager(total, page, f) {
  const pages = Math.ceil(total / 25); if (pages <= 1) return '';
  const mk = (p) => { const q = Object.assign({}, f, { page: p }); return `#/browse?${buildQ(q)}`; };
  return `<div class="pager">
    ${page > 1 ? `<a class="btn ghost" href="${mk(page - 1)}">← 上一页</a>` : ''}
    <span>第 ${page} / ${pages.toLocaleString()} 页</span>
    ${page < pages ? `<a class="btn ghost" href="${mk(page + 1)}">下一页 →</a>` : ''}</div>`;
}

/* ---------- detail ---------- */
async function viewDetail(id) {
  loading();
  let d; try { d = await API('/api/question?id=' + id); } catch (e) { return fatal(e); }
  const c = d.card, s = d.srs;
  app.innerHTML = `
  <a class="linkback" onclick="history.back()">← 返回</a>
  <div class="qhead" style="margin-top:10px">
    <span class="tag">${esc(c.module)}/${esc(c.category)}</span>
    <span class="tag">${esc(c.region)} ${esc(c.year)}</span>
    <span class="tag ${esc(s ? s.status : 'new')}">${{ new: '未学', learning: '学习中', review: '复习中' }[s ? s.status : 'new'] || ''}</span>
    <span class="tag">下次复习 ${s ? esc(fmtDue(s.due)) : '—'}</span>
    ${s && s.status === 'learning' ? `<span class="tag" title="学习步：1 分钟 → 10 分钟，走完才毕业成 1 天">学习步 ${Math.min(2, (s.step || 0) + 1)}/2</span>` : ''}
    ${s && s.leech ? `<span class="tag" style="color:var(--warn)" title="已遗忘 ${s.lapses} 次，间隔已封顶 30 天，建议记笔记或换记忆方式">🔁 顽固题 · 已忘 ${s.lapses} 次</span>` : ''}
    ${s && s.stability ? `<span class="tag" title="FSRS 记忆状态：稳定性 S=记住多久，难度 D=这题对你多难">S ${Math.round(s.stability)}d · D ${(s.difficulty || 0).toFixed(1)}</span>` : ''}
  </div>
  <h1 style="font-size:20px">${esc(c.kadian)}</h1>
  <p class="sub">${esc(c.paper || '')}</p>
  <div class="qtools">
    <button class="qtool ${c.fav ? 'on' : ''}" id="d-fav">${c.fav ? '★ 已收藏' : '☆ 收藏'}</button>
    <button class="qtool ${c.doubt_status === 'resolved' ? 'on' : ''}" id="d-doubt">${c.doubt_status === 'resolved' ? '✓ 疑点已复核' : '⚑ 标记疑点已复核'}</button>
  </div>
  ${c.ask_model ? `<div class="askmodel">💡 问法模型：${esc(c.ask_model)}</div>` : ''}
  ${c.material ? `<details open class="material-wrap"><summary style="cursor:pointer;color:var(--brand);margin-bottom:8px">📄 给定材料</summary><div class="material">${c.material}</div></details>` : ''}
  <div class="stem">${c.stem}</div>
  <div class="opts">${c.options.map(o => `<div class="opt ${o.is_answer ? 'show-ans' : ''}">
    <span class="k">${o.key}</span><span class="body">${o.html || esc(o.label)}</span>
    ${o.is_answer ? '<span style="color:var(--ok);font-weight:800">✔</span>' : ''}</div>`).join('')}</div>
  <div class="answer-line right">正确答案：${esc(c.answer)}</div>
  <div class="note-box"><h4>📝 我的笔记</h4>
    <textarea id="d-note">${esc(c.note || '')}</textarea>
    <div class="row"><span class="note-saved" id="d-note-saved">${c.note_updated ? '上次保存 ' + esc(c.note_updated) : ''}</span>
    <button class="btn sm ok" id="d-note-save">保存笔记</button></div></div>
  <div class="reveal">
    ${c.mother ? `<div class="sec mother"><h4>🧩 母题抽象</h4>${inlineMd(c.mother)}</div>` : ''}
    ${c.reasoning ? `<div class="sec"><h4>🔗 推理链</h4>${inlineMd(c.reasoning)}</div>` : ''}
    ${c.fastest ? `<div class="sec fastest"><h4>⚡ 最快解法</h4>${inlineMd(c.fastest)}</div>` : ''}
    ${c.pitfalls ? `<div class="sec pitfalls"><h4>⚠ 易错点</h4>${inlineMd(c.pitfalls)}</div>` : ''}
    ${c.analysis ? `<div class="sec"><h4>📘 官方解析</h4>${c.analysis}</div>` : ''}
    ${c.doubt ? `<div class="sec doubt"><h4>❓ 疑点待复核</h4>${inlineMd(c.doubt)}</div>` : ''}
  </div>
  <div class="row" style="margin-top:20px">
    <a class="btn ok" href="#/study?module=${encodeURIComponent(c.module)}&category=${encodeURIComponent(c.category)}&kadian=${encodeURIComponent(c.kadian)}">按此考点练习同类题</a>
  </div>`;
  document.getElementById('d-fav').onclick = async (e) => {
    const b = e.currentTarget;
    if (b.classList.contains('busy')) return;
    const on = !c.fav;
    const restore = busyBtn(b, on ? '收藏中…' : '取消中…');
    let ok = false;
    try { await POST('/api/fav', { id: c.id, on }); ok = true; }
    catch (err) { toast('收藏没保存成功：' + (err && err.message ? err.message : err), 'bad'); }
    finally { restore(); }
    if (!ok) return;
    c.fav = on ? 1 : 0;
    b.classList.toggle('on', !!on); b.textContent = on ? '★ 已收藏' : '☆ 收藏'; scheduleSide();
  };
  document.getElementById('d-note-save').onclick = async (e) => {
    const b = e.currentTarget;
    if (b.classList.contains('busy')) return;
    const text = document.getElementById('d-note').value.trim();
    const restore = busyBtn(b, '保存中…');
    let ok = false;
    try { await POST('/api/note', { id: c.id, text }); ok = true; }
    catch (err) { toast('笔记保存失败：' + (err && err.message ? err.message : err), 'bad'); }
    finally { restore(); }
    if (!ok) return;
    document.getElementById('d-note-saved').textContent = text ? '已保存 ✓' : '已清空笔记';
  };
  document.getElementById('d-doubt').onclick = async (e) => {
    const b = e.currentTarget;
    if (b.classList.contains('busy')) return;
    const resolved = c.doubt_status !== 'resolved';
    const restore = busyBtn(b, '提交中…');
    let ok = false;
    try { await POST('/api/doubt', { id: c.id, status: resolved ? 'resolved' : '' }); ok = true; }
    catch (err) { toast('标记没保存成功：' + (err && err.message ? err.message : err), 'bad'); }
    finally { restore(); }
    if (!ok) return;
    c.doubt_status = resolved ? 'resolved' : '';
    b.classList.toggle('on', resolved);
    b.textContent = resolved ? '✓ 疑点已复核' : '⚑ 标记疑点已复核';
  };
  lazyImgs();
}

/* ---------- kadian ---------- */
async function viewKadian() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const m = q.get('module') || '', cat = q.get('category') || '';
  loading('加载考点…');
  const p = new URLSearchParams(); if (m) p.set('module', m); if (cat) p.set('category', cat); p.set('size', '200');
  const res = await API('/api/kadian?' + p);
  app.innerHTML = `
  <h1>考点导航</h1><p class="sub">按考点聚合，横向对比不同省份的同类考法</p>
  <div class="filters card">
    <label class="fld">模块<select id="k-mod"><option value="">全部</option>
      ${BOOT.modules.map(x => `<option ${m === x.module ? 'selected' : ''}>${esc(x.module)}</option>`).join('')}</select></label>
    <label class="fld">大类<select id="k-cat"><option value="">全部</option>
      ${BOOT.categories.filter(c => !m || c.module === m).map(c => `<option ${cat === c.category ? 'selected' : ''} value="${esc(c.category)}">${esc(c.category)}</option>`).join('')}</select></label>
    <button class="btn" id="k-go">筛选</button>
  </div>
  <div class="grid g2" style="margin-top:16px">
    ${res.rows.map(r => `<div class="card kd-card" onclick="goKadianBrowse('${enc(r.kd)}')">
      <div class="row" style="justify-content:space-between"><b>${esc((r.kd || '').split('/').pop().slice(0, 34))}</b><span class="tag">${r.n} 题</span></div>
      <div class="sub" style="margin:6px 0">${esc(r.module || r.m)}/${esc(r.category || r.c)}</div>
      ${r.mother ? `<div style="font-size:13px;color:var(--purple)">🧩 ${esc(String(r.mother).replace(/[#*>`]/g, '').slice(0, 120))}…</div>` : ''}
      </div>`).join('')}
  </div>`;
  document.getElementById('k-go').onclick = () => { location.hash = '#/kadian?module=' + encodeURIComponent(val('k-mod')) + '&category=' + encodeURIComponent(val('k-cat')); };
}
function enc(s) { return encodeURIComponent(s); }
function goKadianBrowse(kd) { location.hash = '#/browse?kadian=' + kd; }

/* markdown-lite for text fields (they contain html already) */
function inlineMd(t) { return t || ''; }

/* 做题时隐去材料里的 Obsidian 疑点/解析 callout（> [!warning] …）避免剧透答案逻辑 */
function stripCallouts(t) {
  if (!t) return t;
  let s = String(t);
  // 1) 纯文本层面先剔除 '>' 引用行（Obsidian callout 形如 '> [!warning] 疑点…'）。
  //    必须先于 innerHTML 处理：innerHTML 会把 '>' 序列化成 '&gt;'，导致后续正则漏网。
  s = s.replace(/^[ \t]*>[^\n]*(?:\n[ \t]*>[^\n]*)*/gm, '');
  // 2) 兜底：整行含强解析信号的裸解析段落（不带 callout 标记也会剧透）
  s = s.split('\n').filter(line => {
    const plain = line.replace(/<[^>]+>/g, '');
    if (!plain.trim() || /<img|<p>|<\/p>/i.test(line)) return true;
    return !/(官方解析|疑点|待人工复核|不影响\s*(正确)?答案|以\s*[A-F]\s*作答为准|与答案\s*[：:]?\s*[A-F])/.test(plain);
  }).join('\n');
  // 3) HTML 引用块
  if (/<blockquote/i.test(s)) {
    const d = document.createElement('div'); d.innerHTML = s;
    d.querySelectorAll('blockquote').forEach(e => e.remove());
    s = d.innerHTML;
  }
  // 压缩多余空行
  s = s.replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');
  return s;
}
function toggleMatFull() {
  const el = document.getElementById('mat-toggle'), body = document.getElementById('mat-stripped');
  if (!el || !body) return;
  const raw = window.__curMatRaw || '';
  if (el.dataset.on === '1') { body.innerHTML = stripCallouts(raw); el.dataset.on = ''; el.textContent = '显示疑点提示 ▾'; }
  else { body.innerHTML = raw; el.dataset.on = '1'; el.textContent = '隐藏疑点提示 ▴'; }
}

/* ---------- materials ---------- */
/* 材料按「材料」聚合，不再按 material_ref（「编号+首句」）—— 编号是各份试卷自己编的，
   同一段材料在不同卷子里编号不同会被拆成几组，不同材料撞上同一编号又会被并成一组。 */
let MATROWS = [], MATPAPERS = [];
async function viewMaterials(opts) {
  const o = opts || {};
  loading('加载材料组…');
  const p = new URLSearchParams({ size: '60', min: o.all ? '1' : '2', max: o.all ? '9999' : '8' });
  if (o.q) p.set('q', o.q);
  let res; try { res = await API('/api/materials?' + p); } catch (e) { return fatal(e); }
  MATROWS = res.rows;
  app.innerHTML = `
  <h1>材料组题</h1><p class="sub">资料分析按同一段材料成组出题。同一段材料被多份试卷复用时，卡片上会标出「N 份卷」，点开再选做哪一份。</p>
  <div class="row" style="margin-bottom:var(--s4)">
    <input id="m-q" placeholder="搜材料关键词…" value="${esc(o.q || '')}" style="flex:1;min-width:220px">
    <button class="btn sm" id="m-go">搜索</button>
    <button class="btn sm ghost" id="m-all">${o.all ? '只看标准组' : '显示全部（含大材料）'}</button>
  </div>
  <div class="sub" style="margin:0 0 var(--s4)">共 ${res.total} 段材料${o.all ? '' : '（默认只列 2~8 题的标准组）'}</div>
  <div class="grid g2">
    ${res.rows.map((r, i) => `<div class="card kd-card" id="mat-${i}">
      <div class="row" style="justify-content:space-between">
        <b>📄 ${r.has_image ? '含图表' : '纯文字'}材料</b>
        <span class="tag" style="white-space:nowrap">${r.n} 题${r.n_paper > 1 ? ` · ${r.n_paper} 份卷` : ''}</span></div>
      <div class="sub" style="margin:8px 0;line-height:1.5">${esc(r.snippet)}…</div>
      <div class="mat-meta" title="${esc(r.paper)}">${esc(r.region)} ${esc(r.year)}${r.paper ? ' · ' + esc(r.paper) : ''}</div>
      <div class="row"><span class="btn sm ghost" onclick="openMaterial(${i})">整组开练 →</span></div>
      <div class="mat-papers"></div>
    </div>`).join('')}
  </div>
  ${!res.rows.length ? `<div class="empty">没有匹配的材料${o.q ? '，换个关键词试试' : ''}</div>` : ''}`;
  document.getElementById('m-go').onclick = () => viewMaterials({ q: document.getElementById('m-q').value.trim(), all: o.all });
  document.getElementById('m-q').onkeydown = (e) => { if (e.key === 'Enter') document.getElementById('m-go').click(); };
  document.getElementById('m-all').onclick = () => viewMaterials({ q: o.q, all: !o.all });
}

async function openMaterial(i) {
  const row = MATROWS[i]; if (!row) return;
  const box = document.querySelector('#mat-' + i + ' .mat-papers');
  if (!box) return;
  if (box.dataset.open === '1') { box.innerHTML = ''; box.dataset.open = ''; return; }
  box.dataset.open = '1';
  box.innerHTML = '<div class="sub" style="margin:10px 0 0">加载中…</div>';
  let d; try { d = await API('/api/materials/one?mid=' + encodeURIComponent(row.mid)); }
  catch (e) { box.innerHTML = `<div class="sub" style="margin:10px 0 0">${esc(e.message || e)}</div>`; return; }
  if (d.papers.length === 1) { box.innerHTML = ''; return startMaterial(row.mid, d.papers[0]); }
  MATPAPERS = d.papers;
  box.innerHTML = `<div class="mat-papers">
    <div class="sub" style="margin:10px 0 6px">这段材料被 ${d.papers.length} 份试卷用到，选一份开练：</div>
    ${d.papers.map((p, j) => `<button class="btn sm ghost" style="margin:0 6px 6px 0" onclick="startMaterial(MATROWS[${i}].mid,MATPAPERS[${j}])">
      ${esc(p.region)} ${esc(p.year)} · ${p.n} 题</button>`).join('')}
  </div>`;
}

function startMaterial(mid, p) {
  startSession({ mode: 'material', mid, region: p.region, year: p.year,
    size: String(Math.min(12, p.n || 5)) });
}

/* ---------- search ---------- */
/* 全文检索：≥3 字符走 FTS5 trigram（毫秒级），更短的词后端退回 LIKE 逐行匹配。
   结果片段由后端做好 HTML 转义 + <mark> 高亮，前端直接插入，不要再 esc 一遍。 */
let SEARCH_FACETS = null;

function viewSearch() {
  const p0 = new URLSearchParams(location.hash.split('?')[1] || '');
  const f = {
    q: p0.get('q') || '', module: p0.get('module') || '',
    region: p0.get('region') || '', year: p0.get('year') || '',
    page: Math.max(1, +p0.get('page') || 1),
  };
  app.innerHTML = `
  <h1>全文搜索</h1><p class="sub">搜题干、解析、考点与分类。多个关键词用空格分开，全部命中才算。</p>
  <div class="card" style="margin-bottom:var(--s4)">
    <div class="row" style="margin-bottom:12px">
      <input id="s-q" placeholder="例如：基尼系数 / 比重变化 / 逻辑填空" value="${esc(f.q)}" style="flex:1;min-width:240px;font-size:15px">
      <button class="btn" id="s-go">搜索</button>
    </div>
    <div class="filters" style="margin-bottom:0">
      <label class="fld">模块<select id="s-mod"><option value="">全部</option>
        ${BOOT.modules.map(m => `<option value="${esc(m.module)}"${m.module === f.module ? ' selected' : ''}>${esc(m.module)} (${m.n})</option>`).join('')}</select></label>
      <label class="fld">地区<select id="s-reg"><option value="">全部</option></select></label>
      <label class="fld">年份<select id="s-yr"><option value="">全部</option></select></label>
    </div>
  </div>
  <div id="s-res"></div>`;

  const go = (page) => {
    const q = new URLSearchParams();
    const v = document.getElementById('s-q').value.trim();
    if (v) q.set('q', v);
    const m = document.getElementById('s-mod').value; if (m) q.set('module', m);
    const r = document.getElementById('s-reg').value; if (r) q.set('region', r);
    const y = document.getElementById('s-yr').value; if (y) q.set('year', y);
    if (page > 1) q.set('page', String(page));
    const target = '#/search' + (q.toString() ? '?' + q.toString() : '');
    // 条件没变时 hashchange 不触发，得手动刷一次，否则「再点一次搜索」毫无反应
    if (location.hash === target) loadSearch({ q: v, module: m, region: r, year: y, page });
    else location.hash = target;
  };
  document.getElementById('s-go').onclick = () => go(1);
  document.getElementById('s-q').onkeydown = e => { if (e.key === 'Enter') go(1); };
  ['s-mod', 's-reg', 's-yr'].forEach(id => document.getElementById(id).onchange = () => go(1));

  // 地区/年份选项由 /api/search 顺带返回（题库全量 facet，后端缓存一次）。
  // 不能用 /api/accuracy —— 那是按本人答题历史算的，新账号全空。
  if (SEARCH_FACETS) fillSearchFacets(f);
  loadSearch(f);
}

function fillSearchFacets(f) {
  const R = document.getElementById('s-reg'), Y = document.getElementById('s-yr');
  if (!R || !Y || !SEARCH_FACETS) return;
  const opt = (x, cur) => `<option value="${esc(x.k)}"${x.k === cur ? ' selected' : ''}>${esc(x.k)} (${x.n})</option>`;
  R.innerHTML = '<option value="">全部</option>' + SEARCH_FACETS.region.map(x => opt(x, f.region)).join('');
  Y.innerHTML = '<option value="">全部</option>' + SEARCH_FACETS.year.map(x => opt(x, f.year)).join('');
}

async function loadSearch(f) {
  const box = document.getElementById('s-res'); if (!box) return;
  if (!f.q) {
    box.innerHTML = `<div class="empty"><div class="big">🔍</div><h2>输入关键词开始搜索</h2>
      <p class="sub">三个字以上走全文索引（毫秒级）；两个字也能搜，只是后端要逐行匹配，稍慢一点。</p></div>`;
    // 空词也发一次，只为拿地区/年份 facet（返回体很小）
    if (!SEARCH_FACETS) API('/api/search?size=1').then(d => {
      if (d.facets) { SEARCH_FACETS = d.facets; fillSearchFacets(f); }
    }).catch(() => { });
    return;
  }
  box.innerHTML = `<div class="loading" style="padding:26px"><div class="spinner"></div><div class="loading-txt">搜索中…</div></div>`;
  const p = new URLSearchParams({ q: f.q, page: String(f.page || 1), size: '20' });
  if (f.module) p.set('module', f.module);
  if (f.region) p.set('region', f.region);
  if (f.year) p.set('year', f.year);
  let d; try { d = await API('/api/search?' + p); }
  catch (e) { box.innerHTML = `<div class="card">${esc(e.message || e)}</div>`; return; }
  if (d.facets && !SEARCH_FACETS) { SEARCH_FACETS = d.facets; fillSearchFacets(f); }
  if (!d.rows.length) {
    box.innerHTML = `<div class="empty"><div class="big">🫥</div><h2>没有匹配的题</h2>
      <p class="sub">换个说法试试，或者把筛选条件放宽。</p></div>`;
    return;
  }
  const pages = Math.ceil(d.total / d.size);
  box.innerHTML = `
  <div class="sub" style="margin:0 0 var(--s3)">共 ${d.total.toLocaleString()} 条${pages > 1 ? ` · 第 ${d.page} / ${pages} 页` : ''}${d.mode === 'like' ? ' · 短词逐行匹配' : ''}</div>
  ${d.rows.map(r => `<div class="card s-hit" onclick="location.hash='#/detail?id=${r.id}'">
    <div class="row" style="gap:6px;margin-bottom:8px">
      <span class="tag ${r.hit === '题干' ? 'review' : 'learning'}">命中${esc(r.hit)}</span>
      <span class="tag">${esc(r.module || '')}${r.category ? '/' + esc(r.category) : ''}</span>
      <span class="tag">${esc(r.region || '')} ${esc(r.year || '')}</span>
      ${r.has_image ? '<span class="tag">含图</span>' : ''}
    </div>
    <div class="s-frag">${r.frag}</div>
  </div>`).join('')}
  ${pages > 1 ? `<div class="row" style="justify-content:center;margin-top:var(--s5)">
    <button class="btn ghost" ${d.page <= 1 ? 'disabled' : ''} onclick="searchPage(${d.page - 1})">← 上一页</button>
    <button class="btn ghost" ${d.page >= pages ? 'disabled' : ''} onclick="searchPage(${d.page + 1})">下一页 →</button>
  </div>` : ''}`;
}

function searchPage(n) {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  if (n > 1) q.set('page', String(n)); else q.delete('page');
  location.hash = '#/search?' + q.toString();
}

/* ---------- doubts ---------- */
async function viewDoubts() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const only = q.get('only') || '';
  const page = +(q.get('page') || 1);
  loading('加载疑点…');
  const p = new URLSearchParams(); if (only) p.set('only', only); p.set('page', page); p.set('size', '20');
  const res = await API('/api/doubts?' + p);
  const mk = (pg) => { const x = new URLSearchParams(); if (only) x.set('only', only); x.set('page', pg); return `#/doubts?${x}`; };
  app.innerHTML = `
  <h1>疑点复核</h1><p class="sub">共 ${res.total.toLocaleString()} 题标注了「官方解析可能存在疑点」，逐条复核形成自己的判断</p>
  <div class="chipset">
    <a class="btn sm ${!only ? '' : 'ghost'}" href="#/doubts">全部疑点</a>
    <a class="btn sm ${only === 'pending' ? '' : 'ghost'}" href="#/doubts?only=pending">仅看待复核</a>
  </div>
  ${res.rows.map(r => `<div class="card" style="margin-bottom:12px">
    <div class="qhead">
      <span class="tag">${esc(r.module)}/${esc(r.category)}</span>
      <span class="tag">${esc(r.region)} ${esc(r.year)}</span>
      ${r.ds_status === 'resolved' ? '<span class="tag review">✓ 已复核</span>' : '<span class="tag learning">待复核</span>'}
    </div>
    <div class="sub" style="margin:4px 0">${esc((r.kadian || '').split('/').pop().slice(0, 40))}</div>
    <div class="reveal" style="margin-top:8px"><div class="sec doubt"><h4>❓ 疑点</h4>${inlineMd(r.doubt)}</div></div>
    <div class="row" style="margin-top:10px">
      <a class="linkback" href="#/detail?id=${r.id}">查看完整题</a>
      <button class="btn sm ${r.ds_status === 'resolved' ? 'ghost' : 'ok'}" onclick="markDoubt(${r.id}, '${r.ds_status === 'resolved' ? '' : 'resolved'}', this)">
        ${r.ds_status === 'resolved' ? '撤销复核标记' : '✓ 标记已复核'}</button>
    </div>
  </div>`).join('')}
  ${res.total > 20 ? `<div class="pager">
    ${page > 1 ? `<a class="btn ghost" href="${mk(page - 1)}">← 上一页</a>` : ''}
    <span>第 ${page} 页 · 共 ${Math.ceil(res.total / 20)} 页</span>
    ${page * 20 < res.total ? `<a class="btn ghost" href="${mk(page + 1)}">下一页 →</a>` : ''}</div>` : ''}`;
}
async function markDoubt(id, status, btn) {
  if (btn && btn.classList.contains('busy')) return;
  const restore = busyBtn(btn, '提交中…');
  let ok = false;
  try { await POST('/api/doubt', { id, status }); ok = true; }
  catch (e) { toast('标记没保存成功：' + (e && e.message ? e.message : e), 'bad'); }
  finally { restore(); }
  if (!ok) return;
  if (btn) { btn.textContent = status === 'resolved' ? '撤销复核标记' : '✓ 标记已复核'; btn.className = 'btn sm ' + (status === 'resolved' ? 'ghost' : 'ok'); }
  const tag = btn && btn.closest('.card') && btn.closest('.card').querySelector('.qhead .tag.review, .qhead .tag.learning');
}

/* ---------- exam ---------- */
/* 计分口径：官方从不公布行测分值，这里给两套常用口径。
   weight 按模块加权（更接近真实估分），even 就是纯正确率。 */
const SCORE_MODES = {
  weight: '按模块加权（常识/政治 0.5、言语/判断 0.8、数量/资料 1.0，归一到 100 分）',
  even: '每题等分（纯正确率，不区分模块）',
};

function viewExam() {
  app.innerHTML = `
  <h1>模拟考试</h1><p class="sub">整卷作答 · 交卷即时判分 · 可断点续考。题面按真实卷面的模块顺序排列，不打乱。</p>
  <div id="ex-resume"></div>
  <div class="seg" id="e-tabs"><button class="on" data-tab="paper">真题整卷</button><button data-tab="quick">快速组卷</button></div>
  <div id="e-pane"></div>
  <h2>历史记录</h2>
  <div class="card" style="padding:0;overflow:auto" id="e-hist"><div class="loading" style="padding:26px"><div class="spinner"></div><div class="loading-txt">加载历史…</div></div></div>
  <div id="e-hist-detail"></div>`;
  const tabs = document.getElementById('e-tabs');
  tabs.querySelectorAll('button').forEach(b => b.onclick = () => {
    tabs.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    renderExamPane(b.dataset.tab);
  });
  renderExamPane('paper');
  loadExamResume();
  loadExamHistory();
}

/* ---------- 组卷入口：真题整卷 / 快速组卷 ---------- */
async function renderExamPane(kind) {
  const pane = document.getElementById('e-pane'); if (!pane) return;
  if (kind === 'quick') { pane.innerHTML = quickPaneHTML(); bindQuickPane(); return; }
  if (!state.papers) {
    pane.innerHTML = `<div class="card"><div class="loading"><div class="spinner"></div>
      <div class="loading-txt">读取真题卷清单…</div></div></div>`;
    try { state.papers = (await API('/api/exam/papers')).rows || []; }
    catch (e) {
      pane.innerHTML = `<div class="card"><div class="sub" style="margin:0">真题卷清单读取失败：${esc(e.message || e)}</div></div>`;
      return;
    }
  }
  if (!state.papers.length) {
    pane.innerHTML = `<div class="card"><div class="sub" style="margin:0">题库里没有可整卷组卷的真题（需要同一份试卷至少 20 题）。用「快速组卷」即可。</div></div>`;
    return;
  }
  pane.innerHTML = paperPaneHTML();
  bindPaperPane();
}

function paperPaneHTML() {
  const regions = [...new Set(state.papers.map(p => p.region).filter(Boolean))];
  return `<div class="card" style="max-width:760px">
    <p class="sub" style="margin:0 0 14px">按原卷一次性组卷：题量、模块构成、卷面顺序都与当年真题一致。</p>
    <div class="filters" style="margin-bottom:12px">
      <label class="fld">地区<select id="p-region">${regions.map(r => `<option>${esc(r)}</option>`).join('')}</select></label>
      <label class="fld">年份<select id="p-year"></select></label>
      <label class="fld">时长(分钟)<input id="p-t" type="number" value="120" min="10" max="180" style="width:96px"></label>
    </div>
    <label class="fld" style="margin-bottom:var(--s5)">试卷<select id="p-paper" style="width:100%"></select></label>
    <div class="row" style="justify-content:space-between">
      <span class="sub" id="p-info" style="margin:0"></span>
      <button class="btn big warn" id="p-go">▶ 开始整卷模考</button>
    </div>
  </div>`;
}

function bindPaperPane() {
  const R = document.getElementById('p-region'), Y = document.getElementById('p-year'), P = document.getElementById('p-paper');
  if (!R) return;
  const ps = state.papers || [];
  const listOf = () => ps.filter(p => p.region === R.value && p.year === Y.value);
  const cur = () => listOf()[+P.value || 0];
  const updateInfo = () => {
    const p = cur(), box = document.getElementById('p-info');
    if (box) box.textContent = p ? `${p.region} ${p.year} · 共 ${p.n} 题` : '';
  };
  const fillPapers = () => {
    P.innerHTML = listOf().map((p, i) => `<option value="${i}">${esc(p.paper)}（${p.n} 题）</option>`).join('');
    updateInfo();
  };
  const fillYears = () => {
    const ys = [...new Set(ps.filter(p => p.region === R.value).map(p => p.year))].sort().reverse();
    Y.innerHTML = ys.map(y => `<option>${esc(y)}</option>`).join('');
    fillPapers();
  };
  R.onchange = fillYears; Y.onchange = fillPapers; P.onchange = updateInfo;
  fillYears();
  document.getElementById('p-go').onclick = () => {
    const p = cur(); if (!p) return toast('没有可用的真题卷', 'bad');
    const mins = Math.max(10, Math.min(180, +document.getElementById('p-t').value || 120));
    startExam({ n: p.n, minutes: mins, region: p.region, year: p.year, paper: p.paper,
      title: `${p.region} ${p.year} 真题整卷`, scoreMode: 'weight' });
  };
}

function quickPaneHTML() {
  return `<div class="card" style="max-width:760px">
    <div class="filters">
      <label class="fld">模块<select id="e-mod"><option value="">全部混合</option>
        ${BOOT.modules.map(m => `<option value="${esc(m.module)}">${esc(m.module)}</option>`).join('')}</select></label>
      <label class="fld">大类<select id="e-cat"><option value="">全部大类</option>
        ${BOOT.categories.map(c => `<option value="${esc(c.category)}">${esc(c.category)}</option>`).join('')}</select></label>
      <label class="fld">题量<input id="e-n" type="number" value="20" min="5" max="200" style="width:96px"></label>
      <label class="fld">时长(分钟)<input id="e-t" type="number" value="20" min="1" max="180" style="width:96px"></label>
      <label class="fld" style="flex:1;min-width:280px">计分<select id="e-score" style="width:100%">
        ${Object.keys(SCORE_MODES).map(k => `<option value="${k}">${esc(SCORE_MODES[k])}</option>`).join('')}</select></label>
    </div>
    <div class="row"><button class="btn big warn" id="e-go">▶ 开始模考</button>
      <span class="sub" style="margin:0">抽到的题会按真实卷面模块顺序重排</span></div>
  </div>`;
}

function bindQuickPane() {
  const emod = document.getElementById('e-mod');
  if (!emod) return;
  emod.onchange = () => {
    const c = document.getElementById('e-cat'); const mv = emod.value;
    c.innerHTML = '<option value="">全部大类</option>' + BOOT.categories.filter(x => !mv || x.module === mv)
      .map(x => `<option value="${esc(x.category)}">${esc(x.category)}</option>`).join('');
  };
  document.getElementById('e-go').onclick = () => startExam({
    module: emod.value, category: document.getElementById('e-cat').value,
    n: Math.max(5, Math.min(200, +document.getElementById('e-n').value || 20)),
    minutes: Math.max(1, Math.min(180, +document.getElementById('e-t').value || 20)),
    scoreMode: document.getElementById('e-score').value,
    title: (emod.value || '全模块') + ' 模考',
  });
}

/* ---------- 断点续考 ---------- */
async function loadExamResume() {
  const box = document.getElementById('ex-resume'); if (!box) return;
  let d; try { d = await API('/api/exam/resume'); } catch (e) { return; }
  const pg = d.progress;
  if (!pg || !pg.items || !pg.items.length) { box.innerHTML = ''; return; }
  const remain = Math.max(0, Math.floor((pg.deadline - Date.now()) / 1000));
  const done = pg.items.filter(x => x.chosen).length;
  box.innerHTML = `<div class="card resume-card">
    <div style="flex:1;min-width:240px">
      <b>有一张没做完的卷：${esc(pg.title || '模拟考试')}</b>
      <div class="sub" style="margin:4px 0 0">已答 ${done} / ${pg.items.length} 题 · ${remain > 0 ? '剩余 ' + fmt(remain) : '已超时（继续后立即交卷）'} · 存档于 ${esc((pg.updated || '').replace('T', ' ').slice(5, 16))}</div>
    </div>
    <div class="row"><button class="btn resume" id="ex-resume-go">继续上次模考</button>
      <button class="btn ghost" id="ex-resume-del">放弃</button></div></div>`;
  document.getElementById('ex-resume-go').onclick = () => resumeExam(pg);
  document.getElementById('ex-resume-del').onclick = async () => {
    if (!confirm('放弃这张卷？已作答的内容不会保存。')) return;
    try { await POST('/api/exam/discard', {}); } catch (e) { /* 已删过也无所谓 */ }
    box.innerHTML = ''; toast('已放弃上次模考');
  };
}

async function resumeExam(pg) {
  loading('正在恢复上次模考…');
  await buildExam(pg.items.map(x => ({ id: x.id })), {
    minutes: pg.minutes, title: pg.title, scoreMode: pg.scoreMode, paper: pg.paper,
    deadline: pg.deadline, cur: pg.cur, chosen: pg.items.map(x => x.chosen || null),
  });
}

let _examSaveTimer = null;
function examSave() {
  const E = state.exam;
  if (!E || E.submitted || _examSaveTimer) return;   // 单飞：同一时间只挂一个待发请求
  _examSaveTimer = setTimeout(async () => {
    _examSaveTimer = null;
    const S = state.exam; if (!S || S.submitted) return;
    S.savedAt = Date.now();
    try {
      await POST('/api/exam/save', { payload: {
        items: S.items.map(x => ({ id: x.card.id, chosen: x.chosen })),
        cur: S.cur, deadline: S.deadline, minutes: S.minutes,
        title: S.title, scoreMode: S.scoreMode, paper: S.paper,
      } });
    } catch (e) { /* 存档失败不打断作答，下一轮 tick 会再试 */ }
  }, 400);
}

/* ---------- 组卷与作答 ---------- */
async function startExam(cfg) {
  loading('组卷中…');
  /* mode=exam：从整个题库随机抽（含已学题）。用 new 会只抽没学过的，学到后期就组不出卷了 */
  const p = new URLSearchParams(); p.set('mode', 'exam'); p.set('size', cfg.n);
  ['module', 'category', 'region', 'year', 'paper'].forEach(k => { if (cfg[k]) p.set(k, cfg[k]); });
  let res; try { res = await API('/api/next?' + p); } catch (e) { return fatal(e); }
  if (!res.cards.length) {
    app.innerHTML = `<div class="empty"><div class="big">📭</div><h2>该范围没有可组的题</h2>
      <div class="row"><a class="btn" href="#/exam">返回</a></div></div>`; return;
  }
  await buildExam(res.cards, cfg);
}

/* 把「题号列表 + 配置」变成一张可作答的卷：逐题取完整卡片（含解析与材料）。 */
async function buildExam(cards, cfg) {
  const totalQ = cards.length;
  let doneQ = 0;
  loading(`组卷中… 正在调取题目 0/${totalQ}`);
  let reveal;
  try {
    reveal = await Promise.all(cards.map(c => API('/api/question?id=' + c.id).then(d => {
      doneQ++;
      loading(`组卷中… 正在调取题目 ${doneQ}/${totalQ}`);
      return d.card;
    })));
  } catch (e) { return fatal(e); }
  state.exam = {
    items: reveal.map((c, i) => ({ card: c, chosen: (cfg.chosen && cfg.chosen[i]) || null })),
    cur: Math.max(0, Math.min(reveal.length - 1, cfg.cur || 0)),
    total: reveal.length,
    deadline: cfg.deadline || (Date.now() + (cfg.minutes || 20) * 60 * 1000),
    minutes: cfg.minutes || 20,
    submitted: false,
    title: cfg.title || '模拟考试',
    scoreMode: cfg.scoreMode || 'weight',
    paper: cfg.paper || '',
    savedAt: 0, timer: null,
  };
  renderExam();
  clearInterval(state.exam.timer);
  state.exam.timer = setInterval(examTick, 1000);
  examSave();   // 组完卷立刻落一次存档：开考就关掉浏览器也能接着做
}

function examTick() {
  const E = state.exam; if (!E || E.submitted) return;
  const remain = E.deadline - Date.now();
  const el = document.getElementById('ex-time');
  if (el) {
    const s = Math.max(0, Math.floor(remain / 1000));
    el.textContent = fmt(s); el.classList.toggle('low', s <= 60);
  }
  if (remain <= 0) { clearInterval(E.timer); examSubmit(true); return; }
  /* 每 15 秒静默存档一次：只靠「选完就存」不够 —— 有人会在一道题上停很久，
     或者干脆没选就关掉页面。 */
  if (Date.now() - (E.savedAt || 0) > 15000) examSave();
}
function fmt(s) { const m = Math.floor(s / 60), r = s % 60; return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r; }

/* 答题卡按模块分组：整卷真题有 135 题，一长串数字看不出「我现在在哪个模块」。 */
function examGroups(E) {
  const out = [];
  E.items.forEach((x, i) => {
    const m = x.card.module || '其他';
    let g = out[out.length - 1];
    if (!g || g.m !== m) { g = { m, list: [] }; out.push(g); }
    g.list.push({ x, i });
  });
  return out;
}

function renderExam() {
  const E = state.exam; if (!E) return;
  const it = E.items[E.cur], c = it.card;
  const done = E.items.filter(x => x.chosen).length;
  app.innerHTML = `
  <div class="exam-timer"><div><b style="font-size:15px">模拟考试 · ${esc(E.title)}</b>
    <div class="sub" style="margin:2px 0 0">第 ${E.cur + 1} / ${E.total} 题 · ${esc(c.module || '')} · 已答 ${done}</div></div>
    <div style="text-align:right"><div class="t" id="ex-time">--:--</div><div class="sub" style="margin:0">剩余时间</div></div></div>
  <details class="exam-card" ${window.innerWidth < 720 ? '' : 'open'}>
    <summary>答题卡 · 已答 ${done} / ${E.total}</summary>
    <div class="exam-nav">${examGroups(E).map(g => `<div class="exam-grp">
    <div class="exam-grp-h">${esc(g.m)}<span>${g.list.length} 题</span></div>
    <div class="exam-grp-b">${g.list.map(({ x, i }) => `<button class="exam-dot ${x.chosen ? 'answered' : ''} ${i === E.cur ? 'cur' : ''}" onclick="examGoto(${i})">${i + 1}</button>`).join('')}</div>
  </div>`).join('')}</div>
  </details>
  ${c.material ? `<details open class="material-wrap"><summary style="cursor:pointer;color:var(--brand);margin-bottom:8px">📄 给定材料 <span class="m-hint">（疑点提示将在作答后显示）</span></summary><div class="material" style="max-height:340px">${stripCallouts(c.material)}</div></details>` : ''}
  <div class="qhead"><span class="tag">${esc(c.module)}/${esc(c.category)}</span><span class="tag">${esc((c.kadian || '').split('/').pop().slice(0, 22))}</span></div>
  <div class="stem exam-q">${c.stem || '<i>（题干为图片）</i>'}</div>
  <div class="opts">${c.options.map(o => `<div class="opt ${it.chosen === o.key ? 'sel' : ''}" data-key="${o.key}">
    <span class="k">${o.key}</span><span class="body">${o.html || esc(o.label)}</span></div>`).join('')}</div>
  <div class="row" style="margin-top:20px;justify-content:space-between">
    <button class="btn ghost" ${E.cur === 0 ? 'disabled' : ''} onclick="examGoto(${E.cur - 1})">← 上一题</button>
    <div class="row">
      ${E.cur < E.total - 1 ? `<button class="btn" onclick="examGoto(${E.cur + 1})">下一题 →</button>` : ''}
      <button class="btn ok" onclick="examSubmit(false)">✅ 交卷</button>
    </div>
  </div>`;
  examTick();
  document.querySelectorAll('.opt').forEach(el => el.onclick = () => {
    it.chosen = el.dataset.key;
    /* 只切换选中态，不整页重绘：重绘会把滚动位置拉回顶部，长材料题答到一半就跳回开头 */
    document.querySelectorAll('.opt').forEach(x => x.classList.toggle('sel', x === el));
    const dot = document.querySelectorAll('.exam-dot')[E.cur];
    if (dot) dot.classList.add('answered');
    examSave();
  });
  lazyImgs();
}
function examGoto(i) {
  const E = state.exam; if (!E || i < 0 || i >= E.total) return;
  E.cur = i; renderExam(); examSave();
  /* 手机上答题卡是折叠的：点完题号就收起来，否则得再往下滚一屏才看到题干 */
  const d = document.querySelector('details.exam-card');
  if (d && window.innerWidth < 720) d.open = false;
}

async function examSubmit(auto) {
  const E = state.exam; if (!E || E.submitted) return;
  const blank = E.items.filter(x => !x.chosen).length;
  if (!auto && blank > 0 && !confirm(`还有 ${blank} 题没作答，确定交卷吗？\n（未作答按 0 分计入卷面，但不会写进记忆曲线）`)) return;
  E.submitted = true; clearInterval(E.timer);
  const used = Math.round((E.minutes * 60 * 1000 - Math.max(0, E.deadline - Date.now())) / 1000);
  /* answered=false 的题只计入卷面分，不写记忆曲线（跳过≠遗忘） */
  const items = E.items.map(x => ({
    id: x.card.id,
    correct: !!(x.chosen && x.chosen === x.card.answer),
    answered: !!x.chosen,
    chosen: x.chosen || '',
    answer: x.card.answer || '',
  }));
  showMask('正在判分并写入记忆曲线…');
  let res;
  try {
    res = await POST('/api/exam/submit', {
      title: E.title, duration: used, items, score_mode: E.scoreMode, paper: E.paper,
    });
  } catch (e) {
    hideMask(); E.submitted = false;
    if (E.deadline > Date.now()) E.timer = setInterval(examTick, 1000);
    toast('交卷没成功：' + (e && e.message ? e.message : e) + '　请再点一次「交卷」', 'bad');
    return;
  }
  hideMask();
  const answered = E.items.filter(x => x.chosen).length;
  const bd = res.breakdown || [];
  app.innerHTML = `
  <div class="exam-result card">
    <div class="sub" style="margin-bottom:6px">${auto ? '⏰ 时间到，已自动交卷' : '🎉 交卷成功'}</div>
    <div class="score" style="color:${res.score >= 60 ? 'var(--ok)' : 'var(--warn)'}">${res.score}</div>
    <div class="sub">得分</div>
    <div class="row" style="justify-content:center;margin:16px 0">
      <span class="tag">共 ${res.total} 题</span><span class="tag review">答对 ${res.correct}</span>
      <span class="tag">作答 ${answered}</span><span class="tag">用时 ${Math.floor(used / 60)}分${used % 60}秒</span>
    </div>
    ${bd.length ? `<div style="text-align:left;max-width:560px;margin:0 auto 16px;overflow:auto">
      <table><thead><tr><th>模块</th><th>题量</th><th>作答</th><th>答对</th><th>模块得分</th></tr></thead><tbody>
      ${bd.map(b => `<tr><td>${esc(b.module)}</td><td>${b.n}</td><td>${b.answered}</td>
        <td style="color:var(--ok)">${b.correct}</td>
        <td><b style="color:${b.score >= 60 ? 'var(--ok)' : 'var(--warn)'}">${b.score}</b></td></tr>`).join('')}
      </tbody></table>
      <p class="sub" style="margin:10px 0 0">计分口径：${esc(SCORE_MODES[res.score_mode] || SCORE_MODES.weight)}</p></div>` : ''}
    <p class="sub">成绩已按「对→一般 / 错→忘记」写入记忆曲线，错题自动进错题本。</p>
    <div class="row" style="justify-content:center">
      <button class="btn" onclick="examReview()">逐题查看</button>
      <a class="btn ok" href="#/exam">再来一卷</a>
      <a class="btn ghost" href="#/wrongbook">看错题本</a>
      <a class="btn ghost" href="#/">返回总览</a>
    </div>
  </div>
  <div id="ex-review"></div>`;
  scheduleSide();
}

function examReview() {
  const E = state.exam; const box = document.getElementById('ex-review');
  if (!E || !box) return;
  box.innerHTML = `<h2>逐题对照</h2>` + E.items.map((x, i) => {
    const c = x.card; const ok = x.chosen && x.chosen === c.answer;
    return `<div class="card" style="margin-bottom:12px">
      <div class="row" style="justify-content:space-between"><b>第 ${i + 1} 题 · ${esc(c.module || '')}</b>
        <span class="tag ${ok ? 'review' : 'learning'}">${ok ? '✓ 正确' : (x.chosen ? '✗ 选' + x.chosen + '，应' + c.answer : '未作答，应' + c.answer)}</span></div>
      <div class="stem" style="font-size:15px;margin:10px 0">${c.stem}</div>
      <div class="opts">${c.options.map(o => `<div class="opt ${o.is_answer ? 'show-ans' : ''} ${x.chosen === o.key && !o.is_answer ? 'wrong' : ''}">
        <span class="k">${o.key}</span><span class="body">${o.html || esc(o.label)}</span></div>`).join('')}</div>
    </div>`;
  }).join('');
  box.scrollIntoView({ behavior: 'smooth' });
}

/* ---------- 历史记录：列表 + 单次答题卡快照 ---------- */
async function loadExamHistory() {
  const box = document.getElementById('e-hist'); if (!box) return;
  let d; try { d = await API('/api/exam/history'); } catch (e) { box.innerHTML = `<div class="empty" style="padding:24px">${esc(e.message || e)}</div>`; return; }
  if (!d.rows.length) { box.innerHTML = '<div class="empty" style="padding:24px">还没有模考记录</div>'; return; }
  box.innerHTML = `<table><thead><tr><th>时间</th><th>名称</th><th>题量</th><th>正确</th><th>得分</th><th>计分</th><th>用时</th><th></th></tr></thead><tbody>
    ${d.rows.map(r => `<tr><td>${esc((r.ts || '').replace('T', ' ').slice(0, 16))}</td><td>${esc(r.title)}</td>
      <td>${r.total}</td><td style="color:var(--ok)">${r.correct}</td>
      <td><b style="color:${r.score >= 60 ? 'var(--ok)' : 'var(--warn)'}">${r.score}</b></td>
      <td class="sub" style="margin:0">${r.blueprint ? (r.blueprint.score_mode === 'even' ? '等分' : '加权') : '等分'}</td>
      <td>${Math.floor((r.duration || 0) / 60)}分${(r.duration || 0) % 60}秒</td>
      <td><button class="btn ghost sm" onclick="examShowHistory(${r.id})">答题卡</button></td></tr>`).join('')}</tbody></table>`;
}

async function examShowHistory(hid) {
  const box = document.getElementById('e-hist-detail'); if (!box) return;
  box.innerHTML = `<div class="loading" style="padding:24px"><div class="spinner"></div><div class="loading-txt">读取答题卡…</div></div>`;
  let d; try { d = await API('/api/exam/history?id=' + hid); } catch (e) { box.innerHTML = `<div class="card">${esc(e.message || e)}</div>`; return; }
  const row = d.row, detail = row.detail || [];
  if (!detail.length) { box.innerHTML = `<div class="card"><div class="sub" style="margin:0">这条记录是旧版本存的，没有答题卡快照。</div></div>`; return; }
  let bp = null; try { bp = typeof row.blueprint === 'string' ? JSON.parse(row.blueprint) : row.blueprint; } catch (e) { bp = null; }
  /* 按模块汇总（模块顺序取快照里记录的卷面顺序，老记录就按出现顺序） */
  const order = (bp && bp.order) || [];
  const byMod = {};
  detail.forEach(x => {
    const m = x.module || '其他';
    const b = byMod[m] || (byMod[m] = { n: 0, correct: 0, answered: 0, items: [] });
    b.n++; b.answered += x.answered ? 1 : 0; b.correct += x.correct ? 1 : 0; b.items.push(x);
  });
  const mods = Object.keys(byMod).sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const cls = x => x.correct ? 'ok' : (x.answered ? 'bad' : 'blank');
  box.innerHTML = `<h2>第 ${row.id} 次 · ${esc(row.title)}</h2>
  <div class="card">
    <div class="row" style="justify-content:space-between;margin-bottom:12px">
      <div><b style="font-size:20px">${row.score}</b> 分 <span class="sub" style="margin:0">· ${row.total} 题 · 答对 ${row.correct} · ${esc((row.ts || '').replace('T', ' ').slice(0, 16))}</span></div>
      <button class="btn ghost sm" onclick="document.getElementById('e-hist-detail').innerHTML=''">收起</button>
    </div>
    <div style="overflow:auto"><table><thead><tr><th>模块</th><th>题量</th><th>作答</th><th>答对</th><th>正确率</th></tr></thead><tbody>
      ${mods.map(m => { const b = byMod[m]; const p = b.answered ? Math.round(b.correct / b.answered * 100) : 0;
        return `<tr><td>${esc(m)}</td><td>${b.n}</td><td>${b.answered}</td>
          <td style="color:var(--ok)">${b.correct}</td><td>${p}%</td></tr>`; }).join('')}
    </tbody></table></div>
    <p class="sub" style="margin:12px 0 0">点题号看原题（绿=对，红=错，灰=未作答）</p>
    <div class="exam-nav">${mods.map(m => `<div class="exam-grp">
      <div class="exam-grp-h">${esc(m)}<span>${byMod[m].n} 题</span></div>
      <div class="exam-grp-b">${byMod[m].items.map(x => `<button class="exam-dot snap ${cls(x)}" onclick="examSnapQ(${x.id})">${detail.indexOf(x) + 1}</button>`).join('')}</div>
    </div>`).join('')}</div>
  </div>
  <div id="e-snap-q"></div>`;
  box.scrollIntoView({ behavior: 'smooth' });
}

async function examSnapQ(qid) {
  const box = document.getElementById('e-snap-q'); if (!box) return;
  box.innerHTML = `<div class="loading" style="padding:20px"><div class="spinner"></div></div>`;
  let d; try { d = await API('/api/question?id=' + qid); } catch (e) { box.innerHTML = `<div class="card">${esc(e.message || e)}</div>`; return; }
  const c = d.card;
  box.innerHTML = `<div class="card" style="margin-top:12px">
    <div class="row" style="justify-content:space-between"><b>${esc(c.module)}/${esc(c.category)}</b>
      <span class="tag review">答案 ${esc(c.answer || '')}</span></div>
    ${c.material ? `<details class="material-wrap" style="margin-top:10px"><summary style="cursor:pointer;color:var(--brand)">📄 给定材料</summary><div class="material">${stripCallouts(c.material)}</div></details>` : ''}
    <div class="stem" style="font-size:15px;margin:10px 0">${c.stem || ''}</div>
    <div class="opts">${c.options.map(o => `<div class="opt ${o.is_answer ? 'show-ans' : ''}">
      <span class="k">${o.key}</span><span class="body">${o.html || esc(o.label)}</span></div>`).join('')}</div>
    ${c.analysis ? `<div class="sec" style="margin-top:12px"><h4>📘 官方解析</h4>${c.analysis}</div>` : ''}
  </div>`;
  lazyImgs(box);
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ---------- stats ---------- */
async function viewStats() {
  loading('统计中…');
  const [st, heat, sk, acc, weak] = await Promise.all([
    API('/api/stats'), API('/api/heatmap?days=180'), API('/api/streak'), API('/api/accuracy'), API('/api/weak'),
  ]);
  const hm = {}; heat.days.forEach(d => hm[d.d] = d.n);
  const cells = [];
  const todayD = new Date();
  const N = 182;
  const start = new Date(todayD); start.setDate(start.getDate() - (N - 1));
  // align start to Sunday
  start.setDate(start.getDate() - start.getDay());
  for (let d = new Date(start); d <= todayD; d.setDate(d.getDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    const n = hm[key] || 0;
    let lv = 0; if (n >= 20) lv = 4; else if (n >= 10) lv = 3; else if (n >= 5) lv = 2; else if (n >= 1) lv = 1;
    cells.push(`<div class="heat-cell l${lv}" title="${key}: ${n} 题"></div>`);
  }
  const goalPct = sk.goal ? Math.min(100, Math.round(sk.today / sk.goal * 100)) : 0;
  const maxAcc = (a) => { const t = (a.c || 0) + (a.w || 0); return t ? Math.round(a.c / t * 100) : 0; };
  app.innerHTML = `
  <h1>数据统计</h1><p class="sub">学习节奏 · 正确率 · 薄弱考点，一眼看清</p>
  <div class="grid g4">
    <div class="card kpi ok"><div class="n">${sk.current}</div><div class="l">🔥 连续打卡(天)</div></div>
    <div class="card kpi purple"><div class="n">${sk.best}</div><div class="l">🏆 最长连续(天)</div></div>
    <div class="card kpi brand"><div class="n">${st.studied_today}</div><div class="l">✅ 今日已练</div></div>
    <div class="card kpi warn"><div class="n">${st.wrong}</div><div class="l">📕 错题总数</div></div>
  </div>
  <div class="grid g2" style="margin-top:16px">
    <div class="card kpi bad">
      <div class="n">${st.self_biased || 0}</div>
      <div class="l">🪞 自评偏差（选了错答案，却自评「记住了」）</div>
      <p class="sub" style="margin:8px 0 0">这是「感觉会」和「真会」的差距。数字偏大时，别急着点「一般」，先看一遍解析再评。</p>
    </div>
    <div class="card kpi warn">
      <div class="n">${st.leech || 0}</div>
      <div class="l">🔁 顽固题（已遗忘 ≥ ${st.leech_at || 8} 次）</div>
      <p class="sub" style="margin:8px 0 0">这些题的复习间隔已封顶 30 天，逼你反复短间隔见面。建议记一条自己的笔记，换种记法。</p>
    </div>
  </div>
  <div class="card" style="margin-top:16px">
    <div class="ring-row">
      <div class="ring" style="--v:${goalPct}"><div class="in"><b>${sk.today}/${sk.goal}</b><span>今日目标</span></div></div>
      <div>
        <h2 style="margin:0 0 8px">每日目标</h2>
        <p class="sub" style="margin:0 0 12px">当前每天目标 <b>${sk.goal}</b> 题</p>
        <div class="row">
          <input id="g-in" type="number" min="1" max="500" value="${sk.goal}" style="width:100px">
          <button class="btn sm" id="g-set">更新目标</button>
        </div>
      </div>
    </div>
  </div>
  <h2>练习热力图（近半年）</h2>
  <div class="card"><div class="heat-wrap"><div class="heat-grid">${cells.join('')}</div></div>
    <div class="heat-legend">少 <span class="heat-cell"></span><span class="heat-cell l1"></span><span class="heat-cell l2"></span><span class="heat-cell l3"></span><span class="heat-cell l4"></span> 多</div></div>
  <h2>各模块正确率</h2>
  <div class="card">
    ${acc.module.map(a => { const pc = maxAcc(a); return `<div class="acc-row">
      <span class="name">${esc(a.k)}</span><div class="track"><i style="width:${pc}%"></i></div>
      <span class="pct">${pc}% · 对${a.c}/错${a.w}</span></div>`; }).join('') || '<div class="sub" style="margin:0">练习后这里会显示正确率</div>'}
  </div>
  <h2>各大类正确率</h2>
  <div class="card">
    ${acc.category.slice(0, 12).map(a => { const pc = maxAcc(a); return `<div class="acc-row">
      <span class="name" title="${esc(a.k)}">${esc((a.k || '').slice(0, 14))}</span><div class="track"><i style="width:${pc}%"></i></div>
      <span class="pct">${pc}% · 对${a.c}/错${a.w}</span></div>`; }).join('') || '<div class="sub" style="margin:0">暂无数据</div>'}
  </div>
  <h2>薄弱考点（错误 / 遗忘最多）</h2>
  <div class="grid g2">
    ${weak.rows.slice(0, 12).map(r => `<div class="card kd-card" onclick="goKadianBrowse('${enc(r.kd)}')">
      <div class="row" style="justify-content:space-between"><b>${esc((r.kd || '').split('/').pop().slice(0, 26))}</b><span class="tag">${esc(r.m)}</span></div>
      <div class="sub" style="margin:6px 0">做过 ${r.seen} · 对 ${r.c || 0} 错 ${r.w || 0} · 遗忘 ${r.lp || 0}</div>
      <div class="bar"><i style="width:${r.acc}%;background:linear-gradient(90deg,var(--bad),var(--warn))"></i></div>
      <div class="sub" style="margin:4px 0 0">正确率 ${r.acc}%</div>
    </div>`).join('') || '<div class="sub">还没有练过错题，暂无薄弱点</div>'}
  </div>`;
  document.getElementById('g-set').onclick = async (e) => {
    const b = e.currentTarget;
    if (b.classList.contains('busy')) return;
    const v = +document.getElementById('g-in').value || 20;
    const restore = busyBtn(b, '保存中…');
    try { await POST('/api/goal', { value: v }); }
    catch (err) { restore(); toast('保存失败：' + (err && err.message ? err.message : err), 'bad'); return; }
    viewStats();
  };
}

/* ---------- settings ---------- */
function viewSettings() {
  app.innerHTML = `
  <h1>设置</h1><p class="sub">外观与学习习惯</p>
  <div class="card" style="max-width:640px">
    <h2 style="margin-top:0">外观</h2>
    <div class="row" style="justify-content:space-between;margin:14px 0">
      <span>主题（点击循环：暗色 → 亮色 → 跟随系统）</span>
      <button class="btn ghost" id="st-theme">当前：<b id="st-theme-name"></b></button>
    </div>
    <div style="margin:14px 0">
      <div class="sub" style="margin-bottom:8px">字号</div>
      <div class="row" id="st-fonts">
        ${[14, 15, 16, 17, 18, 19].map(px => `<button class="qtool" data-px="${px}" style="font-size:${px}px">${px}</button>`).join('')}
      </div>
    </div>
    <div class="row" style="justify-content:space-between;margin:14px 0">
      <span>专注模式（隐藏侧栏，居中窄列）</span>
      <button class="btn ghost" id="st-focus"></button>
    </div>
  </div>
  <div class="card" style="max-width:640px;margin-top:16px">
    <h2 style="margin-top:0">刷题</h2>
    <div class="row" style="justify-content:space-between;gap:12px;margin:14px 0">
      <span>评分后自动下一题<br><span class="sub" style="margin:4px 0 0">默认评完立即切题；想看完解析再走可选「不自动」。手机也可向左滑动切题</span></span>
      <select id="st-autonext" style="flex:0 0 168px">
        ${[[-1, '立即（评分后马上切题）'], [0, '不自动，手动继续'], [5, '5 秒后自动'], [8, '8 秒后自动'], [12, '12 秒后自动']]
          .map(([v, t]) => `<option value="${v}" ${autoNextSec() === v ? 'selected' : ''}>${t}</option>`).join('')}
      </select>
    </div>
  </div>
  <div class="card" style="max-width:640px;margin-top:16px">
    <h2 style="margin-top:0">学习节奏</h2>
    <div class="row" style="gap:10px;flex-wrap:wrap">
      <label class="sub" style="margin:0">每日目标（题）</label>
      <input id="st-goal" type="number" min="1" max="500" style="width:90px">
      <button class="btn" id="st-goal-save">保存</button>
      <span class="sub" id="st-goal-cur" style="margin:0"></span>
    </div>
    <div class="row" style="gap:10px;flex-wrap:wrap;margin-top:14px">
      <label class="sub" style="margin:0">每日新题上限</label>
      <input id="st-lim-new" type="number" min="0" max="300" style="width:90px">
      <label class="sub" style="margin:0 0 0 12px">每日复习上限</label>
      <input id="st-lim-rev" type="number" min="0" max="2000" style="width:90px">
    </div>
    <p class="sub" style="margin:10px 0 0">超出的题会顺延到明天，不会丢；填 <b>0</b> 表示不限量。一天刷太多新题，第二天会被积压的复习题埋掉，20 / 200 是比较稳的节奏。</p>
    <div class="row" style="margin-top:12px"><button class="btn" id="st-lim-save">保存上限</button>
      <span class="sub" id="st-lim-cur" style="margin:0"></span></div>
  </div>
  <div class="card" style="max-width:640px;margin-top:16px">
    <h2 style="margin-top:0">📤 数据导出</h2>
    <p class="sub" style="margin:0 0 12px">将错题本 / 笔记导出为 Markdown 文件，可粘贴到 Obsidian、Notion 等笔记软件。导出内容仅含当前账号数据。</p>
    <div class="row">
      <button class="btn" id="st-exp-wb">📕 导出错题本 (.md)</button>
      <button class="btn" id="st-exp-note">📝 导出笔记 (.md)</button>
    </div>
  </div>
    <div class="card" style="max-width:640px;margin-top:16px">
    <h2 style="margin-top:0">👤 账号管理</h2>
    <div class="row" style="justify-content:space-between;gap:16px;flex-wrap:wrap">
      <div>当前账号：<b id="st-user">—</b>${(ME && ME.username) ? '（用户名 ' + esc(ME.username) + '）' : ''}<br><span class="sub" style="margin:4px 0 0">${(ME && ME.anon) ? '游客模式：学习数据保存在本浏览器对应的云端身份，清空浏览器数据后将无法恢复。' : '各账号的学习进度、收藏与笔记相互隔离，凭用户名 + 密码登录。'}</span></div>
      <div class="row">
        <button class="btn ghost" id="st-switch">切换账号</button>
        <button class="btn" id="st-pw">修改密码</button>
        <button class="btn" id="st-out">退出账号</button>
        <button class="btn danger" id="st-del">删除当前账号</button>
        <button class="btn ok" id="st-upgrade">升级为正式账号</button>
      </div>
    </div>
    ${(ME && ME.anon) ? '<p class="sub" style="margin:10px 0 0">游客模式无需登录即可使用；如需跨设备同步或在其它浏览器继续学习，可「升级为正式账号」设定用户名与密码。</p>' : ''}
  </div>
  <div class="card" style="max-width:640px;margin-top:16px">
    <h2 style="margin-top:0">关于</h2>
    <p class="sub" style="margin:0">题库与学习数据均保存在服务端数据库，登录后使用。共 ${BOOT.total.toLocaleString()} 题。
    重新导入题库不影响已积累的复习进度、笔记与收藏。</p>
  </div>`;
  document.getElementById('st-theme-name').textContent = themeName(getTheme());
  document.getElementById('st-theme').onclick = () => { toggleTheme(); document.getElementById('st-theme-name').textContent = themeName(getTheme()); };
  const fs = getFont();
  document.querySelectorAll('#st-fonts .qtool').forEach(b => {
    if (+b.dataset.px === fs) b.classList.add('on');
    b.onclick = () => { setFont(+b.dataset.px); document.querySelectorAll('#st-fonts .qtool').forEach(x => x.classList.remove('on')); b.classList.add('on'); };
  });
  const fbtn = document.getElementById('st-focus');
  const syncFocus = () => { fbtn.textContent = isFocus() ? '已开启 · 关闭' : '已关闭 · 开启'; fbtn.className = 'btn ' + (isFocus() ? 'ok' : 'ghost'); };
  syncFocus(); fbtn.onclick = () => { setFocus(!isFocus()); syncFocus(); };
  const anSel = document.getElementById('st-autonext');
  if (anSel) anSel.onchange = () => setAutoNext(+anSel.value);
  API('/api/streak').then(s => {
    document.getElementById('st-goal').value = s.goal;
    document.getElementById('st-goal-cur').textContent = '今日 ' + s.today + '/' + s.goal;
  });
  document.getElementById('st-goal-save').onclick = async (e) => {
    const b = e.currentTarget;
    if (b.classList.contains('busy')) return;
    const v = +document.getElementById('st-goal').value || 20;
    const restore = busyBtn(b, '保存中…');
    try {
      await POST('/api/goal', { value: v });
      const s = await API('/api/streak');
      document.getElementById('st-goal-cur').textContent = '今日 ' + s.today + '/' + s.goal;
      toast('已保存每日目标：' + v + ' 题');
    } catch (err) { toast('保存失败：' + (err && err.message ? err.message : err), 'bad'); }
    finally { restore(); }
  };
  /* 每日新题 / 复习上限：超量顺延到明天，避免「一天爽刷、第二天被复习埋掉」 */
  const limNew = document.getElementById('st-lim-new'), limRev = document.getElementById('st-lim-rev');
  const syncLim = (s) => {
    limNew.value = s.limit_new; limRev.value = s.limit_review;
    document.getElementById('st-lim-cur').textContent = `今日已用：新题 ${s.today_new} · 复习 ${s.today_review}`;
  };
  API('/api/stats').then(syncLim).catch(() => { });
  document.getElementById('st-lim-save').onclick = async (e) => {
    const b = e.currentTarget;
    if (b.classList.contains('busy')) return;
    const restore = busyBtn(b, '保存中…');
    try {
      await POST('/api/limits', { daily_new: +limNew.value || 0, daily_review: +limRev.value || 0 });
      syncLim(await API('/api/stats'));
      scheduleSide(0);
      toast('已保存每日上限');
    } catch (err) { toast('保存失败：' + (err && err.message ? err.message : err), 'bad'); }
    finally { restore(); }
  };
  // 功能5：导出 / 功能6：账号管理
  document.getElementById('st-exp-wb').onclick = async (e) => {
    const b = e.currentTarget;
    const restore = busyBtn(b, '导出中…');
    try {
      const d = await API('/api/export/wrongbook');
      if (!d.text) { toast('当前账号还没有错题'); return; }
      downloadMd(d.filename, d.text);
      toast('已生成 ' + d.filename);
    } catch (err) { toast('导出失败：' + (err && err.message ? err.message : err), 'bad'); }
    finally { restore(); }
  };
  document.getElementById('st-exp-note').onclick = async (e) => {
    const b = e.currentTarget;
    const restore = busyBtn(b, '导出中…');
    try {
      const d = await API('/api/export/notes');
      if (!d.text) { toast('当前账号还没有笔记'); return; }
      downloadMd(d.filename, d.text);
      toast('已生成 ' + d.filename);
    } catch (err) { toast('导出失败：' + (err && err.message ? err.message : err), 'bad'); }
    finally { restore(); }
  };
  const su = document.getElementById('st-user'); if (su) su.textContent = ME ? (ME.name || ME.username) : '未登录';
  const anon = !!(ME && ME.anon);
  if (document.getElementById('st-switch')) document.getElementById('st-switch').onclick = logoutUser;   // 切换账号 = 退出后用另一账号登录
  const pwBtn = document.getElementById('st-pw'); if (pwBtn) pwBtn.style.display = anon ? 'none' : '';
  const delBtn = document.getElementById('st-del'); if (delBtn) delBtn.style.display = anon ? 'none' : '';
  const upBtn = document.getElementById('st-upgrade'); if (upBtn) upBtn.style.display = anon ? '' : 'none';
  if (pwBtn) pwBtn.onclick = changePassword;
  document.getElementById('st-out').onclick = logoutUser;
  if (delBtn) delBtn.onclick = doDeleteUser;
  if (upBtn) upBtn.onclick = upgradeAccount;
}

/* 游客账号升级为正式账号：设定用户名 + 密码，解除匿名 */
function upgradeAccount() {
  const box = document.createElement('div');
  box.className = 'modal-mask';
  box.innerHTML = `<div class="modal card">
    <h2 style="margin-top:0">🛡️ 升级为正式账号</h2>
    <p class="sub" style="margin-bottom:14px">为游客身份设定用户名和密码后，即可在任何浏览器凭账号登录、继续你的学习进度（数据不变）。</p>
    <label class="fld" style="display:block;margin-bottom:8px">用户名<input id="up-user" size="20" autocomplete="username"></label>
    <label class="fld" style="display:block;margin-bottom:8px">密码（至少 6 位）<input id="up-pw" type="password" size="20" autocomplete="new-password"></label>
    <button class="btn ok" id="up-go" style="width:100%">升级并保存</button>
    <button class="btn ghost" id="up-cancel" style="width:100%;margin-top:8px">取消</button>
  </div>`;
  document.body.appendChild(box);
  const $ = id => box.querySelector('#' + id);
  const cancel = () => box.remove();
  box.querySelector('#up-cancel').onclick = cancel;
  box.onclick = e => { if (e.target === box) cancel(); };
  $('up-go').onclick = async () => {
    const username = $('up-user').value.trim();
    const password = $('up-pw').value;
    if (!username || password.length < 6) { alert('用户名不能为空，密码至少 6 位'); return; }
    const go = $('up-go');
    if (go.disabled) return;
    const restore = busyBtn(go, '正在升级…');
    try {
      const r = await POST('/api/auth/upgrade', { username, password });
      if (!r.ok) { restore(); alert(r.error || '升级失败'); return; }
      onLoginOk(r); box.remove(); location.reload();
    } catch (e) { restore(); alert('操作失败：' + e); }
  };
  $('up-user').focus();
}

/* ---------- 主题 / 字号 / 专注 ---------- */
const THEME_ORDER = ['dark', 'light', 'auto'];
function getTheme() { try { return localStorage.getItem('kg_theme') || 'dark'; } catch (e) { return 'dark'; } }
function themeName(t) { return { dark: '暗色', light: '亮色', auto: '跟随系统' }[t] || t; }
function resolveReal(t) {
  if (t === 'auto') return (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  return t;
}
function applyTheme(t) {
  const real = resolveReal(t);
  document.documentElement.setAttribute('data-theme', real);
  const b = document.getElementById('theme-toggle');
  if (b) { b.textContent = real === 'light' ? '🌙' : (t === 'auto' ? '🌓' : '☀️'); b.title = '主题：' + themeName(t) + '（点击切换）'; }
}
function toggleTheme() {
  const cur = getTheme();
  const next = THEME_ORDER[(THEME_ORDER.indexOf(cur) + 1) % THEME_ORDER.length];
  try { localStorage.setItem('kg_theme', next); } catch (e) { }
  applyTheme(next);
}
function getFont() { try { return +(localStorage.getItem('kg_fontscale')) || 15; } catch (e) { return 15; } }
function setFont(px) { try { localStorage.setItem('kg_fontscale', px); } catch (e) { } document.documentElement.style.fontSize = px + 'px'; }
function isFocus() { return document.documentElement.getAttribute('data-focus') === '1'; }
function setFocus(on) {
  if (on) document.documentElement.setAttribute('data-focus', '1'); else document.documentElement.removeAttribute('data-focus');
  try { localStorage.setItem('kg_focus', on ? '1' : '0'); } catch (e) { }
}

/* ---------- 账号：登录 / 注册 / 退出 / 密码 ---------- */
function syncUserChip() {
  const el = document.getElementById('user-name'); if (!el) return;
  el.textContent = ME ? (ME.name || ME.username) : '未登录';
}

function onLoginOk(d) {
  setTok(d.token); ME = d.user;
  try { localStorage.removeItem('kg_cur_user'); } catch (e) { }   // 老标识不再使用
  syncUserChip();
}

/* 登录 / 注册界面（未登录时全屏，不列出任何账号名，避免泄露他人昵称） */
function showLogin(msg) {
  document.querySelectorAll('.modal-mask').forEach(m => m.remove());
  const box = document.createElement('div');
  box.className = 'modal-mask';
  box.innerHTML = `<div class="modal card">
    <h2 style="margin-top:0">🔐 考公脑库</h2>
    <p class="sub" style="margin-bottom:14px">${msg ? esc(msg) + '<br>' : ''}登录后使用，各账号的学习数据相互隔离。</p>
    <div class="row" style="gap:8px;margin-bottom:12px">
      <button class="qtool on" id="lg-tab-login">登录</button>
      <button class="qtool" id="lg-tab-reg">注册新账号</button>
    </div>
    <label class="fld" style="display:block;margin-bottom:8px">用户名<input id="lg-user" size="20" autocomplete="username"></label>
    <label class="fld" style="display:block;margin-bottom:8px">密码<input id="lg-pw" type="password" size="20" autocomplete="current-password"></label>
    <label class="fld" id="lg-name-wrap" style="display:none;margin-bottom:8px">昵称（可留空）<input id="lg-name" size="20" maxlength="12"></label>
    <button class="btn ok" id="lg-go" style="width:100%">登录</button>
    <div class="guest-sep"><span>或</span></div>
    <button class="btn guest" id="lg-guest" style="width:100%">🚪 游客模式 · 免注册直接使用</button>
    <p class="sub" style="margin:12px 0 0;font-size:12px">💡 首次使用点「注册新账号」。用户名 2-20 字，密码至少 6 位。<br>游客模式无需账号，进度仅保存在本浏览器对应的云端身份，清空浏览器数据后将无法恢复。</p>
  </div>`;
  document.body.appendChild(box);
  const $ = id => box.querySelector('#' + id);
  let mode = 'login';
  const setMode = m => {
    mode = m;
    $('lg-tab-login').classList.toggle('on', m === 'login');
    $('lg-tab-reg').classList.toggle('on', m === 'reg');
    $('lg-go').textContent = m === 'login' ? '登录' : '注册并进入';
    $('lg-name-wrap').style.display = m === 'reg' ? 'block' : 'none';
  };
  $('lg-tab-login').onclick = () => setMode('login');
  $('lg-tab-reg').onclick = () => setMode('reg');
  const submit = async () => {
    const username = $('lg-user').value.trim();
    const password = $('lg-pw').value;
    if (!username || !password) { alert('请输入用户名和密码'); return; }
    const go = $('lg-go');
    if (go.disabled) return;
    const restore = busyBtn(go, mode === 'reg' ? '注册中…' : '登录中…');
    try {
      if (mode === 'reg') {
        const r = await fetch('/api/auth/register', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password, name: $('lg-name').value.trim() }),
        }).then(r => r.json());
        if (!r.ok) { restore(); alert(r.error || '注册失败'); return; }
        onLoginOk(r); box.remove(); location.reload();
      } else {
        const r = await fetch('/api/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        }).then(r => r.json());
        if (r.need_password) { box.remove(); return showSetPassword(username); }
        if (!r.ok) { restore(); alert(r.error || '登录失败'); return; }
        onLoginOk(r); box.remove(); location.reload();
      }
    } catch (e) { restore(); alert('操作失败：' + e); }
  };
  $('lg-go').onclick = submit;
  $('lg-pw').onkeydown = e => { if (e.key === 'Enter') submit(); };
  $('lg-guest').onclick = async () => {
    const g = $('lg-guest');
    if (g.disabled) return;
    const restore = busyBtn(g, '正在创建游客身份…');
    try {
      const r = await fetch('/api/auth/guest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      }).then(r => r.json());
      if (!r.ok) { restore(); alert(r.error || '进入游客模式失败'); return; }
      onLoginOk(r); box.remove(); location.reload();
    } catch (e) { restore(); alert('操作失败：' + e); }
  };
  $('lg-user').focus();
}

/* 老账号首次补设密码 */
function showSetPassword(username) {
  const box = document.createElement('div');
  box.className = 'modal-mask';
  box.innerHTML = `<div class="modal card">
    <h2 style="margin-top:0">🔑 为账号设置密码</h2>
    <p class="sub" style="margin-bottom:14px">账号「${esc(username)}」还没有设置密码。请设置一个密码来保护你的学习记录，设置后其他人就无法进入你的账号。</p>
    <label class="fld" style="display:block;margin-bottom:8px">用户名<input id="sp-user" size="20" value="${esc(username)}"></label>
    <label class="fld" style="display:block;margin-bottom:8px">新密码（至少 6 位）<input id="sp-pw" type="password" size="20" autocomplete="new-password"></label>
    <button class="btn ok" id="sp-go" style="width:100%">设置密码并进入</button>
    <button class="btn ghost" id="sp-cancel" style="width:100%;margin-top:8px">返回登录</button>
    <p class="sub" style="margin:12px 0 0;font-size:12px">⚠️ 无密码的老账号只能在本机完成首次设密；若提示无法设置，请在部署服务的电脑上操作，或改用其他账号。</p>
  </div>`;
  document.body.appendChild(box);
  const $ = id => box.querySelector('#' + id);
  $('sp-cancel').onclick = () => { box.remove(); showLogin(''); };
  const submit = async () => {
    const username2 = $('sp-user').value.trim();
    const password = $('sp-pw').value;
    if (!username2 || password.length < 6) { alert('密码至少 6 位'); return; }
    const go = $('sp-go');
    if (go.disabled) return;
    const restore = busyBtn(go, '正在设置…');
    let legacy_id = '';
    try { legacy_id = localStorage.getItem('kg_cur_user') || ''; } catch (e) { }
    try {
      const r = await fetch('/api/auth/claim', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username2, password, legacy_id }),
      }).then(r => r.json());
      if (!r.ok) { restore(); alert(r.error || '设置失败'); return; }
      onLoginOk(r); box.remove(); location.reload();
    } catch (e) { restore(); alert('操作失败：' + e); }
  };
  $('sp-go').onclick = submit;
  $('sp-pw').onkeydown = e => { if (e.key === 'Enter') submit(); };
  $('sp-pw').focus();
}

/* 账号菜单：只显示自己，不列出他人账号 */
function openUserMenu() {
  const box = document.createElement('div');
  box.className = 'modal-mask';
  box.innerHTML = `<div class="modal card">
    <h2 style="margin-top:0">👤 账号</h2>
    <p class="sub" style="margin-bottom:14px">当前登录：<b>${esc((ME && ME.name) || '—')}</b>${(ME && ME.username) ? '（用户名 ' + esc(ME.username) + '）' : ''}</p>
    <button class="btn" id="um-pw" style="width:100%;margin-bottom:8px">🔑 修改密码</button>
    <button class="btn danger" id="um-out" style="width:100%;margin-bottom:8px">退出账号</button>${(ME && ME.anon) ? '<p class="sub" style="margin:0">游客模式：退出将清除本浏览器的全部学习数据。</p>' : ''}
    <a class="btn ghost" href="#/settings" style="width:100%;margin-bottom:8px" onclick="document.querySelector('.modal-mask').remove()">⚙ 账号管理</a>
    <button class="btn ghost" id="um-close" style="width:100%">关闭</button>
  </div>`;
  document.body.appendChild(box);
  const close = () => box.remove();
  box.querySelector('#um-close').onclick = close;
  box.onclick = e => { if (e.target === box) close(); };
  box.querySelector('#um-out').onclick = () => { close(); logoutUser(); };
  box.querySelector('#um-pw').onclick = () => { close(); changePassword(); };
  if (ME && ME.anon) {
    const pwBtn = box.querySelector('#um-pw');
    if (pwBtn) pwBtn.remove();
  }
}

function changePassword() {
  const box = document.createElement('div');
  box.className = 'modal-mask';
  box.innerHTML = `<div class="modal card">
    <h2 style="margin-top:0">🔑 修改密码</h2>
    <label class="fld" style="display:block;margin-bottom:8px">原密码<input id="cp-old" type="password" size="20"></label>
    <label class="fld" style="display:block;margin-bottom:12px">新密码（至少 6 位）<input id="cp-new" type="password" size="20" autocomplete="new-password"></label>
    <div class="row" style="justify-content:flex-end">
      <button class="btn ghost" id="cp-cancel">取消</button>
      <button class="btn ok" id="cp-go">确认修改</button>
    </div>
  </div>`;
  document.body.appendChild(box);
  const $ = id => box.querySelector('#' + id);
  $('cp-cancel').onclick = () => box.remove();
  $('cp-go').onclick = async () => {
    const old_password = $('cp-old').value, password = $('cp-new').value;
    if (password.length < 6) { alert('新密码至少 6 位'); return; }
    const go = $('cp-go');
    if (go.disabled) return;
    const restore = busyBtn(go, '提交中…');
    try {
      const r = await POST('/api/auth/password', { old_password, password });
      if (!r.ok) { restore(); alert(r.error || '修改失败'); return; }
      onLoginOk(r); box.remove(); toast('密码已修改 ✓');
    } catch (e) { restore(); alert('操作失败：' + e); }
  };
}

/* 退出账号：清除本机登录凭证，数据仍安全保存在服务端 */
async function logoutUser() {
  if (!confirm('退出当前账号？\n你的学习数据仍安全保存在服务器上，之后用用户名和密码即可重新登录。')) return;
  showMask('正在退出…');
  await fetch('/api/auth/logout', {
    method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: '{}',
  }).catch(() => { });
  setTok(''); ME = null;
  location.reload();
}

async function doDeleteUser() {
  if (!ME) return;
  if (!confirm(`确定删除账号「${ME.name}」吗？\n该账号的复习进度、错题本、收藏和笔记将被永久清除，且无法恢复。`)) return;
  if (!confirm('再次确认：此操作不可撤销，真的要删除吗？')) return;
  const password = prompt('请输入当前密码以确认删除：');
  if (password === null) return;
  showMask('正在删除账号及其学习数据…');
  try {
    const r = await POST('/api/users/delete', { password });
    if (!r.ok) { hideMask(); alert(r.error || '删除失败'); return; }
  } catch (e) {
    hideMask(); alert('操作失败：' + e); return;
  }
  hideMask();
  setTok(''); ME = null;
  location.reload();
}

/* ---------- boot ---------- */
(async function boot() {
  // 注意：跳转中(HEALING)不 return。若 location.replace 因故未生效，
  // 页面还能继续正常渲染，避免永远停在"加载中…"。
  applyTheme(getTheme());
  setFont(getFont());
  const tb = document.getElementById('theme-toggle'); if (tb) tb.onclick = toggleTheme;
  const fe = document.getElementById('focus-exit'); if (fe) fe.onclick = () => { setFocus(false); };
  if (window.matchMedia) {
    try { matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (getTheme() === 'auto') applyTheme('auto'); }); } catch (e) { }
  }
  // bootstrap 与 auth/me 并行发起（省一个往返 RTT；me 依赖的 token 在 localStorage，无先后依赖）
  const bootP = API('/api/bootstrap').then(b => ({ ok: true, b }), e => ({ ok: false, e }));
  const meP = fetch('/api/auth/me', { headers: authHeaders() })
    .then(r => r.json()).catch(() => null);
  const br = await bootP;
  if (!br.ok) return fatal('后端未就绪：' + br.e);
  BOOT = br.b;

  // 判断是否已登录：未登录则显示登录 / 注册界面
  let me = (await meP) || { ok: false };
  if (me && me.ok && me.user) {
    ME = me.user;
  } else {
    setTok('');
    let legacy = '';
    try { legacy = localStorage.getItem('kg_cur_user') || ''; } catch (e) { }
    showLogin(legacy ? '检测到本机已有账号但尚未设置密码，请输入用户名登录后设置。' : '');
    window.__kgBooted = true;   // 登录页已经可用，index.html 的「加载慢」兜底不该再出现
    return;   // 登录成功后会 reload
  }

  const un = document.getElementById('user-name'); if (un) un.onclick = () => openUserMenu();
  syncUserChip();
  window.__kgBooted = true;
  nav().catch(() => { }); refreshSide().catch(() => { });
})();
