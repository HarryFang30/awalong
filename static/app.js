"use strict";

// =====================================================================
// 工具
// =====================================================================
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const TEAM_NAME = { good: "好人", evil: "坏人" };
const MARKS = ["", "good", "evil", "merlin"];
const MARK_TEXT = { "": "标记", good: "好人", evil: "坏人", merlin: "梅林?" };
const ACTIVE = ["created", "running"];
const NARROW = window.matchMedia("(max-width: 560px)");
const DESKTOP = window.matchMedia("(min-width: 901px)");

const S = {
  config: null,
  gameId: null,
  g: null,
  events: [],
  lastId: 0,
  ended: false,
  endShown: false,
  selected: [],
  lastPick: 0,          // 最近点选的座位（行动栏里只给它播放放入动画）
  busy: false,          // 正在提交行动
  pendingKey: null,
  marks: {},
  tipN: undefined,      // 等待时的小贴士序号
  tipTimer: null,
  pollTimer: null,
  covered: false,
  live: false,          // 首次拉取之后才算“实时”，只有实时的新事件才播放动画
  revealFresh: false,   // 刚开局：展示身份揭晓
  fx: null,             // 时刻（印章、翻牌、刺杀、胜负）的状态，见 resetFx()
};

function store(key, val) {
  try { localStorage.setItem(key, val); } catch { /* 隐私模式等 */ }
}
function load(key, def = "") {
  try { return localStorage.getItem(key) ?? def; } catch { return def; }
}
function forget(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

async function api(path, body) {
  const opt = body === undefined
    ? {}
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetch(path, opt);
  let data = {};
  try { data = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

// 只有内容变化时才写 innerHTML（轮询很频繁，避免重建 DOM、重启动画）
function patch(el, html) {
  if (el._h === html) return false;
  el._h = html;
  el.innerHTML = html;
  return true;
}
function setAttr(el, name, val) {
  if (val === null || val === undefined || val === false) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== String(val)) {
    el.setAttribute(name, val);
  }
}

const ic = (name) => ART.icon(name);
const player = (s) => S.g?.players.find((p) => p.seat === +s);
const nameOf = (s) => player(s)?.name ?? "";
// 纹章：同一个 AI 性格每局都是同一面盾（底色 + 徽记），你是羊皮纸盾 + 姓名首字
const armsOf = (s) => ART.arms(player(s));
// 小色块（队伍标签、你知道的信息）用盾面底色；你的盾是金色羊皮纸，色块用金色
const seatColor = (s) => { const a = armsOf(s); return a.me ? "#d9b45a" : a.field; };
// 可复用的迷你纹章盾：盾面 + 底部的座位号圆章。size: xs / sm / md / lg
// 对局记录、行动栏队员位、结算表、桌心队伍都用它，和圆桌上的座位长得一样
function seatEmblem(seat, size = "sm") {
  const a = armsOf(seat);
  return `<span class="emb emb-${size}${a.me ? " me" : ""}" aria-hidden="true">${ART.blazon(a, "eshield")}<b>${+seat}</b></span>`;
}
const sortSeats = (arr) => [...arr].sort((a, b) => a - b);
const seatsText = (arr) => (arr && arr.length ? sortSeats(arr).map((s) => `${s}号`).join("、") : "无");
const seatTag = (s) => `<b>${s}号</b>${player(s)?.is_human ? "（你）" : `「${esc(nameOf(s))}」`}`;
const seatChip = (s, extra = "") => `<span class="sc" style="--c:${seatColor(s)}">${s}号${extra}</span>`;
const seatChips = (arr) => (arr && arr.length ? `<span class="scs">${sortSeats(arr).map((s) => seatChip(s)).join("")}</span>` : "无");
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function md(text) {
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
  let html = "";
  let list = null;
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of esc(text).split(/\r?\n/)) {
    const t = raw.trim();
    let m;
    if (!t || /^-{3,}$/.test(t)) { close(); continue; }
    if ((m = t.match(/^#{1,6}\s+(.*)$/))) { close(); html += `<h3>${inline(m[1])}</h3>`; continue; }
    if ((m = t.match(/^[-*•]\s+(.*)$/))) {
      if (list !== "ul") { close(); html += "<ul>"; list = "ul"; }
      html += `<li>${inline(m[1])}</li>`;
      continue;
    }
    if ((m = t.match(/^\d+[.)、]\s*(.*)$/))) {
      if (list !== "ol") { close(); html += "<ol>"; list = "ol"; }
      html += `<li>${inline(m[1])}</li>`;
      continue;
    }
    close();
    html += `<p>${inline(t)}</p>`;
  }
  close();
  return html;
}

// =====================================================================
// 开局设置
// =====================================================================
async function initSetup() {
  try {
    S.config = await api("/api/config");
  } catch (err) {
    $("#setup-error").textContent = "连不上本地服务：" + err.message;
    return;
  }
  const form = $("#setup-form");
  $("#f-name").value = load("avalon.name");
  $("#f-key").value = load("avalon.key");
  $("#f-model").value = load("avalon.model");
  $("#f-model").placeholder = S.config.model;
  if (load("avalon.num")) $("#f-num").value = load("avalon.num");
  if (load("avalon.len")) $("#f-len").value = load("avalon.len");
  $("#f-lady").checked = load("avalon.lady") === "1";
  form.mode.value = load("avalon.mode") || "llm";
  $("#server-key-note").hidden = !S.config.has_server_key;

  refreshSetup();
  refreshMode();
  $("#f-num").addEventListener("change", refreshSetup);
  $("#f-seat").addEventListener("change", () => {
    $("#f-role").disabled = $("#f-seat").value === "watch";
    renderLobby();
  });
  $("#f-role").addEventListener("change", renderLobby);
  $("#f-lady").addEventListener("change", renderLobby);
  form.addEventListener("change", (e) => { if (e.target.name === "mode") refreshMode(); });
  $("#btn-check").addEventListener("click", checkKey);
  form.addEventListener("submit", startGame);
}

function refreshSetup() {
  const n = +$("#f-num").value;
  const preset = S.config.presets[n];
  const roles = S.config.roles;

  const seatSel = $("#f-seat");
  const prevSeat = seatSel.value || load("avalon.seat") || "random";
  seatSel.innerHTML = `<option value="random">随机</option>` +
    Array.from({ length: n }, (_, i) => `<option value="${i + 1}">${i + 1}号</option>`).join("") +
    `<optgroup label="不上桌，看全 AI 对局"><option value="watch">观战</option></optgroup>`;
  seatSel.value = prevSeat === "watch" || +prevSeat <= n ? prevSeat : "random";

  const roleSel = $("#f-role");
  const prevRole = roleSel.value || load("avalon.role") || "random";
  const unique = [...new Set(preset.roles)];
  const roleOpts = (team) => unique.filter((r) => roles[r].team === team)
    .map((r) => `<option value="${r}">${esc(roles[r].name)}</option>`).join("");
  roleSel.innerHTML = `<option value="random">随机（推荐）</option>` +
    `<optgroup label="好人阵营">${roleOpts("good")}</optgroup><optgroup label="坏人阵营">${roleOpts("evil")}</optgroup>`;
  roleSel.value = unique.includes(prevRole) ? prevRole : "random";
  roleSel.disabled = seatSel.value === "watch";

  const counts = {};
  preset.roles.forEach((r) => { counts[r] = (counts[r] || 0) + 1; });
  const tags = Object.entries(counts)
    .map(([r, c]) => `<span class="tag ${roles[r].team}" title="${esc(roles[r].ability)}">${ART.role(r, "emblem")}${esc(roles[r].name)}${c > 1 ? `<b>×${c}</b>` : ""}</span>`)
    .join("");
  const sizes = preset.team_sizes
    .map((z, i) => `<span class="qs${n >= 7 && i === 3 ? " two" : ""}" title="第${i + 1}轮：${z}人${n >= 7 && i === 3 ? "，需2张失败" : ""}">${z}</span>`)
    .join("");
  $("#roles-preview").innerHTML =
    `<div class="rp-row"><span class="rp-k">本局角色</span><span class="rp-v">${tags}</span></div>` +
    `<div class="rp-row"><span class="rp-k">任务人数</span><span class="rp-v">${sizes}${n >= 7 ? "<small>第4轮需2张失败</small>" : ""}</span></div>`;
  renderLobby();
}

// 开局预览：一张小圆桌，纹章盾按人数排开；你坐在正下方（观战则在桌外）
function renderLobby() {
  const box = $("#lobby-table");
  if (!box || !S.config) return;
  const n = +$("#f-num").value;
  const seatVal = $("#f-seat").value;
  const watch = seatVal === "watch";
  const mine = watch ? 0 : +seatVal || 0; // 0 = 随机座位
  const roleKey = $("#f-role").value;
  const roles = S.config.roles;
  const preset = S.config.presets[n];
  const good = preset.roles.filter((r) => roles[r].team === "good").length;
  const lady = $("#f-lady").checked;

  // 座位节点常驻，只改位置和内容：换人数时盾牌会沿桌边滑到新位置
  if (!box._seats) {
    box._seats = [];
    for (let i = 0; i <= 10; i++) {
      const el = document.createElement("span");
      el.className = "lt-seat";
      box.appendChild(el);
      box._seats.push(el);
    }
  }
  const base = mine || 1;
  const off = watch ? 0.5 : 0; // 观战：桌边留出正下方给“你”的眼睛
  box._seats.forEach((el, i) => {
    const s = i; // 0 号节点 = 观战之眼
    let show = s >= 1 && s <= n;
    let x = 50, y = 83, html = "", cls = "lt-seat";
    if (s === 0) {
      show = watch;
      cls += " eye";
      html = `<span class="lt-eye">${ic("eye")}</span><i>观战</i>`;
    } else if (show) {
      const th = Math.PI / 2 + ((s - base + off) * 2 * Math.PI) / n;
      x = 50 + 39 * Math.cos(th);
      y = 50 + 36.5 * Math.sin(th);
      const me = !watch && s === base;
      const unknown = me && !mine;
      if (me) cls += unknown ? " me unk" : " me";
      // 随机座位时号码未定：你的盾是素面“？”，其他人只画纹章不写号码
      const num = unknown ? "?" : mine || watch ? s : "";
      // 你的盾和对局里一样是金色羊皮纸；其他座位用纹章底色（人设要开局后才定）
      html = (me ? ART.blazon({ me: true }) : ART.shield(s)) + (num === "" ? "" : `<b>${num}</b>`) + (me ? "<i>你</i>" : "");
    }
    if (!show) cls += " off";
    if (el.className !== cls) el.className = cls;
    if (show) {
      el.style.left = x.toFixed(2) + "%";
      el.style.top = y.toFixed(2) + "%";
    }
    patch(el, html);
  });

  patch($("#lobby-center"),
    `<b class="lt-n">${n}<small>人局</small></b>` +
    `<span class="lt-teams"><span class="g">好人 ${good}</span><span class="e">坏人 ${n - good}</span></span>` +
    (lady ? `<span class="lt-lady">${ART.ladyBadge()}湖中仙女</span>` : ""));

  const roleText = roleKey && roleKey !== "random" && roles[roleKey] ? `扮演<b>${esc(roles[roleKey].name)}</b>` : "角色随机";
  patch($("#lobby-cap"), watch
    ? `<b>观战</b>：全 AI 对局，所有身份一览无余`
    : `${mine ? `你坐<b>${mine}号</b>位` : "座位随机"} · ${roleText}`);
}

function refreshMode() {
  const llm = $("#setup-form").mode.value === "llm";
  $("#llm-fields").classList.toggle("hidden", !llm);
}

async function checkKey() {
  const out = $("#check-result");
  out.textContent = "测试中…";
  try {
    const r = await api("/api/check-key", { api_key: $("#f-key").value.trim(), model: $("#f-model").value.trim() });
    out.textContent = (r.ok ? "✅ " : "❌ ") + r.message;
  } catch (err) {
    out.textContent = "❌ " + err.message;
  }
}

async function startGame(e) {
  e.preventDefault();
  const form = e.target;
  const body = {
    num_players: +form.num_players.value,
    name: form.name.value.trim(),
    seat: form.seat.value,
    role: form.role.value,
    speech_len: +form.speech_len.value,
    lady: form.lady.checked,
    mode: form.mode.value,
    api_key: form.api_key.value.trim(),
    model: form.model.value.trim(),
  };
  store("avalon.name", body.name);
  store("avalon.key", body.api_key);
  store("avalon.model", body.model);
  store("avalon.num", String(body.num_players));
  store("avalon.seat", body.seat);
  store("avalon.role", body.role);
  store("avalon.len", String(body.speech_len));
  store("avalon.lady", body.lady ? "1" : "0");
  store("avalon.mode", body.mode);

  const btn = $("#btn-start");
  const label = $(".bs-label", btn);
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  if (label) label.textContent = "召集骑士中…";
  $("#setup-error").textContent = "";
  try {
    const { id } = await api("/api/games", body);
    enterGame(id, true);
  } catch (err) {
    $("#setup-error").textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    if (label) label.textContent = "开始游戏";
  }
}

function showSetup(message = "") {
  clearTimeout(S.pollTimer);
  stopTips();
  S.gameId = null;
  forget("avalon.game");
  resetFx();
  document.title = "阿瓦隆练习场";
  $("#game").classList.add("hidden");
  $("#setup").classList.remove("hidden");
  $("#setup-error").textContent = message;
  if ($("#modal").open) $("#modal").close();
}

// =====================================================================
// 对局
// =====================================================================
function enterGame(id, fresh = false) {
  clearTimeout(S.pollTimer);
  resetFx();
  Object.assign(S, {
    gameId: id, g: null, events: [], lastId: 0, ended: false, endShown: false,
    selected: [], lastPick: 0, busy: false, pendingKey: null, covered: false, live: false, revealFresh: fresh,
  });
  stopTips();
  try { S.marks = JSON.parse(load("avalon.marks." + id) || "{}"); } catch { S.marks = {}; }
  store("avalon.game", id);
  $("#log").innerHTML = "";
  $("#table").querySelectorAll(".seat").forEach((el) => el.remove());
  for (const sel of ["#action", "#quest-track", "#reject-track", "#table-center", "#identity"]) {
    const el = $(sel);
    el._h = null;
    el._mode = null;
    el.innerHTML = "";
  }
  document.body.classList.remove("show-thoughts");
  $("#show-thoughts").checked = false;
  $("#thoughts-toggle").hidden = true;
  $("#setup").classList.add("hidden");
  $("#game").classList.remove("hidden");
  window.scrollTo(0, 0);
  poll();
}

async function poll() {
  clearTimeout(S.pollTimer);
  const id = S.gameId;
  if (!id) return;
  try {
    const prevLast = S.lastId;
    let st = await api(`/api/games/${id}/state?since=${S.lastId}`);
    if (id !== S.gameId) return;
    if (st.status === "ended" && !S.ended) {
      // 对局结束：重新拉取全部记录（含隐藏信息和 AI 内心独白）
      st = await api(`/api/games/${id}/state?since=0`);
      if (id !== S.gameId) return;
      S.ended = true;
      S.events = [];
      $("#log").innerHTML = "";
      $("#thoughts-toggle").hidden = false;
    }
    if (!S.g && st.spectator) {
      $("#thoughts-toggle").hidden = false;
      $("#show-thoughts").checked = true;
      document.body.classList.add("show-thoughts");
    }
    S.g = st;
    const fresh = [];
    for (const ev of st.events) {
      S.events.push(ev);
      const isNew = S.live && ev.id > prevLast;
      if (isNew) { prepMoment(ev); fresh.push(ev); }
      appendEvent(ev, isNew);
    }
    S.lastId = st.last_event_id;
    render();
    S.live = true;
    // 时刻在渲染之后再演：要用到座位的位置，桌面状态也已经是最新的
    playMoments(fresh);
    if (S.ended && !S.endShown) {
      S.endShown = true;
      // 结算卷轴等所有时刻（刺杀、胜负标题）演完再展开；刷新恢复时直接打开
      whenFxIdle(() => fxLater(showEndModal, fresh.length ? 250 : 700));
    }
    if (!ACTIVE.includes(st.status)) return;
    S.pollTimer = setTimeout(poll, st.pending ? 1500 : 700);
  } catch (err) {
    if (err.message.includes("不存在")) {
      showSetup("上一局已经不在了（服务器可能重启过），开一局新的吧。");
      return;
    }
    S.pollTimer = setTimeout(poll, 3000);
  }
}

function render() {
  renderTracks();
  renderTable();
  renderIdentity();
  renderAction();
  renderUsage();
  maybeReveal();
}

function currentRejects() {
  const g = S.g;
  return S.events.filter((e) => e.type === "vote" && e.quest === g.quest_index && !e.approved).length;
}

function renderTracks() {
  const g = S.g;
  const prev = S.fx.quests;
  // 任务翻牌还没揭晓时，顶栏的火漆先按“未出结果”画，等印章落下再盖上（不提前剧透）
  const quests = g.quests.map((q, i) => (i === S.fx.holdQuest ? { ...q, success: null } : q));
  const now = quests.map((q) => q.success);
  S.fx.quests = now;
  const html = quests.map((q, i) => {
    let cls = "";
    if (q.success === true) cls = "success";
    else if (q.success === false) cls = "fail";
    else if (i === g.quest_index && ACTIVE.includes(g.status)) cls = "current";
    let title = `第${i + 1}轮：${q.size}人`;
    if (q.fails_needed === 2) title += "，需要2张失败才失败";
    if (q.success !== null) title += `；${q.success ? "成功" : "失败"}（${q.fails}张失败）`;
    // 结果用内联 SVG（字体里的 ✓ ✗ 渲染发虚）；失败多于 1 张时在火漆下方写张数
    const face = q.success === true ? ic("check") : q.success === false ? ic("cross") : q.size;
    const fails = q.success !== null && q.fails > 1 ? `<span class="qf">${q.fails}败</span>` : "";
    return `<div class="quest ${cls}" title="${title}" aria-label="${title}"><span class="qn">${face}</span>${q.fails_needed === 2 && q.success === null ? '<span class="two">2败</span>' : ""}${fails}</div>`;
  }).join("");
  const track = $("#quest-track");
  if (patch(track, html) && prev && S.live) {
    // 新揭晓的任务：盖上火漆印（只播放一次）
    now.forEach((v, i) => { if (v !== null && prev[i] === null) track.children[i]?.classList.add("just"); });
  }
  const r = currentRejects();
  patch($("#reject-track"), Array.from({ length: 5 }, (_, i) =>
    `<i class="${i < r ? "on" : ""} ${i === 4 ? "last" : ""}"></i>`).join("") + `<span class="sr-only">已否决 ${r} 次</span>`);
}

// 最近一次投票；新的提名开始后它就“过时”了：座位上的票型缩小变暗，但仍然看得清
function lastVote() {
  let stale = false;
  for (let i = S.events.length - 1; i >= 0; i--) {
    const t = S.events[i].type;
    if (t === "vote") return { ev: S.events[i], stale };
    if (t === "proposal" || t === "quest_start" || t === "evil_reveal") stale = true;
  }
  return null;
}

function selection() {
  const p = S.g.pending;
  if (!p) return null;
  if (p.type === "propose") return { seats: S.g.players.map((x) => x.seat), max: p.size, type: p.type };
  if (["lady_choose", "assassin_suggest", "assassinate"].includes(p.type)) return { seats: p.candidates, max: 1, type: p.type };
  return null;
}

// ---------------------------------------------------------------------
// 座位排布：沿椭圆按“弧长”等距排开（宽桌子两侧不会挤成一摞），你永远坐在正下方。
// 椭圆大小按圆桌区域的实际宽高算：上方留出王冠，下方留出名牌和标签，两侧留出名牌半宽。
// 只有尺寸、人数或你的座位变化时才重新计算；平时轮询不会改动任何样式。
// ---------------------------------------------------------------------
const RING = { key: "", pos: {}, side: {} };

// 沿椭圆按弧长等分 n 个座位（从正下方开始，顺时针：下 → 左 → 上 → 右）
function ringPoints(n, rx, ry) {
  const M = 720;
  const cum = [0];
  let px = 0, py = ry;
  for (let i = 1; i <= M; i++) {
    const t = Math.PI / 2 + (i / M) * 2 * Math.PI;
    const x = rx * Math.cos(t), y = ry * Math.sin(t);
    cum.push(cum[i - 1] + Math.hypot(x - px, y - py));
    px = x; py = y;
  }
  const L = cum[M];
  const pts = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const target = (k * L) / n;
    while (j < M && cum[j + 1] < target) j++;
    const f = cum[j + 1] > cum[j] ? (target - cum[j]) / (cum[j + 1] - cum[j]) : 0;
    const tArc = Math.PI / 2 + ((j + f) / M) * 2 * Math.PI;
    const tEq = Math.PI / 2 + (k * 2 * Math.PI) / n;
    const t = 0.8 * tArc + 0.2 * tEq; // 以弧长为主，稍微向等角靠一点
    pts.push({ c: Math.cos(t), s: Math.sin(t) });
  }
  return pts;
}

function ringLayout() {
  const g = S.g;
  const wrap = $(".table-wrap");
  const table = $("#table");
  if (!g || !table) return false;
  const W = table.clientWidth, H = table.clientHeight;
  if (!W || !H) return false;
  const base = g.you ? g.you.seat : 1;
  const key = `${W}x${H}|${g.n}|${base}|${window.innerWidth}x${window.innerHeight}`;
  if (key === RING.key) return false;
  RING.key = key;

  const cs = getComputedStyle(table);
  const num = (name, def) => { const v = parseFloat(cs.getPropertyValue(name)); return Number.isFinite(v) ? v : def; };
  const m = {
    sh: num("--sh", 56),            // 盾牌宽
    up: num("--seat-up", 54),       // 盾心以上要留的空间（王冠）
    down: num("--seat-down", 84),   // 盾心以下（座位号圆章 + 名牌 + 标签）
    side: num("--seat-side", 56),   // 竖排座位的半宽
    info: num("--info-w", 96),      // 横排座位：名牌那一侧的宽度
    gx: num("--rim-gx", 54),        // 座位环比桌沿宽出多少
    gy: num("--rim-gy", 12),
    aspect: num("--ring-aspect", 2.1),
  };
  const n = g.n;
  const ry = Math.max(30, (H - m.up - m.down) / 2);
  const cy = m.up + ry;
  const place = (halfW) => {
    const rx = Math.max(30, Math.min(W / 2 - halfW, ry * m.aspect));
    return { rx, pts: ringPoints(n, rx, ry).map((p) => ({ ...p, x: rx * p.c, y: ry * p.s })) };
  };
  // 先按竖排（盾在上、名牌在下）排；两侧相邻的座位挤在一起、而桌子又够宽时，
  // 把两侧的座位改成横排：盾牌贴着桌沿，名牌和标签放到外侧的木头上
  let lay = place(m.side);
  const crowded = lay.pts.some((a, i) => {
    const b = lay.pts[(i + 1) % n];
    return Math.abs(a.x - b.x) < 2 * m.side - 10 && Math.abs(a.y - b.y) < m.down + m.up * 0.85;
  });
  const sideHalf = m.sh / 2 + m.sh * 0.26 + 3 + m.info;
  const sideMode = crowded && W / 2 - sideHalf >= ry * 1.15;
  if (sideMode) lay = place(sideHalf);

  RING.pos = {};
  RING.side = {};
  lay.pts.forEach((p, k) => {
    const seat = ((base - 1 + k) % n) + 1;
    RING.pos[seat] = {
      left: `${((100 * (W / 2 + p.x)) / W).toFixed(3)}%`,
      top: `${((100 * (cy + p.y)) / H).toFixed(3)}%`,
    };
    RING.side[seat] = sideMode && Math.abs(p.c) > 0.55 ? (p.c < 0 ? "side-l" : "side-r") : "";
  });
  const oy = Math.max(24, ry - m.gy);
  const ox = Math.max(30, Math.min(lay.rx - (sideMode ? m.sh * 0.5 + 18 : m.gx), oy * 1.72));
  const vars = { "--cy": `${cy.toFixed(1)}px`, "--ox": `${ox.toFixed(1)}px`, "--oy": `${oy.toFixed(1)}px` };
  for (const [k, v] of Object.entries(vars)) if (wrap.style.getPropertyValue(k) !== v) wrap.style.setProperty(k, v);
  return true;
}

function placeSeat(el, seat) {
  const pos = RING.pos[seat];
  if (!pos) return;
  // 浏览器会把 "12.300%" 规范成 "12.3%"，所以记住上次写入的值来比较，避免每次轮询都改样式
  const k = pos.left + "," + pos.top;
  if (el._pos === k) return;
  el._pos = k;
  el.style.left = pos.left;
  el.style.top = pos.top;
}

function placeSeats() {
  if (!S.g || !ringLayout()) return;
  renderTable(); // 横排/竖排可能变了，连同位置一起更新
}
if (window.ResizeObserver) new ResizeObserver(placeSeats).observe($("#table"));
// 左栏只允许竖向滚动：键盘聚焦 / scrollIntoView 到桌边的座位时，浏览器可能把它横向滚开一截
$(".left").addEventListener("scroll", (e) => { if (e.target.scrollLeft) e.target.scrollLeft = 0; }, { passive: true });

function labelClass(text) {
  if (/坏/.test(text)) return "evil";
  if (/梅林/.test(text)) return "merlin";
  return "good";
}

const PICK_ICON = { propose: "check", lady_choose: "waves", assassin_suggest: "dagger", assassinate: "dagger" };

function renderTable() {
  const g = S.g;
  const sel = selection();
  const team = g.proposal || [];
  const lv = S.ended ? null : lastVote();
  const vote = lv?.ev;
  const freshVote = vote && !lv.stale && vote.id === S.fx.voteId && performance.now() - S.fx.voteAt < 1500;
  const table = $("#table");
  const tcls = ["table"];
  if (sel) tcls.push("picking", `pick-${sel.type}`);
  if (g.n >= 9) tcls.push("crowded");
  const tclass = tcls.join(" ");
  if (table.className !== tclass) table.className = tclass;
  // 终局时所有身份公开；刺杀的匕首落下之前先不亮出来（holdRoles），观战一直公开
  const open = g.spectator || (S.ended && !S.fx.holdRoles);
  ringLayout();
  const seen = new Set();
  g.players.forEach((p) => {
    seen.add(String(p.seat));
    let el = table.querySelector(`.seat[data-seat="${p.seat}"]`);
    if (!el) {
      el = document.createElement("div");
      el.dataset.seat = p.seat;
      el.innerHTML = `<div class="avatar"></div><div class="plate"><span class="name"></span><span class="mk"></span></div><div class="labels"></div>`;
      table.appendChild(el);
    }
    const [avatarEl, plateEl, labelsEl] = el.children;
    const [nameEl, mkEl] = plateEl.children;

    const cls = ["seat"];
    if (p.is_human) cls.push("me");
    if (team.includes(p.seat)) cls.push("on-team");
    let selectable = false;
    if (sel) {
      if (sel.seats.includes(p.seat)) { cls.push("selectable"); selectable = true; } else cls.push("dim");
      if (S.selected.includes(p.seat)) cls.push("selected");
    }
    if (g.thinking.includes(p.seat)) cls.push("thinking");
    if (p.role_name && open) cls.push("revealed", `team-${p.team}`);
    if (RING.side[p.seat]) cls.push(RING.side[p.seat]);
    const className = cls.join(" ");
    if (el.className !== className) el.className = className;
    placeSeat(el, p.seat);

    // 纹章盾 + 座位号圆章 + 各种徽记
    const isLeader = g.leader === p.seat && ACTIVE.includes(g.status);
    let chip = "";
    if (vote) {
      const v = vote.votes[String(p.seat)];
      if (v !== undefined) {
        chip = `<span class="vote-chip ${v ? "yes" : "no"}${lv.stale ? " stale" : ""}" title="${lv.stale ? "上一次投票：" : ""}${v ? "赞成" : "反对"}" style="--i:${p.seat}">${ic(v ? "check" : "cross")}</span>`;
      }
    }
    const pickIc = PICK_ICON[sel?.type] || "check";
    const avatarHtml = ART.blazon(ART.arms(p)) + `<span class="num">${p.seat}</span>` +
      (isLeader ? `<span class="crown" title="队长">${ART.crownBadge()}</span>` : "") +
      (g.lady_enabled && g.lady_holder === p.seat ? `<span class="lady" title="湖中仙女">${ART.ladyBadge()}</span>` : "") +
      chip +
      `<span class="think" aria-hidden="true"><i></i><i></i><i></i></span>` +
      `<span class="badge tb" aria-hidden="true">${ic("swords")}</span>` +
      `<span class="badge sb sb-${sel?.type || "none"}" aria-hidden="true">${ic(pickIc)}</span>`;
    if (patch(avatarEl, avatarHtml) && freshVote) avatarEl.querySelector(".vote-chip")?.classList.add("pop");
    setAttr(avatarEl, "title", p.is_human ? "你" : `${p.name}：${p.persona}`);
    setAttr(avatarEl, "role", selectable ? "button" : null);
    setAttr(avatarEl, "tabindex", selectable ? "0" : null);
    setAttr(avatarEl, "aria-pressed", selectable ? String(S.selected.includes(p.seat)) : null);
    setAttr(avatarEl, "aria-label", `${p.seat}号 ${p.name}${p.is_human ? "（你）" : ""}`);

    patch(nameEl, `${esc(p.name)}${p.is_human ? "<small>（你）</small>" : ""}`);

    const labels = [];
    if (p.role_name && open && (S.ended || !p.is_human)) {
      labels.push(`<span class="label ${p.team}">${esc(p.role_name)}</span>`);
    } else if (p.known) {
      labels.push(`<span class="label ${labelClass(p.known)}">${esc(p.known)}</span>`);
    }
    const mark = S.marks[p.seat] || "";
    const markBtn = p.is_human || g.spectator ? ""
      : `<button class="mark" data-mark="${mark}" title="记下你对TA的判断（点击切换）" aria-label="标记 ${p.seat}号：${MARK_TEXT[mark]}">${MARK_TEXT[mark]}</button>`;
    patch(mkEl, markBtn);
    patch(labelsEl, labels.join(""));
  });
  table.querySelectorAll(".seat").forEach((el) => { if (!seen.has(el.dataset.seat)) el.remove(); });
  patch($("#table-center"), centerText());
}

// 桌心的一排小盾：已选的队员 + 虚线空位
function teamSlots(seats, need = 0) {
  const list = sortSeats(seats || []);
  let html = list.map((s) => `<span class="slot on" title="${s}号 ${esc(nameOf(s))}">${seatEmblem(s, "sm")}</span>`).join("");
  for (let i = list.length; i < need; i++) html += `<span class="slot">${ART.slotShield()}</span>`;
  return html ? `<div class="tc-slots">${html}</div>` : "";
}

function centerText() {
  const g = S.g;
  if (g.status === "ended") {
    return `<div class="tc-kicker">对局结束</div><div class="phase win-${g.winner}">${g.winner === "good" ? "好人" : "坏人"}阵营获胜</div><div class="tc-line">${esc(g.end_reason)}</div>`;
  }
  if (g.status === "error") return `<div class="phase">出错了</div><div class="tc-line">${esc(g.error)}</div>`;
  if (g.status === "cancelled") return `<div class="phase">对局已结束</div>`;
  // 轮到你点人：桌心直接告诉你点几个、点了几个
  const sel = selection();
  if (sel) {
    const need = sel.max;
    const verb = { propose: "点选队员", lady_choose: "点选查验对象", assassin_suggest: "点选你怀疑的梅林", assassinate: "点选刺杀目标" }[sel.type];
    const kicker = {
      propose: `你是队长 · 第${g.quest_index + 1}轮第${Math.max(1, g.attempt)}次提名`,
      lady_choose: "湖中仙女在你手中",
      assassin_suggest: "刺杀讨论",
      assassinate: "你是刺客 · 一击定胜负",
    }[sel.type];
    const done = S.selected.length === need;
    return `<div class="tc-kicker">${kicker}</div>` +
      `<div class="phase pick${sel.type === "assassinate" || sel.type === "assassin_suggest" ? " evil-text" : ""}">${verb} <span class="cnt${done ? " done" : ""}"><b>${S.selected.length}</b>/${need}</span></div>` +
      teamSlots(S.selected, need);
  }
  const head = `第${g.quest_index + 1}轮任务 · 第${Math.max(1, g.attempt)}次提名`;
  const phase = {
    setup: "准备中",
    propose: `队长 ${g.leader}号 正在组队`,
    discuss: "大家正在发言",
    vote: "投票中",
    quest: "任务进行中",
    lady: "湖中仙女查验中",
    assassinate: "刺杀阶段：坏人正在寻找梅林",
  }[g.phase] || "";
  if (g.phase === "assassinate") return `<div class="tc-kicker">好人三胜</div><div class="phase evil-text">刺杀阶段</div><div class="tc-line">坏人正在讨论谁是梅林</div>`;
  if (g.phase === "lady") return `<div class="tc-kicker">第${g.quest_index}轮之后</div><div class="phase">湖中仙女</div><div class="tc-line">${phase}</div>`;
  const q = g.quests[g.quest_index];
  const kicker = q ? `<div class="tc-kicker">${q.size}人出征${q.fails_needed === 2 ? " · 需2张失败" : ""}</div>` : "";
  return `${kicker}<div class="phase">${head}</div><div class="tc-line">${phase}</div>${g.proposal ? teamSlots(g.proposal) : ""}`;
}

function renderIdentity() {
  const y = S.g.you;
  const box = $("#identity");
  if (!y) {
    const cls = S.g.spectator ? "identity spectator" : "identity";
    if (box.className !== cls) box.className = cls;
    patch(box, S.g.spectator
      ? `<div class="secret"><div class="id-art">${ART.icon("eye", "emblem")}<span class="id-no">观战</span></div>
         <div class="id-body"><div class="kicker">上帝视角</div><div class="role">观战模式</div>
         <p class="ability">所有身份公开，AI 的内心独白会实时出现在对局记录里。看看梅林怎么藏、刺客怎么找、坏人怎么配合。</p></div></div>`
      : "");
    return;
  }
  const know = y.knowledge.length
    ? y.knowledge.map((k) => `<span class="kchip ${labelClass(k.label)}"><i style="--c:${seatColor(k.seat)}"></i>${k.seat}号 · ${esc(k.label)}</span>`).join("")
    : `<span class="know-none">没有额外信息，全靠推理。</span>`;
  const tip = y.team === "evil" && y.role !== "oberon"
    ? `<p class="tip">坏人默契：已知队友同车且只需1张失败时，由座位号最小的坏人出失败。</p>` : "";
  const cls = `identity ${y.team}${S.covered ? " covered" : ""}`;
  if (box.className !== cls) box.className = cls;
  patch(box, `
    <button class="ghost peek" id="btn-cover" aria-pressed="${S.covered}">${S.covered ? "显示" : "遮住"}</button>
    <div class="secret">
      <div class="id-art">${ART.role(y.role)}<span class="id-no">${y.seat}号</span></div>
      <div class="id-body">
        <div class="kicker">你的身份 · ${y.seat}号座位</div>
        <div class="role">${esc(y.role_name)}<span class="team">${TEAM_NAME[y.team]}阵营</span></div>
        <p class="ability">${esc(y.ability)}</p>
        <div class="know"><span class="know-k">你知道</span>${know}</div>
        ${tip}
      </div>
    </div>
    <div class="card-back" aria-hidden="true"><span>身份已遮住</span></div>`);
}
$("#identity").addEventListener("click", (e) => {
  if (!e.target.closest("#btn-cover")) return;
  S.covered = !S.covered;
  renderIdentity();
});

function renderUsage() {
  const g = S.g;
  const el = $("#usage");
  if (!g.llm) { if (el.textContent !== "离线 AI") el.textContent = "离线 AI"; return; }
  const u = g.usage;
  if (!u) return;
  const k = ((u.prompt_tokens + u.completion_tokens) / 1000).toFixed(1);
  const text = `DeepSeek ${u.calls} 次 · ${k}k tokens`;
  if (el.textContent !== text) el.textContent = text;
  setAttr(el, "title", `模型 ${u.model}；输入 ${u.prompt_tokens}（缓存命中 ${u.cache_hit_tokens}），输出 ${u.completion_tokens}；失败 ${u.errors} 次`);
}

// =====================================================================
// 时刻：身份揭晓 / 投票印章 / 任务翻牌 / 湖中仙女 / 刺杀 / 胜负标题
//   · 只为轮询拿到的“新”事件播放：刷新恢复、轮询空转都不会重播
//   · 同一批事件只演最新的一个（任务结果顶替它的投票、刺杀顶替“刺杀阶段”）；
//     正在演的被更新的事件顶替时立刻让位——只有翻牌和刺杀会先演完揭晓那一下（min）
//   · 桌上的时刻不接收点击（照样能点座位、行动栏）；点一下 / Esc 直接摆出结果
//   · 轮到你行动时，正在演的时刻缩短到 hurry 就让路
//   · 所有定时器登记在 S.fx 里，新开一局时全部清掉：旧局的时刻不会出现在新局里
// =====================================================================
let FXGEN = 0;
function resetFx() {
  FXGEN++;
  if (S.fx) S.fx.timers.forEach(clearTimeout);
  S.fx = {
    timers: new Set(),
    voteId: 0, voteAt: 0,   // 刚揭晓的投票：座位上的票依次弹出
    quests: null,           // 顶栏火漆的上一次状态（新盖上的才播放动画）
    cur: null, next: null, finale: null, leaving: false, idle: [],
    holdQuest: -1,          // 翻牌揭晓之前，顶栏这一轮先不盖火漆
    holdRoles: false,       // 匕首落下之前，座位上先不亮出全部身份
    holdEnd: "",            // 胜负标题出现之前，行动栏先显示这句
    heldLog: new Set(),     // 扣住的对局记录（事件 id）
    revealTimer: 0,
  };
  const box = $("#moment");
  if (box) box.innerHTML = "";
  $(".table-wrap")?.removeAttribute("data-spot");
  document.querySelectorAll(".reveal, .mo-finale").forEach((el) => el.remove());
}
resetFx();

// 登记过的定时器：新开一局（FXGEN 变了）之后，漏清的也不会再执行
function fxLater(fn, ms) {
  const gen = FXGEN;
  const timers = S.fx.timers;
  const id = setTimeout(() => { timers.delete(id); if (gen === FXGEN) fn(); }, ms);
  timers.add(id);
  return id;
}
function fxClear(id) {
  clearTimeout(id);
  S.fx.timers.delete(id);
}
function whenFxIdle(fn) {
  const fx = S.fx;
  if (!fx.cur && !fx.next && !fx.finale && !fx.leaving) fn();
  else fx.idle.push(fn);
}

// ---------- 新事件到达、渲染之前：先压住会剧透的东西 ----------
const END_WAIT = { assassination: "刺客出手了……", quest_result: "任务牌揭晓中……", vote: "投票揭晓中……" };
function prepMoment(ev) {
  const fx = S.fx;
  if (ev.type === "vote") {
    fx.voteId = ev.id;
    fx.voteAt = performance.now();
  } else if (ev.type === "quest_result") {
    fx.holdQuest = ev.quest;
  } else if (ev.type === "game_end") {
    const before = S.events[S.events.length - 2];
    fx.holdEnd = END_WAIT[before?.type] || "对局结束，正在揭晓……";
    if (!S.g.spectator) fx.holdRoles = true;
  }
}
function releaseQuest() {
  if (S.fx.holdQuest < 0) return;
  S.fx.holdQuest = -1;
  if (S.g) renderTracks();
}
function releaseRoles() {
  if (!S.fx.holdRoles) return;
  S.fx.holdRoles = false;
  if (S.g) renderTable();
}
function releaseEnd() {
  releaseRoles();
  if (!S.fx.holdEnd) return;
  S.fx.holdEnd = "";
  if (S.g) renderAction();
}
function releaseAll() {
  releaseQuest();
  releaseEnd();
  [...S.fx.heldLog].forEach(releaseLog);
}

// ---------- 印章：金框珐琅牌 + 顶上的圆形印记 ----------
function plaque(tone, icon, kick, title, sub = "", extra = "", t = 0) {
  return `<div class="plq tone-${tone}"${t ? ` style="--t:${t}ms"` : ""}>` +
    `<span class="plq-seal" aria-hidden="true">${ic(icon)}</span>` +
    (kick ? `<span class="plq-kick">${kick}</span>` : "") +
    `<b class="plq-title">${title}</b>` + (sub ? `<span class="plq-sub">${sub}</span>` : "") + extra + `</div>`;
}
const whoIs = (s) => (player(s)?.is_human ? "你" : `${s}号「${esc(nameOf(s))}」`);

// 座位盾牌中心（相对圆桌区域）：光环、匕首、涟漪都对准它
function seatPoint(seat) {
  const wrap = $(".table-wrap");
  const av = $(`#table .seat[data-seat="${seat}"] .avatar`);
  if (!wrap || !av) return null;
  const w = wrap.getBoundingClientRect();
  const r = av.getBoundingClientRect();
  if (!r.width) return null;
  return { x: Math.round(r.left + r.width / 2 - w.left), y: Math.round(r.top + r.height / 2 - w.top), w: r.width };
}
function ring(parent, seat, kind, delay = 0) {
  const pt = seatPoint(seat);
  if (!pt || !parent) return null;
  const el = document.createElement("span");
  el.className = `mo-ring ${kind}`;
  el.setAttribute("aria-hidden", "true");
  el.style.cssText = `left:${pt.x}px;top:${pt.y}px;--r:${Math.round(pt.w * 1.7)}px;--d:${delay}ms`;
  parent.appendChild(el);
  return el;
}
// 不占桌心的小涟漪（湖中仙女查验了谁）：独立于印章队列，减少动态效果时不画
function ripple(seat, kind) {
  if (reduceMotion()) return;
  const el = ring($("#moment"), seat, `ripple ${kind}`);
  if (el) fxLater(() => el.remove(), 1500);
}
// 聚光：圆桌变暗，只留下这些座位
function spot(seats) {
  const wrap = $(".table-wrap");
  if (!wrap) return;
  if (seats && seats.length) wrap.dataset.spot = seats.join(" ");
  else wrap.removeAttribute("data-spot");
}

const MOMENTS = {
  vote(ev) {
    const yes = Object.values(ev.votes).filter(Boolean).length;
    const no = Object.keys(ev.votes).length - yes;
    let note = "";
    if (!ev.approved) {
      const k = S.events.filter((e) => e.type === "vote" && e.quest === ev.quest && !e.approved && e.id <= ev.id).length;
      note = k >= 5 ? `<span class="plq-note danger">连续5次否决，坏人直接获胜</span>`
        : k >= 3 ? `<span class="plq-note warn">本轮已否决${k}次 · 再否决${5 - k}次坏人获胜</span>`
        : `<span class="plq-note">本轮已否决${k}次</span>`;
    }
    return {
      kind: "vote", min: 250, hurry: 1200, ms: ev.approved ? 1700 : 2000,
      html: `<div class="mo">${plaque(ev.approved ? "yes" : "no", ev.approved ? "check" : "cross",
        `第${ev.quest + 1}轮 · 第${ev.attempt}次提名`, ev.approved ? "投票通过" : "投票否决", `${yes} 赞成 · ${no} 反对`, note)}</div>`,
    };
  },

  // 任务翻牌：发下扣着的羊皮纸任务牌（张数 = 队伍人数），洗乱后逐张翻开，最后盖上印章。
  // 每张牌是谁出的是秘密，只公开张数，所以顺序是随机的。
  quest_result(ev) {
    const n = ev.team.length;
    const cards = [...Array(n - ev.fails).fill(true), ...Array(ev.fails).fill(false)];
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    const flip0 = 300 + 50 * n;
    const gap = Math.round(Math.min(160, 600 / n));
    const land = flip0 + (n - 1) * gap + 330;
    const card = (ok, i) => `<div class="qcard" style="--d:${i * 60}ms;--f:${flip0 + i * gap}ms"><div class="qc-in">` +
      `<div class="qc-face qc-back"><span class="qc-wax">${ic("swords")}</span></div>` +
      `<div class="qc-face qc-front ${ok ? "ok" : "bad"}">${ic(ok ? "chalice" : "dagger")}<span>${ok ? "成功" : "失败"}</span></div></div></div>`;
    const need = ev.fails_needed === 2 ? "（本轮需2张）" : "";
    const release = () => {
      if (S.fx.holdQuest === ev.quest) releaseQuest();
      releaseLog(ev.id);
    };
    return {
      kind: "quest", min: land + 350, hurry: land + 700, ms: land + 1500, land, release,
      html: `<div class="mo"><div class="qc-kick">第${ev.quest + 1}轮任务 · ${n}张任务牌</div>` +
        `<div class="qc-row" role="img" aria-label="${n - ev.fails}张成功，${ev.fails}张失败">${cards.map(card).join("")}</div>` +
        plaque(ev.success ? "good" : "evil", ev.success ? "chalice" : "dagger", "", `任务${ev.success ? "成功" : "失败"}`,
          `${ev.fails}张失败牌${need} · 比分 ${ev.score[0]} : ${ev.score[1]}`, "", land) + `</div>`,
    };
  },

  lady_claim(ev) {
    const mine = player(ev.holder)?.is_human;
    const truth = S.events.find((e) => e.type === "lady_result" && e.holder === ev.holder && e.target === ev.target)?.result;
    let sub = ev.claim ? "宣布可能是假的，想想TA自己是哪边的" : `查验了${ev.target}号，但没有公开`;
    if (mine) sub = "真相只有你知道";
    else if (S.g.spectator && truth) {
      sub = `真实结果：${TEAM_NAME[truth]}` + (!ev.claim ? "" : truth === ev.claim ? " · 说了实话" : " · 撒了谎！");
    }
    return {
      kind: "lady", min: 400, hurry: 1300, ms: 2300,
      html: `<div class="mo">${plaque("lady", "waves", `湖中仙女 · ${whoIs(ev.holder)}宣布`,
        ev.claim ? `${ev.target}号是${TEAM_NAME[ev.claim]}` : "不公布结果", sub)}</div>`,
      start: (c) => ring(c.el, ev.target, "lady"),
    };
  },

  evil_reveal(ev) {
    const mine = player(ev.assassin)?.is_human;
    return {
      kind: "evil", min: 300, hurry: 1300, ms: 2600,
      html: `<div class="mo">${plaque("evil", "dagger", "好人完成了3次任务", "刺杀阶段",
        `坏人亮明身份 · ${mine ? "你是刺客：找出梅林" : `刺客${ev.assassin}号寻找梅林`}`)}</div>`,
      start: (c) => ev.evil.forEach((s, i) => ring(c.el, s, "mark", i * 110)),
    };
  },

  // 刺杀：圆桌变暗、聚光在目标上，匕首落下；落空时点出真正的梅林（复盘最有价值的一课）
  assassination(ev) {
    const hit = ev.hit;
    const merlin = S.g.players.find((p) => p.role === "merlin")?.seat; // 终局后才公开
    const tgt = player(ev.target);
    const kick = player(ev.assassin)?.is_human ? "你出手了" : `刺客${whoIs(ev.assassin)}出手`;
    let sub;
    if (hit) sub = `${whoIs(ev.target)}正是梅林 · 坏人翻盘`;
    else if (merlin) sub = `${ev.target}号${tgt?.role_name ? `是${esc(tgt.role_name)}` : "不是梅林"} · 真正的梅林是${whoIs(merlin)}`;
    else sub = `${ev.target}号不是梅林 · 好人守住了胜利`;
    const release = () => { releaseRoles(); releaseLog(ev.id); };
    return {
      kind: "assassin", min: 2000, hurry: 2000, ms: 2900, land: 620, release,
      html: `<div class="mo">${plaque(hit ? "evil" : "good", hit ? "dagger" : "chalice", kick, hit ? "刺中梅林！" : "刺杀落空", sub, "", 700)}</div>`,
      start(c) {
        spot([ev.target]);
        ring(c.el, ev.target, "aim");
        const pt = seatPoint(ev.target);
        if (pt) {
          const d = document.createElement("span");
          d.className = "mo-dagger";
          d.setAttribute("aria-hidden", "true");
          // 匕首扎在盾牌右上角，不挡住纹章和座位号
          d.style.cssText = `left:${Math.round(pt.x + pt.w * 0.32)}px;top:${Math.round(pt.y - pt.w * 0.22)}px;--w:${Math.round(pt.w * 0.72)}px`;
          d.innerHTML = ic("dagger");
          c.el.appendChild(d);
        }
      },
      onLand(c) {
        c.el.classList.add(hit ? "is-hit" : "is-miss");
        if (!hit && merlin && merlin !== ev.target) {
          spot([ev.target, merlin]);
          ring(c.el, merlin, "merlin");
        }
        release();
      },
      done: () => spot(null),
    };
  },
};

// 胜负标题：一面垂下的纹章旗，赢了飘金箔；几秒后（或点一下）展开结算卷轴
function finaleMoment(ev) {
  const me = S.g.you;
  const win = !!me && me.team === ev.winner;
  const kind = !me ? "watch" : win ? "win" : "lose";
  const title = !me ? `${TEAM_NAME[ev.winner]}获胜` : win ? "胜利" : "败北";
  const kick = me ? `${TEAM_NAME[ev.winner]}阵营获胜` : "观战结束";
  const icon = kind === "win" ? "crown" : ev.winner === "good" ? "chalice" : "dagger";
  const rnd = (a, b) => a + Math.random() * (b - a);
  const leaves = kind === "win" && !reduceMotion()
    ? `<div class="fn-leaves" aria-hidden="true">${Array.from({ length: 34 }, () =>
      `<i style="--x:${rnd(2, 98).toFixed(1)}%;--d:${Math.round(rnd(0, 650))}ms;--t:${Math.round(rnd(1500, 2300))}ms;` +
      `--r:${Math.round(rnd(-200, 200))}deg;--dx:${Math.round(rnd(-70, 70))}px;--s:${rnd(0.7, 1.25).toFixed(2)}"></i>`).join("")}</div>`
    : "";
  return {
    kind: "finale", body: true, min: 0, hurry: 0, ms: reduceMotion() ? 1800 : 2400,
    html: `<div class="fn-scrim"></div>${leaves}
      <div class="fn-hang fn-${kind} team-${ev.winner}" role="status">
        <span class="fn-rod" aria-hidden="true"></span>
        <div class="fn-banner"><div class="fn-field">
          <span class="fn-emblem" aria-hidden="true">${ic(icon)}</span>
          <span class="fn-kick">${kick}</span>
          <b class="fn-title">${title}</b>
          ${me ? `<span class="fn-role">你是${esc(me.role_name)}</span>` : ""}
          <p class="fn-sub">${esc(ev.reason)}</p>
        </div></div>
      </div>
      <span class="fn-hint">点击查看结算</span>`,
    start(c) {
      // 标题盖住整个页面的这一刻，行动栏、座位身份、对局记录都换成终局的样子
      releaseEnd();
      releaseLog(ev.id);
      c.el.addEventListener("click", () => endMoment(c));
    },
  };
}

// ---------- 队列 ----------
function playMoments(evs) {
  let last = null;
  let end = null;
  for (const ev of evs) {
    if (ev.type === "game_end") end = ev;
    else if (ev.type === "lady_check") ripple(ev.target, "lady");
    else if (MOMENTS[ev.type]) {
      if (last) MOMENTS[last.type](last).release?.(); // 同一批里被顶替的：只放出它压住的东西
      last = ev;
    }
  }
  if (last) queueMoment(MOMENTS[last.type](last));
  if (end) queueMoment(finaleMoment(end), true);
}
function queueMoment(m, finale = false) {
  const fx = S.fx;
  if (finale) fx.finale = m;
  else {
    fx.next?.release?.(); // 还没轮到就被更新的事件顶替了
    fx.next = m;
  }
  // 终局标题排在后面时，正在演的“原因”（最后一次投票、翻牌、刺杀）先演完 hurry 那么久
  if (fx.cur) cutMoment(fx.cur, finale);
  else nextMoment();
}
function nextMoment() {
  const fx = S.fx;
  if (fx.cur || fx.leaving) return;
  let m = fx.next;
  if (m) fx.next = null;
  else if ((m = fx.finale)) fx.finale = null;
  if (m) { startMoment(m); return; }
  releaseAll(); // 兜底：压住的东西不会比时刻活得更久
  fx.idle.splice(0).forEach((fn) => fn());
}
function startMoment(m) {
  const fx = S.fx;
  const el = document.createElement("div");
  el.className = `mo-wrap mo-${m.kind}`;
  el.innerHTML = m.html;
  (m.body ? document.body : $("#moment")).appendChild(el);
  const c = { m, el, at: performance.now(), endAt: 0, timer: 0, landTimer: 0, landed: false };
  fx.cur = c;
  if (!m.body) fitMoment(el);
  m.start?.(c);
  if (m.land !== undefined) {
    if (reduceMotion()) landMoment(c);
    else c.landTimer = fxLater(() => landMoment(c), m.land);
  }
  // 轮到你行动时：只演关键部分
  const ms = S.g?.pending && !m.body ? m.hurry : m.ms;
  c.endAt = c.at + ms;
  c.timer = fxLater(() => endMoment(c), ms);
}
// 桌心放不下时：宽而矮的桌子（笔记本）把翻牌和印章左右摆开，仍放不下就按比例缩小（手机）
function fitMoment(el) {
  const mo = el.querySelector(".mo");
  const wrap = $(".table-wrap");
  if (!mo || !wrap || !mo.offsetHeight) return;
  const oy = parseFloat(wrap.style.getPropertyValue("--oy")) || wrap.clientHeight * 0.36;
  const ox = parseFloat(wrap.style.getPropertyValue("--ox")) || wrap.clientWidth * 0.34;
  // 座位压在桌沿上：竖直方向只算内圈（金线圈住的那一圈）再留一点余量；水平方向桌心最宽
  const availH = 1.36 * oy + 50;
  const availW = 1.7 * ox + 20;
  if (mo.querySelector(".qc-row") && mo.offsetHeight + 30 > availH && availW > availH * 1.5) mo.classList.add("row");
  const s = Math.min(1, availH / (mo.offsetHeight + 30), availW / mo.offsetWidth);
  if (s < 0.98) mo.style.setProperty("--mo-s", Math.max(0.6, s).toFixed(3));
}
function landMoment(c) {
  if (c.landed) return;
  c.landed = true;
  fxClear(c.landTimer);
  if (c.m.onLand) c.m.onLand(c);
  else c.m.release?.();
}
// 让位：被更新的事件顶替时演到 min（翻牌要等印章落下），轮到你行动时演到 hurry，然后收起
function cutMoment(c, hurry = false) {
  const now = performance.now();
  const endAt = Math.max(now, c.at + (hurry ? c.m.hurry : c.m.min));
  if (endAt >= c.endAt) return;
  fxClear(c.timer);
  c.endAt = endAt;
  c.timer = fxLater(() => endMoment(c), endAt - now);
}
function endMoment(c) {
  const fx = S.fx;
  if (fx.cur !== c) return;
  fxClear(c.timer);
  landMoment(c);
  c.m.release?.();
  c.m.done?.(c);
  fx.cur = null;
  fx.leaving = true;
  c.el.classList.add("out");
  fxLater(() => {
    c.el.remove();
    fx.leaving = false;
    nextMoment();
  }, reduceMotion() ? 0 : 260);
}
function hurryMoments() {
  if (S.fx.cur && !S.fx.cur.m.body) cutMoment(S.fx.cur, true);
}
// 点一下：直接摆出结果（所有牌翻开、印章落下），稍停再收起；再点一下立即收起
function skipMoment() {
  const c = S.fx.cur;
  if (!c || c.m.body) return;
  landMoment(c);
  if (c.el.classList.contains("skip")) { endMoment(c); return; }
  c.el.classList.add("skip");
  const now = performance.now();
  const left = Math.min(800, Math.max(0, c.endAt - now));
  fxClear(c.timer);
  c.endAt = now + left;
  c.timer = fxLater(() => endMoment(c), left);
}

// ---------- 开局身份揭晓：圆桌上方的一张塔罗牌，2 秒后飞进左下的身份卡 ----------
function maybeReveal() {
  const g = S.g;
  if (S.revealFresh && (g.you || g.spectator)) {
    S.revealFresh = false;
    // 已经轮到你行动（比如你是首任队长）：不挡圆桌，只让身份卡亮一下
    if (g.you && !g.pending && ACTIVE.includes(g.status)) showReveal(g.you);
    else if (g.you) pulseIdentity();
  }
  if (g.pending) hideReveal();
}

function showReveal(y) {
  const wrap = $(".table-wrap");
  if (!wrap) return;
  wrap.querySelectorAll(".reveal").forEach((el) => el.remove());
  const know = y.knowledge.length
    ? y.knowledge.map((k) => `<span class="kchip ${labelClass(k.label)}">${seatEmblem(k.seat, "xs")}${k.seat}号 · ${esc(k.label)}</span>`).join("")
    : `<span class="rv-none">没有额外信息，全靠推理</span>`;
  const el = document.createElement("div");
  el.className = `reveal ${y.team}`;
  el.setAttribute("role", "status");
  el.innerHTML = `<div class="rv-scrim"></div>
    <div class="rv-card">
      <div class="rv-kicker">你的身份 · ${y.seat}号座位</div>
      <div class="rv-art">${ART.role(y.role)}</div>
      <div class="rv-role">${esc(y.role_name)}</div>
      <span class="label ${y.team} rv-team">${TEAM_NAME[y.team]}阵营</span>
      <div class="rv-know"><span class="rv-know-k">你知道</span>${know}</div>
    </div>`;
  wrap.appendChild(el);
  const card = el.querySelector(".rv-card");
  const s = Math.min(1, (wrap.clientHeight - 16) / card.offsetHeight, (wrap.clientWidth - 24) / card.offsetWidth);
  if (s < 1) el.style.setProperty("--rv-s", Math.max(0.55, s).toFixed(3));
  el.addEventListener("click", () => hideReveal());
  S.fx.revealTimer = fxLater(() => hideReveal(), 1850); // 再加 0.46 秒飞走：2.5 秒内完全收起
}

// 收起：不透明的牌飞进身份卡的插画框（看得清它去了哪），身份卡随后亮一下
function hideReveal(instant = false) {
  const el = document.querySelector(".reveal:not(.out)");
  if (!el) return;
  fxClear(S.fx.revealTimer);
  el.classList.add("out");
  const card = el.querySelector(".rv-card");
  const target = $("#identity .id-art");
  const gen = FXGEN;
  const done = () => { el.remove(); if (gen === FXGEN) pulseIdentity(); };
  if (instant || reduceMotion() || !card.animate) { el.remove(); return; }
  const a = card.getBoundingClientRect();
  const b = target ? target.getBoundingClientRect() : null;
  const s0 = parseFloat(el.style.getPropertyValue("--rv-s")) || 1;
  el.querySelector(".rv-scrim").animate([{ opacity: 1 }, { opacity: 0 }], { duration: 280, fill: "forwards" });
  let anim;
  if (b && b.width && b.top < window.innerHeight - 40 && b.bottom > 0) {
    const dx = b.left + b.width / 2 - (a.left + a.width / 2);
    const dy = b.top + b.height / 2 - (a.top + a.height / 2);
    const s1 = b.width / card.offsetWidth;
    anim = card.animate([
      { transform: `scale(${s0})`, opacity: 1 },
      { transform: `translate(${dx}px, ${dy}px) scale(${s1})`, opacity: 1, offset: 0.86 },
      { transform: `translate(${dx}px, ${dy}px) scale(${s1})`, opacity: 0 },
    ], { duration: 460, easing: "cubic-bezier(.55, 0, .3, 1)", fill: "forwards" });
  } else {
    anim = card.animate([{ opacity: 1, transform: `scale(${s0})` }, { opacity: 0, transform: `scale(${s0 * 0.92})` }],
      { duration: 220, fill: "forwards" });
  }
  anim.onfinish = done;
  fxLater(() => el.isConnected && done(), 800); // 兜底
}

function pulseIdentity() {
  const box = $("#identity");
  if (!box || reduceMotion() || !box.animate || !box.offsetWidth) return;
  box.animate([{ filter: "brightness(1.45) saturate(1.2)" }, { filter: "none" }], { duration: 750, easing: "ease-out" });
}

// 点击 / 按键：收起身份牌、跳过桌上的时刻、关掉胜负标题
// 用 click 而不是 pointerdown：手机上滑动页面不会误触发
document.addEventListener("click", (e) => {
  if (!S.fx) return;
  if (!e.target.closest?.(".reveal")) hideReveal();
  if (S.fx.cur && !S.fx.cur.m.body) skipMoment();
}, true);
document.addEventListener("keydown", (e) => {
  if (!S.fx || e.repeat) return;
  const c = S.fx.cur;
  const key = e.key;
  if (c?.m.body && (key === "Escape" || key === "Enter" || key === " ")) {
    e.preventDefault();
    endMoment(c);
    return;
  }
  if (document.querySelector(".reveal:not(.out)")) {
    const typing = e.target.closest?.("input, textarea, select, button");
    if (key === "Escape" || (!typing && (key === "Enter" || key === " "))) hideReveal();
  } else if (key === "Escape" && c) {
    skipMoment();
  }
}, true);

// =====================================================================
// 行动栏：轮到你时呈上一张羊皮纸卡片（深红缎带“轮到你了”）
//   左：印章 + 标题 + 一句规则提醒；中：发言 / 提名的队伍；右：已选队员位 + 按钮
// 等待时收成一行：谁在思考（纹章 + 墨点）+ 定时轮换的练习小贴士
// =====================================================================
function attemptWarn() {
  const a = S.g.attempt;
  if (a >= 5) return `<div class="alert danger">${ic("warn")}<span>第5次提名：再被否决，坏人直接获胜！</span></div>`;
  if (a === 4) return `<div class="alert">${ic("warn")}<span>已否决3次：连续5次否决，坏人直接获胜</span></div>`;
  return "";
}

// 快捷短语：按钮上是短标签，点一下把整句放进发言框
const QUICK = [["同意这车", "这车我同意。"], ["反对这车", "这车我反对。"], ["我是好人", "我是好人，相信我。"], ["车上有问题", "我觉得车上有问题。"], ["先听后面的", "先过，听后面的。"]];
// 有实体键盘的桌面才提示 Ctrl+Enter；手机上占位文字保持一行
const FINE_POINTER = window.matchMedia("(hover: hover) and (pointer: fine)");
const ph = (text) => esc(text + (FINE_POINTER.matches && !NARROW.matches ? "（Ctrl+Enter 提交）" : ""));
const speechBox = (text) => `<textarea id="act-speech" rows="2" maxlength="500" placeholder="${ph(text)}"></textarea>`;

// 卡片头：缎带 + 印章 + 标题 + 规则提醒（seal：gold / lady / evil）
const head = (icon, title, sub, extra = "", seal = "gold") => `
    <span class="turn-tag" aria-hidden="true">轮到你了</span>
    <div class="act-head"><span class="act-seal seal-${seal}" aria-hidden="true">${ic(icon)}</span>
      <div class="act-titles"><div class="act-title">${title}</div>${sub ? `<div class="act-sub">${sub}</div>` : ""}${extra}</div></div>`;

// 已选：迷你纹章 + 虚线空位 + n/N（内容由 updateSelectionUI 填）
const pick = () => `<div class="pick"><span class="pick-k">已选</span><span class="slots" id="sel-slots"></span><span class="cnt" id="sel-cnt"></span>` +
  `<span class="sr-only" aria-live="polite">已选 <span id="sel-list">无</span></span></div>`;

// 一排迷你纹章：提名的队伍 / 可选的人
function teamLine(seats, label, names = true) {
  const list = sortSeats(seats || []);
  const people = list.map((s) => {
    const me = player(s)?.is_human;
    const who = names ? (me ? "（你）" : ` ${esc(nameOf(s))}`) : (me ? "（你）" : "");
    return `<span class="tl-p${me ? " me" : ""}" title="${s}号 ${esc(nameOf(s))}">${seatEmblem(s, "xs")}<span>${s}号${who}</span></span>`;
  }).join("");
  return `<div class="team-line"><span class="tl-k">${label}</span><span class="tl-v">${people}</span></div>`;
}

const PANELS = {
  propose: (p) => {
    const q = S.g.quests[S.g.quest_index];
    return `${head("crown", `你是队长：组建 <span class="em">${p.size}</span> 人队伍`,
      `在圆桌上点选 ${p.size} 人 · 可以选自己${q && q.fails_needed === 2 ? " · 本轮需2张失败" : ""}`, attemptWarn())}
    <div class="act-main">${speechBox("说说组队理由（可选）")}</div>
    <div class="act-side with-pick">${pick()}<button class="primary" id="act-submit" disabled>${ic("swords")}<span>确认发车</span></button></div>`;
  },
  speak: (p) => `${head("quill", "轮到你发言", `<span class="tl-long">队长 ${S.g.leader}号 </span>提名 ${seatChips(p.team)}`)}
    <div class="act-main">
      <div class="quick" role="group" aria-label="快捷短语">${QUICK.map(([k, q]) => `<button type="button" data-quick="${esc(q)}" title="${esc(q)}">${esc(k)}</button>`).join("")}</div>
      ${speechBox("你的发言，所有人都会听到")}
    </div>
    <div class="act-side"><button class="ghost pass" id="act-pass">过</button><button class="primary" id="act-submit">${ic("quill")}<span>发言</span></button></div>`,
  vote: (p) => `${head("ballot", "投票：这支队伍能出发吗？", `赞成票过半（至少 ${Math.floor(S.g.n / 2) + 1} 票）才发车`, attemptWarn())}
    <div class="act-main">${teamLine(p.team, `<span class="tl-long">队长 ${S.g.leader}号 </span>提名`)}</div>
    <div class="act-side vote"><button class="yes" data-vote="1">${ic("check")}<span>赞成</span></button><button class="no" data-vote="0">${ic("cross")}<span>反对</span></button></div>`,
  quest: (p) => `${head("swords", "你在任务队伍中：秘密出牌", p.fails_needed === 2 ? "本轮需要2张失败才失败" : "只要出现1张失败，任务就失败")}
    <div class="act-main">${teamLine(p.team, "同车")}<p class="act-note">出牌不记名，只公布失败牌的张数${p.can_fail ? "" : "；好人只能出成功"}</p></div>
    <div class="act-side cards">
      <button class="card-btn ok" data-card="success">${ic("chalice")}<span>成功</span></button>
      <button class="card-btn bad" data-card="fail" ${p.can_fail ? "" : 'disabled title="好人只能出成功"'}>${ic(p.can_fail ? "dagger" : "lock")}<span>失败</span>${p.can_fail ? "" : "<small>好人不能出</small>"}</button>
    </div>`,
  lady_choose: (p) => `${head("waves", "湖中仙女：查验一名玩家", "在圆桌上点选 · 只有你会看到TA的真实阵营", "", "lady")}
    <div class="act-main">${teamLine(p.candidates, "可查验", false)}</div>
    <div class="act-side with-pick">${pick()}<button class="primary" id="act-submit" disabled>${ic("eye")}<span>查验</span></button></div>`,
  lady_announce: (p) => `${head("waves", `查验结果：${p.target}号是 <span class="label ${p.result}">${TEAM_NAME[p.result]}</span>`, "只有你看到真实结果，公布时可以撒谎", "", "lady")}
    <div class="act-main">
      <div class="claim-row" role="radiogroup" aria-label="公开宣布"><span class="claim-k">公开宣布</span>
        <label class="pill-radio good"><input type="radio" name="claim" value="good" ${p.result === "good" ? "checked" : ""}><span>是好人</span></label>
        <label class="pill-radio evil"><input type="radio" name="claim" value="evil" ${p.result === "evil" ? "checked" : ""}><span>是坏人</span></label>
        <label class="pill-radio"><input type="radio" name="claim" value="none"><span>不公布</span></label>
      </div>
      ${speechBox("说点什么（可以撒谎）")}
    </div>
    <div class="act-side"><button class="primary" id="act-submit">${ic("horn")}<span>公布</span></button></div>`,
  assassin_suggest: (p) => `${head("dagger", "刺杀讨论：谁是梅林？", "在圆桌上点选一人 · 建议会告诉刺客，由刺客拍板", "", "evil")}
    <div class="act-main">${speechBox("说说你的理由")}</div>
    <div class="act-side with-pick">${pick()}<button class="primary" id="act-submit" disabled>${ic("dagger")}<span>提出建议</span></button></div>`,
  assassinate: (p) => `${head("dagger", "你是刺客：最后一击", "刺中梅林，坏人翻盘 · 在圆桌上点选目标", "", "evil")}
    <div class="act-main">${speechBox("刺杀前想说的话（可选）")}</div>
    <div class="act-side with-pick">${pick()}<button class="evil" id="act-submit" disabled>${ic("dagger")}<span>刺杀！</span></button></div>`,
};

function setAction(html, mode = null) {
  const box = $("#action");
  box.innerHTML = html;
  box._h = html;
  box._mode = mode;
  if (mode !== "wait") stopTips();
}
// 结束 / 出错这类整块内容：只有变化时才重写
function setActionIfChanged(html) {
  const box = $("#action");
  if (box._mode === "wait") box._h = null;
  box._mode = null;
  stopTips();
  return patch(box, html);
}

function renderAction() {
  const g = S.g;
  const box = $("#action");
  const bar = $(".action-bar");
  const noHint = g.status !== "running" || g.spectator;
  setAttr($("#btn-hint"), "disabled", noHint ? "" : null);
  const p = g.pending;
  bar.classList.toggle("your-turn", !!p);
  bar.classList.toggle("no-hint", noHint);
  const title = p ? "【轮到你】阿瓦隆练习场" : "阿瓦隆练习场";
  if (document.title !== title) document.title = title;
  if (p) {
    const key = `p${p.id}`;
    if (S.pendingKey !== key) {
      S.pendingKey = key;
      S.selected = [];
      S.lastPick = 0;
      hurryMoments(); // 轮到你了：桌心的时刻演完关键部分就让路
      // 只有“刚刚轮到你”才闪一下金光；刷新恢复时不播放
      const fresh = S.live || S.revealFresh;
      setAction(`<div class="panel panel-${p.type}${fresh ? " enter" : ""}" role="group" aria-label="轮到你了">${PANELS[p.type] ? PANELS[p.type](p) : ""}</div>`);
      bindAction(p);
      renderTable();
      const ta = $("#act-speech");
      if (ta && DESKTOP.matches) ta.focus({ preventScroll: true });
    }
    updateSelectionUI();
    return;
  }
  S.pendingKey = null;
  if (g.status === "ended" && S.fx.holdEnd) {
    // 刺杀 / 最后一次翻牌还在桌上演：结果先不写在行动栏里，胜负标题出现时再换上
    showWaiting(`<span class="w-v">${S.fx.holdEnd}</span>`);
    return;
  }
  if (g.status === "ended") {
    const me = g.you;
    const verdict = me ? (me.team === g.winner ? "你赢了" : "这局输了") : "观战结束";
    const html = `<div class="end-row win-${g.winner}">
      <span class="end-seal" aria-hidden="true">${ic(g.winner === "good" ? "chalice" : "dagger")}</span>
      <div class="end-text"><b class="end-title">${g.winner === "good" ? "好人" : "坏人"}阵营获胜<small>${verdict}</small></b><span class="end-sub">${esc(g.end_reason)}</span></div>
      <div class="end-btns"><button class="ghost" id="act-summary">${ic("scroll")}<span>结算</span></button>
        <button class="primary" id="act-again">${ic("restart")}<span>再来一局</span></button></div></div>`;
    if (setActionIfChanged(html)) {
      $("#act-summary").onclick = showEndModal;
      $("#act-again").onclick = () => showSetup();
    }
    return;
  }
  if (g.status === "error" || g.status === "cancelled") {
    const err = g.status === "error";
    const html = `<div class="end-row stopped">
      <span class="end-seal" aria-hidden="true">${ic(err ? "warn" : "scroll")}</span>
      <div class="end-text"><b class="end-title">${err ? "对局出错了" : "对局已停止"}</b>${err ? `<span class="end-sub">${esc(g.error)}</span>` : ""}</div>
      <div class="end-btns"><button class="primary" id="act-again">${ic("restart")}<span>新游戏</span></button></div></div>`;
    if (setActionIfChanged(html)) $("#act-again").onclick = () => showSetup();
    return;
  }
  showWaiting(waitingHtml());
}

// ---------- 等待：谁在思考 + 练习小贴士 ----------
// 骨架只建一次；之后只改“谁在思考”那一段（没变化就不碰 DOM），小贴士按定时器轮换
function showWaiting(who) {
  const box = $("#action");
  if (box._mode !== "wait") {
    setAction(`<div class="waiting">
      <span class="w-ink" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="w-who" role="status"></span>
      <span class="w-tip"></span></div>`, "wait");
    startTips();
  }
  patch(box.querySelector(".w-who"), who);
}

const THINK_VERB = {
  propose: "正在挑选队员", discuss: "正在发言", vote: "正在投票", quest: "正在出牌",
  lady: "正在使用湖中仙女", assassinate: "正在讨论谁是梅林",
};
function waitingHtml() {
  const g = S.g;
  const t = g.thinking.filter((s) => !player(s)?.is_human);
  const verb = THINK_VERB[g.phase] || "正在思考";
  if (t.length && t.length <= 2) {
    return t.map((s) => `<span class="w-p">${seatEmblem(s, "sm")}<b>${s}号「${esc(nameOf(s))}」</b></span>`).join("") +
      `<span class="w-v">${verb}</span>`;
  }
  if (t.length > 2) {
    return `<span class="w-ps">${t.slice(0, 5).map((s) => seatEmblem(s, "sm")).join("")}</span><span class="w-v"><b>${t.length} 位玩家</b>${verb}</span>`;
  }
  if (g.phase === "quest") {
    return `${g.proposal ? `<span class="w-ps">${sortSeats(g.proposal).map((s) => seatEmblem(s, "sm")).join("")}</span>` : ""}<span class="w-v">任务进行中，等待队员出牌</span>`;
  }
  const idle = {
    propose: `队长 ${g.leader}号 正在挑选队员`, discuss: "等待下一位玩家发言", vote: "等待投票结果",
    lady: "湖中仙女查验中", assassinate: "坏人正在讨论谁是梅林",
  }[g.phase] || "请稍候";
  return `<span class="w-v">${idle}</span>`;
}

// 练习小贴士：每 9 秒换一句（只由定时器驱动，轮询不会让它闪动）
const TIP_MS = 9000;
const TIPS = [
  "趁 AI 思考，点座位下的「标记」记下你的判断，结算时看看猜对几个。",
  "留意谁总在替同一个人说话——坏人常常互相掩护。",
  "反对“干净车”的人值得多看一眼。",
  "任务失败后，回看车上的人和投赞成票的人。",
  "第5次提名还投反对的人，嫌疑很大。",
  "当梅林时别让票型太准，刺客会从票型里找你。",
  "说法前后矛盾、跟着别人改口的人，往往在隐藏什么。",
  "队长挑人时，看他“避开了谁”也很有信息量。",
  "拿不准的时候，点「教练」：它只用你能看到的信息给建议。",
];
const PHASE_TIPS = {
  propose: ["组队时优先带被任务结果证明过的人，少带刚出过失败车上的人。", "队长的提名本身就是信息：坏人当队长时，常把队友悄悄塞上车。"],
  discuss: ["听发言时留意：谁在替谁辩护？坏人之间常常互相打掩护。", "第一个跳出来强烈反对“干净车”的人，值得记一笔。"],
  vote: ["票型是公开信息：任务失败后，回头看看谁给那辆车投了赞成。", "坏人往往支持有队友在的车，反对全是好人的车。"],
  quest: ["只有1张失败时，车上至少有1个坏人；没有失败也不代表车上全是好人。", "坏人有时会故意出成功来“洗白”，留意后面几轮的表现。"],
  lady: ["湖中仙女的持有者可以撒谎——听宣布时要结合TA自己的立场。"],
  assassinate: ["刺客会找“票型最准、总能避开坏人”的人——这就是梅林要藏的原因。", "梅林的破绽往往在早期：谁一开始就精准地反对了坏人车？"],
};
// 观战：没有标记、没有教练，讲“看什么”
const WATCH_TIPS = [
  "对照每个人的发言和内心独白，看看谁在演。",
  "看梅林怎么藏：明明知道坏人是谁，却不能表现得太准。",
  "看坏人怎么配合：谁在替队友说话，谁故意投了反对？",
  "好人赢下3轮后，刺客会从票型里找梅林——提前猜猜他会刺谁。",
  "任务失败时，看看是哪个坏人出的失败，他为什么敢出。",
  "派西维尔能看到梅林和莫甘娜，但分不清谁是谁——看他怎么分辨。",
  "试着在投票前预测每个人的票，再和结果对照。",
];
function tipText() {
  const g = S.g;
  if (g.spectator) return WATCH_TIPS[S.tipN % WATCH_TIPS.length];
  const phaseList = PHASE_TIPS[g.phase] || [];
  const pool = S.tipN % 2 && phaseList.length ? phaseList : TIPS;
  return pool[Math.floor(S.tipN / 2) % pool.length];
}
function showTip(fresh) {
  const el = $("#action .w-tip");
  if (!el || !S.g) { stopTips(); return; }
  patch(el, `<span class="w-tip-k">${ic("candle")}<span>小贴士</span></span><span class="w-tip-t${fresh ? " in" : ""}">${esc(tipText())}</span>`);
}
function startTips() {
  stopTips();
  if (S.tipN === undefined) S.tipN = Math.floor(Math.random() * 1000);
  S.tipN++;
  showTip(false);
  S.tipTimer = setInterval(() => { S.tipN++; showTip(!reduceMotion()); }, TIP_MS);
}
function stopTips() {
  clearInterval(S.tipTimer);
  S.tipTimer = null;
}

// ---------- 选人：已选队员位 + 计数 + 按钮 ----------
function updateSelectionUI() {
  const p = S.g.pending;
  if (!p) return;
  const sel = selection();
  const need = sel ? sel.max : 0;
  const list = $("#sel-list");
  if (list) {
    const text = seatsText(S.selected);
    if (list.textContent !== text) list.textContent = text;
  }
  const slots = $("#sel-slots");
  if (slots && need) {
    const chosen = sortSeats(S.selected);
    let html = "";
    for (let i = 0; i < need; i++) {
      const s = chosen[i];
      html += s
        ? `<span class="slot on${s === S.lastPick ? " new" : ""}" title="${s}号 ${esc(nameOf(s))}">${seatEmblem(s, "sm")}</span>`
        : `<span class="slot">${ART.slotShield()}</span>`;
    }
    patch(slots, html);
    patch($("#sel-cnt"), `<b>${S.selected.length}</b>/${need}`);
    slots.parentElement.classList.toggle("full", S.selected.length === need);
  }
  const btn = $("#act-submit");
  if (!btn || !need || S.busy) return;
  const off = S.selected.length !== need;
  if (btn.disabled !== off) btn.disabled = off;
}

function bindAction(p) {
  const box = $("#action");
  const speech = () => ($("#act-speech")?.value || "").trim();
  const submit = async (data) => {
    S.busy = true;
    box.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      await api(`/api/games/${S.gameId}/action`, { pending_id: p.id, ...data });
      S.busy = false;
      S.selected = [];
      S.pendingKey = `done${p.id}`;
      showWaiting(`<span class="w-v">已提交，等待其他玩家</span>`);
      setTimeout(poll, 150);
    } catch (err) {
      S.busy = false;
      box.querySelectorAll("button").forEach((b) => (b.disabled = false));
      box.querySelectorAll("[data-card='fail']").forEach((b) => { if (!p.can_fail) b.disabled = true; });
      updateSelectionUI();
      alert(err.message);
    }
  };

  box.querySelectorAll("[data-quick]").forEach((b) => {
    b.onclick = () => {
      const ta = $("#act-speech");
      ta.value = (ta.value ? ta.value + " " : "") + b.dataset.quick;
      ta.focus();
    };
  });
  box.querySelectorAll("[data-vote]").forEach((b) => { b.onclick = () => submit({ vote: b.dataset.vote === "1" }); });
  box.querySelectorAll("[data-card]").forEach((b) => { b.onclick = () => submit({ card: b.dataset.card }); });
  const pass = $("#act-pass");
  if (pass) pass.onclick = () => submit({ speech: "" });

  const btn = $("#act-submit");
  if (btn) {
    btn.onclick = () => {
      if (p.type === "propose") submit({ team: S.selected, speech: speech() });
      else if (p.type === "speak") submit({ speech: speech() });
      else if (p.type === "lady_announce") submit({ claim: box.querySelector("input[name=claim]:checked")?.value || "none", speech: speech() });
      else submit({ target: S.selected[0], speech: speech() });
    };
  }
  const ta = $("#act-speech");
  if (ta && btn) {
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !btn.disabled) { e.preventDefault(); btn.click(); }
    });
  }
}

// 手机上行动栏是吸底的：把它的高度告诉页面，滚动定位（键盘聚焦、scrollIntoView）时让出这块位置
if (window.ResizeObserver) {
  new ResizeObserver(() => {
    const h = `${Math.round($(".action-bar").offsetHeight)}px`;
    const root = document.documentElement;
    if (root.style.getPropertyValue("--dock-h") !== h) root.style.setProperty("--dock-h", h);
  }).observe($(".action-bar"));
}

// 座位点击：选人 / 标记
$("#table").addEventListener("click", (e) => {
  const seatEl = e.target.closest(".seat");
  if (!seatEl || !S.g) return;
  const seat = +seatEl.dataset.seat;
  if (e.target.closest(".mark")) {
    const cur = S.marks[seat] || "";
    S.marks[seat] = MARKS[(MARKS.indexOf(cur) + 1) % MARKS.length];
    store("avalon.marks." + S.gameId, JSON.stringify(S.marks));
    renderTable();
    return;
  }
  const sel = selection();
  if (!sel || !sel.seats.includes(seat)) return;
  // lastPick：行动栏里只有刚放进去的那面小盾弹一下
  if (S.selected.includes(seat)) { S.selected = S.selected.filter((s) => s !== seat); S.lastPick = 0; }
  else if (sel.max === 1) { S.selected = [seat]; S.lastPick = seat; }
  else if (S.selected.length < sel.max) { S.selected.push(seat); S.lastPick = seat; }
  renderTable();
  updateSelectionUI();
});
// 键盘也能选人
$("#table").addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.classList?.contains("avatar")) {
    e.preventDefault();
    e.target.click();
  }
});
NARROW.addEventListener("change", () => { if (S.g) { placeSeats(); renderTable(); } });

// =====================================================================
// 对局记录
// =====================================================================
function thoughts(ev, seats) {
  if (!ev.thoughts) return "";
  return seats
    .filter((s) => ev.thoughts[String(s)])
    .map((s) => `<div class="thought">${ic("thought")}<div><b>${s}号「${esc(nameOf(s))}」：</b>${esc(ev.thoughts[String(s)])}</div></div>`)
    .join("");
}

function bubble(seat, text, tags = []) {
  const me = player(seat)?.is_human;
  const passed = !text;
  return `<div class="speech${me ? " mine" : ""}">
    <div class="mini">${seatEmblem(seat, "sm")}</div>
    <div class="bubble${passed ? " passed" : ""}">
      <div class="who"><b>${seat}号 ${esc(nameOf(seat))}</b>${me ? "（你）" : ""}${tags.map((t) => `<span class="tag-r">${t}</span>`).join("")}</div>
      ${passed ? "过" : esc(text)}
    </div></div>`;
}

const sys = (text, cls = "") => `<div class="ev ev-system ${cls}">${text}</div>`;

function eventHtml(ev) {
  const all = S.g.players.map((p) => p.seat);
  switch (ev.type) {
    case "start":
      return sys(`<span class="orn">${ic("swords")}</span>游戏开始！首任队长是 ${seatTag(ev.leader)}${ev.lady ? `，湖中仙女在 ${seatTag(ev.lady)} 手中` : ""}。`, "start");
    case "quest_start":
      return `<div class="ev ev-divider"><span>第${ev.quest + 1}轮任务 · ${ev.size}人${ev.fails_needed === 2 ? " · 需2张失败" : ""}</span></div>`;
    case "proposal":
      return `<div class="ev ev-proposal">${ic("crown")}<div>${seatTag(ev.leader)} 第${ev.attempt}次提名：${seatChips(ev.team)}</div></div>` + thoughts(ev, [ev.leader]);
    case "speech": {
      const tags = [];
      if (ev.leader) tags.push("队长");
      if (ev.suggest) tags.push(`建议刺杀 ${ev.suggest}号`);
      if (ev.assassin) tags.push("刺客");
      return `<div class="ev">${bubble(ev.seat, ev.text, tags)}</div>` + thoughts(ev, [ev.seat]);
    }
    case "vote": {
      const entries = Object.entries(ev.votes).map(([s, v]) => [+s, v]).sort((a, b) => a[0] - b[0]);
      const yes = entries.filter(([, v]) => v).length;
      const team = ev.team || [];
      const chips = entries.map(([s, v]) =>
        `<span class="chip ${v ? "yes" : "no"}${team.includes(s) ? " on" : ""}" title="${s}号${v ? "赞成" : "反对"}${team.includes(s) ? "（在车上）" : ""}">${s}号${ic(v ? "check" : "cross")}</span>`).join("");
      return `<div class="ev ev-vote ${ev.approved ? "ok" : "rej"}"><div class="vhead">${ic("ballot")}<span>投票</span>
        <span class="${ev.approved ? "verdict-yes" : "verdict-no"}">${ev.approved ? "通过" : "否决"}</span>
        <span class="tally">${yes} : ${entries.length - yes}</span></div><div class="chips">${chips}</div></div>` + thoughts(ev, all);
    }
    case "quest_result": {
      let extra = "";
      if (ev.secret) {
        const fails = Object.entries(ev.secret.cards).filter(([, c]) => c === "fail").map(([s]) => +s);
        extra = ` · 出失败的是：${seatsText(fails)}`;
      }
      return `<div class="ev ev-quest ${ev.success ? "success" : "fail"}"><span class="seal">${ic(ev.success ? "chalice" : "dagger")}</span>
        <div><div class="qt">任务${ev.success ? "成功" : "失败"}</div>
        <span class="sub"><span class="nw">队伍 ${seatsText(ev.team)}</span> · <span class="nw">${ev.fails} 张失败牌</span> · <span class="nw">比分 ${ev.score[0]} : ${ev.score[1]}</span>${extra}</span></div></div>` + thoughts(ev, ev.team);
    }
    case "lady_check":
      return `<div class="ev ev-lady">${ic("waves")}<div>${seatTag(ev.holder)} 用湖中仙女查验了 ${seatTag(ev.target)}</div></div>` + thoughts(ev, [ev.holder]);
    case "lady_result": {
      const mine = player(ev.holder)?.is_human;
      return `<div class="ev ev-private">${ic("eye")}<span>${mine ? "（仅你可见）" : `（真实结果，${ev.holder}号看到）`}${ev.target}号的阵营是 <span class="label ${ev.result}">${TEAM_NAME[ev.result]}</span></span></div>`;
    }
    case "lady_claim": {
      const claim = ev.claim ? TEAM_NAME[ev.claim] : "不公布";
      return `<div class="ev ev-lady">${ic("waves")}<div>${seatTag(ev.holder)} 宣称 ${ev.target}号是 <b>${claim}</b></div></div>` +
        (ev.text ? `<div class="ev">${bubble(ev.holder, ev.text)}</div>` : "") + thoughts(ev, [ev.holder]);
    }
    case "evil_reveal":
      return `<div class="ev ev-divider evil"><span>刺杀阶段</span></div>` +
        sys(`好人完成了3次任务！坏人亮明身份：<b>${seatsText(ev.evil)}</b>，刺客是 ${ev.assassin}号。坏人正在讨论谁是梅林……`);
    case "assassination":
      return `<div class="ev ev-quest ${ev.hit ? "fail" : "success"}"><span class="seal">${ic("dagger")}</span>
        <div><div class="qt">刺客 ${ev.assassin}号 刺杀了 ${ev.target}号</div>
        <span class="sub">${ev.hit ? "刺中了梅林！" : "没有刺中梅林"}</span></div></div>` + thoughts(ev, [ev.assassin]);
    case "game_end":
      return `<div class="ev ev-end ${ev.winner}"><div class="ee-title">${ic(ev.winner === "good" ? "chalice" : "dagger")}${ev.winner === "good" ? "好人" : "坏人"}阵营获胜！</div><span class="small">${esc(ev.reason)}</span></div>`;
    case "system":
      return sys(esc(ev.text), ev.level === "warn" ? "warn" : "");
    default:
      return "";
  }
}

// 会在桌上“揭晓”的结果（任务翻牌、刺杀、胜负）先扣在记录里，等桌上揭晓了再显示，不提前剧透
const HOLD_LOG = new Set(["quest_result", "assassination", "game_end"]);
function appendEvent(ev, fresh = false) {
  const log = $("#log");
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  const html = eventHtml(ev);
  if (!html) return;
  const held = fresh && HOLD_LOG.has(ev.type);
  if (held) S.fx.heldLog.add(ev.id);
  log.insertAdjacentHTML("beforeend", `<div class="evw${fresh && !held ? " fresh" : ""}${held ? " held" : ""}" data-ev="${ev.id}">${html}</div>`);
  if (nearBottom || !S.ended) log.scrollTop = log.scrollHeight;
}
// 放出扣住的记录（带入场动画）；没有扣住的不会被改动
function releaseLog(id) {
  if (!S.fx.heldLog.delete(id)) return;
  const log = $("#log");
  const el = log.querySelector(`.evw.held[data-ev="${id}"]`);
  if (!el) return;
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  el.classList.remove("held");
  el.classList.add("fresh");
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

$("#show-thoughts").addEventListener("change", (e) => {
  document.body.classList.toggle("show-thoughts", e.target.checked);
});

// =====================================================================
// 弹窗：教练 / 结算 / 复盘 / 规则
// =====================================================================
function openModal(title, html, kind = "") {
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = html;
  const m = $("#modal");
  m.dataset.kind = kind;
  if (!m.open) m.showModal();
  $("#modal-body").scrollTop = 0;
}
$("#modal-close").onclick = () => $("#modal").close();
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") $("#modal").close(); });

$("#btn-hint").onclick = async () => {
  if (!S.gameId) return;
  const btn = $("#btn-hint");
  btn.disabled = true;
  openModal("教练提示", `<div class="loading">教练正在看你的牌面和局势<span class="dots"></span></div>`, "hint");
  try {
    const r = await api(`/api/games/${S.gameId}/hint`, {});
    openModal("教练提示", `<div class="letter">${md(r.text)}</div><p class="muted small note-line">教练只使用你能看到的信息，不会偷看别人的身份。</p>`, "hint");
  } catch (err) {
    openModal("教练提示", `<p class="error">${esc(err.message)}</p>`, "hint");
  } finally {
    btn.disabled = S.g?.status !== "running" || S.g?.spectator;
  }
};

function showEndModal() {
  const g = S.g;
  if (!g || g.status !== "ended") return;
  const me = g.you;
  const win = me && g.winner === me.team;
  const winner = `${g.winner === "good" ? "好人" : "坏人"}阵营获胜`;
  const title = me ? (win ? "你赢了！" : "这局输了") : winner;
  const sub = me ? `${winner} · 你是 ${esc(me.role_name)}` : "观战结束";
  let markTotal = 0;
  let markRight = 0;
  const rows = g.players.map((p) => {
    const m = S.marks[p.seat] || "";
    let markCell = "";
    if (m) {
      const ok = m === "merlin" ? p.role === "merlin" : m === p.team;
      markTotal++;
      if (ok) markRight++;
      markCell = `<span class="mk ${ok ? "ok" : "bad"}">${MARK_TEXT[m]} ${ok ? "✓" : "✗"}</span>`;
    }
    const st = g.stats?.[String(p.seat)];
    const acc = st && st.votes ? Math.round((100 * st.correct) / st.votes) + "%" : "-";
    return `<tr class="${p.is_human ? "me-row" : ""}">
      <td><span class="who-cell">${seatEmblem(p.seat, "sm")}${esc(p.name)}${p.is_human ? "（你）" : ""}</span></td>
      <td><span class="label ${p.team}">${esc(p.role_name)}</span></td>
      <td>${p.team === "good" ? acc : "-"}</td>
      <td>${st && p.team === "good" ? st.proposals_with_evil + "/" + st.proposals : "-"}</td>
      ${me ? `<td>${markCell}</td>` : ""}</tr>`;
  }).join("");
  const myStats = me && g.stats?.[String(me.seat)];
  const score = g.score || [g.quests.filter((q) => q.success === true).length, g.quests.filter((q) => q.success === false).length];
  const tiles = [`<div class="tile"><span class="tk">任务比分</span><span class="tv"><b class="t-good">${score[0]}</b> : <b class="t-evil">${score[1]}</b></span></div>`];
  if (me && me.team === "good" && myStats && myStats.votes) {
    tiles.push(`<div class="tile"><span class="tk">你的投票正确率</span><span class="tv">${Math.round((100 * myStats.correct) / myStats.votes)}%</span></div>`);
  }
  if (me) {
    tiles.push(`<div class="tile"><span class="tk">身份标记</span><span class="tv">${markTotal ? `${markRight}/${markTotal}` : "—"}</span></div>`);
  }
  let markLine = "";
  if (me) {
    markLine = markTotal
      ? `<p>你的身份标记：标了 ${markTotal} 人，猜对 ${markRight} 人。</p>`
      : `<p class="muted small">小技巧：对局中点击座位下方的“标记”记录你的判断，结算时会告诉你猜对了几个。</p>`;
  }
  const kind = !me ? "neutral" : win ? "win" : "lose";
  const html = `
    <div class="end-banner ${kind} team-${g.winner}">
      <div class="eb-emblem">${ic(!me ? "swords" : win ? "crown" : g.winner === "good" ? "chalice" : "dagger")}</div>
      <div class="eb-title">${title}</div>
      <div class="eb-sub">${sub}</div>
    </div>
    <p class="end-reason">${esc(g.end_reason)}</p>
    <div class="end-stats">${tiles.join("")}</div>
    <h3>身份揭晓</h3>
    <div class="table-scroll"><table class="reveal-table">
      <thead><tr><th>玩家</th><th>身份</th><th title="赞成无坏人的车、反对有坏人的车算正确（仅统计好人）">投票正确率</th><th title="好人当队长时提名的队伍含坏人次数 / 当队长次数">含坏人的提名</th>${me ? "<th>你的标记</th>" : ""}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${markLine}
    ${myStats && me.team === "good" ? `<p>你作为好人：赞成含坏人的车 ${myStats.approve_evil} 次，反对干净的车 ${myStats.reject_clean} 次。</p>` : ""}
    <div class="end-actions">
      <button class="primary" id="end-review">${me ? "AI 教练复盘" : "AI 整局点评"}</button>
      <button id="end-thoughts">${ic("thought")}查看 AI 内心独白</button>
      <button class="ghost" id="end-again">再来一局</button>
    </div>
    <div id="review-box"></div>`;
  openModal("对局结算", html, "end");
  $("#end-review").onclick = loadReview;
  $("#end-thoughts").onclick = () => {
    $("#show-thoughts").checked = true;
    document.body.classList.add("show-thoughts");
    $("#modal").close();
    $("#log").scrollTop = 0;
  };
  $("#end-again").onclick = () => showSetup();
  if (g.review) $("#review-box").innerHTML = `<h3>AI 教练复盘</h3><div class="letter">${md(g.review)}</div>`;
}

async function loadReview() {
  const box = $("#review-box");
  const btn = $("#end-review");
  btn.disabled = true;
  box.innerHTML = `<div class="loading">教练正在复盘整局（大约需要十几秒）<span class="dots"></span></div>`;
  box.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth" });
  try {
    const r = await api(`/api/games/${S.gameId}/review`, {});
    if (S.g) S.g.review = r.text;
    box.innerHTML = `<h3>AI 教练复盘</h3><div class="letter">${md(r.text)}</div>`;
  } catch (err) {
    box.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    btn.disabled = false;
  }
}

$("#btn-rules").onclick = () => {
  const n = S.g?.n || 7;
  const preset = S.config.presets[n];
  const roles = [...new Set(preset.roles)]
    .map((r) => {
      const R = S.config.roles[r];
      return `<li class="role-li"><span class="role-ic ${R.team}">${ART.role(r)}</span><div><b>${R.name}</b> <span class="label ${R.team}">${TEAM_NAME[R.team]}</span><br>${esc(R.ability)}</div></li>`;
    })
    .join("");
  const sizes = preset.team_sizes
    .map((z, i) => `<span class="qs${n >= 7 && i === 3 ? " two" : ""}" title="第${i + 1}轮">${z}</span>`).join("");
  openModal("规则速查", `
    <h3>流程</h3>
    <ol>
      <li>队长提名指定人数的队伍，其他人按顺序发言，然后所有人同时投票。</li>
      <li>赞成票<b>超过半数</b>才发车，否则队长交给下一位。同一轮<b>连续5次否决</b>，坏人直接获胜。</li>
      <li>队员秘密出牌：好人只能出成功，坏人可以出失败。出现失败牌任务就失败${n >= 7 ? "（本局第4轮需要2张失败）" : ""}。</li>
      <li>先赢3轮的阵营获胜；但好人赢下3轮后，刺客还可以刺杀梅林翻盘。</li>
    </ol>
    <h3>本局（${n}人）角色</h3>
    <ul class="role-list">${roles}</ul>
    <p class="sizes-line">任务人数：${sizes}</p>
    <h3>练习小贴士</h3>
    <ul>
      <li>任务失败后，记下车上的人和投赞成票的人——坏人常常支持有队友的车。</li>
      <li>反对“干净车”的人值得怀疑；第5次提名时乱投反对的人更值得怀疑。</li>
      <li>当梅林时别让票型太准；当刺客时找“票型最准、总能避开坏人”的人。</li>
      <li>点击座位下方的“标记”记下你的判断，结算时看看自己猜对了几个。</li>
    </ul>`, "rules");
};

$("#btn-new").onclick = async () => {
  if (S.g && ACTIVE.includes(S.g.status)) {
    if (!confirm("放弃当前对局，开始新游戏？")) return;
    try { await api(`/api/games/${S.gameId}/abort`, {}); } catch { /* 无所谓 */ }
  }
  showSetup();
};

// =====================================================================
// 启动
// =====================================================================
(async function boot() {
  await initSetup();
  const saved = load("avalon.game");
  if (!saved) return;
  try {
    const st = await api(`/api/games/${saved}/state?since=999999`);
    if (["running", "ended"].includes(st.status)) enterGame(saved);
    else forget("avalon.game");
  } catch {
    forget("avalon.game");
  }
})();
