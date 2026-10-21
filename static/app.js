"use strict";

// =====================================================================
// 工具
// =====================================================================
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const SEAT_COLORS = ["#c0504d", "#2e86c1", "#2f9e5b", "#8e44ad", "#d68910", "#16a085", "#c2185b", "#5d6d7e", "#a85a1c", "#3f5fbf"];
const TEAM_NAME = { good: "好人", evil: "坏人" };
const MARKS = ["", "good", "evil", "merlin"];
const MARK_TEXT = { "": "标记", good: "好人", evil: "坏人", merlin: "梅林?" };
const ACTIVE = ["created", "running"];

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

const player = (s) => S.g?.players.find((p) => p.seat === +s);
const nameOf = (s) => player(s)?.name ?? "";
const seatColor = (s) => SEAT_COLORS[(s - 1) % SEAT_COLORS.length];
const seatsText = (arr) => (arr && arr.length ? [...arr].sort((a, b) => a - b).map((s) => `${s}号`).join("、") : "无");
const seatTag = (s) => `<b>${s}号</b>${player(s)?.is_human ? "（你）" : `「${esc(nameOf(s))}」`}`;

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
  $("#roles-preview").innerHTML =
    `本局角色：${tags}<br>任务人数：${preset.team_sizes.join(" / ")}${n >= 7 ? "（第4轮需2张失败）" : ""}`;
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
    enterGame(id);
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
  $("#game").classList.add("hidden");
  $("#setup").classList.remove("hidden");
  $("#setup-error").textContent = message;
  if ($("#modal").open) $("#modal").close();
}

// =====================================================================
// 对局
// =====================================================================
function enterGame(id) {
  clearTimeout(S.pollTimer);
  Object.assign(S, {
    gameId: id, g: null, events: [], lastId: 0, ended: false, endShown: false,
    selected: [], pendingKey: null, covered: false,
  });
  try { S.marks = JSON.parse(load("avalon.marks." + id) || "{}"); } catch { S.marks = {}; }
  store("avalon.game", id);
  $("#log").innerHTML = "";
  $("#action").innerHTML = "";
  document.body.classList.remove("show-thoughts");
  $("#show-thoughts").checked = false;
  $("#thoughts-toggle").hidden = true;
  $("#setup").classList.add("hidden");
  $("#game").classList.remove("hidden");
  poll();
}

async function poll() {
  clearTimeout(S.pollTimer);
  const id = S.gameId;
  if (!id) return;
  try {
    let st = await api(`/api/games/${id}/state?since=${S.lastId}`);
    if (id !== S.gameId) return;
    if (st.status === "ended" && !S.ended) {
      // 对局结束：重新拉取全部记录（含隐藏信息和 AI 内心独白）
      st = await api(`/api/games/${id}/state?since=0`);
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
      appendEvent(ev);
    }
    S.lastId = st.last_event_id;
    render();
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
}

function currentRejects() {
  const g = S.g;
  return S.events.filter((e) => e.type === "vote" && e.quest === g.quest_index && !e.approved).length;
}

function renderTracks() {
  const g = S.g;
  $("#quest-track").innerHTML = g.quests.map((q, i) => {
    let cls = "";
    if (q.success === true) cls = "success";
    else if (q.success === false) cls = "fail";
    else if (i === g.quest_index && ACTIVE.includes(g.status)) cls = "current";
    let title = `第${i + 1}轮：${q.size}人`;
    if (q.fails_needed === 2) title += "，需要2张失败才失败";
    if (q.success !== null) title += `；${q.success ? "成功" : "失败"}（${q.fails}张失败）`;
    return `<div class="quest ${cls}" title="${title}">${q.size}${q.fails_needed === 2 ? '<span class="two">2败</span>' : ""}</div>`;
  }).join("");
  const r = currentRejects();
  $("#reject-track").innerHTML = Array.from({ length: 5 }, (_, i) =>
    `<i class="${i < r ? "on" : ""} ${i === 4 ? "last" : ""}"></i>`).join("");
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
  return { x: 50 + 41 * Math.cos(theta), y: 50 + 37 * Math.sin(theta) };
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
  const seats = g.players.map((p) => {
    const cls = ["seat"];
    if (p.is_human) cls.push("me");
    if (team.includes(p.seat)) cls.push("on-team");
    if (sel) {
      if (sel.seats.includes(p.seat)) cls.push("selectable");
      else cls.push("dim");
      if (S.selected.includes(p.seat)) cls.push("selected");
    }
    if (g.thinking.includes(p.seat)) cls.push("thinking");
    const pos = seatPos(p.seat);
    const labels = [];
    if (p.role_name && (S.ended || !p.is_human)) {
      labels.push(`<span class="label ${p.team}">${p.role_name}</span>`);
    } else if (p.known) {
      labels.push(`<span class="label ${labelClass(p.known)}">${esc(p.known)}</span>`);
    }
    let chip = "";
    if (vote) {
      const v = vote.votes[String(p.seat)];
      chip = `<span class="vote-chip ${v ? "yes" : "no"}">${v ? "✓" : "✗"}</span>`;
    }
    const mark = S.marks[p.seat] || "";
    const markBtn = p.is_human || g.spectator ? "" : `<button class="mark" data-mark="${mark}" title="记下你对TA的判断（点击切换）">${MARK_TEXT[mark]}</button>`;
    const title = p.is_human ? "你" : `${p.name}：${p.persona}`;
    return `<div class="${cls.join(" ")}" data-seat="${p.seat}" style="left:${pos.x}%;top:${pos.y}%">
      <div class="avatar" style="background:${seatColor(p.seat)}" title="${esc(title)}">${p.seat}
        ${g.leader === p.seat && ACTIVE.includes(g.status) ? '<span class="crown" title="队长">👑</span>' : ""}
        ${g.lady_enabled && g.lady_holder === p.seat ? '<span class="lady" title="湖中仙女">🌊</span>' : ""}
        ${chip}
      </div>
      <div class="name">${esc(p.name)}${p.is_human ? "（你）" : ""}</div>
      <div class="labels">${labels.join("")}${markBtn}</div>
    </div>`;
  });
  const table = $("#table");
  table.querySelectorAll(".seat").forEach((el) => el.remove());
  table.insertAdjacentHTML("beforeend", seats.join(""));
  $("#table-center").innerHTML = centerText();
}

function centerText() {
  const g = S.g;
  if (g.status === "ended") {
    return `<div class="phase">${g.winner === "good" ? "好人" : "坏人"}阵营获胜</div><div>${esc(g.end_reason)}</div>`;
  }
  if (g.status === "error") return `<div class="phase">出错了</div><div>${esc(g.error)}</div>`;
  if (g.status === "cancelled") return `<div class="phase">对局已结束</div>`;
  const head = `第${g.quest_index + 1}轮任务 · 第${Math.max(1, g.attempt)}次提名`;
  const team = g.proposal ? `<div class="team">队伍：${seatsText(g.proposal)}</div>` : "";
  const phase = {
    setup: "准备中",
    propose: `队长 ${g.leader}号 正在组队`,
    discuss: "大家正在发言",
    vote: "投票中",
    quest: "任务进行中",
    lady: "湖中仙女查验中",
    assassinate: "刺杀阶段：坏人正在寻找梅林",
  }[g.phase] || "";
  if (g.phase === "assassinate") return `<div class="phase">刺杀阶段</div><div>坏人正在讨论谁是梅林</div>`;
  if (g.phase === "lady") return `<div class="phase">湖中仙女</div><div>${phase}</div>`;
  return `<div class="phase">${head}</div><div>${phase}</div>${team}`;
}

function renderIdentity() {
  const y = S.g.you;
  const box = $("#identity");
  if (!y) {
    box.className = "identity";
    box.innerHTML = S.g.spectator
      ? `<div class="role">👁 观战模式</div><p class="muted">上帝视角：所有身份公开，AI 的内心独白会实时出现在对局记录里。
         看看梅林怎么藏、刺客怎么找、坏人怎么配合。</p>`
      : "";
    return;
  }
  const know = y.knowledge.length
    ? y.knowledge.map((k) => `${k.seat}号（${esc(k.label)}）`).join("、")
    : "没有额外信息，全靠推理。";
  const tip = y.team === "evil" && y.role !== "oberon"
    ? `<p class="muted small">坏人默契：已知队友同车且只需1张失败时，由座位号最小的坏人出失败。</p>` : "";
  box.className = `identity ${y.team}${S.covered ? " covered" : ""}`;
  box.innerHTML = `
    <button class="ghost peek" id="btn-cover">${S.covered ? "显示" : "遮住"}</button>
    <div class="secret">
      <div class="role">你是 ${y.seat}号 · ${esc(y.role_name)}<span class="team">${TEAM_NAME[y.team]}阵营</span></div>
      <p class="muted">${esc(y.ability)}</p>
      <p>你知道：${know}</p>
      ${tip}
    </div>`;
  $("#btn-cover").onclick = () => { S.covered = !S.covered; renderIdentity(); };
}

function renderUsage() {
  const g = S.g;
  if (!g.llm) { $("#usage").textContent = "离线 AI"; return; }
  const u = g.usage;
  if (!u) return;
  const k = ((u.prompt_tokens + u.completion_tokens) / 1000).toFixed(1);
  $("#usage").textContent = `DeepSeek ${u.calls} 次 · ${k}k tokens`;
  $("#usage").title = `模型 ${u.model}；输入 ${u.prompt_tokens}（缓存命中 ${u.cache_hit_tokens}），输出 ${u.completion_tokens}；失败 ${u.errors} 次`;
}

// =====================================================================
// 行动栏
// =====================================================================
function attemptWarn() {
  const a = S.g.attempt;
  if (a >= 5) return `<div class="alert">⚠️ 本轮第5次提名：再被否决坏人直接获胜！</div>`;
  if (a === 4) return `<div class="alert">注意：本轮已经否决3次了。</div>`;
  return "";
}

const QUICK = ["这车我同意。", "这车我反对。", "我是好人，相信我。", "我觉得车上有问题。", "先过，听后面的。"];

const PANELS = {
  propose: (p) => `
    <div class="act-title">👑 你是队长：在圆桌上点选 <span class="em">${p.size}</span> 名队员（可以选自己）</div>
    ${attemptWarn()}
    <textarea id="act-speech" rows="2" maxlength="500" placeholder="说说你的组队理由（可选，Ctrl+Enter 提交）"></textarea>
    <div class="act-row"><span>已选：<b id="sel-list">无</b></span><span class="spacer"></span>
      <button class="primary" id="act-submit" disabled>确认发车</button></div>`,
  speak: (p) => `
    <div class="act-title">🎤 轮到你发言 · 队长 ${S.g.leader}号 提名：<span class="em">${seatsText(p.team)}</span></div>
    <div class="quick">${QUICK.map((q) => `<button type="button" data-quick="${esc(q)}">${esc(q)}</button>`).join("")}</div>
    <textarea id="act-speech" rows="2" maxlength="500" placeholder="你的发言（Ctrl+Enter 提交）"></textarea>
    <div class="act-row"><span class="spacer"></span>
      <button class="ghost" id="act-pass">过</button>
      <button class="primary" id="act-submit">发言</button></div>`,
  vote: (p) => `
    <div class="act-title">🗳 投票：队长 ${S.g.leader}号 提名 <span class="em">${seatsText(p.team)}</span></div>
    ${attemptWarn()}
    <div class="act-buttons">
      <button class="good" data-vote="1">✔ 赞成</button>
      <button class="evil" data-vote="0">✘ 反对</button>
    </div>`,
  quest: (p) => `
    <div class="act-title">⚔️ 你在任务队伍中，请秘密出牌${p.fails_needed === 2 ? "（本轮需要2张失败才失败）" : ""}</div>
    <div class="act-buttons">
      <button class="good" data-card="success">成功</button>
      <button class="evil" data-card="fail" ${p.can_fail ? "" : 'disabled title="好人只能出成功"'}>失败</button>
    </div>
    ${p.can_fail ? "" : '<p class="muted small">好人只能出成功。</p>'}`,
  lady_choose: (p) => `
    <div class="act-title">🌊 湖中仙女：选择一名玩家查验阵营（可选：${seatsText(p.candidates)}）</div>
    <div class="act-row"><span>已选：<b id="sel-list">无</b></span><span class="spacer"></span>
      <button class="primary" id="act-submit" disabled>查验</button></div>`,
  lady_announce: (p) => `
    <div class="act-title">🌊 查验结果（只有你知道）：${p.target}号是
      <span class="label ${p.result}">${TEAM_NAME[p.result]}</span></div>
    <div class="claim-row">公开宣布：
      <label class="check"><input type="radio" name="claim" value="good" ${p.result === "good" ? "checked" : ""}> 好人</label>
      <label class="check"><input type="radio" name="claim" value="evil" ${p.result === "evil" ? "checked" : ""}> 坏人</label>
      <label class="check"><input type="radio" name="claim" value="none"> 不公布</label>
    </div>
    <textarea id="act-speech" rows="2" maxlength="500" placeholder="说点什么（可以撒谎）"></textarea>
    <div class="act-row"><span class="spacer"></span><button class="primary" id="act-submit">公布</button></div>`,
  assassin_suggest: (p) => `
    <div class="act-title">🗡 刺杀讨论：你觉得谁是梅林？点选一人告诉刺客（可选：${seatsText(p.candidates)}）</div>
    <textarea id="act-speech" rows="2" maxlength="500" placeholder="说说你的理由"></textarea>
    <div class="act-row"><span>已选：<b id="sel-list">无</b></span><span class="spacer"></span>
      <button class="primary" id="act-submit" disabled>提出建议</button></div>`,
  assassinate: (p) => `
    <div class="act-title">🗡 你是刺客：刺中梅林就能翻盘！点选刺杀目标（可选：${seatsText(p.candidates)}）</div>
    <textarea id="act-speech" rows="2" maxlength="500" placeholder="刺杀前想说的话（可选）"></textarea>
    <div class="act-row"><span>已选：<b id="sel-list">无</b></span><span class="spacer"></span>
      <button class="evil" id="act-submit" disabled>刺杀！</button></div>`,
};

function renderAction() {
  const g = S.g;
  const box = $("#action");
  $("#btn-hint").disabled = g.status !== "running" || g.spectator;
  const p = g.pending;
  if (p) {
    const key = `p${p.id}`;
    if (S.pendingKey !== key) {
      S.pendingKey = key;
      S.selected = [];
      box.innerHTML = PANELS[p.type] ? PANELS[p.type](p) : "";
      bindAction(p);
      renderTable();
      const ta = $("#act-speech");
      if (ta && window.matchMedia("(min-width: 901px)").matches) ta.focus();
    }
    updateSelectionUI();
    return;
  }
  S.pendingKey = null;
  if (g.status === "ended") {
    box.innerHTML = `<div class="act-row" style="margin-top:0">
      <span class="act-title" style="margin:0">${g.winner === "good" ? "好人" : "坏人"}阵营获胜</span><span class="spacer"></span>
      <button class="ghost" id="act-summary">结算</button>
      <button class="primary" id="act-again">再来一局</button></div>`;
    $("#act-summary").onclick = showEndModal;
    $("#act-again").onclick = () => showSetup();
    return;
  }
  if (g.status === "error" || g.status === "cancelled") {
    box.innerHTML = `<div class="act-row" style="margin-top:0"><span>${g.status === "error" ? "对局出错：" + esc(g.error) : "对局已停止"}</span>
      <span class="spacer"></span><button class="primary" id="act-again">新游戏</button></div>`;
    $("#act-again").onclick = () => showSetup();
    return;
  }
  box.innerHTML = `<div class="waiting">${waitingText()}<span class="dots"></span></div>`;
}

function waitingText() {
  const g = S.g;
  const t = g.thinking;
  if (g.phase === "vote") return "等待其他玩家投票";
  if (g.phase === "quest") return "任务进行中，等待队员出牌";
  if (!t.length) return "请稍候";
  return t.map((s) => `${s}号「${esc(nameOf(s))}」`).join("、") + (g.phase === "propose" ? " 正在组队" : " 正在思考");
}

function updateSelectionUI() {
  const p = S.g.pending;
  const list = $("#sel-list");
  if (list) list.textContent = seatsText(S.selected);
  const btn = $("#act-submit");
  if (!btn || !p) return;
  if (p.type === "propose") btn.disabled = S.selected.length !== p.size;
  else if (["lady_choose", "assassin_suggest", "assassinate"].includes(p.type)) btn.disabled = S.selected.length !== 1;
}

function bindAction(p) {
  const box = $("#action");
  const speech = () => ($("#act-speech")?.value || "").trim();
  const submit = async (data, btn) => {
    box.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      await api(`/api/games/${S.gameId}/action`, { pending_id: p.id, ...data });
      S.selected = [];
      box.innerHTML = `<div class="waiting">已提交<span class="dots"></span></div>`;
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

// =====================================================================
// 对局记录
// =====================================================================
function thoughts(ev, seats) {
  if (!ev.thoughts) return "";
  return seats
    .filter((s) => ev.thoughts[String(s)])
    .map((s) => `<div class="thought"><b>💭 ${s}号「${esc(nameOf(s))}」：</b>${esc(ev.thoughts[String(s)])}</div>`)
    .join("");
}

function bubble(seat, text, tag = "") {
  const me = player(seat)?.is_human;
  const passed = !text;
  return `<div class="speech ${me ? "mine" : ""}">
    <div class="mini" style="background:${seatColor(seat)}">${seat}</div>
    <div class="bubble ${passed ? "passed" : ""}">
      <div class="who"><b>${seat}号 ${esc(nameOf(seat))}</b>${me ? "（你）" : ""}${tag}</div>
      ${passed ? "过" : esc(text)}
    </div></div>`;
}

const sys = (text, cls = "") => `<div class="ev ev-system ${cls}">${text}</div>`;

function eventHtml(ev) {
  const all = S.g.players.map((p) => p.seat);
  switch (ev.type) {
    case "start":
      return sys(`游戏开始！首任队长是 ${seatTag(ev.leader)}${ev.lady ? `，湖中仙女在 ${seatTag(ev.lady)} 手中` : ""}。`);
    case "quest_start":
      return `<div class="ev ev-divider">第${ev.quest + 1}轮任务 · ${ev.size}人${ev.fails_needed === 2 ? " · 需2张失败" : ""}</div>`;
    case "proposal":
      return `<div class="ev ev-proposal">👑 ${seatTag(ev.leader)} 第${ev.attempt}次提名：<b>${seatsText(ev.team)}</b></div>` + thoughts(ev, [ev.leader]);
    case "speech": {
      let tag = ev.leader ? " · 队长" : "";
      if (ev.suggest) tag += ` · 建议刺杀 ${ev.suggest}号`;
      if (ev.assassin) tag += " · 刺客";
      return `<div class="ev">${bubble(ev.seat, ev.text, tag)}</div>` + thoughts(ev, [ev.seat]);
    }
    case "vote": {
      const entries = Object.entries(ev.votes).map(([s, v]) => [+s, v]).sort((a, b) => a[0] - b[0]);
      const yes = entries.filter(([, v]) => v).length;
      const chips = entries.map(([s, v]) => `<span class="chip ${v ? "yes" : "no"}">${s}号 ${v ? "✓" : "✗"}</span>`).join("");
      return `<div class="ev ev-vote">🗳 投票 <span class="${ev.approved ? "verdict-yes" : "verdict-no"}">${ev.approved ? "通过" : "否决"}</span>
        （${yes} : ${entries.length - yes}）<div class="chips">${chips}</div></div>` + thoughts(ev, all);
    }
    case "quest_result": {
      let extra = "";
      if (ev.secret) {
        const fails = Object.entries(ev.secret.cards).filter(([, c]) => c === "fail").map(([s]) => +s);
        extra = ` · 出失败的是：${seatsText(fails)}`;
      }
      return `<div class="ev ev-quest ${ev.success ? "success" : "fail"}">任务${ev.success ? "成功 ✅" : "失败 ❌"}
        <span class="sub">队伍 ${seatsText(ev.team)} · ${ev.fails} 张失败牌 · 比分 ${ev.score[0]} : ${ev.score[1]}${extra}</span></div>` + thoughts(ev, ev.team);
    }
    case "lady_check":
      return sys(`🌊 ${seatTag(ev.holder)} 用湖中仙女查验了 ${seatTag(ev.target)}`) + thoughts(ev, [ev.holder]);
    case "lady_result": {
      const mine = player(ev.holder)?.is_human;
      return `<div class="ev ev-private">${mine ? "（仅你可见）" : `（真实结果，${ev.holder}号看到）`}${ev.target}号的阵营是 <b>${TEAM_NAME[ev.result]}</b></div>`;
    }
    case "lady_claim": {
      const claim = ev.claim ? TEAM_NAME[ev.claim] : "不公布";
      return `<div class="ev ev-proposal">🌊 ${seatTag(ev.holder)} 宣称 ${ev.target}号是 <b>${claim}</b></div>` +
        (ev.text ? `<div class="ev">${bubble(ev.holder, ev.text)}</div>` : "") + thoughts(ev, [ev.holder]);
    }
    case "evil_reveal":
      return `<div class="ev ev-divider">刺杀阶段</div>` +
        sys(`好人完成了3次任务！坏人亮明身份：<b>${seatsText(ev.evil)}</b>，刺客是 ${ev.assassin}号。坏人正在讨论谁是梅林……`);
    case "assassination":
      return `<div class="ev ev-quest ${ev.hit ? "fail" : "success"}">🗡 刺客 ${ev.assassin}号 刺杀了 ${ev.target}号
        <span class="sub">${ev.hit ? "刺中了梅林！" : "没有刺中梅林"}</span></div>` + thoughts(ev, [ev.assassin]);
    case "game_end":
      return `<div class="ev ev-end ${ev.winner}">${ev.winner === "good" ? "好人" : "坏人"}阵营获胜！<br><span class="small">${esc(ev.reason)}</span></div>`;
    case "system":
      return sys(esc(ev.text), ev.level === "warn" ? "warn" : "");
    default:
      return "";
  }
}

function appendEvent(ev) {
  const log = $("#log");
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  const html = eventHtml(ev);
  if (!html) return;
  log.insertAdjacentHTML("beforeend", html);
  if (nearBottom || !S.ended) log.scrollTop = log.scrollHeight;
}

$("#show-thoughts").addEventListener("change", (e) => {
  document.body.classList.toggle("show-thoughts", e.target.checked);
});

// =====================================================================
// 弹窗：教练 / 结算 / 复盘 / 规则
// =====================================================================
function openModal(title, html) {
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = html;
  const m = $("#modal");
  if (!m.open) m.showModal();
  $("#modal-body").scrollTop = 0;
}
$("#modal-close").onclick = () => $("#modal").close();
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") $("#modal").close(); });

$("#btn-hint").onclick = async () => {
  if (!S.gameId) return;
  const btn = $("#btn-hint");
  btn.disabled = true;
  openModal("💡 教练提示", `<div class="loading">教练正在看你的牌面和局势……</div>`);
  try {
    const r = await api(`/api/games/${S.gameId}/hint`, {});
    openModal("💡 教练提示", md(r.text) + `<p class="muted small">教练只使用你能看到的信息，不会偷看别人的身份。</p>`);
  } catch (err) {
    openModal("💡 教练提示", `<p class="error">${esc(err.message)}</p>`);
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
  const banner = me ? `${win ? "🎉 你赢了！" : "这局输了"}（${winner}）` : `🏁 ${winner}`;
  let markTotal = 0;
  let markRight = 0;
  const rows = g.players.map((p) => {
    const m = S.marks[p.seat] || "";
    let markCell = "";
    if (m) {
      const ok = m === "merlin" ? p.role === "merlin" : m === p.team;
      markTotal++;
      if (ok) markRight++;
      markCell = `${MARK_TEXT[m]} ${ok ? "✅" : "❌"}`;
    }
    const st = g.stats?.[String(p.seat)];
    const acc = st && st.votes ? Math.round((100 * st.correct) / st.votes) + "%" : "-";
    return `<tr${p.is_human ? ' style="color:var(--gold)"' : ""}>
      <td>${p.seat}号 ${esc(p.name)}${p.is_human ? "（你）" : ""}</td>
      <td><span class="label ${p.team}">${esc(p.role_name)}</span></td>
      <td>${p.team === "good" ? acc : "-"}</td>
      <td>${st && p.team === "good" ? st.proposals_with_evil + "/" + st.proposals : "-"}</td>
      ${me ? `<td>${markCell}</td>` : ""}</tr>`;
  }).join("");
  const myStats = me && g.stats?.[String(me.seat)];
  let markLine = "";
  if (me) {
    markLine = markTotal
      ? `<p>你的身份标记：标了 ${markTotal} 人，猜对 ${markRight} 人。</p>`
      : `<p class="muted small">小技巧：对局中点击座位下方的“标记”记录你的判断，结算时会告诉你猜对了几个。</p>`;
  }
  const html = `
    <div class="end-banner ${win || !me ? "win" : "lose"}">${banner}</div>
    <p style="text-align:center">${esc(g.end_reason)}</p>
    <h3>身份揭晓</h3>
    <table>
      <tr><th>玩家</th><th>身份</th><th title="赞成无坏人的车、反对有坏人的车算正确（仅统计好人）">投票正确率</th><th title="好人当队长时提名的队伍含坏人次数 / 当队长次数">含坏人的提名</th>${me ? "<th>你的标记</th>" : ""}</tr>
      ${rows}
    </table>
    ${markLine}
    ${myStats && me.team === "good" ? `<p>你作为好人：赞成含坏人的车 ${myStats.approve_evil} 次，反对干净的车 ${myStats.reject_clean} 次。</p>` : ""}
    <div class="end-actions">
      <button class="primary" id="end-review">🧑‍🏫 ${me ? "AI 教练复盘" : "AI 整局点评"}</button>
      <button id="end-thoughts">💭 查看 AI 内心独白</button>
      <button class="ghost" id="end-again">再来一局</button>
    </div>
    <div id="review-box"></div>`;
  openModal("对局结算", html);
  $("#end-review").onclick = loadReview;
  $("#end-thoughts").onclick = () => {
    $("#show-thoughts").checked = true;
    document.body.classList.add("show-thoughts");
    $("#modal").close();
    $("#log").scrollTop = 0;
  };
  $("#end-again").onclick = () => showSetup();
  if (g.review) $("#review-box").innerHTML = `<h3>AI 教练复盘</h3>` + md(g.review);
}

async function loadReview() {
  const box = $("#review-box");
  const btn = $("#end-review");
  btn.disabled = true;
  box.innerHTML = `<div class="loading">教练正在复盘整局（大约需要十几秒）……</div>`;
  box.scrollIntoView({ behavior: "smooth" });
  try {
    const r = await api(`/api/games/${S.gameId}/review`, {});
    if (S.g) S.g.review = r.text;
    box.innerHTML = `<h3>AI 教练复盘</h3>` + md(r.text);
  } catch (err) {
    box.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    btn.disabled = false;
  }
}

$("#btn-rules").onclick = () => {
  const n = S.g?.n || 7;
  const preset = S.config.presets[n];
  const roles = [...new Set(preset.roles)]
    .map((r) => `<li><b>${S.config.roles[r].name}</b>（${TEAM_NAME[S.config.roles[r].team]}）：${esc(S.config.roles[r].ability)}</li>`)
    .join("");
  openModal("规则速查", `
    <h3>流程</h3>
    <ol>
      <li>队长提名指定人数的队伍，其他人按顺序发言，然后所有人同时投票。</li>
      <li>赞成票<b>超过半数</b>才发车，否则队长交给下一位。同一轮<b>连续5次否决</b>，坏人直接获胜。</li>
      <li>队员秘密出牌：好人只能出成功，坏人可以出失败。出现失败牌任务就失败${n >= 7 ? "（本局第4轮需要2张失败）" : ""}。</li>
      <li>先赢3轮的阵营获胜；但好人赢下3轮后，刺客还可以刺杀梅林翻盘。</li>
    </ol>
    <h3>本局（${n}人）角色</h3>
    <ul>${roles}</ul>
    <p>任务人数：${preset.team_sizes.join(" / ")}</p>
    <h3>练习小贴士</h3>
    <ul>
      <li>任务失败后，记下车上的人和投赞成票的人——坏人常常支持有队友的车。</li>
      <li>反对“干净车”的人值得怀疑；第5次提名时乱投反对的人更值得怀疑。</li>
      <li>当梅林时别让票型太准；当刺客时找“票型最准、总能避开坏人”的人。</li>
      <li>点击座位下方的“标记”记下你的判断，结算时看看自己猜对了几个。</li>
    </ul>`);
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
