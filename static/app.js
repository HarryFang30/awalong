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
  pendingKey: null,
  marks: {},
  pollTimer: null,
  covered: false,
  live: false,          // 首次拉取之后才算“实时”，只有实时的新事件才播放动画
  revealFresh: false,   // 刚开局：展示身份揭晓
  fx: { voteId: 0, voteAt: 0, quests: null, queue: [], busy: false, timer: null, curAt: 0, revealTimer: null, revealAt: 0 },
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
const seatColor = (s) => ART.color(s);
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
  $("#f-seat").addEventListener("change", () => { $("#f-role").disabled = $("#f-seat").value === "watch"; });
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
    `<option value="watch">观战（全 AI 对局，上帝视角）</option>`;
  seatSel.value = prevSeat === "watch" || +prevSeat <= n ? prevSeat : "random";

  const roleSel = $("#f-role");
  const prevRole = roleSel.value || load("avalon.role") || "random";
  const unique = [...new Set(preset.roles)];
  roleSel.innerHTML = `<option value="random">随机（推荐）</option>` +
    unique.map((r) => `<option value="${r}">${roles[r].name}（${TEAM_NAME[roles[r].team]}）</option>`).join("");
  roleSel.value = unique.includes(prevRole) ? prevRole : "random";
  roleSel.disabled = seatSel.value === "watch";

  const counts = {};
  preset.roles.forEach((r) => { counts[r] = (counts[r] || 0) + 1; });
  const tags = Object.entries(counts)
    .map(([r, c]) => `<span class="tag ${roles[r].team}" title="${esc(roles[r].ability)}">${roles[r].name}${c > 1 ? "×" + c : ""}</span>`)
    .join("");
  const sizes = preset.team_sizes
    .map((z, i) => `<span class="qs${n >= 7 && i === 3 ? " two" : ""}" title="第${i + 1}轮：${z}人">${z}</span>`)
    .join("");
  $("#roles-preview").innerHTML =
    `<div class="rp-row"><span class="rp-k">本局角色</span><span class="rp-v">${tags}</span></div>` +
    `<div class="rp-row"><span class="rp-k">任务人数</span><span class="rp-v">${sizes}${n >= 7 ? "<small>（第4轮需2张失败）</small>" : ""}</span></div>`;
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
  btn.disabled = true;
  $("#setup-error").textContent = "";
  try {
    const { id } = await api("/api/games", body);
    enterGame(id, true);
  } catch (err) {
    $("#setup-error").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

function showSetup(message = "") {
  clearTimeout(S.pollTimer);
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
    selected: [], pendingKey: null, covered: false, live: false, revealFresh: fresh,
  });
  try { S.marks = JSON.parse(load("avalon.marks." + id) || "{}"); } catch { S.marks = {}; }
  store("avalon.game", id);
  $("#log").innerHTML = "";
  $("#table").querySelectorAll(".seat").forEach((el) => el.remove());
  for (const sel of ["#action", "#quest-track", "#reject-track", "#table-center", "#identity"]) {
    const el = $(sel);
    el._h = null;
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
    for (const ev of st.events) {
      S.events.push(ev);
      const fresh = S.live && ev.id > prevLast;
      appendEvent(ev, fresh);
      if (fresh) eventMoment(ev);
    }
    S.lastId = st.last_event_id;
    render();
    S.live = true;
    if (S.ended && !S.endShown) {
      S.endShown = true;
      setTimeout(showEndModal, 700);
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
  const now = g.quests.map((q) => q.success);
  S.fx.quests = now;
  const html = g.quests.map((q, i) => {
    let cls = "";
    if (q.success === true) cls = "success";
    else if (q.success === false) cls = "fail";
    else if (i === g.quest_index && ACTIVE.includes(g.status)) cls = "current";
    let title = `第${i + 1}轮：${q.size}人`;
    if (q.fails_needed === 2) title += "，需要2张失败才失败";
    if (q.success !== null) title += `；${q.success ? "成功" : "失败"}（${q.fails}张失败）`;
    const face = q.success === true ? "✓" : q.success === false ? "✗" : q.size;
    return `<div class="quest ${cls}" title="${title}" aria-label="${title}"><span class="qn">${face}</span>${q.fails_needed === 2 ? '<span class="two">2败</span>' : ""}</div>`;
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

function lastVoteEvent() {
  for (let i = S.events.length - 1; i >= 0; i--) {
    const t = S.events[i].type;
    if (t === "vote") return S.events[i];
    if (t === "proposal" || t === "quest_start" || t === "evil_reveal") return null;
  }
  return null;
}

function selection() {
  const p = S.g.pending;
  if (!p) return null;
  if (p.type === "propose") return { seats: S.g.players.map((x) => x.seat), max: p.size };
  if (["lady_choose", "assassin_suggest", "assassinate"].includes(p.type)) return { seats: p.candidates, max: 1 };
  return null;
}

function seatPos(seat) {
  const n = S.g.n;
  const base = S.g.you ? S.g.you.seat : 1;
  const theta = Math.PI / 2 + ((seat - base) * 2 * Math.PI) / n;
  const [rx, ry] = NARROW.matches ? [38.5, 39] : [41, 37];
  return { x: 50 + rx * Math.cos(theta), y: 50 + ry * Math.sin(theta) };
}

function labelClass(text) {
  if (/坏/.test(text)) return "evil";
  if (/梅林/.test(text)) return "merlin";
  return "good";
}

function renderTable() {
  const g = S.g;
  const sel = selection();
  const team = g.proposal || [];
  const vote = lastVoteEvent();
  const freshVote = vote && vote.id === S.fx.voteId && performance.now() - S.fx.voteAt < 1500;
  const table = $("#table");
  const seen = new Set();
  g.players.forEach((p) => {
    seen.add(String(p.seat));
    let el = table.querySelector(`.seat[data-seat="${p.seat}"]`);
    if (!el) {
      el = document.createElement("div");
      el.dataset.seat = p.seat;
      el.innerHTML = `<div class="avatar"></div><div class="name"></div><div class="labels"></div>`;
      table.appendChild(el);
    }
    const [avatarEl, nameEl, labelsEl] = el.children;

    const cls = ["seat"];
    if (p.is_human) cls.push("me");
    if (team.includes(p.seat)) cls.push("on-team");
    let selectable = false;
    if (sel) {
      if (sel.seats.includes(p.seat)) { cls.push("selectable"); selectable = true; } else cls.push("dim");
      if (S.selected.includes(p.seat)) cls.push("selected");
    }
    if (g.thinking.includes(p.seat)) cls.push("thinking");
    if (p.role_name && (S.ended || g.spectator)) cls.push("revealed", `team-${p.team}`);
    const className = cls.join(" ");
    if (el.className !== className) el.className = className;

    const pos = seatPos(p.seat);
    const left = `${pos.x.toFixed(3)}%`, top = `${pos.y.toFixed(3)}%`;
    if (el.style.left !== left) el.style.left = left;
    if (el.style.top !== top) el.style.top = top;

    // 盾牌 + 徽记
    const isLeader = g.leader === p.seat && ACTIVE.includes(g.status);
    let chip = "";
    if (vote) {
      const v = vote.votes[String(p.seat)];
      chip = `<span class="vote-chip ${v ? "yes" : "no"}" title="${v ? "赞成" : "反对"}" style="--i:${p.seat}">${ic(v ? "check" : "cross")}</span>`;
    }
    const avatarHtml = ART.shield(p.seat) + `<span class="num">${p.seat}</span>` +
      (isLeader ? `<span class="crown" title="队长">${ART.crownBadge()}</span>` : "") +
      (g.lady_enabled && g.lady_holder === p.seat ? `<span class="lady" title="湖中仙女">${ART.ladyBadge()}</span>` : "") +
      chip +
      `<span class="think" aria-hidden="true"><i></i><i></i><i></i></span>` +
      `<span class="badge tb" aria-hidden="true">${ic("swords")}</span>` +
      `<span class="badge sb" aria-hidden="true">${ic("check")}</span>`;
    if (patch(avatarEl, avatarHtml) && freshVote) avatarEl.querySelector(".vote-chip")?.classList.add("pop");
    setAttr(avatarEl, "title", p.is_human ? "你" : `${p.name}：${p.persona}`);
    setAttr(avatarEl, "role", selectable ? "button" : null);
    setAttr(avatarEl, "tabindex", selectable ? "0" : null);
    setAttr(avatarEl, "aria-pressed", selectable ? String(S.selected.includes(p.seat)) : null);
    setAttr(avatarEl, "aria-label", `${p.seat}号 ${p.name}${p.is_human ? "（你）" : ""}`);

    patch(nameEl, `${esc(p.name)}${p.is_human ? "<small>（你）</small>" : ""}`);

    const labels = [];
    if (p.role_name && (S.ended || !p.is_human)) {
      labels.push(`<span class="label ${p.team}">${esc(p.role_name)}</span>`);
    } else if (p.known) {
      labels.push(`<span class="label ${labelClass(p.known)}">${esc(p.known)}</span>`);
    }
    const mark = S.marks[p.seat] || "";
    const markBtn = p.is_human || g.spectator ? ""
      : `<button class="mark" data-mark="${mark}" title="记下你对TA的判断（点击切换）" aria-label="标记 ${p.seat}号：${MARK_TEXT[mark]}">${MARK_TEXT[mark]}</button>`;
    patch(labelsEl, labels.join("") + markBtn);
  });
  table.querySelectorAll(".seat").forEach((el) => { if (!seen.has(el.dataset.seat)) el.remove(); });
  patch($("#table-center"), centerText());
}

function centerText() {
  const g = S.g;
  if (g.status === "ended") {
    return `<div class="tc-kicker">对局结束</div><div class="phase win-${g.winner}">${g.winner === "good" ? "好人" : "坏人"}阵营获胜</div><div class="tc-line">${esc(g.end_reason)}</div>`;
  }
  if (g.status === "error") return `<div class="phase">出错了</div><div class="tc-line">${esc(g.error)}</div>`;
  if (g.status === "cancelled") return `<div class="phase">对局已结束</div>`;
  const head = `第${g.quest_index + 1}轮任务 · 第${Math.max(1, g.attempt)}次提名`;
  const team = g.proposal ? `<div class="team">${seatChips(g.proposal)}</div>` : "";
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
  return `${kicker}<div class="phase">${head}</div><div class="tc-line">${phase}</div>${team}`;
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
  if (!g.llm) { el.textContent = "离线 AI"; return; }
  const u = g.usage;
  if (!u) return;
  const k = ((u.prompt_tokens + u.completion_tokens) / 1000).toFixed(1);
  const text = `DeepSeek ${u.calls} 次 · ${k}k tokens`;
  if (el.textContent !== text) el.textContent = text;
  el.title = `模型 ${u.model}；输入 ${u.prompt_tokens}（缓存命中 ${u.cache_hit_tokens}），输出 ${u.completion_tokens}；失败 ${u.errors} 次`;
}

// =====================================================================
// 时刻：身份揭晓 / 投票 / 任务 / 刺杀（只为新事件播放）
// =====================================================================
function resetFx() {
  clearTimeout(S.fx.timer);
  clearTimeout(S.fx.revealTimer);
  S.fx = { voteId: 0, voteAt: 0, quests: null, queue: [], busy: false, timer: null, curAt: 0, revealTimer: null, revealAt: 0 };
  const m = $("#moment");
  if (m) m.innerHTML = "";
  document.querySelectorAll(".reveal").forEach((el) => el.remove());
}

function moment(html, cls, ms) {
  S.fx.queue.push({ html, cls, ms });
  if (S.fx.queue.length > 2) S.fx.queue.shift();
  if (!S.fx.busy) { nextMoment(); return; }
  // 新时刻来了：当前印章至少停留 0.9 秒，然后让位，避免越积越晚
  clearTimeout(S.fx.timer);
  S.fx.timer = setTimeout(nextMoment, Math.max(0, 900 - (performance.now() - S.fx.curAt)));
}
function nextMoment() {
  const m = S.fx.queue.shift();
  const box = $("#moment");
  if (!m) { S.fx.busy = false; box.innerHTML = ""; return; }
  S.fx.busy = true;
  S.fx.curAt = performance.now();
  box.innerHTML = `<div class="stamp ${m.cls}" style="--ms:${m.ms}ms">${m.html}</div>`;
  S.fx.timer = setTimeout(nextMoment, m.ms);
}

function eventMoment(ev) {
  if (ev.type === "vote") {
    S.fx.voteId = ev.id;
    S.fx.voteAt = performance.now();
    const yes = Object.values(ev.votes).filter(Boolean).length;
    const no = Object.keys(ev.votes).length - yes;
    moment(`<span class="st-ic">${ic(ev.approved ? "check" : "cross")}</span><b>${ev.approved ? "投票通过" : "投票否决"}</b><small>${yes} 赞成 · ${no} 反对</small>`,
      ev.approved ? "yes" : "no", 1500);
  } else if (ev.type === "quest_result") {
    moment(`<span class="st-ic">${ic(ev.success ? "chalice" : "dagger")}</span><b>任务${ev.success ? "成功" : "失败"}</b><small>${ev.fails} 张失败牌 · 比分 ${ev.score[0]} : ${ev.score[1]}</small>`,
      ev.success ? "good" : "evil", 2300);
  } else if (ev.type === "evil_reveal") {
    moment(`<span class="st-ic">${ic("dagger")}</span><b>刺杀阶段</b><small>好人三胜！刺客现身寻找梅林</small>`, "evil", 2300);
  } else if (ev.type === "assassination") {
    moment(`<span class="st-ic">${ic("dagger")}</span><b>${ev.hit ? "刺中梅林！" : "刺杀落空"}</b><small>刺客 ${ev.assassin}号 → ${ev.target}号</small>`,
      ev.hit ? "evil" : "good", 2600);
  }
}

function maybeReveal() {
  const g = S.g;
  if (S.revealFresh && g.you) {
    S.revealFresh = false;
    showReveal(g.you);
  } else if (S.revealFresh && g.spectator) {
    S.revealFresh = false;
  }
  // 手机上揭晓卡片盖住全屏：需要你行动时让路
  if (g.pending && document.querySelector(".reveal:not(.out):not(.in-panel)") && performance.now() - S.fx.revealAt > 1200) hideReveal();
}

function showReveal(y) {
  document.querySelectorAll(".reveal").forEach((el) => el.remove());
  const know = y.knowledge.length
    ? `<div class="rv-know">你知道：${y.knowledge.map((k) => `${k.seat}号（${esc(k.label)}）`).join("、")}</div>`
    : `<div class="rv-know">没有额外信息，全靠推理。</div>`;
  // 桌面：出现在（此时还空着的）对局记录卷轴上，不挡圆桌和行动栏；手机：全屏
  const inPanel = DESKTOP.matches;
  const el = document.createElement("div");
  el.className = `reveal ${y.team}${inPanel ? " in-panel" : ""}`;
  el.setAttribute("role", "status");
  el.innerHTML = `<div class="rv-card">
      <div class="rv-kicker">你的身份</div>
      <div class="rv-art">${ART.role(y.role)}</div>
      <div class="rv-role">${esc(y.role_name)}</div>
      <div class="rv-team">${TEAM_NAME[y.team]}阵营 · ${y.seat}号座位</div>
      ${know}
    </div>
    <div class="rv-hint">点击任意处开始</div>`;
  (inPanel ? $(".right") : document.body).appendChild(el);
  S.fx.revealAt = performance.now();
  S.fx.revealTimer = setTimeout(hideReveal, inPanel ? 4200 : S.g.pending ? 1800 : 3200);
}
function hideReveal() {
  clearTimeout(S.fx.revealTimer);
  document.querySelectorAll(".reveal:not(.out)").forEach((el) => {
    el.classList.add("out");
    setTimeout(() => el.remove(), reduceMotion() ? 0 : 320);
  });
}
document.addEventListener("pointerdown", () => { if (document.querySelector(".reveal:not(.out)")) hideReveal(); }, true);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
    if (document.querySelector(".reveal:not(.out)")) hideReveal();
  }
}, true);

// =====================================================================
// 行动栏
// =====================================================================
function attemptWarn() {
  const a = S.g.attempt;
  if (a >= 5) return `<div class="alert danger">${ic("warn")}本轮第5次提名：再被否决坏人直接获胜！</div>`;
  if (a === 4) return `<div class="alert">${ic("warn")}注意：本轮已经否决3次了。</div>`;
  return "";
}

const QUICK = ["这车我同意。", "这车我反对。", "我是好人，相信我。", "我觉得车上有问题。", "先过，听后面的。"];

const PANELS = {
  propose: (p) => `
    <div class="act-title">${ic("crown")}<span>你是队长：在圆桌上点选 <span class="em">${p.size}</span> 名队员</span><span class="sub">（可以选自己）</span></div>
    ${attemptWarn()}
    <div class="compose">
      <textarea id="act-speech" rows="2" maxlength="500" placeholder="说说你的组队理由（可选，Ctrl+Enter 提交）"></textarea>
      <div class="act-row"><span class="sel">已选 <b id="sel-list">无</b></span><span class="spacer"></span>
        <button class="primary" id="act-submit" disabled>确认发车</button></div>
    </div>`,
  speak: (p) => `
    <div class="act-head">
      <div class="act-title">${ic("quill")}<span>轮到你发言</span><span class="sub">队长 ${S.g.leader}号 提名</span>${seatChips(p.team)}</div>
      <div class="quick">${QUICK.map((q) => `<button type="button" data-quick="${esc(q)}">${esc(q)}</button>`).join("")}</div>
    </div>
    <div class="compose">
      <textarea id="act-speech" rows="2" maxlength="500" placeholder="你的发言（Ctrl+Enter 提交）"></textarea>
      <div class="act-row"><span class="spacer"></span>
        <button class="ghost" id="act-pass">过</button>
        <button class="primary" id="act-submit">发言</button></div>
    </div>`,
  vote: (p) => `
    <div class="act-title">${ic("ballot")}<span>投票</span><span class="sub">队长 ${S.g.leader}号 提名</span>${seatChips(p.team)}</div>
    ${attemptWarn()}
    <div class="act-buttons">
      <button class="good" data-vote="1">${ic("check")}<span>赞成</span></button>
      <button class="evil" data-vote="0">${ic("cross")}<span>反对</span></button>
    </div>`,
  quest: (p) => `
    <div class="act-title">${ic("swords")}<span>你在任务队伍中，请秘密出牌</span>${p.fails_needed === 2 ? '<span class="sub">（本轮需要2张失败才失败）</span>' : ""}</div>
    <div class="act-buttons cards">
      <button class="good card-btn" data-card="success">${ic("chalice")}<span>成功</span></button>
      <button class="evil card-btn" data-card="fail" ${p.can_fail ? "" : 'disabled title="好人只能出成功"'}>${ic("dagger")}<span>失败</span></button>
      ${p.can_fail ? "" : '<p class="note">好人只能出成功。</p>'}
    </div>`,
  lady_choose: (p) => `
    <div class="act-title">${ic("waves")}<span>湖中仙女：选择一名玩家查验阵营</span><span class="sub">可选：${seatsText(p.candidates)}</span></div>
    <div class="act-row"><span class="sel">已选 <b id="sel-list">无</b></span><span class="spacer"></span>
      <button class="primary" id="act-submit" disabled>查验</button></div>`,
  lady_announce: (p) => `
    <div class="act-title">${ic("waves")}<span>查验结果（只有你知道）：${p.target}号是</span>
      <span class="label ${p.result}">${TEAM_NAME[p.result]}</span></div>
    <div class="claim-row"><span class="claim-k">公开宣布</span>
      <label class="pill-radio"><input type="radio" name="claim" value="good" ${p.result === "good" ? "checked" : ""}><span>好人</span></label>
      <label class="pill-radio"><input type="radio" name="claim" value="evil" ${p.result === "evil" ? "checked" : ""}><span>坏人</span></label>
      <label class="pill-radio"><input type="radio" name="claim" value="none"><span>不公布</span></label>
    </div>
    <div class="compose">
      <textarea id="act-speech" rows="2" maxlength="500" placeholder="说点什么（可以撒谎）"></textarea>
      <div class="act-row"><span class="spacer"></span><button class="primary" id="act-submit">公布</button></div>
    </div>`,
  assassin_suggest: (p) => `
    <div class="act-title">${ic("dagger")}<span>刺杀讨论：你觉得谁是梅林？点选一人告诉刺客</span><span class="sub">可选：${seatsText(p.candidates)}</span></div>
    <div class="compose">
      <textarea id="act-speech" rows="2" maxlength="500" placeholder="说说你的理由"></textarea>
      <div class="act-row"><span class="sel">已选 <b id="sel-list">无</b></span><span class="spacer"></span>
        <button class="primary" id="act-submit" disabled>提出建议</button></div>
    </div>`,
  assassinate: (p) => `
    <div class="act-title">${ic("dagger")}<span>你是刺客：刺中梅林就能翻盘！点选刺杀目标</span><span class="sub">可选：${seatsText(p.candidates)}</span></div>
    <div class="compose">
      <textarea id="act-speech" rows="2" maxlength="500" placeholder="刺杀前想说的话（可选）"></textarea>
      <div class="act-row"><span class="sel">已选 <b id="sel-list">无</b></span><span class="spacer"></span>
        <button class="evil" id="act-submit" disabled>刺杀！</button></div>
    </div>`,
};

function setAction(html) {
  const box = $("#action");
  box.innerHTML = html;
  box._h = html;
}

function renderAction() {
  const g = S.g;
  const box = $("#action");
  $("#btn-hint").disabled = g.status !== "running" || g.spectator;
  const p = g.pending;
  $(".action-bar").classList.toggle("your-turn", !!p);
  const title = p ? "【轮到你】阿瓦隆练习场" : "阿瓦隆练习场";
  if (document.title !== title) document.title = title;
  if (p) {
    const key = `p${p.id}`;
    if (S.pendingKey !== key) {
      S.pendingKey = key;
      S.selected = [];
      setAction(`<div class="panel panel-${p.type}">${PANELS[p.type] ? PANELS[p.type](p) : ""}</div>`);
      bindAction(p);
      renderTable();
      const ta = $("#act-speech");
      if (ta && DESKTOP.matches) ta.focus();
    }
    updateSelectionUI();
    return;
  }
  S.pendingKey = null;
  if (g.status === "ended") {
    const html = `<div class="act-row end-row">
      <span class="act-title end-title win-${g.winner}">${ic(g.winner === "good" ? "chalice" : "dagger")}<span>${g.winner === "good" ? "好人" : "坏人"}阵营获胜</span></span><span class="spacer"></span>
      <button class="ghost" id="act-summary">结算</button>
      <button class="primary" id="act-again">再来一局</button></div>`;
    if (patch(box, html)) {
      $("#act-summary").onclick = showEndModal;
      $("#act-again").onclick = () => showSetup();
    }
    return;
  }
  if (g.status === "error" || g.status === "cancelled") {
    const html = `<div class="act-row end-row"><span class="act-msg">${g.status === "error" ? "对局出错：" + esc(g.error) : "对局已停止"}</span>
      <span class="spacer"></span><button class="primary" id="act-again">新游戏</button></div>`;
    if (patch(box, html)) $("#act-again").onclick = () => showSetup();
    return;
  }
  patch(box, `<div class="waiting"><span class="quill">${ic("quill")}</span><span class="wt">${waitingText()}</span><span class="dots" aria-hidden="true"></span></div>`);
}

function waitingText() {
  const g = S.g;
  const t = g.thinking;
  if (g.phase === "vote") return "等待其他玩家投票";
  if (g.phase === "quest") return "任务进行中，等待队员出牌";
  if (!t.length) return "请稍候";
  return t.map((s) => seatChip(s, `「${esc(nameOf(s))}」`)).join("") + `<span>${g.phase === "propose" ? "正在组队" : "正在思考"}</span>`;
}

function updateSelectionUI() {
  const p = S.g.pending;
  const list = $("#sel-list");
  if (list) {
    const text = seatsText(S.selected);
    if (list.textContent !== text) list.textContent = text;
    const need = p?.type === "propose" ? p.size : 1;
    list.closest(".sel")?.classList.toggle("full", S.selected.length === need);
  }
  const btn = $("#act-submit");
  if (!btn || !p) return;
  if (p.type === "propose") btn.disabled = S.selected.length !== p.size;
  else if (["lady_choose", "assassin_suggest", "assassinate"].includes(p.type)) btn.disabled = S.selected.length !== 1;
}

function bindAction(p) {
  const box = $("#action");
  const speech = () => ($("#act-speech")?.value || "").trim();
  const submit = async (data) => {
    box.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      await api(`/api/games/${S.gameId}/action`, { pending_id: p.id, ...data });
      S.selected = [];
      setAction(`<div class="waiting"><span class="quill">${ic("quill")}</span><span class="wt">已提交</span><span class="dots" aria-hidden="true"></span></div>`);
      S.pendingKey = `done${p.id}`;
      setTimeout(poll, 150);
    } catch (err) {
      box.querySelectorAll("button").forEach((b) => (b.disabled = false));
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
  if (S.selected.includes(seat)) S.selected = S.selected.filter((s) => s !== seat);
  else if (sel.max === 1) S.selected = [seat];
  else if (S.selected.length < sel.max) S.selected.push(seat);
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
NARROW.addEventListener("change", () => { if (S.g) renderTable(); });

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
    <div class="mini">${ART.shield(seat, "mshield")}<span>${seat}</span></div>
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
        `<span class="chip ${v ? "yes" : "no"}${team.includes(s) ? " on" : ""}"${team.includes(s) ? ' title="在车上"' : ""}>${s}号 ${v ? "✓" : "✗"}</span>`).join("");
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

function appendEvent(ev, fresh = false) {
  const log = $("#log");
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  const html = eventHtml(ev);
  if (!html) return;
  log.insertAdjacentHTML("beforeend", `<div class="evw${fresh ? " fresh" : ""}">${html}</div>`);
  if (nearBottom || !S.ended) log.scrollTop = log.scrollHeight;
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
      <td><span class="who-cell"><span class="mini">${ART.shield(p.seat, "mshield")}<span>${p.seat}</span></span>${esc(p.name)}${p.is_human ? "（你）" : ""}</span></td>
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
