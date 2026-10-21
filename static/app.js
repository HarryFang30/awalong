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
  let res;
  // 本机服务没开 / 断网：浏览器只给一句英文 “Failed to fetch”，换成说得清的中文
  try { res = await fetch(path, opt); } catch { throw new Error("连不上本机服务（确认 run.py 还开着）"); }
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
// 对局记录、行动栏队员位、结算表、桌心队伍都用它，和圆桌上的座位长得一样。
// 每面纹章只画一次（#arms-sprite 里的 <symbol>），各处用 <use> 引用：长对局的记录不会堆出上千个 SVG 节点
const ARMS = { key: "" };
function ensureArms() {
  const g = S.g;
  if (!g) return;
  const key = `${S.gameId}|` + g.players.map((p) => `${p.seat}:${p.name}:${p.is_human ? 1 : 0}`).join(",");
  if (ARMS.key === key) return;
  ARMS.key = key;
  let box = document.getElementById("arms-sprite");
  if (!box) {
    box = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    box.id = "arms-sprite";
    box.setAttribute("class", "svg-defs");
    box.setAttribute("aria-hidden", "true");
    document.body.appendChild(box);
  }
  box.innerHTML = g.players.map((p) => {
    const inner = ART.blazon(ART.arms(p), "x").replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
    return `<symbol id="arms-${p.seat}" viewBox="0 0 64 74">${inner}</symbol>`;
  }).join("");
}
function seatEmblem(seat, size = "sm") {
  const a = armsOf(seat);
  const art = ARMS.key ? `<svg class="eshield" viewBox="0 0 64 74" aria-hidden="true" focusable="false"><use href="#arms-${+seat}"/></svg>` : ART.blazon(a, "eshield");
  return `<span class="emb emb-${size}${a.me ? " me" : ""}" aria-hidden="true">${art}<b>${+seat}</b></span>`;
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
    setupError(err.message.startsWith("连不上") ? err.message : "连不上本地服务：" + err.message);
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
    .map((z, i) => `<span class="qs" title="第${i + 1}轮：${z}人${n >= 7 && i === 3 ? "，需2张失败" : ""}">${z}${n >= 7 && i === 3 ? '<span class="two" aria-hidden="true">需2败</span>' : ""}</span>`)
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
  // 结果：内联图标 + 有底色的小签；✅ / ❌ 只留给读屏软件（不显示系统彩色表情）
  const show = (ok, msg) => {
    out.className = `small check-result ${ok ? "ok" : "bad"}`;
    out.innerHTML = `${ic(ok ? "check" : "cross")}<span><span class="sr-only">${ok ? "✅" : "❌"} </span>${esc(msg)}</span>`;
  };
  out.className = "small check-result";
  out.textContent = "测试中…";
  try {
    const r = await api("/api/check-key", { api_key: $("#f-key").value.trim(), model: $("#f-model").value.trim() });
    show(r.ok, r.message);
  } catch (err) {
    show(false, err.message);
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
  setupError("");
  try {
    const { id } = await api("/api/games", body);
    enterGame(id, true);
  } catch (err) {
    setupError(err.message);
  } finally {
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    if (label) label.textContent = "开始游戏";
  }
}

// 开局表单的错误：和“测试连接”的失败结果同一种小签（玫瑰底、✕ 图标）
function setupError(msg) {
  const el = $("#setup-error");
  if (!msg) el.textContent = "";
  else el.innerHTML = `${ic("cross")}<span>${esc(msg)}</span>`;
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
  setupError(message);
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
    selected: [], lastPick: 0, busy: false, pendingKey: null, covered: false, live: false, revealFresh: fresh, netFail: 0,
  });
  stopTips();
  try { S.marks = JSON.parse(load("avalon.marks." + id) || "{}"); } catch { S.marks = {}; }
  store("avalon.game", id);
  LOGGEN++; // 上一局还没补完的记录不再往这里补
  LOG.rebuild = null;
  $("#log").innerHTML = "";
  LOG.pinned = true;
  newRowsPill(false);
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

// 轮询只有一条链：同一时刻最多一个 /state 请求在路上。
// 拉取途中又要求拉一次（刚提交了行动、换了一局）就记下来，这一次回来后马上接着拉——
// 两个请求带着同一个 since 并行回来，会把同一批事件处理两遍（重复的记录、重复的刺杀和胜负）
async function poll() {
  clearTimeout(S.pollTimer);
  if (S.polling) { S.pollAgain = true; return; }
  const id = S.gameId;
  if (!id) return;
  S.polling = true;
  S.pollAgain = false;
  let next = null;
  try {
    next = await pollOnce(id);
  } finally {
    S.polling = false;
  }
  if (S.gameId !== id || S.pollAgain) {
    S.pollAgain = false;
    if (S.gameId) { clearTimeout(S.pollTimer); S.pollTimer = setTimeout(poll, S.gameId !== id ? 0 : 60); }
    return;
  }
  if (next !== null) S.pollTimer = setTimeout(poll, next);
}
// 尽快再拉一次（提交行动之后）：不另起一条并行的轮询
function pollSoon(ms) {
  if (S.polling) { S.pollAgain = true; return; }
  clearTimeout(S.pollTimer);
  S.pollTimer = setTimeout(poll, ms);
}

// 拉一次状态并处理新事件；返回下一次轮询的间隔（毫秒），不用再拉时返回 null
async function pollOnce(id) {
  try {
    let rebuild = !S.live;
    let endedNow = false;
    let refetched = false;
    let st = await api(`/api/games/${id}/state?since=${S.lastId}`);
    if (id !== S.gameId) return null;
    S.netFail = 0;
    // “新”以处理这一刻的 lastId 为准（不是发请求时的）
    const prevLast = S.lastId;
    if (st.status === "ended" && !S.ended) {
      // 对局结束：重新拉取全部记录（含隐藏信息和 AI 内心独白）
      st = await api(`/api/games/${id}/state?since=0`);
      if (id !== S.gameId) return null;
      S.ended = true;
      S.events = [];
      rebuild = true;
      refetched = true;
      endedNow = S.live;
      if (!endedNow) $("#thoughts-toggle").hidden = false;
    }
    if (!S.g && st.spectator) {
      $("#thoughts-toggle").hidden = false;
      $("#show-thoughts").checked = true;
      document.body.classList.add("show-thoughts");
    }
    S.g = st;
    ensureArms();
    const fresh = [];
    const items = [];
    for (const ev of st.events) {
      // 已经处理过的事件不再处理第二遍（终局重新拉全部记录时除外：那时 S.events 是重建的）
      if (!refetched && ev.id <= prevLast) continue;
      S.events.push(ev);
      const isNew = S.live && ev.id > prevLast;
      if (isNew) { prepMoment(ev); fresh.push(ev); }
      items.push([ev, isNew]);
    }
    // 一次性写入（不再每条记录读一次布局）；刷新恢复 / 终局重建后直接停在最新一条。
    // 刚刚打完：先只写新到的几条（照常扣住要揭晓的），整段带内心独白的重建等刺杀、胜负演完再分批做
    if (endedNow) appendEvents(items.filter(([, isNew]) => isNew));
    else appendEvents(items, rebuild);
    S.lastId = Math.max(S.lastId, st.last_event_id);
    render();
    S.live = true;
    // 时刻在渲染之后再演：要用到座位的位置，桌面状态也已经是最新的
    playMoments(fresh);
    if (endedNow) {
      // 整段带内心独白的重建等结算卷轴展开之后再做（不和 showModal 挤在一起卡住展开）；要看独白时 flushLog 立刻补上
      LOG.rebuild = () => {
        LOG.rebuild = null;
        if (id !== S.gameId) return;
        appendEvents(S.events.map((ev) => [ev, false]), true);
        $("#thoughts-toggle").hidden = false;
      };
      whenFxIdle(() => fxLater(() => LOG.rebuild?.(), 1200));
    }
    if (S.ended && !S.endShown) {
      S.endShown = true;
      // 结算卷轴等所有时刻（刺杀、胜负标题）演完再展开；刷新恢复时直接打开
      whenFxIdle(() => fxLater(showEndModal, fresh.length ? 250 : 700));
    }
    if (!ACTIVE.includes(st.status)) return null;
    return st.pending ? 1500 : 700;
  } catch (err) {
    if (id !== S.gameId) return null;
    if (err.message.includes("不存在")) {
      showSetup("上一局已经不在了（服务器可能重启过），开一局新的吧。");
      return null;
    }
    // 连着两次拉不到：等待条换成“连接断开”（不动已经摆出来的行动卡片），连上之后照常渲染
    if (++S.netFail === 2 && S.g) renderAction();
    return 3000;
  }
}

// 轮到你的待办。刚提交过的那条不算：提交之前发出的轮询晚到时还带着它，交过的卡片不能又摆回来
const myTurn = () => {
  const p = S.g?.pending;
  return p && S.pendingKey !== `done${p.id}` ? p : null;
};

function render() {
  // 新的待办：先清空上一次的选择，再画桌子（行动栏不用再重画一遍桌子）
  const p = myTurn();
  if (p && S.pendingKey !== `p${p.id}`) { S.selected = []; S.lastPick = 0; }
  renderTracks();
  renderTable();
  renderIdentity();
  renderAction();
  renderUsage();
  maybeReveal();
}

// 翻牌途中，顶栏、否决数还停在正在揭晓的这一轮（不管牌翻开后游戏是否继续，看上去都一样）
const shownQuest = () => (S.fx.holdQuest >= 0 ? S.fx.holdQuest : S.g.quest_index);
function currentRejects() {
  const qi = shownQuest();
  return S.events.filter((e) => e.type === "vote" && e.quest === qi && !e.approved).length;
}

function renderTracks() {
  const g = S.g;
  const prev = S.fx.quests;
  // 任务翻牌还没揭晓时，顶栏的火漆先按“未出结果”画，等印章落下再盖上（不提前剧透）
  const quests = g.quests.map((q, i) => (i === S.fx.holdQuest ? { ...q, success: null } : q));
  const now = quests.map((q) => q.success);
  S.fx.quests = now;
  const cur = S.fx.holdQuest >= 0 || ACTIVE.includes(g.status) ? shownQuest() : -1;
  const html = quests.map((q, i) => {
    let cls = "";
    if (q.success === true) cls = "success";
    else if (q.success === false) cls = "fail";
    else if (i === cur) cls = "current";
    let title = `第${i + 1}轮：${q.size}人`;
    if (q.fails_needed === 2) title += "，需要2张失败才失败";
    if (q.success !== null) title += `；${q.success ? "成功" : "失败"}（${q.fails}张失败）`;
    // 结果用内联 SVG（字体里的 ✓ ✗ 渲染发虚）；失败多于 1 张时在火漆下方挂几把小匕首（= 失败牌，和翻牌时的牌面一样）
    // “需2败”（规则）和匕首（结果）一眼就分得开；读屏软件读 sr-only 里的整句
    const face = q.success === true ? ic("check") : q.success === false ? ic("cross") : q.size;
    const two = q.fails_needed === 2 && q.success === null ? '<span class="two" aria-hidden="true">需2败</span>' : "";
    return `<div class="quest ${cls}" title="${title}"><span class="qn" aria-hidden="true">${face}</span>${two}${failPips(q)}<span class="sr-only">${title}</span></div>`;
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

// 任务失败牌多于 1 张：火漆右下角挂几把小匕首（4 张以上写“×N”）
function failPips(q) {
  if (q.success === null || q.success === undefined || !(q.fails > 1)) return "";
  const d = ic("dagger");
  return `<span class="qf" aria-hidden="true">${q.fails <= 3 ? d.repeat(q.fails) : `${d}<i>×${q.fails}</i>`}</span>`;
}

// 揭晓的“闸门”：还没翻定的任务结果 / 还没开演的“刺杀阶段”。闸门之后到的事件（下一轮的提名、发言、
// 坏人讨论刺杀谁……）在桌上和记录里先当没发生，免得翻牌途中就看出游戏是否还在继续
const gateId = () => S.fx.questGate || S.fx.holdReveal;

// 最近一次投票；新的提名开始后它就“过时”了：座位上的票型缩小变暗，但仍然看得清
function lastVote() {
  const gate = gateId();
  let stale = false;
  for (let i = S.events.length - 1; i >= 0; i--) {
    const e = S.events[i];
    if (gate && e.id >= gate) continue;
    if (e.type === "vote") return { ev: e, stale };
    if (e.type === "proposal" || e.type === "quest_start" || e.type === "evil_reveal") stale = true;
  }
  return null;
}

// 湖中仙女在谁手里。闸门扣着时按闸门之前的记录算：仙女只在游戏继续时才交出去，翻牌途中挪动就等于提前公布了结果
function ladyHolder() {
  const g = S.g;
  const gate = gateId();
  if (!gate) return g.lady_holder;
  for (let i = S.events.length - 1; i >= 0; i--) {
    const e = S.events[i];
    if (e.id >= gate) continue;
    if (e.type === "lady_claim") return e.target;
    if (e.type === "start") return e.lady;
  }
  return g.lady_holder;
}

// 揭晓之前（翻牌、刺杀、胜负）先压住行动栏；已经摆出来的行动卡片不收回（不打断正在输入的人）
const dockHeld = () => !!S.fx.holdEnd && !(S.g?.pending && S.pendingKey === `p${S.g.pending.id}`);

function selection() {
  const p = myTurn();
  if (!p || dockHeld()) return null;
  if (p.type === "propose") return { seats: S.g.players.map((x) => x.seat), max: p.size, type: p.type };
  if (["lady_choose", "assassin_suggest", "assassinate"].includes(p.type)) return { seats: p.candidates, max: 1, type: p.type };
  return null;
}

// ---------------------------------------------------------------------
// 座位排布：沿椭圆按“弧长”等距排开（宽桌子两侧不会挤成一摞），你永远坐在正下方。
// 椭圆大小按圆桌区域的实际宽高算：上方留出王冠，下方留出名牌和标签，两侧留出名牌半宽。
// 只有尺寸、人数或你的座位变化时才重新计算；平时轮询不会改动任何样式。
// ---------------------------------------------------------------------
const RING = { key: "", pos: {}, side: {}, W: 0, H: 0, px: null, nb: "", glide: null, glideUntil: 0, fitTimer: 0 };

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
  // 尺寸来自 ResizeObserver（不在每次轮询时强制同步布局）；还没收到时才现读一次
  let W = RING.W, H = RING.H;
  if (!W || !H) { W = table.clientWidth; H = table.clientHeight; }
  if (!W || !H) return false;
  const base = g.you ? g.you.seat : 1;
  const key = `${W}x${H}|${g.n}|${base}|${window.innerWidth}x${window.innerHeight}`;
  if (key === RING.key) return false;
  RING.key = key;

  const cs = getComputedStyle(table);
  const num = (name, def) => { const v = parseFloat(cs.getPropertyValue(name)); return Number.isFinite(v) ? v : def; };
  const m = {
    sh: num("--sh", 56),            // 盾牌宽
    sw: num("--seat-w", 112),       // 竖排座位块宽（名牌、标签最宽处）
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
  RING.z = {};
  const px = {};
  lay.pts.forEach((p, k) => {
    const seat = ((base - 1 + k) % n) + 1;
    RING.pos[seat] = {
      left: `${((100 * (W / 2 + p.x)) / W).toFixed(3)}%`,
      top: `${((100 * (cy + p.y)) / H).toFixed(3)}%`,
    };
    RING.side[seat] = sideMode && Math.abs(p.c) > 0.55 ? (p.c < 0 ? "side-l" : "side-r") : "";
    px[seat] = [W / 2 + p.x, cy + p.y];
  });
  // 越靠下的座位叠得越靠上：上面座位“标记”按钮往下放大的点击区域，永远压不住下面那面盾牌（挤的桌子上不会点错人）
  Object.keys(px).sort((a, b) => px[a][1] - px[b][1]).forEach((seat, i) => { RING.z[seat] = String(2 + i); });
  // 同一局里只是圆桌变了高度（比如轮到你时行动栏升高）：座位从原来的位置滑过去，而不是一下跳开。
  // 宽度变了（旋转屏幕、拖窗口）就直接就位：横竖屏切换时座位从屏幕外滑回来会撑出横向滚动
  const nb = `${n}|${base}`;
  const prev = RING.geo;
  RING.glide = null;
  if (RING.nb === nb && RING.px && prev && Math.abs(prev.W - W) < 1 && wrap.classList.contains("ring-ready") && !reduceMotion()) {
    RING.glide = {};
    for (const seat in px) if (RING.px[seat]) RING.glide[seat] = [RING.px[seat][0] - px[seat][0], RING.px[seat][1] - px[seat][1]];
  }
  if (RING.nb !== nb) {
    // 新的一局：第一次摆好之前不做过渡（桌面、桌心文字直接就位）
    wrap.classList.remove("ring-ready");
    setTimeout(() => wrap.classList.add("ring-ready"), 120);
  }
  RING.px = px;
  RING.nb = nb;
  const oy = Math.max(24, ry - m.gy);
  const ox = Math.max(30, Math.min(lay.rx - (sideMode ? m.sh * 0.5 + 18 : m.gx), oy * 1.72));
  RING.geo = { W, H, cy, oy, ox };
  const vars = { "--cy": `${cy.toFixed(1)}px`, "--ox": `${ox.toFixed(1)}px`, "--oy": `${oy.toFixed(1)}px` };
  for (const [k, v] of Object.entries(vars)) if (wrap.style.getPropertyValue(k) !== v) wrap.style.setProperty(k, v);
  // 桌面椭圆跟着座位一起滑：变量一次写到终点，再用合成层上的 transform 从旧的大小过渡过去
  // （不再给会继承的自定义属性做过渡——那样每一帧都要重算整张桌子的样式）
  if (RING.glide && prev) glideOval(prev, RING.geo);
  RING.centerGlide = !!RING.glide;
  RING.fitDirty = true; // 桌心文字下次渲染时按新的座位重新摆
  return true;
}
const GLIDE_EASE = "cubic-bezier(.25, .8, .3, 1)";
function glideOval(a, b) {
  const table = $("#table");
  if (!table.animate || !a.ox || !b.ox || !a.oy || !b.oy) return;
  const sx = a.ox / b.ox, sy = a.oy / b.oy, dy = a.cy - b.cy;
  if (Math.abs(sx - 1) < 0.004 && Math.abs(sy - 1) < 0.004 && Math.abs(dy) < 0.5) return;
  const kf = { transform: [`translateY(${dy.toFixed(1)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`, "none"] };
  for (const pe of ["::before", "::after"]) {
    let an = null;
    try { an = table.animate(kf, { duration: GLIDE_MS, easing: GLIDE_EASE, pseudoElement: pe }); } catch { return; }
    // 不支持给伪元素做动画的浏览器会把动画加在整张桌子上：立刻取消，椭圆直接就位
    if (an.effect?.pseudoElement !== pe) { an.cancel(); return; }
  }
}

// 各座位实际占的矩形（相对圆桌，横坐标以桌心为 0）。上半桌算到名牌和标签的底；
// 下半桌算到盾牌顶——strict（桌心常驻的文字）时再留出王冠、票型的位置，时刻只是一闪而过，可以压住王冠
function seatBoxes(strict) {
  const table = $("#table");
  const tr = table.getBoundingClientRect();
  const cx = tr.left + tr.width / 2;
  const cy = RING.geo.cy;
  const out = [];
  for (const el of table.querySelectorAll(".seat")) {
    // 还在滑动的座位直接停到终点再量
    for (const an of el.getAnimations?.() || []) if (an.id === "glide") an.finish();
    const a = el.firstElementChild.getBoundingClientRect(); // .avatar
    if (!a.width) continue;
    let x0 = a.left, x1 = a.right, y1 = a.bottom;
    for (const part of [el.children[1], el.children[2]]) { // .plate、.labels
      const r = part?.getBoundingClientRect();
      if (!r || !r.width) continue;
      x0 = Math.min(x0, r.left);
      x1 = Math.max(x1, r.right);
      y1 = Math.max(y1, r.bottom);
    }
    out.push({
      x0: x0 - cx, x1: x1 - cx,
      above: (a.top + a.bottom) / 2 - tr.top < cy,
      top: a.top - tr.top - (strict ? a.width * 0.42 : 0),
      bottom: y1 - tr.top,
    });
  }
  return out;
}
// 桌心可用的竖直区间：只看和 [-hw, hw] 横向重叠的座位，再限制在桌面椭圆之内
function bandFor(hw, boxes) {
  const { cy, oy, H } = RING.geo;
  let top = Math.max(4, cy - oy), bot = Math.min(H - 4, cy + oy);
  for (const b of boxes) {
    if (b.x1 <= -hw || b.x0 >= hw) continue;
    if (b.above) top = Math.max(top, b.bottom + 3);
    else bot = Math.min(bot, b.top - 3);
  }
  return { top, bot };
}

// 桌心文字：放在“上方座位的名牌、标签以下，下方座位的王冠以上”那一条的正中；
// 那一条太矮时先把文字收窄（避开下方两侧的座位），还放不下就省掉小标题、再省掉说明行。
// 只在桌心内容或座位布局变化时量一次，轮询空转时不碰 DOM
function fitCenter() {
  const tc = $("#table-center");
  const wrap = $(".table-wrap");
  if (!RING.geo || !tc.firstElementChild) return;
  if (tc.style.maxWidth) tc.style.maxWidth = "";
  if (tc.classList.contains("tight")) tc.classList.remove("tight", "tighter");
  const full = tc.offsetWidth / 2;
  if (!full) return;
  const boxes = seatBoxes(true);
  let hw = full, b = bandFor(hw, boxes);
  for (let w = full - 10; w >= 90 && b.bot - b.top < 110; w -= 10) {
    const bb = bandFor(w, boxes);
    if (bb.bot - bb.top > b.bot - b.top + 10) { hw = w; b = bb; }
  }
  if (hw < full) tc.style.maxWidth = `${Math.round(2 * hw)}px`;
  stackParts(tc);
  const ok = b.bot - b.top > 36;
  const y = ok ? (b.top + b.bot) / 2 : RING.geo.cy;
  const ty = `${y.toFixed(1)}px`;
  const was = parseFloat(wrap.style.getPropertyValue("--tc-y"));
  if (wrap.style.getPropertyValue("--tc-y") !== ty) {
    wrap.style.setProperty("--tc-y", ty);
    // 圆桌刚滑过（行动栏升起 / 收起）：桌心文字也滑到新位置（合成层上的 translate）；只是文字变了就直接就位
    if (RING.centerGlide && Number.isFinite(was) && Math.abs(was - y) > 1 && tc.animate && !reduceMotion()) {
      tc.animate({ translate: [`0px ${(was - y).toFixed(1)}px`, "0px 0px"] }, { duration: GLIDE_MS, easing: GLIDE_EASE });
    }
  }
  RING.centerGlide = false;
  const avail = ok ? b.bot - b.top + 6 : 60;
  if (tc.offsetHeight <= avail) return;
  tc.classList.add("tight");
  if (tc.offsetHeight > avail) tc.classList.add("tighter");
}

function placeSeat(el, seat) {
  const pos = RING.pos[seat];
  if (!pos) return;
  const z = RING.z?.[seat];
  if (z && el._z !== z) { el._z = z; el.style.zIndex = z; }
  // 浏览器会把 "12.300%" 规范成 "12.3%"，所以记住上次写入的值来比较，避免每次轮询都改样式
  const k = pos.left + "," + pos.top;
  if (el._pos === k) return;
  const first = !el._pos;
  el._pos = k;
  el.style.left = pos.left;
  el.style.top = pos.top;
  const d = !first && RING.glide?.[seat];
  if (d && Math.abs(d[0]) + Math.abs(d[1]) > 1 && el.animate) {
    el.animate({ translate: [`${d[0].toFixed(1)}px ${d[1].toFixed(1)}px`, "0px 0px"] },
      { duration: GLIDE_MS, easing: GLIDE_EASE, id: "glide" });
    RING.glideUntil = performance.now() + GLIDE_MS;
  }
}
const GLIDE_MS = 300;
const gliding = () => performance.now() < RING.glideUntil;
// 座位还在滑动时先不量（量到的是半路上的位置）：滑完再摆桌心文字和正在演的时刻
function fitAfterGlide() {
  clearTimeout(RING.fitTimer);
  RING.fitTimer = setTimeout(() => {
    if (!S.g) return;
    RING.fitDirty = true;
    renderTable();
    refitMoment();
  }, Math.max(0, RING.glideUntil - performance.now()) + 30);
}

function placeSeats() {
  if (!S.g || !ringLayout()) return;
  renderTable(); // 横排/竖排可能变了，连同位置一起更新
  refitMoment();  // 正在演的时刻也按新的座位重新摆
}
if (window.ResizeObserver) {
  new ResizeObserver((entries) => {
    const r = entries[entries.length - 1].contentRect;
    RING.W = r.width;
    RING.H = r.height;
    placeSeats();
  }).observe($("#table"));
}
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
  // 翻牌途中：车上的人、队长王冠照旧；谁在思考（下一任队长 / 坏人讨论刺杀）等揭晓之后再显示
  const flipping = S.fx.holdQuest >= 0;
  const team = (flipping ? S.fx.holdTeam : g.proposal) || [];
  // 出牌时谁还在“思考”是秘密：好人 AI 不用想就出成功，只有坏人 AI 要等模型回话——思考气泡会直接点出车上的坏人
  const quiet = flipping || !!S.fx.holdReveal || g.phase === "quest";
  const lady = g.lady_enabled ? ladyHolder() : null;
  // 终局后座位上不再挂票型——但要等揭晓完（翻牌途中对局就结束了，票型一下子消失也是剧透）
  let lv = S.ended && !S.fx.holdEnd ? null : lastVote();
  // 新的一次投票进行中：上一次的票先收起来（不然看着像大家已经投了赞成，或者你的票被预先填好了）
  if (lv?.stale && g.phase === "vote") lv = null;
  const vote = lv?.ev;
  const freshVote = vote && !lv.stale && vote.id === S.fx.voteId && performance.now() - S.fx.voteAt < 1500;
  const table = $("#table");
  const tcls = ["table"];
  if (sel) tcls.push("picking", `pick-${sel.type}`);
  // 队伍已经选满：其余座位不再像“可以点”（要换人先点掉一个已选的）
  if (sel && sel.max > 1 && S.selected.length >= sel.max) tcls.push("full");
  if (g.n >= 9) tcls.push("crowded");
  const tclass = tcls.join(" ");
  if (table.className !== tclass) {
    table.className = tclass;
    $("#game").classList.toggle("crowded", g.n >= 9); // 9 人以上：手机上行动卡片也收紧一号
  }
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
    if (g.thinking.includes(p.seat) && !quiet) cls.push("thinking");
    if (p.role_name && open) cls.push("revealed", `team-${p.team}`);
    if (RING.side[p.seat]) cls.push(RING.side[p.seat]);
    const className = cls.join(" ");
    if (el.className !== className) el.className = className;
    placeSeat(el, p.seat);

    // 纹章盾 + 座位号圆章 + 各种徽记
    const isLeader = g.leader === p.seat && (ACTIVE.includes(g.status) || flipping);
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
      (lady === p.seat ? `<span class="lady" title="湖中仙女">${ART.ladyBadge()}</span>` : "") +
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

    // 你的名字太长时只省略名字本身，“（你）”始终留着
    patch(nameEl, p.is_human ? `<span class="nm">${esc(p.name)}</span><small>（你）</small>` : esc(p.name));

    const labels = [];
    if (p.role_name && open && (S.ended || !p.is_human)) {
      labels.push(`<span class="label ${p.team}">${esc(p.role_name)}</span>`);
    } else if (p.known) {
      // “坏人（已亮明）”：括号里的部分在窄桌子上省掉（缎带不压到邻座），完整文字在 title 里
      const [main, rest] = p.known.split(/(?=（)/);
      labels.push(`<span class="label ${labelClass(p.known)}" title="${esc(p.known)}">${esc(main)}${rest ? `<span class="lb-x">${esc(rest)}</span>` : ""}</span>`);
    }
    syncMark(mkEl, p, g.spectator);
    // 坏人亮明身份那一幕开演之前，座位上的缎带保持原样（不抢在最后一次翻牌之前剧透）
    if (!S.fx.holdReveal || labelsEl._h === undefined) patch(labelsEl, labels.join(""));
  });
  table.querySelectorAll(".seat").forEach((el) => { if (!seen.has(el.dataset.seat)) el.remove(); });
  const tc = $("#table-center");
  if (patch(tc, centerText()) || RING.fitDirty) {
    if (gliding()) fitAfterGlide();
    else {
      RING.fitDirty = false;
      fitCenter();
    }
  }
}

// 标记按钮：原地改文字和属性（不重建按钮），键盘连按 Enter 时焦点留在它身上
function syncMark(mkEl, p, spectator) {
  let btn = mkEl.firstElementChild;
  if (p.is_human || spectator) {
    if (btn) mkEl.textContent = "";
    return;
  }
  if (!btn) {
    mkEl.innerHTML = `<button class="mark" title="记下你对TA的判断（点击切换）"></button>`;
    btn = mkEl.firstElementChild;
    btn.dataset.mark = "?";
  }
  const mark = S.marks[p.seat] || "";
  if (btn.dataset.mark === mark) return;
  btn.dataset.mark = mark;
  // “梅林?”比别的标记宽一截：名字两侧的留白收窄一点，三个字的名字不会被省略成“林…”
  mkEl.parentElement.classList.toggle("mk-wide", mark === "merlin");
  btn.textContent = MARK_TEXT[mark];
  btn.setAttribute("aria-label", `标记 ${p.seat}号：${MARK_TEXT[mark]}`);
}

// 桌心的一排小盾：已选的队员 + 虚线空位
function teamSlots(seats, need = 0) {
  const list = sortSeats(seats || []);
  let html = list.map((s) => `<span class="slot on" title="${s}号 ${esc(nameOf(s))}">${seatEmblem(s, "sm")}</span>`).join("");
  for (let i = list.length; i < need; i++) html += `<span class="slot">${ART.slotShield()}</span>`;
  return html ? `<div class="tc-slots">${html}</div>` : "";
}

// 两段不断行的文字，中间一个“·”；fitCenter 发现第二段换到下一行时加 .stack：两行各占一行、不要点
const twoPart = (a, b) => `<span class="tp"><span class="nw">${a}</span><span class="sep"> · </span><span class="nw">${b}</span></span>`;
// “第1轮任务 · 第1次提名”放不下一行时：拆成上下两行、去掉中间的点（不让“·”孤零零挂在行尾）
function stackParts(root) {
  for (const tp of root.querySelectorAll(".tp")) {
    tp.classList.remove("stack");
    const a = tp.firstElementChild, z = tp.lastElementChild;
    if (z.offsetTop > a.offsetTop + 2) tp.classList.add("stack");
  }
}

function centerText() {
  const g = S.g;
  // 任务牌还没翻定（包括开演前的那段等待）：桌心停在出牌那一刻——不看已经往前走了的阶段、对局状态
  if (S.fx.holdQuest >= 0) {
    const q = g.quests[S.fx.holdQuest];
    return `<div class="tc-kicker">${q.size}人出征${q.fails_needed === 2 ? " · 需2张失败" : ""}</div>` +
      `<div class="phase">${twoPart(`第${S.fx.holdQuest + 1}轮任务`, `第${Math.max(1, S.fx.holdAttempt)}次提名`)}</div>` +
      `<div class="tc-line">任务进行中</div>${teamSlots(S.fx.holdTeam)}`;
  }
  if (g.status === "ended") {
    return `<div class="tc-kicker">对局结束</div><div class="phase win-${g.winner}">${g.winner === "good" ? "好人" : "坏人"}阵营获胜</div><div class="tc-line">${esc(g.end_reason)}</div>`;
  }
  // 出错的原因可能是一长串异常信息：桌心只写一句，完整原因在下方的行动栏和记录里
  if (g.status === "error") return `<div class="phase">出错了</div><div class="tc-line">对局中断，原因见下方</div>`;
  if (g.status === "cancelled") return `<div class="phase">对局已停止</div><div class="tc-line">这局已被中止</div>`;
  // 轮到你点人：桌心直接告诉你点几个、点了几个
  const sel = selection();
  if (sel) {
    const need = sel.max;
    const verb = { propose: "点选队员", lady_choose: "点选查验对象", assassin_suggest: "点选你怀疑的梅林", assassinate: "点选刺杀目标" }[sel.type];
    const kicker = {
      propose: twoPart("你是队长", `第${g.quest_index + 1}轮第${Math.max(1, g.attempt)}次提名`),
      lady_choose: "湖中仙女在你手中",
      assassin_suggest: "刺杀讨论",
      assassinate: "你是刺客 · 一击定胜负",
    }[sel.type];
    const done = S.selected.length === need;
    return `<div class="tc-kicker">${kicker}</div>` +
      `<div class="phase tc-pick${sel.type === "assassinate" || sel.type === "assassin_suggest" ? " evil-text" : ""}"><span class="nw">${verb}</span> <span class="tc-cnt${done ? " done" : ""}"><b>${S.selected.length}</b>/${need}</span></div>` +
      teamSlots(S.selected, need);
  }
  const head = twoPart(`第${g.quest_index + 1}轮任务`, `第${Math.max(1, g.attempt)}次提名`);
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
  if (g.phase === "lady") {
    // 湖中仙女在第 quest_index 轮（从 0 数）结束之后使用
    const line = myTurn()?.type === "lady_announce" ? "等待你公布查验结果"
      : ladyHolder() ? `${whoIs(ladyHolder())}正在查验` : phase;
    return `<div class="tc-kicker">第${g.quest_index + 1}轮之后</div><div class="phase">湖中仙女</div><div class="tc-line">${line}</div>`;
  }
  const q = g.quests[g.quest_index];
  const kicker = q ? `<div class="tc-kicker">${q.size}人出征${q.fails_needed === 2 ? " · 需2张失败" : ""}</div>` : "";
  return `${kicker}<div class="phase">${head}</div><div class="tc-line">${phase}</div>${g.proposal ? teamSlots(g.proposal) : ""}`;
}

// 你知道的人：迷你纹章 + 座位号 + 信息，整枚不断行（“4号 · 坏人队友”不会被拆成两行）
const knowChip = (seat, label, cls = labelClass(label)) =>
  `<span class="kchip ${cls}">${seatEmblem(seat, "xs")}<b>${seat}号</b><span class="kl">${esc(label)}</span></span>`;

function renderIdentity() {
  const y = S.g.you;
  const box = $("#identity");
  if (!y) {
    const cls = S.g.spectator ? "identity spectator" : "identity";
    if (box.className !== cls) box.className = cls;
    patch(box, S.g.spectator ? spectatorCard() : "");
    return;
  }
  const know = y.knowledge.length
    ? y.knowledge.map((k) => knowChip(k.seat, k.label)).join("")
    : `<span class="know-none">没有额外信息，全靠推理。</span>`;
  const tip = y.team === "evil" && y.role !== "oberon"
    ? `<p class="tip">${ic("swords")}<span>坏人默契：已知队友同车且只需1张失败时，由座位号最小的坏人出失败。</span></p>` : "";
  // 遮住时连阵营底色也换成中性的皮革色：旁边的人看不出你是哪一边
  const cls = S.covered ? "identity covered" : `identity ${y.team}`;
  if (box.className !== cls) box.className = cls;
  patch(box, `
    <button class="ghost peek" id="btn-cover" aria-pressed="${S.covered}" aria-label="${S.covered ? "显示身份卡" : "遮住身份卡"}" title="${S.covered ? "翻开身份卡" : "把身份卡扣过去（旁边有人时）"}">${ic(S.covered ? "eye" : "eyeoff")}<span>${S.covered ? "显示" : "遮住"}</span></button>
    <div class="secret"${S.covered ? ' aria-hidden="true"' : ""}>
      <div class="id-art">${ART.role(y.role)}<span class="id-no">${y.seat}号</span></div>
      <div class="id-body">
        <div class="kicker">你的身份 · ${y.seat}号座位</div>
        <div class="role">${esc(y.role_name)}<span class="team">${TEAM_NAME[y.team]}阵营</span></div>
        <p class="ability">${esc(y.ability)}</p>
        <div class="know"><span class="know-k">你知道</span>${know}</div>
        ${tip}
      </div>
    </div>
    <div class="card-back" aria-hidden="${!S.covered}"><span class="cb-crest">${ART.crest()}</span><span class="cb-words"><span class="cb-text">身份已遮住</span><span class="cb-sub">点一下牌背翻开</span></span></div>`);
}

// 观战：上帝视角的“阵营一览”——好人一行、坏人一行，每人一枚纹章 + 角色名，和圆桌上的盾一一对应
function spectatorCard() {
  const g = S.g;
  const ps = g.players.filter((p) => p.team);
  const row = (team) => {
    const list = ps.filter((p) => p.team === team);
    return `<div class="roster ${team}"><span class="ro-k">${TEAM_NAME[team]}<b>${list.length}</b></span>` +
      list.map((p) => knowChip(p.seat, p.role_name, team)).join("") + "</div>";
  };
  const roster = ps.length
    ? row("good") + row("evil")
    : `<p class="ability">所有身份公开，AI 的内心独白会实时出现在对局记录里。</p>`;
  return `<div class="secret"><div class="id-art">${ART.icon("eye", "emblem")}<span class="id-no">观战</span></div>
    <div class="id-body"><div class="kicker">上帝视角 · ${g.n}人局</div>
    <div class="role">观战模式<span class="team">身份全公开</span></div>
    ${roster}
    <p class="tip">${ic("thought")}<span>看梅林怎么藏、刺客怎么找、坏人怎么配合——打开右边的内心独白对照着看。</span></p></div></div>`;
}

$("#identity").addEventListener("click", (e) => {
  // 按钮切换；扣着的时候点整张牌背也能翻开
  if (!e.target.closest("#btn-cover") && !(S.covered && e.target.closest(".card-back"))) return;
  S.covered = !S.covered;
  renderIdentity();
  $("#btn-cover")?.focus({ preventScroll: true });
});

function renderUsage() {
  const g = S.g;
  const el = $("#usage");
  if (!g.llm) { if (el.textContent !== "离线 AI") el.textContent = "离线 AI"; return; }
  const u = g.usage;
  if (!u) return;
  // 出牌时只有坏人 AI 会调用模型：这段时间里调用次数涨了几次，车上就有几个坏人。出牌和翻牌期间计数先不动
  if ((g.phase === "quest" || S.fx.holdQuest >= 0) && el.textContent) return;
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
//   · 教练 / 规则的卷轴开着时先不演；教练正等着翻牌揭晓再回答时照常演（见 hintWait）
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
    cur: null, queue: [], finale: null, leaving: false, idle: [],
    holdQuest: -1,          // 翻牌揭晓之前，顶栏这一轮先不盖火漆、仍标为当前轮
    questGate: 0,           //   那条任务结果的 id（闸门，见 gateId）
    holdTeam: null,         //   翻牌途中桌上照旧标出的这支队伍
    holdAttempt: 0,         //   这支队伍是第几次提名（桌心照旧写着）
    questAt: 0,             // 最近一次投票通过（任务开始）的时刻：翻牌最早什么时候开演，见 quest_result
    waitTimer: 0,           // 队首的一幕还没到开演时间：到点再叫 nextMoment
    endAfterModal: false,   // 结算卷轴等教练 / 规则卷轴关上再展开
    holdRoles: false,       // 匕首落下之前，座位上先不亮出全部身份
    holdReveal: 0,          // “刺杀阶段”这一幕开演之前（存的是那条事件的 id）：座位上先不挂“坏人（已亮明）”
    gateRows: [],           // 闸门之后到的记录（下一轮的提名发言、坏人讨论刺杀谁）：闸门打开时放出
    holdEnd: "",            // 揭晓之前（翻牌 / 刺杀阶段 / 刺杀 / 胜负标题）行动栏先显示这句
    heldLog: new Set(),     // 扣住的对局记录（事件 id）
    revealTimer: 0,
    revealPid: null,        // 开局身份牌亮出时已经在等你的那条待办（它不会把身份牌赶走）
  };
  const box = $("#moment");
  if (box) box.innerHTML = "";
  $(".table-wrap")?.removeAttribute("data-spot");
  $(".table-wrap")?.removeAttribute("data-mo");
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
  if (!fx.cur && !fx.queue.length && !fx.finale && !fx.leaving) fn();
  else fx.idle.push(fn);
}

// ---------- 新事件到达、渲染之前：先压住会剧透的东西 ----------
const END_WAIT = {
  assassination: "刺客出手了……", quest_result: "任务牌揭晓中……", vote: "投票揭晓中……", evil_reveal: "坏人正在讨论谁是梅林……",
  quest: "任务进行中，等待队员出牌", // 结果已经到了、翻牌还没开演：和真的还在出牌时一模一样（见 questWaitHtml）
};
function prepMoment(ev) {
  const fx = S.fx;
  if (ev.type === "vote") {
    fx.voteId = ev.id;
    fx.voteAt = performance.now();
    if (ev.approved) fx.questAt = fx.voteAt;
  } else if (ev.type === "quest_result") {
    // 每一次翻牌都一样：牌翻定之前，桌面、顶栏、行动栏、记录都停在出牌那一刻。
    // 不然决胜轮“停住”、普通轮“下一轮已经开始”，第一眼就能看出结果
    fx.holdQuest = ev.quest;
    fx.questGate = ev.id;
    fx.holdTeam = ev.team;
    fx.holdAttempt = ev.attempt;
    fx.holdEnd ||= END_WAIT.quest;
  } else if (ev.type === "evil_reveal") {
    // 好人三胜、坏人亮明身份：缎带、记录、行动栏等“刺杀阶段”这一幕开演再出现
    fx.holdReveal = ev.id;
  } else if (ev.type === "game_end") {
    // 前面的翻牌 / “刺杀阶段”还没演完：行动栏保持那几幕对应的那句，等后面几幕开演时再换（setHold）
    const evilOn = fx.cur?.m.type === "evil_reveal" || fx.queue.some((m) => m.type === "evil_reveal");
    if (fx.holdQuest >= 0 || fx.holdReveal) fx.holdEnd ||= END_WAIT.quest_result;
    else if (evilOn) fx.holdEnd = END_WAIT.evil_reveal;
    else {
      const before = S.events[S.events.length - 2];
      fx.holdEnd = END_WAIT[before?.type] || "对局结束，正在揭晓……";
    }
    if (!S.g.spectator) fx.holdRoles = true;
  }
}
// 行动栏还压着时，换成这一幕对应的那句话（不提前说出后面才揭晓的事）
function setHold(text) {
  if (!S.fx.holdEnd || S.fx.holdEnd === text) return;
  S.fx.holdEnd = text;
  if (S.g) renderAction();
}
function releaseQuest() {
  if (S.fx.holdQuest < 0) return;
  S.fx.holdQuest = -1;
  S.fx.questGate = 0;
  S.fx.holdTeam = null;
  releaseGate();
  if (S.g) { renderTracks(); renderTable(); }
  hintResume();
}
function releaseRoles() {
  if (!S.fx.holdRoles) return;
  S.fx.holdRoles = false;
  if (S.g) renderTable();
}
function releaseReveal() {
  if (!S.fx.holdReveal) return;
  S.fx.holdReveal = 0;
  releaseGate();
  if (S.g) renderTable();
  hintResume();
}
// 闸门打开：放出扣在它后面的记录；后面还有一道闸门（刺杀阶段）的，继续扣到那一幕开演
function releaseGate() {
  const gate = gateId();
  S.fx.gateRows = S.fx.gateRows.filter((id) => {
    if (gate && id > gate) return true;
    releaseLog(id);
    return false;
  });
}
// 只执行一次：一幕的 release 会在开演、落定、收起时各被叫到一次，后几次不能把行动栏的话改回去
const once = (fn) => {
  let done = false;
  return () => { if (!done) { done = true; fn(); } };
};
function releaseEnd() {
  releaseRoles();
  if (!S.fx.holdEnd) return;
  S.fx.holdEnd = "";
  // 行动栏压着时圆桌也不让点人：两边一起放开
  if (S.g) { renderTable(); renderAction(); }
}
function releaseAll() {
  releaseQuest();
  releaseReveal();
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
const whoIs = (s) => (player(s)?.is_human ? "你" : `<span class="nw">${s}号「${esc(nameOf(s))}」</span>`);

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
  const el = ring($("#moment"), seat, `ripple r-${kind}`);
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
        : k >= 3 ? `<span class="plq-note warn">${twoPart(`本轮已否决${k}次`, `再否决${5 - k}次坏人获胜`)}</span>`
        : `<span class="plq-note">本轮已否决${k}次</span>`;
    }
    return {
      kind: "vote", min: 250, hurry: 1200, ms: ev.approved ? 1700 : 2000,
      html: `<div class="mo">${plaque(ev.approved ? "yes" : "no", ev.approved ? "check" : "cross",
        twoPart(`第${ev.quest + 1}轮`, `第${ev.attempt}次提名`), ev.approved ? "投票通过" : "投票否决", twoPart(`${yes} 赞成`, `${no} 反对`), note)}</div>`,
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
    const release = once(() => {
      if (S.fx.holdQuest === ev.quest) releaseQuest();
      releaseLog(ev.id);
      // 翻牌落定：结果已经摆在桌上，行动栏可以呈上下一步了（比如轮到你组队）。
      // 后面还排着“刺杀阶段”这一幕时，行动栏等那一幕开演再放（轮到你刺杀的卡片不抢在宣布之前出现）；
      // 对局已经结束时行动栏归胜负标题管
      if (S.fx.holdEnd && !S.fx.holdReveal && S.g?.status !== "ended") releaseEnd();
    });
    // 好人 AI 不用想就出成功，坏人 AI 要等模型回话：牌来得快慢本身就是线索（秒出 = 车上没有 AI 坏人）。
    // 联网对局里翻牌最早在投票通过后随机 2.6～5 秒才开演，那之前桌面和行动栏都还是“任务进行中”
    const dwell = S.g.llm && !S.g.spectator && S.fx.questAt ? S.fx.questAt + 2600 + Math.random() * 2400 : 0;
    return {
      kind: "quest", min: land + 350, hurry: land + 700, ms: land + 1500, land, release, notBefore: dwell,
      start: () => { if (S.fx.holdEnd === END_WAIT.quest) setHold(END_WAIT.quest_result); },
      html: `<div class="mo"><div class="qc-kick">第${ev.quest + 1}轮任务 · ${n}张任务牌</div>` +
        `<div class="qc-row" role="img" aria-label="${n - ev.fails}张成功，${ev.fails}张失败">${cards.map(card).join("")}</div>` +
        plaque(ev.success ? "good" : "evil", ev.success ? "chalice" : "dagger", "", `任务${ev.success ? "成功" : "失败"}`,
          twoPart(`${ev.fails}张失败牌${need}`, `比分 ${ev.score[0]} : ${ev.score[1]}`), "", land) + `</div>`,
    };
  },

  lady_claim(ev) {
    const mine = player(ev.holder)?.is_human;
    const truth = S.events.find((e) => e.type === "lady_result" && e.holder === ev.holder && e.target === ev.target)?.result;
    let sub = ev.claim ? `<span class="nw">宣布可能是假的，</span><span class="nw">想想TA自己是哪边的</span>` : `查验了${ev.target}号，但没有公开`;
    if (mine) sub = "真相只有你知道";
    else if (S.g.spectator && truth) {
      sub = `真实结果：${TEAM_NAME[truth]}` + (!ev.claim ? "" : truth === ev.claim ? " · 说了实话" : " · 撒了谎！");
    }
    return {
      kind: "lady", min: 400, hurry: 1300, ms: 2300,
      html: `<div class="mo">${plaque("lady", "waves", twoPart("湖中仙女", `${whoIs(ev.holder)}宣布`),
        ev.claim ? `${ev.target}号是${TEAM_NAME[ev.claim]}` : "不公布结果", sub)}</div>`,
      start: (c) => ring(c.el, ev.target, "r-lady"),
    };
  },

  evil_reveal(ev) {
    const mine = player(ev.assassin)?.is_human;
    // 这一幕开演（或被更新的事件顶替）时：座位缎带、记录里的“刺杀阶段”、行动栏一起放出来。
    // 对局已经结束时行动栏归胜负标题管，这里只把那句话往前推一步（从“翻牌中”到“讨论中”，不会退回去）
    const release = once(() => {
      releaseReveal();
      releaseLog(ev.id);
      if (S.g?.status !== "ended") releaseEnd();
      else if (S.fx.holdEnd === END_WAIT.quest_result) setHold(END_WAIT.evil_reveal);
    });
    return {
      kind: "evil", min: 900, hurry: 1300, ms: 2600, release,
      html: `<div class="mo">${plaque("evil", "dagger", "好人完成了3次任务", "刺杀阶段",
        twoPart("坏人亮明身份", mine ? "你是刺客：找出梅林" : `刺客${ev.assassin}号寻找梅林`))}</div>`,
      start: (c) => {
        release();
        ev.evil.forEach((s, i) => ring(c.el, s, "r-evil", i * 110));
      },
    };
  },

  // 刺杀：圆桌变暗、聚光在目标上，匕首落下；落空时点出真正的梅林（复盘最有价值的一课）
  assassination(ev) {
    const hit = ev.hit;
    const merlin = S.g.players.find((p) => p.role === "merlin")?.seat; // 终局后才公开
    const tgt = player(ev.target);
    const kick = player(ev.assassin)?.is_human ? "你出手了" : `刺客${whoIs(ev.assassin)}出手`;
    let sub;
    // 每段不断行，只在“·”处折行（折行时 stackParts 去掉点、上下两行）
    if (hit) sub = twoPart(`${whoIs(ev.target)}正是梅林`, "坏人翻盘");
    else if (merlin) sub = twoPart(`${ev.target}号${tgt?.role_name ? `是${esc(tgt.role_name)}` : "不是梅林"}`, `真正的梅林是${whoIs(merlin)}`);
    else sub = twoPart(`${ev.target}号不是梅林`, "好人守住了胜利");
    const release = once(() => { releaseRoles(); releaseLog(ev.id); });
    return {
      kind: "assassin", min: 2000, hurry: 2000, ms: 2900, land: 620, release,
      html: `<div class="mo">${plaque(hit ? "evil" : "good", hit ? "dagger" : "chalice", kick, hit ? "刺中梅林！" : "刺杀落空", sub, "", 700)}</div>`,
      start(c) {
        setHold(END_WAIT.assassination);
        spot([ev.target]);
        ring(c.el, ev.target, "r-aim");
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
          ring(c.el, merlin, "r-merlin");
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
// 同一批事件里，后来的通常顶替前面的（任务结果顶替它的投票）；
// 但任务翻牌后面紧跟的湖中仙女宣布 / 刺杀阶段 / 刺杀是“下一幕”：先翻完牌，再接着演
// “最后一次翻牌 → 刺杀阶段 → 刺杀”是一条链：不管这几条是一次还是分几次拉到的，都按顺序一幕一幕演
// 投票通过 → 翻牌也是一条链：投票的牌子每次都演（同一次拉到时跳过它，等于告诉你车上没有要想很久的 AI 坏人）
const FOLLOWS = { vote: ["quest_result"], quest_result: ["lady_claim", "evil_reveal", "assassination"], evil_reveal: ["assassination"] };
const follows = (a, b) => !!a && (FOLLOWS[a] || []).includes(b);
const momentOf = (ev) => ({ type: ev.type, ...MOMENTS[ev.type](ev) });
function playMoments(evs) {
  const seq = [];
  let end = null;
  for (const ev of evs) {
    if (ev.type === "game_end") end = ev;
    // 翻牌途中先不画（湖中仙女有动静 = 游戏还在继续）；紧接着的“宣布”那一幕会再圈出这个人
    else if (ev.type === "lady_check") { if (S.fx.holdQuest < 0) ripple(ev.target, "lady"); }
    else if (MOMENTS[ev.type]) {
      while (seq.length && !follows(seq[seq.length - 1].type, ev.type)) {
        const old = seq.pop();
        MOMENTS[old.type](old).release?.(); // 同一批里被顶替的：只放出它压住的东西
      }
      seq.push(ev);
    }
  }
  queueMoments(seq.map(momentOf), end ? finaleMoment(end) : null);
}
function queueMoments(list, finale) {
  const fx = S.fx;
  if (!list.length && !finale) return;
  let chained = false;
  if (list.length) {
    // 接在排队的最后一幕（没有排队的就是正在演的那一幕）后面的“下一幕”：排到队尾，前面的照常演完
    const tail = fx.queue.length ? fx.queue[fx.queue.length - 1] : fx.cur?.m;
    if (follows(tail?.type, list[0].type)) {
      fx.queue.push(...list);
      chained = true;
    } else {
      // 还没轮到就被更新的事件顶替了——排着的翻牌除外：任务结果只在翻牌时揭晓，牌一定要翻
      const flips = fx.queue.filter((m) => m.type === "quest_result");
      fx.queue.forEach((m) => { if (m.type !== "quest_result") m.release?.(); });
      fx.queue = [...flips, ...list];
    }
  }
  if (finale) fx.finale = finale;
  // 新的事件到了：正在演的演到 min 就让位；后面排的是“下一幕”或终局标题时，正在演的先演完 hurry 那么久
  if (fx.cur) cutMoment(fx.cur, chained || !list.length);
  else nextMoment();
}
// 队首那一幕还要等多久才开演（翻牌的随机等待）：等的这段时间里，前一幕不必为它收短
const nextWait = () => Math.max(0, (S.fx.queue[0]?.notBefore || 0) - performance.now());
function nextMoment() {
  const fx = S.fx;
  if (fx.cur || fx.leaving) return;
  fxClear(fx.waitTimer);
  const m = fx.queue[0] || fx.finale;
  if (m) {
    const wrap = $(".table-wrap");
    // 教练 / 规则的卷轴开着：先不演（不在卷轴后面白演一遍），压住的东西照旧压着；卷轴关上再接着演。
    // 教练正等着翻牌揭晓再回答时例外（桌上的几幕照常演，胜负标题除外）
    if ($("#modal").open && (m.body || !coachWaiting())) { setAttr(wrap, "data-mo", ""); return; }
    // 翻牌还没到开演的时候：桌心照旧是“任务进行中”（centerText 按扣住的那一轮画），到点再演
    const wait = (m.notBefore || 0) - performance.now();
    if (wait > 30) {
      setAttr(wrap, "data-mo", S.fx.holdQuest >= 0 ? null : "");
      fx.waitTimer = fxLater(nextMoment, wait);
      return;
    }
    if (m === fx.finale) fx.finale = null;
    else fx.queue.shift();
    startMoment(m);
    return;
  }
  $(".table-wrap")?.removeAttribute("data-mo");
  releaseAll(); // 兜底：压住的东西不会比时刻活得更久
  fx.idle.splice(0).forEach((fn) => fn());
}
// 卷轴打开时桌上正在演的那一幕：收起来放回队首，关上卷轴后从头再演（快演完的就让它演完）
function pauseMoment() {
  const fx = S.fx;
  const c = fx.cur;
  if (!c || c.m.body || performance.now() > c.endAt - 500) return;
  fxClear(c.timer);
  fxClear(c.landTimer);
  c.m.done?.(c);
  c.el.remove();
  fx.cur = null;
  fx.queue.unshift(c.m);
  // 已经翻定的牌（顶栏和记录也摆出了结果）：关上卷轴后直接摆出翻定的样子，不再扣着牌重翻一遍
  if (c.landed && c.m.type === "quest_result") c.m.landed = true;
}
$("#modal").addEventListener("close", () => {
  const fx = S.fx;
  if (!S.g || !fx) return;
  if (!fx.cur && (fx.queue.length || fx.finale)) nextMoment();
  if (fx.endAfterModal) { fx.endAfterModal = false; whenFxIdle(() => fxLater(showEndModal, 250)); }
});
function startMoment(m) {
  const fx = S.fx;
  const el = document.createElement("div");
  el.className = `mo-wrap mo-${m.kind}`;
  el.innerHTML = m.html;
  (m.body ? document.body : $("#moment")).appendChild(el);
  const c = { m, el, at: performance.now(), endAt: 0, timer: 0, landTimer: 0, landed: false };
  fx.cur = c;
  // 有时刻在演（或排着队）时，桌心的文字一直让开：前一幕淡出时不会露出下一幕要揭晓的结果
  setAttr($(".table-wrap"), "data-mo", "");
  if (!m.body) fitMoment(el);
  m.start?.(c);
  if (m.land !== undefined) {
    if (reduceMotion()) landMoment(c);
    else c.landTimer = fxLater(() => landMoment(c), m.land);
  }
  // 轮到你行动时：只演关键部分；后面还排着下一幕时收短一点（刺杀阶段 → 刺杀 → 胜负连着演，不拖沓）
  const ms = myTurn() && !m.body ? m.hurry : fx.queue.length ? Math.max(m.hurry, m.ms - 800, Math.min(m.ms, nextWait())) : m.ms;
  c.endAt = c.at + ms;
  c.timer = fxLater(() => endMoment(c), ms);
  if (m.landed) skipMoment(); // 已经翻定过的牌（见 pauseMoment / rushHeld）：直接摆出结果，稍停就收起
}
// 把桌上的时刻摆进“上下座位之间”的那一条（不压住名牌和标签）；放不下就缩小，宽而矮的桌子把翻牌和印章左右摆开。
// 还要在看得见的地方：桌面上是左栏的可视区，手机上是屏幕里、吸底行动栏以上（行动栏升起时不会把结果挡住）
function fitMoment(el) {
  const mo = el.querySelector(".mo");
  const wrap = $(".table-wrap");
  if (!mo || !wrap || !RING.geo) return;
  mo.classList.remove("row", "compact");
  // 已经在传令的位置上：重摆时不再播一遍入场（settled 关掉入场动画）
  const wasHerald = el.classList.contains("herald");
  el.classList.remove("herald", "settled");
  if (wasHerald) el.classList.add("settled");
  for (const k of ["--mo-s", "--mo-y", "--mo-x"]) mo.style.removeProperty(k);
  if (!mo.offsetHeight) return;
  stackParts(mo); // 牌子上的“A · B”放不下一行：上下两行、不要点
  const wr = wrap.getBoundingClientRect();
  const left = $(".left");
  const bar = $(".action-bar");
  let vTop = 0, vBot = window.innerHeight;
  if (bar && getComputedStyle(bar).position === "sticky") vBot -= bar.offsetHeight;
  if (left && getComputedStyle(left).overflowY !== "visible") {
    const lr = left.getBoundingClientRect();
    vTop = Math.max(vTop, lr.top);
    vBot = Math.min(vBot, lr.bottom);
  }
  vTop = vTop - wr.top + 6;
  vBot = vBot - wr.top - 6;
  // 候选摆法：竖排；翻牌还可以左右摆开（row），或省掉小标题、牌小一号（compact）
  const variants = mo.querySelector(".qc-row") ? [[], ["row"], ["compact"], ["compact", "row"]] : [[]];
  // 印章顶上的圆形印记伸出牌子上沿（连同金圈）：这一截也要留在看得见的地方
  const plq = mo.querySelector(".plq");
  const seal = plq?.querySelector(".plq-seal");
  const overhang = () => (seal ? Math.max(0, -(plq.offsetTop + plq.clientTop + seal.offsetTop) + 4) : 0);
  const shapes = variants.map((cls) => {
    if (cls.length) mo.classList.add(...cls);
    const sh = { cls, w: mo.offsetWidth, h: mo.offsetHeight, over: overhang() };
    if (cls.length) mo.classList.remove(...cls);
    return sh;
  });
  const boxes = seatBoxes(false);
  const W = RING.geo.W;
  // 先在座位之间、看得见的那一条里找（缩到 0.62，伸出去的印记也不压座位）；
  // 再放宽一点：印记可以搭在座位上、牌子缩到 0.55；再退到“圆桌上看得见的地方就行”（短暂压住座位）。
  // 印记始终要留在看得见的地方；圆桌露出来的部分放不下（手机上往下翻去看记录了），改成传令（heraldMoment）
  const band = (b) => [Math.max(b.top, vTop), Math.min(b.bot, vBot)];
  const onTable = [Math.max(vTop, 4), Math.min(vBot, wr.height - 4)];
  const tries = [
    { min: 0.62, region: band },
    { min: 0.55, region: (b) => { const [t, z] = band(b); return [Math.max(t - 26, vTop), z]; } },
    { min: 0.6, region: () => onTable },
  ];
  let best = null, tier = -1;
  for (const [i, t] of tries.entries()) {
    for (const sh of shapes) {
      for (let s = 1; s >= t.min - 1e-6; s -= 0.04) {
        if (sh.w * s > W - 8) continue;
        const b = bandFor((sh.w * s) / 2, boxes);
        const [top, bot] = t.region(b);
        const dn = (sh.h * s) / 2 + 3, up = dn + sh.over * s;
        if (up + dn > bot - top) continue;
        // 尽量让整块（连同伸出去的印记）对准座位之间那一条的正中，再推进看得见的范围
        const y = Math.min(Math.max((b.top + b.bot) / 2 + (up - dn) / 2, top + up), bot - dn);
        if (!best || s > best.s + 0.05) best = { s, cls: sh.cls, y };
        break;
      }
    }
    if (best) { tier = i; break; }
  }
  // 圆桌只露出一部分（有座位在屏幕外：手机上往下翻着看记录、横屏左栏滚开了）时，
  // 桌上只放得下缩得很小的（字只剩六七像素）、或者得压在座位上才放得下：改成传令，字保持原大
  const cut = boxes.some((b) => b.top < vTop - 6 || b.bottom > vBot + 6);
  if (!best || (cut && (best.s < 0.75 || tier === tries.length - 1))) {
    heraldMoment(el, mo, variants, [vTop + wr.top - 6, vBot + wr.top + 6]);
    return;
  }
  if (best.cls.length) mo.classList.add(...best.cls);
  if (best.s < 0.98) mo.style.setProperty("--mo-s", best.s.toFixed(3));
  mo.style.setProperty("--mo-y", `${best.y.toFixed(1)}px`);
}
// 传令：圆桌不在屏幕里（手机上往下翻着看记录），时刻不再硬塞进身份卡、记录上面——
// 固定在看得见的那一段（吸底行动栏以上）偏上的位置，衬一块深色皮革底板，后面一层淡淡的暗幕。
// 翻牌用紧凑的排法；滚动页面时它留在原处，演完照常收起
function heraldMoment(el, mo, variants, [top, bot]) {
  el.classList.add("herald");
  stackParts(mo);
  const left = $(".left");
  let x0 = 0, x1 = document.documentElement.clientWidth;
  if (left && getComputedStyle(left).overflowY !== "visible") {
    const lr = left.getBoundingClientRect();
    x0 = Math.max(x0, lr.left);
    x1 = Math.min(x1, lr.right);
  }
  const W = x1 - x0 - 24, H = bot - top - 20;
  // 竖排优先（窄而完整，不会是一块空着半边的宽板子）；放不下再省掉小标题、最后才左右摆开
  const order = variants.length > 1 ? [[], ["compact"], ["row"], ["compact", "row"]] : variants;
  let best = null;
  for (const cls of order) {
    if (cls.length) mo.classList.add(...cls);
    const s = Math.min(1, W / mo.offsetWidth, H / mo.offsetHeight);
    const h = mo.offsetHeight * s;
    if (cls.length) mo.classList.remove(...cls);
    if (!best || s > best.s + 0.08) best = { s, cls, h };
    if (s >= 0.92) break;
  }
  if (best.cls.length) mo.classList.add(...best.cls);
  const s = Math.max(0.5, best.s);
  if (s < 0.98) mo.style.setProperty("--mo-s", s.toFixed(3));
  // 偏上一点（视线自然落在那里），但整块都在看得见的范围里
  const y = Math.min(Math.max(top + (bot - top) * 0.4, top + best.h / 2 + 10), bot - best.h / 2 - 10);
  mo.style.setProperty("--mo-y", `${Math.round(y)}px`);
  mo.style.setProperty("--mo-x", `${Math.round((x0 + x1) / 2)}px`);
  // 暗幕只盖住圆桌那一栏看得见的部分（不压暗行动栏和桌面版右侧的记录）
  const vw = document.documentElement.clientWidth;
  el.style.cssText = `--h-t:${Math.max(0, Math.round(top))}px;--h-b:${Math.max(0, Math.round(window.innerHeight - bot))}px;` +
    `--h-l:${Math.round(x0)}px;--h-r:${Math.max(0, Math.round(vw - x1))}px`;
}
function refitMoment() {
  const c = S.fx?.cur;
  if (!c || c.m.body || !c.el.isConnected) return;
  if (gliding()) fitAfterGlide();
  else fitMoment(c.el);
}
// 时刻演着的时候翻动页面（或被“轮到你点人”滚回圆桌）：停下来后按新的可视范围重摆一次——
// 圆桌回到屏幕里，传令就回到桌上；圆桌滚走了，桌上的时刻就改成传令
let scrollFitTimer = 0;
function refitOnScroll() {
  if (!S.fx?.cur || S.fx.cur.m.body) return;
  clearTimeout(scrollFitTimer);
  scrollFitTimer = setTimeout(refitMoment, 120);
}
window.addEventListener("scroll", refitOnScroll, { passive: true });
$(".left").addEventListener("scroll", refitOnScroll, { passive: true });
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
  // 后面那一幕反正还要等（翻牌的随机等待）：这一幕不必收短——收短了，牌子停留的长短又成了线索
  const endAt = Math.max(now, c.at + (hurry ? c.m.hurry : c.m.min), Math.min(c.endAt, now + nextWait()));
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
  // 后面没有下一幕：桌心的文字和这一幕交叉淡入
  if (!fx.queue.length && !fx.finale) $(".table-wrap")?.removeAttribute("data-mo");
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
    // 开局一定先亮身份——首任队长也一样（小屏手机上身份卡在行动栏下面，不亮这一下就不知道自己是谁）。
    // 行动卡片照常摆好；身份牌几秒后自己收起，点一下立即收起
    if (g.you && ACTIVE.includes(g.status)) {
      showReveal(g.you);
      S.fx.revealPid = myTurn()?.id ?? null;
    } else if (g.you) pulseIdentity();
  }
  // 身份牌还亮着时又轮到你（新的待办）：让开圆桌
  const p = myTurn();
  if (p && p.id !== S.fx.revealPid) hideReveal();
}

function showReveal(y) {
  const wrap = $(".table-wrap");
  if (!wrap) return;
  wrap.querySelectorAll(".reveal").forEach((el) => el.remove());
  const know = y.knowledge.length
    ? y.knowledge.map((k) => knowChip(k.seat, k.label)).join("")
    : `<span class="rv-none">没有额外信息，全靠推理</span>`;
  const el = document.createElement("div");
  el.className = `reveal ${y.team}`;
  el.setAttribute("role", "status");
  el.innerHTML = `<div class="rv-scrim"></div>
    <div class="rv-card">
      <div class="rv-kicker">你的身份 · ${y.seat}号座位</div>
      <div class="rv-art">${ART.role(y.role)}</div>
      <div class="rv-role">${esc(y.role_name)}</div>
      <span class="rv-team">${TEAM_NAME[y.team]}阵营</span>
      <div class="rv-know"><span class="rv-know-k">你知道</span>${know}</div>
    </div>`;
  wrap.appendChild(el);
  const card = el.querySelector(".rv-card");
  const s = Math.min(1, (wrap.clientHeight - 16) / card.offsetHeight, (wrap.clientWidth - 24) / card.offsetWidth);
  if (s < 1) el.style.setProperty("--rv-s", Math.max(0.55, s).toFixed(3));
  el.addEventListener("click", (e) => {
    hideReveal();
    // 首任队长：牌压在你（和两边）的盾上。点在牌下一面能选的盾上时，收起牌的同时选中它
    if (!selection()) return;
    const av = document.elementsFromPoint(e.clientX, e.clientY).find((n) => n.matches?.(".seat.selectable .avatar"));
    av?.click();
  });
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
  if (!S.fx || e.target.closest?.("#modal")) return; // 卷轴里的点击（含点背景关卷轴）不碰桌上的时刻
  if (!e.target.closest?.(".reveal")) hideReveal();
  if (S.fx.cur && !S.fx.cur.m.body) skipMoment();
  if (e.target.closest?.(".table-wrap, .action-bar")) rushHeld(e.target);
}, true);
// 轮到你行动、但行动栏还压着揭晓（最后一次翻牌、刺杀阶段，或两幕之间的空档）：
// 点一下桌面就把压着的结果全部摆出来、呈上行动卡片——同一下点击接着就能选人（后面那几幕照常演）
function rushHeld(target = null) {
  if (!myTurn() || !dockHeld() || $("#modal").open) return;
  // 翻牌还在开演前的等待里：随手点“标记”、教练、桌面空白处不让它提前开演（提前开演 = 结果已经到了，还轮到你了）；
  // 只有点座位的盾、点行动栏这种“要行动”的点击才直接摆出结果
  if (nextWait() > 0 && !target?.closest?.(".avatar, #action")) return;
  // 牌面朝上、印章落下：桌上和顶栏、记录、行动栏在同一刻摆出结果（不是扣着的牌配上已经公布的比分）。
  // 还排着的翻牌（前一幕还没收起）一开演就是翻定的样子
  for (const m of S.fx.queue) {
    m.notBefore = 0;
    if (m.type === "quest_result") m.landed = true;
  }
  if (!S.fx.cur) nextMoment();
  const c = S.fx.cur;
  if (c && !c.m.body && !c.el.classList.contains("skip")) skipMoment();
  releaseAll();
  // 排着的“刺杀阶段”要宣布的东西（缎带、记录、行动栏）已经随 releaseAll 摆出来了：
  // 不再在你选人、出手之后补演那块牌子（也不会把行动栏的话退回“讨论中”）
  S.fx.queue = S.fx.queue.filter((m) => m.type !== "evil_reveal");
}
document.addEventListener("keydown", (e) => {
  if (!S.fx || e.repeat || $("#modal").open) return; // 卷轴开着：Esc 只关卷轴
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
  } else if (key === "Escape" && (c || dockHeld())) {
    if (c) skipMoment();
    rushHeld();
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
// 矮屏 / 横屏的输入框只有一行高：占位文字换短的，不折成被切掉一半的第二行
const COMPACT = window.matchMedia("(max-width: 560px) and (max-height: 760px), (orientation: landscape) and (max-height: 620px) and (min-width: 600px)");
const ph = (text, short) => esc(COMPACT.matches && short ? short : text + (FINE_POINTER.matches && !NARROW.matches ? "（Ctrl+Enter 提交）" : ""));
const speechBox = (text, short = "") => `<textarea id="act-speech" rows="2" maxlength="500" placeholder="${ph(text, short)}"></textarea>`;

// 卡片头：缎带 + 印章 + 标题 + 规则提醒（seal：gold / lady / evil）
const head = (icon, title, sub, extra = "", seal = "gold") => `
    <span class="turn-tag" aria-hidden="true">轮到你了</span>
    <div class="act-head"><span class="act-seal seal-${seal}" aria-hidden="true">${ic(icon)}</span>
      <div class="act-titles"><div class="act-title">${title}</div>${sub ? `<div class="act-sub">${sub}</div>` : ""}${extra}</div></div>`;

// 已选：迷你纹章 + 虚线空位 + n/N（内容由 updateSelectionUI 填）
const pick = () => `<div class="pick" data-full="已选满 · 先点已选的人取消"><span class="pick-k">已选</span><span class="slots" id="sel-slots"></span><span class="cnt" id="sel-cnt"></span>` +
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
    return `${head("crown", `<span><span class="ah-long nw">你是队长：</span><span class="nw">组建 <span class="em">${p.size}</span> 人队伍</span></span>`,
      `在圆桌上点选 ${p.size} 人 · 可以选自己${q && q.fails_needed === 2 ? " · 本轮需2张失败" : ""}`, attemptWarn())}
    <div class="act-main">${speechBox("说说组队理由（可选）", "组队理由（可选）")}</div>
    <div class="act-side with-pick">${pick()}<button class="primary" id="act-submit" disabled>${ic("swords")}<span>确认发车</span></button></div>`;
  },
  speak: (p) => `${head("quill", "轮到你发言", `<span class="tl-long">队长 ${S.g.leader}号 </span>提名 ${seatChips(p.team)}`)}
    <div class="act-main">
      <div class="quick" role="group" aria-label="快捷短语">${QUICK.map(([k, q]) => `<button type="button" data-quick="${esc(q)}" title="${esc(q)}">${esc(k)}</button>`).join("")}</div>
      ${speechBox("你的发言，所有人都会听到", "说点什么…")}
    </div>
    <div class="act-side"><button class="ghost pass" id="act-pass">过</button><button class="primary" id="act-submit">${ic("quill")}<span>发言</span></button></div>`,
  vote: (p) => `${head("ballot", `<span><span class="nw">投票：</span><span class="nw"><span class="ah-long">这支队伍</span>能出发吗？</span></span>`,
    `<span><span class="ah-long nw">赞成票过半</span><span class="nw"><span class="ah-long">（</span>至少 ${Math.floor(S.g.n / 2) + 1} 票<span class="ah-long">）</span>才发车</span></span>`, attemptWarn())}
    <div class="act-main">${teamLine(p.team, `<span class="tl-long">队长 ${S.g.leader}号 </span>提名`)}</div>
    <div class="act-side vote"><button class="yes" data-vote="1">${ic("check")}<span>赞成</span></button><button class="no" data-vote="0">${ic("cross")}<span>反对</span></button></div>`,
  quest: (p) => `${head("swords", `<span><span class="ah-long nw">你在任务队伍中：</span><span class="nw">秘密出牌</span></span>`, p.fails_needed === 2 ? "本轮需要2张失败才失败" : "只要出现1张失败，任务就失败")}
    <div class="act-main">${teamLine(p.team, "同车")}<p class="act-note"><span class="nw">出牌不记名，</span><span class="nw">只公布失败牌的张数</span>${p.can_fail ? "" : `<span class="nw">；好人只能出成功</span>`}</p></div>
    <div class="act-side cards">
      <button class="card-btn ok" data-card="success">${ic("chalice")}<span>成功</span></button>
      <button class="card-btn bad" data-card="fail" ${p.can_fail ? "" : 'disabled title="好人只能出成功"'}>${ic(p.can_fail ? "dagger" : "lock")}<span>失败</span>${p.can_fail ? "" : "<small>好人不能出</small>"}</button>
    </div>`,
  lady_choose: (p) => `${head("waves", `<span><span class="ah-long nw">湖中仙女：</span><span class="nw">查验一名玩家</span></span>`, twoPart("在圆桌上点选", "只有你会看到TA的真实阵营"), "", "lady")}
    <div class="act-main">${teamLine(p.candidates, "可查验", false)}</div>
    <div class="act-side with-pick">${pick()}<button class="primary" id="act-submit" disabled>${ic("eye")}<span>查验</span></button></div>`,
  lady_announce: (p) => `${head("waves", `<span class="ah-long">查验结果：</span>${p.target}号是 <span class="label ${p.result}">${TEAM_NAME[p.result]}</span>`, "只有你看到真实结果，公布时可以撒谎", "", "lady")}
    <div class="act-main">
      <div class="claim-row" role="radiogroup" aria-label="公开宣布"><span class="claim-k">公开宣布</span>
        <label class="pill-radio good"><input type="radio" name="claim" value="good" ${p.result === "good" ? "checked" : ""}><span>是好人</span></label>
        <label class="pill-radio evil"><input type="radio" name="claim" value="evil" ${p.result === "evil" ? "checked" : ""}><span>是坏人</span></label>
        <label class="pill-radio"><input type="radio" name="claim" value="none"><span>不公布</span></label>
      </div>
      ${speechBox("说点什么（可以撒谎）", "说点什么…")}
    </div>
    <div class="act-side"><button class="primary" id="act-submit">${ic("horn")}<span>公布</span></button></div>`,
  assassin_suggest: (p) => `${head("dagger", `<span><span class="ah-long nw">刺杀讨论：</span><span class="nw">谁是梅林？</span></span>`, twoPart("在圆桌上点选一人", "建议会告诉刺客，由刺客拍板"), "", "evil")}
    <div class="act-main">${speechBox("说说你的理由", "你的理由…")}</div>
    <div class="act-side with-pick">${pick()}<button class="primary" id="act-submit" disabled>${ic("dagger")}<span>提出建议</span></button></div>`,
  assassinate: (p) => `${head("dagger", `<span><span class="ah-long nw">你是刺客：</span><span class="nw">最后一击</span></span>`, twoPart("刺中梅林，坏人翻盘", "在圆桌上点选目标"), "", "evil")}
    <div class="act-main">${speechBox("刺杀前想说的话（可选）", "想说的话（可选）")}</div>
    <div class="act-side with-pick">${pick()}<button class="evil" id="act-submit" disabled>${ic("dagger")}<span>刺杀！</span></button></div>`,
};

const TURN_NAME = {
  propose: "组建队伍", speak: "发言", vote: "投票", quest: "秘密出牌", lady_choose: "用湖中仙女查验一名玩家",
  lady_announce: "公布查验结果", assassin_suggest: "刺杀讨论", assassinate: "刺杀梅林",
};
function setTurnNote(text) {
  const el = $("#sr-turn");
  if (el && el.textContent !== text) el.textContent = text;
}

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
  if (HINT.html && HINT.key !== hintKey()) { HINT.html = ""; hintReady(false); } // 局面变了：没看的提示作废
  const held = dockHeld();
  syncHint();
  hintResume();
  const p = held ? null : myTurn();
  bar.classList.toggle("your-turn", !!p);
  const title = p ? "【轮到你】阿瓦隆练习场" : "阿瓦隆练习场";
  if (document.title !== title) document.title = title;
  if (held) {
    // 最后一次翻牌 / 刺杀 / 胜负还在桌上演：结果先不写在行动栏里（轮到你刺杀也等牌翻定了再呈上卡片；点一下桌面就直接翻定）
    showWaiting(S.fx.holdEnd === END_WAIT.quest ? questWaitHtml(S.fx.holdTeam) : `<span class="w-v">${S.fx.holdEnd}</span>`);
    return;
  }
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
      stackParts(box); // 规则提醒“A · B”放不下一行：上下两行、不要点
      // 读屏软件：轮到你时念一句（焦点不一定移过去）
      setTurnNote(`轮到你了：${TURN_NAME[p.type] || "行动"}`);
      refitMoment();
      // 刷新恢复 / 开局就轮到你（首任队长）时也要让出你的座位：直接跳到位，不做平滑滚动
      bringSeatsIntoView(!!selection(), !S.live);
      const ta = $("#act-speech");
      if (ta && DESKTOP.matches) ta.focus({ preventScroll: true });
    }
    updateSelectionUI();
    return;
  }
  // 刚交过的那条（done…）记着：晚到的旧轮询还带着它时，不会把卡片摆回来
  if (!S.pendingKey?.startsWith("done")) S.pendingKey = null;
  setTurnNote("");
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
      <div class="end-text"><b class="end-title">${err ? "对局出错了" : "对局已停止"}</b><span class="end-sub" title="${err ? esc(g.error) : ""}">${err ? esc(g.error) : "这局已被中止（可能在别的窗口开了新局），点「新游戏」重新开始"}</span></div>
      <div class="end-btns"><button class="primary" id="act-again">${ic("restart")}<span>新游戏</span></button></div></div>`;
    if (setActionIfChanged(html)) $("#act-again").onclick = () => showSetup();
    return;
  }
  showWaiting(waitingHtml());
}

// 手机上（行动栏吸底）轮到你点人：把整圈座位滚到行动栏上方；放不下时至少让你和两边的人露出来。
// 发言 / 投票 / 出牌（pick = false）：你的座位被升起的行动栏挡住时轻轻往下挪一点——最多把顶栏挪出屏幕；
// 已经往下翻去看记录了就不动
function bringSeatsIntoView(pick = true, instant = false) {
  const bar = $(".action-bar");
  if (!bar || getComputedStyle(bar).position !== "sticky") return;
  const gen = FXGEN;
  requestAnimationFrame(() => {
    if (gen !== FXGEN) return;
    const seats = document.querySelectorAll("#table .seat");
    if (!seats.length) return;
    const avail = window.innerHeight - bar.offsetHeight;
    let top = Infinity, bot = -Infinity;
    for (const el of seats) {
      const r = el.getBoundingClientRect();
      top = Math.min(top, r.top);
      bot = Math.max(bot, r.bottom);
    }
    top -= 24; // 王冠
    const room = ($(".topbar")?.offsetHeight || 0) - window.scrollY; // 顶栏还露在屏幕里的高度
    let dy = 0;
    if (!pick) {
      if (bot > avail - 6 && room > 4) dy = Math.min(bot - (avail - 6), room);
    } else if (bot - top > avail - 12 || bot > avail - 6) dy = bot - (avail - 6);
    else if (top < 6) dy = top - 6;
    // 顶栏只剩一小条（火漆被切掉下半截，看着像没画好）：整条滚出去——点人时要保证最上面的座位还在屏幕里
    const left = room - dy;
    if (dy > 0 && left > 0 && left < 32 && (!pick || top - room >= 0)) dy = room;
    if (Math.abs(dy) > 4) window.scrollBy({ top: dy, behavior: instant || reduceMotion() ? "auto" : "smooth" });
  });
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
  showTip(); // 手机上：新到的发言换进小贴士那一格
}

const THINK_VERB = {
  propose: "正在挑选队员", discuss: "正在发言", vote: "正在投票", quest: "正在出牌",
  lady: "正在使用湖中仙女", assassinate: "正在讨论谁是梅林",
};
const questWaitHtml = (team) =>
  `${team ? `<span class="w-ps">${sortSeats(team).map((s) => seatEmblem(s, "sm")).join("")}</span>` : ""}<span class="w-v">${END_WAIT.quest}</span>`;
function waitingHtml() {
  const g = S.g;
  if (S.netFail >= 2) return `<span class="w-v">连接断开，正在重连……（确认 run.py 还开着）</span>`;
  // 出牌时不列“谁在出牌”：好人 AI 秒出成功，还在想的只会是车上的坏人
  if (g.phase === "quest") return questWaitHtml(g.proposal);
  const t = g.thinking.filter((s) => !player(s)?.is_human);
  const verb = THINK_VERB[g.phase] || "正在思考";
  if (t.length && t.length <= 2) {
    return t.map((s) => `<span class="w-p">${seatEmblem(s, "sm")}<b>${s}号「${esc(nameOf(s))}」</b></span>`).join("") +
      `<span class="w-v">${verb}</span>`;
  }
  if (t.length > 2) {
    return `<span class="w-ps">${t.slice(0, 5).map((s) => seatEmblem(s, "sm")).join("")}</span><span class="w-v"><b>${t.length} 位玩家</b>${verb}</span>`;
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
  // 揭晓途中按扣住的那一刻挑：翻牌前后都还是“出牌”；刺杀阶段、胜负揭晓前只用通用的（按阶段挑的那句会说出下一阶段是什么）
  const phase = S.fx.holdQuest >= 0 ? "quest" : S.fx.holdEnd ? "" : g.phase;
  const phaseList = PHASE_TIPS[phase] || [];
  const pool = S.tipN % 2 && phaseList.length ? phaseList : TIPS;
  return pool[Math.floor(S.tipN / 2) % pool.length];
}
// 手机上（行动栏吸底，对局记录在下面、看不到）：发言、投票阶段，小贴士那一格换成这次提名最新的一条发言——
// 不用往下翻也跟得上大家在说什么（还扣着没揭晓的记录不算）
function latestSpeech() {
  if (S.fx.holdQuest >= 0 || !["discuss", "vote"].includes(S.g.phase) || getComputedStyle($(".action-bar")).position !== "sticky") return null;
  for (let i = S.events.length - 1; i >= 0; i--) {
    const e = S.events[i];
    if (e.type === "proposal") return null;
    if (e.type === "speech" && e.text && !S.fx.heldLog.has(e.id)) return e;
  }
  return null;
}
// 换了一句（定时轮换 / 新的发言）才重写，并播放淡入
function showTip() {
  const el = $("#action .w-tip");
  if (!el || !S.g) { stopTips(); return; }
  const sp = latestSpeech();
  const key = sp ? `s${sp.id}` : `t${S.tipN}`;
  if (el._key === key) return;
  const fresh = el._key !== undefined && !reduceMotion();
  el._key = key;
  const t = `<span class="w-tip-t${fresh ? " in" : ""}">`;
  patch(el, sp
    ? `<span class="w-tip-k w-say">${ic("quill")}<span>${sp.seat}号</span></span>${t}${esc(nameOf(sp.seat))}：${esc(sp.text)}</span>`
    : `<span class="w-tip-k">${ic("candle")}<span>小贴士</span></span>${t}${esc(tipText())}</span>`);
}
function startTips() {
  stopTips();
  if (S.tipN === undefined) S.tipN = Math.floor(Math.random() * 1000);
  S.tipN++;
  showTip();
  S.tipTimer = setInterval(() => { S.tipN++; showTip(); }, TIP_MS);
}
function stopTips() {
  clearInterval(S.tipTimer);
  S.tipTimer = null;
}

// ---------- 选人：已选队员位 + 计数 + 按钮 ----------
function updateSelectionUI() {
  const p = myTurn();
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
      pollSoon(150);
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

// 手机上行动栏是吸底的：滚动定位（键盘聚焦、scrollIntoView）到桌上和卡片里的东西时让出它的高度。
// 只改一条只作用于这几个元素的样式规则（按 8px 取整），不在 :root 上写会继承的变量——那样每次都要重算整页的样式；
// 行动栏不吸底（桌面、横屏）时什么都不写
if (window.ResizeObserver) {
  const sheet = document.createElement("style");
  document.head.appendChild(sheet);
  let last = "";
  const bar = $(".action-bar");
  new ResizeObserver(() => {
    const sticky = getComputedStyle(bar).position === "sticky";
    const h = Math.ceil(bar.offsetHeight / 8) * 8 + 10;
    // 只加在内容上，不加在行动栏自己身上，否则点行动栏会把页面滚到底
    const css = sticky ? `.avatar, .mark, .identity, .identity .peek, .right, .log-head label { scroll-margin-bottom: ${h}px; }` : "";
    if (css !== last) { last = css; sheet.textContent = css; }
    placePillSoon(); // 行动栏变高 / 变矮：“有新记录”小签跟着挪到看得见的地方
  }).observe(bar);
}

// 座位点击：选人 / 标记
// 用事件路径找座位：同一次点击先跳过了桌上的时刻（可能刚好放开行动栏、重画了这面盾），被点的节点已经换掉也认得出是哪个座位
$("#table").addEventListener("click", (e) => {
  const path = e.composedPath();
  const seatEl = path.find((n) => n.classList?.contains("seat"));
  if (!seatEl || !S.g) return;
  const seat = +seatEl.dataset.seat;
  if (path.some((n) => n.classList?.contains("mark"))) {
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
  else { nudgePick(); return; }
  renderTable();
  updateSelectionUI();
});
// 已经选满还去点别人：已选那一栏晃一下，提示先点掉一个已选的
function nudgePick() {
  const pk = $("#action .pick");
  if (!pk) return;
  pk.classList.remove("nudge");
  void pk.offsetWidth; // 重新触发动画
  pk.classList.add("nudge");
  clearTimeout(pk._nudge);
  pk._nudge = setTimeout(() => pk.classList.remove("nudge"), 1800);
}
// 键盘也能选人
$("#table").addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.classList?.contains("avatar")) {
    e.preventDefault();
    e.target.click();
  }
});
NARROW.addEventListener("change", () => { if (S.g) { placeSeats(); renderTable(); } });
// 转屏 / 拖窗口改了宽度：轮到你时重新把座位让到吸底行动栏上方（只在摆出卡片时滚过一次，横屏转竖屏后你的盾会压在行动栏下），
// 卡片里的“A · B”重新量一次。只看宽度：手机上弹出键盘、地址栏伸缩只改高度，打字时不滚动页面
let vpW = window.innerWidth, vpTimer = 0;
window.addEventListener("resize", () => {
  if (window.innerWidth === vpW) return;
  vpW = window.innerWidth;
  clearTimeout(vpTimer);
  vpTimer = setTimeout(() => {
    if (!S.g || !myTurn() || dockHeld()) return;
    stackParts($("#action"));
    bringSeatsIntoView(!!selection(), true);
  }, 250);
});

// =====================================================================
// 对局记录
// =====================================================================
function thoughts(ev, seats) {
  if (!ev.thoughts) return "";
  return seats
    .filter((s) => ev.thoughts[String(s)])
    .map((s) => `<div class="thought"><span class="th-ic">${ic("thought")}</span><div class="th-body">` +
      `<div class="th-who"><b>${s}号「${esc(nameOf(s))}」</b><span class="th-k">内心独白</span></div>` +
      `<div class="th-text">${esc(ev.thoughts[String(s)])}</div></div></div>`)
    .join("");
}

// 发言：羊皮纸小笺（金线角花 + 细边），左边是发言人的纹章；你的发言靠右、金色；“过”只占一行
// tags: [文字, 样式]，样式 lead = 队长（金）、kill = 刺杀相关（红）
function bubble(seat, text, tags = []) {
  const me = player(seat)?.is_human;
  const passed = !text;
  const tagHtml = tags.map(([t, c]) => `<span class="tag-r ${c || ""}">${t}</span>`).join("");
  return `<div class="speech${me ? " mine" : ""}${passed ? " passed" : ""}">
    <div class="mini">${seatEmblem(seat, "sm")}</div>
    <div class="bubble">
      <div class="who"><span class="ws">${seat}号</span><b class="wn">${esc(nameOf(seat))}</b>${me ? `<span class="wme">你</span>` : ""}${tagHtml}${passed ? `<span class="pass-mark">过</span>` : ""}</div>
      ${passed ? "" : `<div class="say">${esc(text)}</div>`}
    </div></div>`;
}

const sys = (text, cls = "") => `<div class="ev ev-system ${cls}">${text}</div>`;

function eventHtml(ev) {
  const all = S.g.players.map((p) => p.seat);
  switch (ev.type) {
    case "start":
      return sys(`<span class="orn">${ic("swords")}</span>游戏开始！首任队长是 ${seatTag(ev.leader)}${ev.lady ? `，湖中仙女在 ${seatTag(ev.lady)} 手中` : ""}。`, "start");
    case "quest_start":
      // 两段不断行：窄的记录栏（横屏手机）里只在“需2张失败”前折行，不把记录撑出横向滚动
      return `<div class="ev ev-divider"><span><b><span class="nw">第${ev.quest + 1}轮任务 · ${ev.size}人</span>${ev.fails_needed === 2 ? ` <span class="nw">· 需2张失败</span>` : ""}</b></span></div>`;
    case "proposal":
      return `<div class="ev ev-proposal">${ic("crown")}<div>${seatTag(ev.leader)} 第${ev.attempt}次提名：${seatChips(ev.team)}</div></div>` + thoughts(ev, [ev.leader]);
    case "speech": {
      const tags = [];
      if (ev.leader) tags.push(["队长", "lead"]);
      if (ev.suggest) tags.push([`建议刺杀 ${ev.suggest}号`, "kill"]);
      if (ev.assassin) tags.push(["刺客", "kill"]);
      return `<div class="ev">${bubble(ev.seat, ev.text, tags)}</div>` + thoughts(ev, [ev.seat]);
    }
    case "vote": {
      const entries = Object.entries(ev.votes).map(([s, v]) => [+s, v]).sort((a, b) => a[0] - b[0]);
      const yes = entries.filter(([, v]) => v).length;
      const no = entries.length - yes;
      const team = ev.team || [];
      const chips = entries.map(([s, v]) =>
        `<span class="chip ${v ? "yes" : "no"}${team.includes(s) ? " on" : ""}" title="${s}号${v ? "赞成" : "反对"}${team.includes(s) ? "（在车上）" : ""}">${s}号${ic(v ? "check" : "cross")}</span>`).join("");
      // 赞成 / 反对的比例条；中间的刻度是“过半线”，赞成要越过它才发车
      const share = entries.length ? ((100 * yes) / entries.length).toFixed(1) : 0;
      const bar = `<div class="vbar" role="img" aria-label="赞成 ${yes} 票，反对 ${no} 票（赞成超过半数才发车）">` +
        `<span class="vb-track">${yes ? `<i class="vb-yes" style="width:${share}%"></i>` : ""}${no ? `<i class="vb-no" style="width:${(100 - share).toFixed(1)}%"></i>` : ""}</span>` +
        `<b class="vb-mid" title="过半线"></b></div>`;
      return `<div class="ev ev-vote ${ev.approved ? "ok" : "rej"}"><div class="vhead">${ic("ballot")}<span>投票</span>
        ${ev.attempt ? `<span class="vk">第${ev.attempt}次提名</span>` : ""}
        <span class="${ev.approved ? "verdict-yes" : "verdict-no"}">${ev.approved ? "通过" : "否决"}</span>
        <span class="tally" title="赞成 : 反对"><b class="ty">${yes}</b><i>:</i><b class="tn">${no}</b></span></div>${bar}<div class="chips">${chips}</div></div>` + thoughts(ev, all);
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
const HOLD_LOG = new Set(["quest_result", "evil_reveal", "assassination", "game_end"]);
// 记录是否“贴着底部”：由用户的滚动决定（不在平滑滚动途中去读 scrollTop——那时它还没到位）
const LOG = { pinned: true, auto: 0 };
// 往上翻着看早先的发言、票型时，新记录不把人拽回底部：记录区底部浮出一枚“有新记录”，点一下再回到最新
function newRowsPill(show) {
  const pill = $("#log-new");
  if (pill && pill.hidden === show) pill.hidden = !show;
  if (show) placePill();
}
// 手机上行动栏吸底：记录区的下半截压在行动栏下面（或还在屏幕外）。小签抬到记录区看得见的那一段的底部，才看得到、点得到
function placePill() {
  const pill = $("#log-new");
  if (!pill || pill.hidden) return;
  const bar = $(".action-bar");
  let vb = window.innerHeight;
  if (getComputedStyle(bar).position === "sticky") vb -= bar.offsetHeight;
  const rr = $(".right").getBoundingClientRect();
  const log = $("#log");
  const lift = Math.max(0, Math.min(rr.bottom - vb, log.clientHeight - 60));
  const v = `${Math.round(lift)}px`;
  if (pill.style.getPropertyValue("--lift") !== v) pill.style.setProperty("--lift", v);
}
let pillFrame = 0;
const placePillSoon = () => { if (!pillFrame && !$("#log-new").hidden) pillFrame = requestAnimationFrame(() => { pillFrame = 0; placePill(); }); };
window.addEventListener("scroll", placePillSoon, { passive: true });
window.addEventListener("resize", placePillSoon);
function logToBottom(smooth) {
  const log = $("#log");
  LOG.pinned = true;
  newRowsPill(false);
  if (smooth && !reduceMotion()) {
    LOG.auto = performance.now() + 700;
    log.scrollTo({ top: log.scrollHeight, behavior: "smooth" });
  } else {
    LOG.auto = 0;
    log.scrollTop = log.scrollHeight;
  }
}
(() => {
  const log = $("#log");
  log.addEventListener("scroll", () => {
    if (log.scrollHeight - log.scrollTop - log.clientHeight < 120) { LOG.pinned = true; newRowsPill(false); }
    else if (performance.now() > LOG.auto) LOG.pinned = false;
  }, { passive: true });
  // 离最新的记录很远时直接跳过去（长长的平滑滚动反而让人等），近的才平滑滚过去
  $("#log-new").addEventListener("click", () => logToBottom(log.scrollHeight - log.scrollTop - log.clientHeight < 2.5 * log.clientHeight));
  // 用户自己动手滚动：立刻接管，不再当成程序的平滑滚动
  for (const t of ["wheel", "touchstart", "pointerdown", "keydown"]) log.addEventListener(t, () => { LOG.auto = 0; }, { passive: true });
  // 记录区变矮（行动栏升高）时，贴着底部的记录继续贴着底部：最新一条不会被切掉一截
  if (window.ResizeObserver) new ResizeObserver(() => { if (LOG.pinned) log.scrollTop = log.scrollHeight; }).observe(log);
})();
const rowHtml = (ev, fresh) => {
  const h = eventHtml(ev);
  if (!h) return "";
  // 要在桌上揭晓的结果先扣着；闸门（还没翻定的牌、还没开演的“刺杀阶段”）之后到的记录也扣着：
  // 下一轮的提名、发言，坏人讨论刺杀谁，都不抢在牌翻开之前出现
  const own = fresh && HOLD_LOG.has(ev.type);
  const gate = gateId();
  const byGate = fresh && !own && gate && ev.id > gate;
  const held = own || byGate;
  if (held) S.fx.heldLog.add(ev.id);
  if (byGate) S.fx.gateRows.push(ev.id);
  return `<div class="evw${fresh && !held ? " fresh" : ""}${held ? " held" : ""}" data-ev="${ev.id}">${h}</div>`;
};
// 整段重建（刷新恢复 / 终局）：先写最后几十条并停到最新一条，更早的记录在空闲时分批补到上面，
// 不在一个任务里排版上千个节点（终局那一下不会卡住刺杀和胜负的动画）
const LOG_TAIL = 25, LOG_CHUNK = 15; // 先写最后 25 条（够铺满记录区），之后每次空闲补 15 条
let LOGGEN = 0;
const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 400 }) : setTimeout(fn, 30));
// items: [事件, 是否新到]；rebuild = 刷新恢复 / 终局重建：瞬间停到最新一条
function appendEvents(items, rebuild = false) {
  const log = $("#log");
  if (rebuild) {
    const gen = ++LOGGEN;
    // 整段重建不让读屏软件把几十条记录从头念一遍：补完之前先关掉朗读，补完再打开（之后的新记录照常朗读）
    log.setAttribute("aria-live", "off");
    const speak = () => { if (gen === LOGGEN) log.removeAttribute("aria-live"); };
    log.textContent = "";
    const tail = items.slice(-LOG_TAIL);
    let rest = items.slice(0, items.length - tail.length);
    const html = tail.map(([ev, fresh]) => rowHtml(ev, fresh)).join("");
    if (html) log.insertAdjacentHTML("beforeend", html);
    logToBottom(false);
    const step = () => {
      if (gen !== LOGGEN || !rest.length) return false;
      const part = rest.slice(-LOG_CHUNK);
      rest = rest.slice(0, rest.length - part.length);
      const h = part.map(([ev, fresh]) => rowHtml(ev, fresh)).join("");
      if (h) {
        const before = log.scrollHeight;
        log.insertAdjacentHTML("afterbegin", h);
        // 补在上面：贴着底部就继续贴着；用户往上翻着看时，看到的内容不跳
        if (LOG.pinned) log.scrollTop = log.scrollHeight;
        else log.scrollTop += log.scrollHeight - before;
      }
      return rest.length > 0;
    };
    const more = () => { if (step()) idle(more); else speak(); };
    LOG.flush = () => { while (step()); speak(); };
    if (rest.length) idle(more);
    else requestAnimationFrame(speak);
    return;
  }
  const rows = items.map(([ev, fresh]) => rowHtml(ev, fresh));
  const html = rows.join("");
  if (!html) return;
  log.insertAdjacentHTML("beforeend", html);
  if (LOG.pinned) logToBottom(true);
  else if (rows.some((h) => h && !h.startsWith('<div class="evw held'))) newRowsPill(true);
}
// 还没补完的早期记录立刻补完（要从头看内心独白时）
function flushLog() {
  LOG.rebuild?.();
  LOG.flush?.();
  LOG.flush = null;
}
// 放出扣住的记录（带入场动画）；没有扣住的不会被改动。贴着底部时把它滚进视野
function releaseLog(id) {
  if (!S.fx.heldLog.delete(id)) return;
  const el = $("#log").querySelector(`.evw.held[data-ev="${id}"]`);
  if (!el) return;
  el.classList.remove("held");
  el.classList.add("fresh");
  if (LOG.pinned) logToBottom(true);
  else newRowsPill(true);
}

$("#show-thoughts").addEventListener("change", (e) => {
  document.body.classList.toggle("show-thoughts", e.target.checked);
});

// =====================================================================
// 弹窗：教练 / 结算 / 复盘 / 规则
// =====================================================================
// foot：固定在卷轴底部、不随内容滚动的一行按钮（结算的“再来一局”永远看得见）
function openModal(title, html, kind = "", foot = "") {
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = html;
  const f = $("#modal-foot");
  f.innerHTML = foot;
  f.hidden = !foot;
  const m = $("#modal");
  m.dataset.kind = kind;
  if (!m.open) {
    m.showModal();
    if (!coachWaiting()) pauseMoment(); // 桌上正在演的那一幕不在卷轴后面白演：关上卷轴再从头演
  }
  $("#modal-body").scrollTop = 0;
}
$("#modal-close").onclick = () => $("#modal").close();
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") $("#modal").close(); });

// 教练的话（提示 / 复盘）：一封信，标题、要点、加粗都按羊皮卷排版
const letter = (text) => `<div class="letter">${md(text)}</div>`;
const loadingNote = (text) => `<div class="loading"><span class="ld-ic">${ic("candle")}</span><span>${text}<span class="dots"></span></span></div>`;

// 教练的提示针对“此刻”的局面：以待办（没有待办时以最新一条记录）为准，局面变了就作废
const hintKey = () => `${S.gameId}|${S.g?.pending ? "p" + S.g.pending.id : "e" + S.lastId}`;
const HINT = { seq: 0, key: "", html: "", wait: 0, waitGame: "" }; // wait：等着桌上揭晓的那次提问（见 hintWait）
const hintHtml = (text) => `${letter(text)}<p class="note-line">${ic("eye")}<span>教练只使用你能看到的信息，不会偷看别人的身份。</span></p>`;
function hintReady(on) {
  const btn = $("#btn-hint");
  btn.classList.toggle("ready", on);
  setAttr(btn, "aria-label", on ? "教练（提示已经写好）" : null);
}
// 教练按钮跟着对局状态（结束 / 观战时收起）。揭晓途中保持原样：对局刚结束时它会收起——也是一种剧透
function syncHint() {
  if (!S.g || dockHeld()) return;
  const noHint = S.g.status !== "running" || S.g.spectator;
  setAttr($("#btn-hint"), "disabled", noHint ? "" : null);
  $(".action-bar").classList.toggle("no-hint", noHint);
}
// 教练看的是服务器上“此刻”的局面。任务牌还在出（结果随时会到）、或者结果已经到了但翻牌 / 刺杀阶段 / 胜负还压着：
// 这时去问，回答里就会带出桌上还没翻开的结果（比分、对局已结束）。所以先等桌上揭晓完再问——
// 结果到没到都一样等（只在结果已经到了时才等，等本身就成了线索）
const hintWait = () => {
  const fx = S.fx, g = S.g;
  return !!g && (fx.holdQuest >= 0 || !!fx.holdReveal || !!fx.holdEnd || (g.status === "running" && g.phase === "quest" && !myTurn()));
};
$("#btn-hint").onclick = () => {
  if (!S.gameId) return;
  // 关掉卷轴之后才写好的提示：再点一下直接看
  if (HINT.html && HINT.key === hintKey()) {
    openModal("教练提示", HINT.html, "hint");
    hintReady(false);
    return;
  }
  HINT.html = "";
  hintReady(false);
  const seq = ++HINT.seq;
  // 要等的时候卷轴照样展开（说明在等什么），桌上的翻牌照常演（不像平时那样停在卷轴后面），揭晓完马上去问
  HINT.wait = hintWait() ? seq : 0;
  HINT.waitGame = S.gameId;
  openModal("教练提示", HINT.wait
    ? loadingNote("任务牌翻开后，教练马上回答") + `<p class="note-line">${ic("eye")}<span>关上卷轴就能看翻牌；写好之后，教练按钮上会亮起一颗红点。</span></p>`
    : loadingNote("教练正在看你的牌面和局势"), "hint");
  if (HINT.wait) hintResume(); // 对局已经结束、揭晓也演过了：直接说明
  else askCoach(seq);
};
// 教练的卷轴正等着桌上揭晓：这时桌上的几幕照常演
const coachWaiting = () => !!HINT.wait && $("#modal").open && $("#modal").dataset.kind === "hint";
// 每次放开压住的东西 / 重画行动栏之后看一眼：等的那次提问现在可以问了吗
// 卷轴等的时候被关上了：照样等、照样问，写好了在教练按钮上亮一个小点（和问的途中关上卷轴一样）
function hintResume() {
  const seq = HINT.wait;
  if (!seq || !S.g) return;
  if (HINT.waitGame !== S.gameId || seq !== HINT.seq) { HINT.wait = 0; return; }
  const fx = S.fx;
  const over = S.g.status !== "running";
  // 对局已经结束：翻牌（和“刺杀阶段”）揭晓了就不再等——后面的刺杀、胜负标题等卷轴关上再演
  if (over ? fx.holdQuest >= 0 || !!fx.holdReveal : hintWait()) return;
  HINT.wait = 0;
  const showing = $("#modal").open && $("#modal").dataset.kind === "hint";
  if (over) {
    if (showing) {
      openModal("教练提示", S.g.status === "ended"
        ? letter("这一局已经分出胜负。关上卷轴看结局；结算里可以请教练把整局**复盘**一遍。")
        : `<p class="error">对局不在进行中</p>`, "hint");
    }
    return;
  }
  if (showing) openModal("教练提示", loadingNote("教练正在看你的牌面和局势"), "hint");
  askCoach(seq);
}
async function askCoach(seq) {
  const btn = $("#btn-hint");
  const id = S.gameId;
  const key = hintKey();
  btn.disabled = true;
  let html;
  try {
    const r = await api(`/api/games/${id}/hint`, {});
    html = hintHtml(r.text);
  } catch (err) {
    html = `<p class="error">${esc(err.message)}</p>`;
  }
  btn.disabled = false;
  syncHint();
  // 换了一局 / 又点了一次：这份作废
  if (S.gameId !== id || seq !== HINT.seq) return;
  const m = $("#modal");
  if (m.open && m.dataset.kind === "hint") {
    openModal("教练提示", html, "hint");
  } else if (!html.includes('class="error"')) {
    // 等的时候把卷轴关了（在打字、看别的）：不再弹出来抢焦点，教练按钮上亮一个小点，点一下就看
    HINT.key = key;
    HINT.html = html;
    hintReady(true);
  }
}

// 结算横幅里的五枚任务火漆（和顶栏同一套样式）：成功 / 失败 / 没打到的轮次
function questSeals(g) {
  return g.quests.map((q, i) => {
    const done = q.success === true || q.success === false;
    const cls = q.success === true ? "success" : q.success === false ? "fail" : "unplayed";
    const title = `第${i + 1}轮：${q.size}人，${done ? `${q.success ? "成功" : "失败"}（${q.fails}张失败）` : "未进行"}`;
    const face = q.success === true ? ic("check") : q.success === false ? ic("cross") : q.size;
    return `<span class="quest ${cls}" title="${title}"><span class="qn" aria-hidden="true">${face}</span>${done ? failPips(q) : ""}<span class="sr-only">${title}</span></span>`;
  }).join("");
}

// 练习数据：每块一个数字 + 一句解释；tone = good / bad 给数字上色（做得好是绿，要改进是红）
const tile = (k, v, sub = "", tone = "") =>
  `<div class="tile${tone ? " " + tone : ""}"><span class="tk">${k}</span><span class="tv">${v}</span>${sub ? `<span class="ts">${sub}</span>` : ""}</div>`;

function endTiles(g, me, marks) {
  const st = g.stats || {};
  const tiles = [];
  const markTile = () => tiles.push(marks.total
    ? tile("身份标记", `${marks.right}<i>/</i>${marks.total}`, "猜对 / 标记", marks.right * 2 >= marks.total ? (marks.right === marks.total ? "good" : "") : "bad")
    : tile("身份标记", "—", "下局点座位旁的“标记”试试"));
  if (me && me.team === "good") {
    const m = st[String(me.seat)];
    if (m && m.votes) {
      const acc = Math.round((100 * m.correct) / m.votes);
      tiles.push(tile("投票正确率", `${acc}%`, `${m.correct}/${m.votes} 票判断对`, acc >= 75 ? "good" : acc < 50 ? "bad" : ""));
      tiles.push(tile("放坏人上车", `${m.approve_evil}<small>次</small>`, "赞成了含坏人的车", m.approve_evil ? "bad" : "good"));
      tiles.push(tile("误拦好车", `${m.reject_clean}<small>次</small>`, "反对了全是好人的车", m.reject_clean >= 2 ? "bad" : m.reject_clean ? "" : "good"));
    }
    markTile();
  } else if (me) {
    const m = st[String(me.seat)];
    const rode = g.quests.filter((q) => q.team && q.team.includes(me.seat) && q.success !== null).length;
    if (m) tiles.push(tile("出失败牌", `${m.fails_played}<small>张</small>`, "坏人只有出失败才能拿分"));
    tiles.push(tile("混上任务车", `${rode}<small>次</small>`, "坏人上了车才能破坏任务", rode ? "good" : ""));
    const kill = S.events.find((e) => e.type === "assassination");
    if (kill) {
      const merlin = g.players.find((p) => p.role === "merlin");
      const who = kill.assassin === me.seat ? "你" : `${kill.assassin}号`;
      tiles.push(tile("刺杀梅林", kill.hit ? "刺中" : "落空",
        `${who}刺向 ${kill.target}号${!kill.hit && merlin ? `，梅林是 ${merlin.seat}号` : ""}`, kill.hit ? "good" : "bad"));
    }
    markTile();
  } else {
    // 观战：整桌好人的投票水平、票最准的人、坏人出的失败牌、被否决的提名（比分已在横幅的火漆上）
    const goods = g.players.filter((p) => p.team === "good" && st[String(p.seat)]?.votes);
    const sum = (f) => goods.reduce((a, p) => a + st[String(p.seat)][f], 0);
    if (goods.length) {
      tiles.push(tile("好人投票正确率", `${Math.round((100 * sum("correct")) / sum("votes"))}%`, `好人一共投了 ${sum("votes")} 票`));
      const rate = (p) => st[String(p.seat)].correct / st[String(p.seat)].votes;
      const best = goods.reduce((a, p) => (rate(p) > rate(a) ? p : a));
      tiles.push(tile("票最准的好人", `${Math.round(100 * rate(best))}%`, `${best.seat}号「${esc(best.name)}」`, "good"));
    }
    const fails = g.players.filter((p) => p.team === "evil").reduce((a, p) => a + (st[String(p.seat)]?.fails_played || 0), 0);
    tiles.push(tile("坏人出失败", `${fails}<small>张</small>`, "整局的失败牌"));
    const rejects = S.events.filter((e) => e.type === "vote" && !e.approved).length;
    tiles.push(tile("被否决的提名", `${rejects}<small>次</small>`, "同一轮连续5次坏人直接赢"));
  }
  return tiles.join("");
}

function showEndModal() {
  const g = S.g;
  if (!g || g.status !== "ended") return;
  // 教练 / 规则的卷轴还开着（教练的回答可能刚到、正在看）：不盖掉它，关上之后再展开结算
  const open = $("#modal");
  if (open.open && open.dataset.kind !== "end") { S.fx.endAfterModal = true; return; }
  const me = g.you;
  const win = me && g.winner === me.team;
  const winner = `${g.winner === "good" ? "好人" : "坏人"}阵营获胜`;
  const title = me ? (win ? "你赢了！" : "这局输了") : winner;
  const sub = me ? `${winner} · 你是${esc(me.role_name)}` : "观战结束 · 上帝视角";
  const marks = { total: 0, right: 0 };
  const rows = g.players.map((p) => {
    const m = S.marks[p.seat] || "";
    let markCell = "";
    if (m) {
      const ok = m === "merlin" ? p.role === "merlin" : m === p.team;
      marks.total++;
      if (ok) marks.right++;
      markCell = `<span class="mk ${ok ? "ok" : "bad"}">${MARK_TEXT[m]}${ic(ok ? "check" : "cross")}</span>`;
    }
    const st = g.stats?.[String(p.seat)];
    const good = p.team === "good";
    const acc = st && st.votes ? Math.round((100 * st.correct) / st.votes) + "%" : "";
    // 没有数据的格子写“-”；手机上整格隐藏（每人一张两行的小卡片）
    const cell = (k, v, cls = "num") => v === "" || v === undefined
      ? `<td class="${cls} na" data-k="${k}"><span class="muted">-</span></td>`
      : `<td class="${cls}" data-k="${k}">${v}</td>`;
    return `<tr class="${p.is_human ? "me-row" : ""}">
      <td class="who"><span class="who-cell">${seatEmblem(p.seat, "sm")}<span>${esc(p.name)}${p.is_human ? "<small>（你）</small>" : ""}</span></span></td>
      <td class="role"><span class="label ${p.team}">${esc(p.role_name)}</span></td>
      <td class="brk" aria-hidden="true"></td>
      ${cell("投票正确率", good ? acc : "")}
      ${cell("提名含坏人", st && good ? st.proposals_with_evil + "/" + st.proposals : "")}
      ${cell("出失败", st && !good ? st.fails_played : "")}
      ${me ? cell("你的标记", markCell, "mk-cell") : ""}</tr>`;
  }).join("");
  const score = g.score || [g.quests.filter((q) => q.success === true).length, g.quests.filter((q) => q.success === false).length];
  const kind = !me ? "neutral" : win ? "win" : "lose";
  const tiles = endTiles(g, me, marks);
  const html = `
    <div class="end-banner ${kind} team-${g.winner}">
      <div class="eb-emblem">${ic(!me ? "swords" : win ? "crown" : g.winner === "good" ? "chalice" : "dagger")}</div>
      <div class="eb-title">${title}</div>
      <div class="eb-sub">${sub}</div>
      <div class="eb-track" aria-label="任务比分 好人 ${score[0]} : 坏人 ${score[1]}"><span class="eb-seals">${questSeals(g)}</span>
        <span class="eb-score"><b>${score[0]}</b><i>:</i><b>${score[1]}</b></span></div>
    </div>
    <p class="end-reason">${esc(g.end_reason)}</p>
    <h3>${me ? "你的练习数据" : "本局数据"}</h3>
    <div class="end-stats">${tiles}</div>
    <h3>身份揭晓</h3>
    <div class="table-scroll"><table class="reveal-table">
      <thead><tr><th>玩家</th><th>身份</th><th title="赞成无坏人的车、反对有坏人的车算正确（仅统计好人）">投票正确率</th><th title="好人当队长时提名的队伍含坏人次数 / 当队长次数">含坏人的提名</th><th title="坏人在任务中出的失败牌">出失败</th>${me ? "<th>你的标记</th>" : ""}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div id="review-box" class="review-box"></div>`;
  const foot = `<div class="end-actions">
      <button class="ghost" id="end-thoughts" title="查看 AI 内心独白">${ic("thought")}<span><span class="et-long">查看 AI </span>内心独白</span></button>
      <button class="coach" id="end-review">${ic("candle")}<span>${me ? "AI 教练复盘" : "AI 整局点评"}</span></button>
      <button class="primary" id="end-again">${ic("restart")}<span>再来一局</span></button>
    </div>`;
  openModal("对局结算", html, "end", foot);
  $("#end-review").onclick = () => (S.g?.review ? showReview(true) : loadReview());
  $("#end-thoughts").onclick = () => {
    $("#show-thoughts").checked = true;
    document.body.classList.add("show-thoughts");
    $("#modal").close();
    flushLog();
    LOG.pinned = false;
    LOG.auto = 0;
    $("#log").scrollTop = 0;
    if (!DESKTOP.matches) $(".right")?.scrollIntoView({ block: "start", behavior: reduceMotion() ? "auto" : "smooth" });
  };
  $("#end-again").onclick = () => showSetup();
  if (g.review) showReview(false);
}

// 复盘：写进结算卷轴底部；scroll = 滚到复盘的标题处（加载完成、或点“查看复盘”时）
function showReview(scroll) {
  const box = $("#review-box");
  if (!box || !S.g?.review) return;
  box.innerHTML = `<h3 class="review-h">${ic("candle")}<span>${S.g.you ? "AI 教练复盘" : "AI 整局点评"}</span></h3>${letter(S.g.review)}`;
  const btn = $("#end-review");
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = `${ic("scroll")}<span>查看复盘</span>`;
  }
  if (scroll) scrollModalTo(box);
}
function scrollModalTo(el) {
  const body = $("#modal-body");
  const top = body.scrollTop + el.getBoundingClientRect().top - body.getBoundingClientRect().top - 14;
  body.scrollTo({ top: Math.max(0, top), behavior: reduceMotion() ? "auto" : "smooth" });
}

async function loadReview() {
  const box = $("#review-box");
  const btn = $("#end-review");
  const id = S.gameId;
  btn.disabled = true;
  btn.innerHTML = `${ic("candle")}<span>复盘中…</span>`;
  box.innerHTML = loadingNote("教练正在复盘整局（大约需要十几秒）");
  scrollModalTo(box);
  try {
    const r = await api(`/api/games/${id}/review`, {});
    if (S.gameId !== id) return;
    if (S.g) S.g.review = r.text;
    showReview(true);
  } catch (err) {
    if (!box.isConnected) return;
    box.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    btn.disabled = false;
    btn.innerHTML = `${ic("candle")}<span>重试复盘</span>`;
  }
}

$("#btn-rules").onclick = () => {
  const n = S.g?.n || 7;
  const preset = S.config.presets[n];
  const count = (team) => preset.roles.filter((r) => S.config.roles[r].team === team).length;
  const roles = [...new Set(preset.roles)]
    .map((r) => {
      const R = S.config.roles[r];
      const k = preset.roles.filter((x) => x === r).length;
      return `<li class="role-li ${R.team}"><span class="role-ic ${R.team}">${ART.role(r)}</span><div class="role-tx"><div class="role-nm"><b>${esc(R.name)}</b>${k > 1 ? `<small>×${k}</small>` : ""}<span class="label ${R.team}">${TEAM_NAME[R.team]}</span></div><p>${esc(R.ability)}</p></div></li>`;
    })
    .join("");
  const sizes = preset.team_sizes
    .map((z, i) => `<div class="sz"><span class="quest" title="第${i + 1}轮：${z}人${n >= 7 && i === 3 ? "，需要2张失败" : ""}"><span class="qn">${z}</span>${n >= 7 && i === 3 ? '<span class="two">需2败</span>' : ""}</span><small>第${i + 1}轮</small></div>`).join("");
  openModal("规则速查", `
    <h3>流程</h3>
    <ol class="steps">
      <li>队长提名指定人数的队伍，其他人按顺序发言，然后所有人同时投票。</li>
      <li>赞成票<b>超过半数</b>才发车，否则队长交给下一位。同一轮<b>连续5次否决</b>，坏人直接获胜。</li>
      <li>队员秘密出牌：好人只能出成功，坏人可以出失败。出现失败牌任务就失败${n >= 7 ? `（本局第4轮<span class="nw">需要2张失败</span>）` : ""}。</li>
      <li>先赢3轮的阵营获胜；但好人赢下3轮后，刺客还可以刺杀梅林翻盘。</li>
    </ol>
    <h3>本局角色<span class="h3-note">${n}人 · <span class="t-good">好人 ${count("good")}</span> · <span class="t-evil">坏人 ${count("evil")}</span></span></h3>
    <ul class="role-list">${roles}</ul>
    <h3>任务人数</h3>
    <div class="sizes">${sizes}</div>
    ${S.g?.lady_enabled ? `<h3>湖中仙女</h3>
    <p>第2、3、4轮任务结束后（游戏还没分出胜负时），持有者秘密查看一名玩家的阵营，再公开宣布——<b>可以撒谎</b>。
      仙女随后交给被查验的人；拿过仙女的人不能再被查验。</p>` : ""}
    <h3>练习小贴士</h3>
    <ul class="tips">
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
