"use strict";

// =====================================================================
// 美术：纹章盾牌、图标、角色徽记（全部内联 SVG，没有任何外部资源）
// =====================================================================
const ART = (() => {
  const SHIELD = "M6 5Q32 0 58 5V33C58 52 46 64 32 70C18 64 6 52 6 33Z";

  // 每个座位一种纹章底色（红、蓝、绿、紫、金、橙、桑椹、黑、青、灰）
  const TINCT = ["#a8262b", "#22508f", "#2c6b3f", "#6b3b8c", "#8c6a1c", "#a3521b", "#7d2148", "#38332d", "#1d6b73", "#4f5d75"];
  // 每个座位一种纹章分割图案（头带、竖分、斜带、人字、横分、斜十字、十字、竖带、四分、反斜分）
  const ORD = [
    "M0 0H64V21H0Z",
    "M32 0H64V74H32Z",
    "M-6 9L9 -6L72 57L57 72Z",
    "M0 50L32 25L64 50V63L32 38L0 63Z",
    "M0 37H64V74H0Z",
    "M-6 7L7 -6L72 62L59 75ZM72 7L59 -6L-6 62L7 75Z",
    "M26.5 0H37.5V74H26.5ZM0 23H64V34H0Z",
    "M23 0H41V74H23Z",
    "M0 0H32V37H0ZM32 37H64V74H32Z",
    "M64 0V74H0Z",
  ];
  const color = (seat) => TINCT[(seat - 1) % TINCT.length];

  function shield(seat, cls = "shield") {
    // seat 为 0：未定座位的素面盾（羊皮纸底 + 金边），用于开局预览里“随机座位”的你
    if (!seat) {
      return `<svg class="${cls}" viewBox="0 0 64 74" aria-hidden="true" focusable="false">` +
        `<g clip-path="url(#clip-shield)"><rect width="64" height="74" fill="#efe1bd"/>` +
        `<path d="M0 37H64V74H0Z" fill="#8a6a24" fill-opacity=".14"/>` +
        `<rect width="64" height="74" fill="url(#g-shine)"/></g>` +
        `<path class="rim" d="${SHIELD}" fill="none" stroke="url(#g-gold)" stroke-width="3.2"/></svg>`;
    }
    const i = (seat - 1) % 10;
    const dark = i === 7;
    return `<svg class="${cls}" viewBox="0 0 64 74" aria-hidden="true" focusable="false">` +
      `<g clip-path="url(#clip-shield)"><rect width="64" height="74" fill="${color(seat)}"/>` +
      `<path d="${ORD[i]}" fill="${dark ? "#fff" : "#000"}" fill-opacity="${dark ? ".13" : ".22"}"/>` +
      `<rect width="64" height="74" fill="url(#g-shine)"/></g>` +
      `<path class="rim" d="${SHIELD}" fill="none" stroke="url(#g-gold)" stroke-width="3.2"/></svg>`;
  }

  // 24×24 单色图标（currentColor）
  const I = {
    crown: '<path d="M3 17.5 2 6.5l5.4 4.3L12 3.5l4.6 7.3L22 6.5l-1 11z" fill="currentColor"/><rect x="3" y="18.6" width="18" height="2.6" rx="1" fill="currentColor"/>',
    quill: '<path d="M21 2.5C12.5 3.5 7 9 5 17.2l-1.6 4 1.4.6 1.8-3.8C13 17 18.6 11 21 2.5z" fill="currentColor"/><path d="M8 16.5 15.5 8" stroke="rgba(0,0,0,.35)" stroke-width="1.2" fill="none"/>',
    ballot: '<rect x="3.5" y="11" width="17" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7.5 13V3h9v10" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9.6 7.8l1.8 1.8 3.3-3.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    swords: '<g fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M4 4l11.5 11.5M20 4 8.5 15.5"/><path d="M13.3 18.7l5.4-5.4M5.3 13.3l5.4 5.4"/><path d="M17 17l3 3M7 17l-3 3"/></g>',
    waves: '<path d="M2.5 9c2-2 4-2 6 0s4 2 6 0 4-2 6.5 0M2.5 15c2-2 4-2 6 0s4 2 6 0 4-2 6.5 0" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/>',
    dagger: '<path d="M12 1.5l2.2 3.6v9.6H9.8V5.1z" fill="currentColor"/><rect x="6.2" y="14.6" width="11.6" height="2.4" rx="1.2" fill="currentColor"/><rect x="11" y="17" width="2" height="3.8" fill="currentColor"/><circle cx="12" cy="21.6" r="1.5" fill="currentColor"/>',
    eye: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.3" fill="currentColor"/>',
    thought: '<path d="M7.2 16.5a4 4 0 0 1-.7-7.9 5.2 5.2 0 0 1 9.8-1.5 4.1 4.1 0 0 1 .9 8.1c-.4 1-1.3 1.3-2 1.3z" fill="currentColor"/><circle cx="6.2" cy="19.6" r="1.6" fill="currentColor"/><circle cx="3.4" cy="22" r="1" fill="currentColor"/>',
    candle: '<path d="M12 1.8c1.9 2.3 2.4 4 0 6.3-2.4-2.3-1.9-4 0-6.3z" fill="currentColor"/><rect x="9" y="9" width="6" height="10" rx="1.2" fill="currentColor"/><path d="M4.5 19.6h15a1.6 1.6 0 0 1 0 3.2h-15a1.6 1.6 0 0 1 0-3.2z" fill="currentColor"/>',
    check: '<path d="M4.5 12.5l4.8 4.8L19.5 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>',
    cross: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
    chalice: '<path d="M5.5 2.5h13c0 6-2.9 9.6-6.5 9.6S5.5 8.5 5.5 2.5z" fill="currentColor"/><rect x="11" y="11.5" width="2" height="5.5" fill="currentColor"/><path d="M7 21.5c0-2.6 2.2-4 5-4s5 1.4 5 4z" fill="currentColor"/>',
    warn: '<path d="M12 2.5 22.5 21h-21z" fill="currentColor"/><path d="M12 9.2v5.4" stroke="#24170e" stroke-width="2.3" stroke-linecap="round"/><circle cx="12" cy="17.7" r="1.35" fill="#24170e"/>',
    scroll: '<path d="M6 3.5h11.5a2.5 2.5 0 0 1 0 5H16v10a2.5 2.5 0 0 1-2.5 2.5H5a2.5 2.5 0 0 1 0-5h1.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 8.5h4M9 12h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  };
  function icon(name, cls = "ic") {
    return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${I[name] || ""}</svg>`;
  }

  // 48×48 角色徽记（金色主体 currentColor，镂空用 .cut 跟随卡面底色）
  const R = {
    merlin: '<path d="M9 38.5h30c2.4 0 2.6 3.6 0 4H9c-2.6-.4-2.4-4 0-4z" fill="currentColor"/><path d="M13.5 38 22.6 9.5c.9-2.8 4-3.4 5.6-.8l2.2 3.4-3.4 1.6L34.5 38z" fill="currentColor"/><path class="cut" d="M22.5 24.5l1.3 2.7 2.9.4-2.1 2 .5 2.9-2.6-1.4-2.6 1.4.5-2.9-2.1-2 2.9-.4z"/><circle class="cut" cx="27.3" cy="17.5" r="1.7"/><path d="M39 7l.9 2 2.1.3-1.5 1.5.4 2.1-1.9-1-1.9 1 .4-2.1-1.5-1.5 2.1-.3z" fill="currentColor"/><circle cx="8" cy="15" r="1.4" fill="currentColor"/><circle cx="41" cy="26" r="1.1" fill="currentColor"/>',
    percival: '<path d="M11 6h26c0 11.5-5.6 18.5-13 18.5S11 17.5 11 6z" fill="currentColor"/><path class="cut" d="M15.5 9.5h17c-.6 6.5-4 10.8-8.5 10.8s-7.9-4.3-8.5-10.8z" opacity=".55"/><rect x="21.8" y="24" width="4.4" height="10" fill="currentColor"/><path d="M14 42c0-4.8 4.5-7.5 10-7.5s10 2.7 10 7.5z" fill="currentColor"/><g stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M24 1.5v2.5M6 4l2 1.6M42 4l-2 1.6"/></g>',
    servant: '<path d="M9 6.5h30v15c0 11.5-7.8 17.6-15 20.6-7.2-3-15-9.1-15-20.6z" fill="currentColor"/><path class="cut" d="M12.5 10h23v11.6c0 9-6 14.2-11.5 16.8-5.5-2.6-11.5-7.8-11.5-16.8z"/><path d="M24 12.5v23M15.5 21h17" stroke="currentColor" stroke-width="3.6" stroke-linecap="round"/>',
    assassin: '<path d="M24 2.5l4.3 6.6v19.2h-8.6V9.1z" fill="currentColor"/><path class="cut" d="M23.3 9.5h1.4v17h-1.4z" opacity=".6"/><rect x="12.5" y="28" width="23" height="4.4" rx="2.2" fill="currentColor"/><rect x="21.8" y="32.4" width="4.4" height="8" fill="currentColor"/><circle cx="24" cy="43" r="3.2" fill="currentColor"/>',
    morgana: '<path d="M29 5.5A19 19 0 1 0 43 35 15.5 15.5 0 0 1 29 5.5z" fill="currentColor"/><path d="M33 14.5l1.3 3 3.2.4-2.4 2.2.7 3.2-2.8-1.6-2.8 1.6.7-3.2-2.4-2.2 3.2-.4z" fill="currentColor"/><circle cx="40" cy="9" r="1.4" fill="currentColor"/>',
    mordred: '<path d="M6 35 3.5 12.5l9.5 8.5 5.4-12.5L24 19.5l5.6-11 5.4 12.5 9.5-8.5L42 35z" fill="currentColor"/><rect x="5.5" y="36.5" width="37" height="5.5" rx="1.6" fill="currentColor"/><circle class="cut" cx="24" cy="29" r="2.6"/><circle class="cut" cx="14" cy="30" r="1.8"/><circle class="cut" cx="34" cy="30" r="1.8"/>',
    oberon: '<path d="M4.5 15.5c7.5-5.6 31.5-5.6 39 0-.6 11.6-6.4 17.6-12.6 15.6-3.2-1.1-4.6-5.3-6.9-5.3s-3.7 4.2-6.9 5.3C10.9 33.1 5.1 27.1 4.5 15.5z" fill="currentColor"/><ellipse class="cut" cx="15.5" cy="19.5" rx="4.4" ry="2.8"/><ellipse class="cut" cx="32.5" cy="19.5" rx="4.4" ry="2.8"/><path d="M24 31v12" stroke="currentColor" stroke-width="2" stroke-dasharray="2 2.4"/>',
    minion: '<g fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"><path d="M8 8l23 23M40 8 17 31"/><path d="M26.5 37.5l11-11M10.5 26.5l11 11"/><path d="M34 34l6 6M14 34l-6 6"/></g>',
  };
  function role(key, cls = "emblem") {
    return `<svg class="${cls}" viewBox="0 0 48 48" aria-hidden="true" focusable="false">${R[key] || R.servant}</svg>`;
  }

  // 圆桌 + 王者之剑徽章（品牌标志）
  function crest() {
    let spokes = "";
    for (let k = 0; k < 12; k++) {
      const a = (k * Math.PI) / 6;
      const c = Math.cos(a), s = Math.sin(a);
      spokes += `M${(40 + 9 * c).toFixed(2)} ${(42 + 9 * s).toFixed(2)}L${(40 + 23 * c).toFixed(2)} ${(42 + 23 * s).toFixed(2)}`;
    }
    return `<svg viewBox="0 0 80 84" aria-hidden="true" focusable="false">
      <circle cx="40" cy="42" r="31" fill="#5a3720" stroke="#c9a24a" stroke-width="2.6"/>
      <circle cx="40" cy="42" r="27" fill="none" stroke="#2a180c" stroke-width="1.4"/>
      <path d="${spokes}" stroke="#c9a24a" stroke-width="1.1" opacity=".65"/>
      <circle cx="40" cy="42" r="23" fill="none" stroke="#c9a24a" stroke-width="1" opacity=".8"/>
      <circle cx="40" cy="42" r="8" fill="#9e1b2a" stroke="#e3c374" stroke-width="1.4"/>
      <path d="M40 2.5l3.4 7.5v44h-6.8V10z" fill="#ece6d6" stroke="#4a3622" stroke-width="1"/>
      <path d="M40 9v42" stroke="#9c9583" stroke-width="1"/>
      <rect x="25.5" y="53.5" width="29" height="5" rx="2.5" fill="#d9b45a" stroke="#5a3d10" stroke-width="1"/>
      <rect x="37.4" y="58.5" width="5.2" height="13" rx="1.2" fill="#6b4423" stroke="#2a180c" stroke-width=".8"/>
      <circle cx="40" cy="76" r="4" fill="#d9b45a" stroke="#5a3d10" stroke-width="1"/>
    </svg>`;
  }

  const crownBadge = () =>
    `<svg viewBox="0 0 32 24" aria-hidden="true" focusable="false"><path d="M3.5 19.5 1.5 6.5l7.6 6L16 2.5l6.9 10 7.6-6-2 13z" fill="url(#g-gold)" stroke="#4a3010" stroke-width="1.2" stroke-linejoin="round"/><rect x="3.4" y="18.6" width="25.2" height="4" rx="1.2" fill="#b8902f" stroke="#4a3010" stroke-width="1"/><circle cx="16" cy="2.8" r="1.9" fill="#d4464b" stroke="#4a3010" stroke-width=".6"/><circle cx="1.8" cy="6.4" r="1.5" fill="#f6e2a2"/><circle cx="30.2" cy="6.4" r="1.5" fill="#f6e2a2"/><circle cx="16" cy="14" r="1.8" fill="#4f86d0" stroke="#4a3010" stroke-width=".5"/></svg>`;
  const ladyBadge = () =>
    `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10.6" fill="#1b5874" stroke="url(#g-gold)" stroke-width="1.8"/><path d="M5.2 10.4c1.7-1.7 3.4-1.7 5.1 0s3.4 1.7 5.1 0 2.6-1.4 3.4-.6M5.2 14.6c1.7-1.7 3.4-1.7 5.1 0s3.4 1.7 5.1 0 2.6-1.4 3.4-.6" fill="none" stroke="#d6eef8" stroke-width="1.6" stroke-linecap="round"/></svg>`;

  return { color, shield, icon, role, crest, crownBadge, ladyBadge };
})();

// 页面静态位置的美术（品牌徽章、教练蜡烛）
document.querySelectorAll("[data-art]").forEach((el) => {
  const k = el.dataset.art;
  el.innerHTML = k === "crest" ? ART.crest() : k === "lady" ? ART.ladyBadge() : ART.icon(k);
});
