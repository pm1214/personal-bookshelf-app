/*
 * BookShelf Hub デモ v3 の画面スクリプト。
 * 巻の解釈・上限・抜け巻・まとめて入力・バックアップの検証は、すべて BSCore（src/demo/entry.ts）に任せる。
 * ここでは「表示」と「操作」と「保存」だけを扱う。
 *
 * データを失わないための決まり
 *   - 保存データが壊れていたら、別のキーに退避してから進む。退避できなければ保存を止める
 *   - 保存に失敗したら、画面上部に出し続ける（書き出しを促す）
 *   - 読み込みは検証に通ったものだけ。エラーがあれば今のデータは変えない
 *   - 読み込みで置き換える前のデータは bookshelf_hub_before_import に残す
 */
'use strict';
const C = window.BSCore;
const STORAGE_KEY = 'bookshelf_hub_v3';
const OLD_KEYS = ['bookshelf_hub_v2', 'bookshelf_hub_demo_v1'];
const BEFORE_IMPORT_KEY = 'bookshelf_hub_before_import';
const RESCUE_PREFIX = 'bookshelf_hub_rescue_';
const PALETTE = ['#E07B1F', '#2F86D1', '#D6457A', '#1E9C84', '#7E5BCB', '#5F6F86', '#9A6B3F', '#B8A000', '#3F9E3A', '#C2412D'];
const KINDS = ['漫画', 'ライトノベル', '一般書'];
const BIG_RANGE = 50; // これより多い巻をまとめて塗るときは確認する

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nfkc = (s) => String(s ?? '').normalize('NFKC').trim();
const $ = (sel) => document.querySelector(sel);

/* ============ 保存 ============ */
const storage = { failed: false, writeBlocked: false, rescued: null, migratedFrom: null, warnings: [] };

function lsGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function lsSet(k, v) {
  localStorage.setItem(k, v); // 失敗したら例外のまま呼び出し元へ
}

function seedData() {
  const v = (label, stores = [], extra = {}) => ({ label: String(label), stores, ...extra });
  const range = (a, b, f) => Array.from({ length: b - a + 1 }, (_, i) => f(a + i));
  const S = (title, kind, total, main, volumes) => ({ id: C.newId(), title, kind, total, main, note: '', sample: true, volumes });
  const r = C.validateBackup({
    version: 3,
    stores: C.DEFAULT_STORES,
    series: [
      S('作品A（サンプル）', '漫画', 18, 'kindle', [
        ...range(1, 10, (n) => v(n, ['kindle'], { read: n <= 12 })),
        ...range(11, 15, (n) => v(n, ['kobo'], { read: n <= 12 })),
        v(16, ['ebj']), v(18, ['kindle', 'kobo']),
      ]),
      S('作品B（サンプル）', 'ライトノベル', 12, '', [
        v(1, ['kindle']), v(2, ['kindle']), v(3, ['kobo']), v(4, ['ebj']), v('4.5', ['bw']), v(6, ['kindle']), v(7, ['kindle']), v(9, [], { planned: true }),
      ]),
      S('作品C（サンプル）', '漫画', 8, 'kobo', [v(1, ['kindle', 'kobo']), ...range(2, 8, (n) => v(n, ['kobo']))]),
      S('作品D（サンプル）', '一般書', 0, '', [v('上', ['paper']), v('下', [], { planned: true })]),
    ],
  });
  if (!r.ok) throw new Error('サンプルデータが不正です: ' + r.errors.join(', '));
  return r.data;
}

function load() {
  const raw = lsGet(STORAGE_KEY);
  if (raw !== null) {
    const r = C.parseBackupText(raw);
    if (r.ok) {
      storage.warnings = r.warnings;
      return r.data;
    }
    // 壊れている：上書きしないよう、まず別のキーに退避する
    const key = RESCUE_PREFIX + new Date().toISOString().replace(/[:.]/g, '-');
    try {
      lsSet(key, raw);
      storage.rescued = { key, errors: r.errors };
    } catch {
      storage.writeBlocked = true; // 退避できない＝今の保存データを上書きしてはいけない
      storage.rescued = { key: null, errors: r.errors };
    }
  }
  for (const k of OLD_KEYS) {
    const old = lsGet(k);
    if (old === null) continue;
    const r = C.parseBackupText(old);
    if (r.ok) {
      storage.migratedFrom = k; // 古いキーは消さずに残す
      storage.warnings = r.warnings;
      return r.data;
    }
  }
  return seedData();
}

function save() {
  if (storage.writeBlocked) {
    renderBanner();
    return false;
  }
  try {
    lsSet(STORAGE_KEY, JSON.stringify(data));
    if (storage.failed) {
      storage.failed = false;
      renderBanner();
    }
    return true;
  } catch {
    storage.failed = true;
    renderBanner();
    toast('保存できませんでした。設定から書き出してください');
    return false;
  }
}

function renderBanner() {
  const b = $('#banner');
  const parts = [];
  if (storage.writeBlocked) {
    parts.push('<b>保存を止めています。</b>前回の保存データを読めず、退避もできなかったため、上書きしないようにしています。設定の「バックアップ」から今の内容を書き出してください。');
  } else if (storage.failed) {
    parts.push('<b>保存できませんでした。</b>ブラウザの容量不足や、プライベートブラウズの可能性があります。設定から JSON を書き出して保管してください。');
  }
  if (storage.rescued && storage.rescued.key) {
    parts.push(`前回の保存データが壊れていたため、消さずに退避しました（${esc(storage.rescued.key)}）。設定の「退避したデータ」から確認できます。`);
  }
  b.hidden = !parts.length;
  b.innerHTML = parts.map((p) => `<div>${p}</div>`).join('') + (parts.length ? '<div class="actions"><button class="btn sm ghost" data-act="nav" data-view="settings">設定を開く</button></div>' : '');
}

/* ============ 状態 ============ */
let data = load();
const ui = { view: 'library', active: null, brush: 'kindle', range: false, anchor: null, query: '', kind: 'all', sort: 'recent', edit: false };
const undoStack = [];
function pushUndo() {
  undoStack.push(JSON.stringify(data));
  if (undoStack.length > 40) undoStack.shift();
}
function undo() {
  // 今と同じ内容の履歴（値の変わらなかった操作）は飛ばす
  const now = JSON.stringify(data);
  let prev = undoStack.pop();
  while (prev !== undefined && prev === now) prev = undoStack.pop();
  if (!prev) return toast('戻せる操作はありません');
  data = JSON.parse(prev);
  ui.anchor = null;
  save();
  render();
  toast('元に戻しました');
}

const storeById = (id) => data.stores.find((s) => s.id === id);
const seriesById = (id) => data.series.find((s) => s.id === id);
function replaceSeries(next) {
  const i = data.series.findIndex((s) => s.id === next.id);
  if (i >= 0) data.series[i] = next;
}
const stats = (s) => C.summarize(s);

/* ============ 描画 ============ */
function textOn(hex) {
  const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#1b1b22' : '#ffffff';
}
function volBg(v) {
  const cols = v.stores.map((id) => (storeById(id) || {}).color).filter(Boolean);
  if (!cols.length) return '';
  if (cols.length === 1) return `background:${cols[0]};color:${textOn(cols[0])}`;
  const step = 100 / cols.length;
  return `background:linear-gradient(135deg,${cols.map((c, i) => `${c} ${i * step}% ${(i + 1) * step}%`).join(',')});color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.45)`;
}
function stripHtml(s, st) {
  const gaps = new Set(st.missing.map((m) => m.label));
  return `<div class="strip" aria-hidden="true">${s.volumes.slice(0, 400).map((v) => {
    if (v.stores.length) return `<i style="background:${(storeById(v.stores[0]) || {}).color || 'var(--faint)'}"></i>`;
    if (v.planned) return '<i class="plan"></i>';
    if (gaps.has(v.label) && v.key.startsWith('n:')) return '<i class="gap"></i>';
    return '<i></i>';
  }).join('')}</div>`;
}

function setNav() {
  document.querySelectorAll('[data-act="nav"]').forEach((b) => {
    if (b.dataset.view === ui.view && !ui.active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  document.body.classList.toggle('detail', !!ui.active);
}

function render() {
  setNav();
  renderBanner();
  const m = $('#main');
  if (ui.active && seriesById(ui.active)) return renderDetail(m);
  ui.active = null;
  setNav();
  if (ui.view === 'settings') return renderSettings(m);
  if (ui.view === 'stores') return renderStores(m);
  return renderLibrary(m);
}

function renderLibrary(m) {
  const isMiss = ui.view === 'missing';
  let owned = 0, gaps = 0, planned = 0;
  for (const s of data.series) {
    const st = stats(s);
    owned += st.ownedCount;
    gaps += st.missing.length;
    planned += st.planned.length;
  }
  m.innerHTML = `
    <div class="head"><div>
      <div class="eyebrow">${isMiss ? 'Missing' : 'Library'}</div>
      <h1>${isMiss ? '抜け巻・購入予定' : 'マイ本棚'}</h1>
      <div class="muted">${isMiss ? '既刊数までで、どのストアでも持っていない巻です。' : 'ストアが違っても、巻ごとにまとめて管理。'}</div>
    </div><button class="btn" data-act="addSeries">＋ 作品を追加</button></div>
    <div class="stats">
      <div class="stat"><div class="v">${data.series.length}</div><div class="k">作品</div></div>
      <div class="stat"><div class="v">${owned}</div><div class="k">所持している巻</div></div>
      <div class="stat ${gaps ? 'alert' : ''}"><div class="v">${gaps}</div><div class="k">抜け巻</div></div>
      <div class="stat"><div class="v">${planned}</div><div class="k">購入予定</div></div>
    </div>
    <div class="tools">
      <input class="input" type="search" id="q" placeholder="作品名で絞り込む" value="${esc(ui.query)}" aria-label="作品名で絞り込む">
      <select class="input" id="kindFilter" aria-label="種類">
        <option value="all">すべての種類</option>${KINDS.map((k) => `<option ${ui.kind === k ? 'selected' : ''}>${k}</option>`).join('')}
      </select>
      <select class="input" id="sortSel" aria-label="並び順">
        <option value="recent" ${ui.sort === 'recent' ? 'selected' : ''}>追加順</option>
        <option value="title" ${ui.sort === 'title' ? 'selected' : ''}>作品名順</option>
        <option value="gaps" ${ui.sort === 'gaps' ? 'selected' : ''}>抜け巻が多い順</option>
      </select>
    </div>
    <div class="list" id="list"></div>
    ${storage.migratedFrom ? `<p class="msg ok">以前のデモのデータを新しい形式で読み込みました（元のデータも残しています）。</p>` : ''}
    ${storage.warnings.length ? `<p class="msg">読み込み時に直した点が ${storage.warnings.length} 件あります（設定で確認できます）。</p>` : ''}`;
  renderList();
}

function renderList() {
  const isMiss = ui.view === 'missing';
  const q = nfkc(ui.query).toLowerCase();
  let rows = data.series.map((s) => ({ s, st: stats(s) }))
    .filter(({ s, st }) => (!isMiss || st.missing.length || st.planned.length) && (ui.kind === 'all' || s.kind === ui.kind) && nfkc(s.title).toLowerCase().includes(q));
  if (ui.sort === 'title') rows.sort((a, b) => a.s.title.localeCompare(b.s.title, 'ja'));
  if (ui.sort === 'gaps') rows.sort((a, b) => b.st.missing.length - a.st.missing.length);
  if (ui.sort === 'recent') rows.reverse();
  const el = $('#list');
  if (!el) return;
  el.innerHTML = rows.length ? rows.map(({ s, st }) => `
    <button class="row" data-act="open" data-id="${esc(s.id)}">
      <div style="min-width:0"><div class="t">${esc(s.title)}${s.sample ? '<span class="sample">サンプル</span>' : ''}</div>
        <div class="meta">${esc(s.kind)}・${s.total ? `既刊 <span class="num">${s.total}</span> 巻` : '巻数指定なし'}${st.storesUsed.length ? '・' + st.storesUsed.map((id) => esc((storeById(id) || {}).name)).join(' / ') : ''}</div>
        ${isMiss ? `<div class="chips" style="margin-top:6px">${st.missing.slice(0, 60).map((m) => `<span class="chip" style="color:var(--danger)">${esc(m.label)}巻</span>`).join('')}${st.missing.length > 60 ? `<span class="chip">ほか${st.missing.length - 60}巻</span>` : ''}${st.planned.map((v) => `<span class="chip" style="color:var(--accent)">予定 ${esc(v.label)}</span>`).join('')}</div>` : ''}
      </div>
      <div class="right"><div class="num">${st.ownedCount}<span class="muted"> 巻所持</span></div>${st.missing.length ? `<div class="miss">抜け ${st.missing.length}</div>` : `<div class="muted">抜けなし</div>`}</div>
      ${stripHtml(s, st)}
    </button>`).join('')
    : `<div class="empty">${data.series.length ? (isMiss ? '抜け巻はありません。' : '条件に合う作品はありません。') : 'まだ作品がありません。「＋ 作品を追加」から登録してください。'}</div>`;
}

/* ---- 作品ページ ---- */
function brushList() {
  return [...data.stores.map((s) => ({ id: s.id, name: s.name, color: s.color })),
    { id: '_plan', name: '購入予定' }, { id: '_read', name: '既読' }, { id: '_erase', name: '消しゴム' }];
}
function brushObj(id) {
  if (id === '_plan') return { type: 'planned' };
  if (id === '_read') return { type: 'read' };
  if (id === '_erase') return { type: 'erase' };
  return { type: 'store', storeId: id };
}
function renderDetail(m) {
  const s = seriesById(ui.active);
  if (!brushList().some((b) => b.id === ui.brush)) ui.brush = data.stores[0] ? data.stores[0].id : '_plan';
  const L = C.LIMITS;
  m.innerHTML = `
    <button class="link back" data-act="close">← 本棚に戻る</button>
    <div class="head"><div style="min-width:0;max-width:100%">
      <div class="eyebrow">${esc(s.kind)}</div>
      ${ui.edit ? `<form class="form" id="titleForm"><input class="input" id="titleInput" value="${esc(s.title)}" maxlength="${L.maxTitleLength}" aria-label="作品名"><button class="btn sm">保存</button><button type="button" class="btn ghost sm" data-act="editTitle">やめる</button></form>`
        : `<h1>${esc(s.title)} <button class="link" style="font-size:13px" data-act="editTitle">名前を変更</button></h1>`}
      <div class="facts" id="facts"></div>
    </div></div>
    <div class="legend" id="legend"></div>
    <div class="grid" id="grid" role="group" aria-label="巻の一覧"></div>
    <div class="brushbar" role="toolbar" aria-label="ブラシ">
      <div class="brushes" id="brushes"></div>
      <div class="brushrow">
        <span id="hint" aria-live="polite"></span>
        <span style="display:flex;gap:6px">
          <button class="toggle" data-act="rangeMode" aria-pressed="${ui.range}">範囲</button>
          <button class="toggle" data-act="undo">元に戻す</button>
        </span>
      </div>
    </div>
    <div class="two">
      <section class="panel">
        <h2>まとめて入力</h2>
        <p class="muted">例：<code>1-10 kindle, 11-15 kobo, 18 kindle kobo, 19 予定</code><br>使える語：ストア名、<code>予定</code>、<code>既読</code>、<code>未購入</code>。巻番号は ${L.maxVolumeNumber} まで、1回で ${L.maxTargetsPerInput} 巻まで。</p>
        <form class="form" id="rangeForm"><input class="input" id="rangeText" placeholder="1-10 kindle, 11-15 kobo" autocomplete="off" maxlength="5000" aria-label="まとめて入力" aria-describedby="rangeMsg"><button class="btn">反映</button></form>
        <div class="msg" id="rangeMsg" aria-live="polite"></div>
      </section>
      <section class="panel">
        <h2>巻を追加</h2>
        <p class="muted">0巻、10.5巻、上・下、外伝、短編集など、番号どおりでない巻を足します。</p>
        <form class="form" id="volForm"><input class="input" id="volLabel" placeholder="例：10.5 / 上 / 外伝" maxlength="${L.maxLabelLength + 4}" aria-label="追加する巻" aria-describedby="volMsg"><button class="btn ghost">追加</button></form>
        <div class="msg" id="volMsg" aria-live="polite"></div>
      </section>
    </div>
    <section class="panel">
      <h2><label for="noteInput">メモ</label></h2>
      <textarea class="input notebox" id="noteInput" maxlength="${L.maxNoteLength}" placeholder="例：14巻から電子版に切り替え">${esc(s.note)}</textarea>
      <div class="counter" id="noteCount"></div>
      <div style="margin-top:12px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="muted">作品ごと消す</span><button class="btn danger sm" data-act="deleteSeries">この作品を削除</button>
      </div>
    </section>`;
  renderFacts();
  renderBrushes();
  renderGrid();
  updateNoteCount();
}
function updateNoteCount() {
  const el = $('#noteInput');
  if (el) $('#noteCount').textContent = `${[...el.value].length} / ${C.LIMITS.maxNoteLength}`;
}
function renderFacts() {
  const s = seriesById(ui.active), st = stats(s);
  $('#facts').innerHTML = `
    <label>既刊数 <input class="input num" type="number" id="totalInput" min="0" max="${C.LIMITS.maxKnownTotal}" step="1" value="${s.total}" inputmode="numeric"> 巻</label>
    <label>主に買うストア <select class="input" id="mainSel"><option value="">なし</option>${data.stores.map((x) => `<option value="${esc(x.id)}" ${s.main === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
    <span><span class="num">${st.ownedCount}</span> 巻所持・抜け <span class="num" style="color:${st.missing.length ? 'var(--danger)' : 'inherit'}">${st.missing.length}</span>・既読 <span class="num">${st.readCount}</span>${st.beyondKnownTotal.length ? `・既刊数より後ろに記録 <span class="num">${st.beyondKnownTotal.length}</span>巻` : ''}</span>`;
}
function renderBrushes() {
  const counts = {};
  for (const v of seriesById(ui.active).volumes) for (const id of v.stores) counts[id] = (counts[id] || 0) + 1;
  $('#brushes').innerHTML = brushList().map((b, i) => `
    <button class="brush" data-act="brush" data-id="${esc(b.id)}" aria-pressed="${ui.brush === b.id}">
      ${b.color ? `<span class="dot" style="background:${b.color}"></span>` : b.id === '_plan' ? '<span class="sw plan" style="width:11px;height:11px"></span>' : b.id === '_read' ? '✓' : '⌫'}
      ${esc(b.name)}${counts[b.id] ? ` <span class="num muted">${counts[b.id]}</span>` : ''}${i < 9 ? `<span class="k">${i + 1}</span>` : ''}
    </button>`).join('');
  const b = brushList().find((x) => x.id === ui.brush);
  const s = seriesById(ui.active);
  const anchor = ui.anchor && s.volumes.find((v) => v.id === ui.anchor);
  $('#hint').innerHTML = ui.range || anchor
    ? (anchor ? `<span class="rangebadge">${esc(anchor.label)}巻</span>から。終わりの巻をタップ（Esc で取り消し）` : '始まりの巻をタップ')
    : `タップで「${esc(b ? b.name : '')}」を付け外し・長押しで範囲`;
  document.querySelector('[data-act="rangeMode"]').setAttribute('aria-pressed', String(ui.range));
}
function renderGrid() {
  const s = seriesById(ui.active);
  const st = stats(s);
  const gap = new Set(st.missing.map((m) => m.volumeId).filter(Boolean));
  $('#grid').innerHTML = s.volumes.map((v) => {
    const cls = ['vol'];
    if (v.stores.length) cls.push('owned');
    else if (v.planned) cls.push('plan');
    else if (gap.has(v.id)) cls.push('gap');
    if (C.isCountedVolume(v) && v.sort > s.total) cls.push('beyond');
    if ([...v.label].length > 3) cls.push('small');
    if (v.id === ui.anchor) cls.push('anchor');
    const names = v.stores.map((id) => (storeById(id) || {}).name).join('・');
    const label = `${v.label}巻 ${names || (v.planned ? '購入予定' : '未購入')}${v.read ? '、既読' : ''}`;
    return `<button class="${cls.join(' ')}" data-act="vol" data-vid="${esc(v.id)}" style="${volBg(v)}" aria-label="${esc(label)}" title="${esc(label)}"><span class="lbl">${esc(v.label)}</span>${v.read ? '<span class="rd" aria-hidden="true">✓</span>' : ''}</button>`;
  }).join('') || '<div class="empty" style="grid-column:1/-1">巻がありません。既刊数を入れるか、「巻を追加」から足してください。</div>';
  const used = [...new Set(s.volumes.flatMap((v) => v.stores))];
  $('#legend').innerHTML = used.map((id) => { const x = storeById(id); return x ? `<span><i class="sw" style="background:${x.color};border-color:transparent"></i>${esc(x.name)}</span>` : ''; }).join('')
    + '<span><i class="sw gap"></i>抜け巻</span><span><i class="sw plan"></i>購入予定</span><span>✓ 既読</span>';
}
function refreshDetail() {
  renderFacts();
  renderBrushes();
  renderGrid();
}
/** 範囲選択中、マウスを乗せた巻までを先に見せる（誤操作を減らす） */
function previewRange(vid) {
  const s = seriesById(ui.active);
  if (!s || !ui.anchor) return;
  const a = s.volumes.findIndex((v) => v.id === ui.anchor), b = s.volumes.findIndex((v) => v.id === vid);
  const lo = Math.min(a, b), hi = Math.max(a, b);
  [...$('#grid').children].forEach((el, i) => el.classList.toggle('inrange', a >= 0 && b >= 0 && i >= lo && i <= hi));
}

/* ---- 塗る ---- */
function describe(vols, brushId, before, after) {
  const range = vols.length > 1 ? `${vols[0].label}〜${vols[vols.length - 1].label}巻（${vols.length}巻）` : `${vols[0].label}巻`;
  const name = (brushList().find((b) => b.id === brushId) || {}).name || '';
  const changed = after.filter((v, i) => JSON.stringify(v) !== JSON.stringify(before[i])).length;
  if (!changed) return `${range}：変更はありません`;
  if (brushId === '_erase') return `${range}を未購入にしました`;
  return `${range}の「${name}」を切り替えました`;
}
function paint(vols) {
  const s = seriesById(ui.active);
  pushUndo();
  const next = C.applyBrush(s, vols.map((v) => v.id), brushObj(ui.brush));
  const ids = new Set(vols.map((v) => v.id));
  const before = s.volumes.filter((v) => ids.has(v.id));
  const after = next.volumes.filter((v) => ids.has(v.id));
  replaceSeries(next);
  save();
  refreshDetail();
  toast(describe(vols, ui.brush, before, after), true);
}
function tapVolume(vid, shift) {
  const s = seriesById(ui.active);
  if (ui.range || shift || ui.anchor) {
    if (!ui.anchor) {
      ui.anchor = vid;
      renderBrushes();
      renderGrid();
      return;
    }
    const a = s.volumes.findIndex((v) => v.id === ui.anchor), b = s.volumes.findIndex((v) => v.id === vid);
    ui.anchor = null;
    const vols = s.volumes.slice(Math.min(a, b), Math.max(a, b) + 1);
    renderBrushes();
    if (vols.length > BIG_RANGE) {
      const name = (brushList().find((x) => x.id === ui.brush) || {}).name;
      renderGrid();
      return confirmBox(`${vols[0].label}〜${vols[vols.length - 1].label}巻（${vols.length}巻）に「${name}」を当てます。`, '当てる', () => paint(vols), false);
    }
    return paint(vols);
  }
  const v = s.volumes.find((x) => x.id === vid);
  if (v) paint([v]);
}

/* ---- ストア別 ---- */
function renderStores(m) {
  const per = data.stores.map((st) => {
    const list = data.series.map((s) => ({ s, n: s.volumes.filter((v) => v.stores.includes(st.id)).length })).filter((x) => x.n);
    return { st, list, total: list.reduce((a, x) => a + x.n, 0) };
  });
  const spread = data.series.map((s) => ({ s, k: stats(s).storesUsed.length })).filter((x) => x.k >= 3);
  m.innerHTML = `
    <div class="head"><div><div class="eyebrow">Stores</div><h1>ストア別</h1>
    <div class="muted">ストアごとに何冊持っているか。ストアの終了やアカウント移行の確認に。</div></div></div>
    ${spread.length ? `<section class="panel" style="margin:0 0 16px"><h2>3つ以上のストアに分かれている作品</h2><div class="chips">${spread.map((x) => `<button class="chip" style="border:0" data-act="open" data-id="${esc(x.s.id)}">${esc(x.s.title)}・${x.k}ストア</button>`).join('')}</div></section>` : ''}
    <div class="cards">${per.map(({ st, list, total }) => `
      <div class="storecard"><div class="hd"><span class="dot" style="background:${st.color}"></span>${esc(st.name)}<span class="num">${total}<span class="muted"> 巻</span></span></div>
      ${list.length ? `<ul>${list.map((x) => `<li><button data-act="open" data-id="${esc(x.s.id)}">${esc(x.s.title)}</button><span class="num muted">${x.n}</span></li>`).join('')}</ul>` : '<div class="muted" style="margin-top:6px">まだありません</div>'}
      </div>`).join('')}</div>`;
}

/* ---- 設定 ---- */
function rescueKeys() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith(RESCUE_PREFIX) || k === BEFORE_IMPORT_KEY || OLD_KEYS.includes(k))) out.push(k);
    }
  } catch { /* 読めない環境 */ }
  return out.sort();
}
function renderSettings(m) {
  const L = C.LIMITS;
  const saved = rescueKeys();
  m.innerHTML = `
    <div class="head"><div><div class="eyebrow">Settings</div><h1>設定・バックアップ</h1>
    <div class="muted">データはこのブラウザの中だけに保存されます。別の端末やブラウザとは同期しません。</div></div></div>
    <section class="panel" style="margin-top:0">
      <h2>ストア</h2>
      <p class="muted">色の四角を押すと色が変わります。「別名」はまとめて入力で使える呼び名です（カンマ区切り）。</p>
      <div class="storelist">${data.stores.map((st) => `
        <div class="storeitem">
          <button class="swbtn" style="background:${st.color}" data-act="storeColor" data-id="${esc(st.id)}" aria-label="${esc(st.name)}の色を変える"></button>
          <input class="input" data-store-name="${esc(st.id)}" value="${esc(st.name)}" maxlength="${L.maxStoreNameLength}" aria-label="ストア名">
          <input class="input" data-store-alias="${esc(st.id)}" value="${esc(st.alias.join(', '))}" placeholder="別名" aria-label="${esc(st.name)}の別名">
          <button class="btn ghost sm" data-act="storeDelete" data-id="${esc(st.id)}">削除</button>
        </div>`).join('')}</div>
      <form class="form" id="storeForm" style="margin-top:12px"><input class="input" id="newStore" placeholder="ストアを追加（例：Renta!）" maxlength="${L.maxStoreNameLength}" aria-label="追加するストア名"><button class="btn ghost">追加</button></form>
    </section>
    <section class="panel">
      <h2>バックアップ</h2>
      <p class="muted"><b>JSON</b>はすべての記録（メモ・既刊数・ストアの色や別名・特殊な巻番号を含む）を保存・復元できる完全バックアップです。ブラウザのデータを消すと記録も消えるので、ときどき書き出して保管してください。</p>
      <div class="form">
        <button class="btn" data-act="exportJson">JSONを書き出す</button>
        <button class="btn ghost" data-act="exportCsv">CSVを書き出す</button>
        <button class="btn ghost" data-act="pickFile">JSONファイルを読み込む</button>
        <input type="file" id="fileIn" accept="application/json,.json" hidden>
      </div>
      <p class="notice-csv">${esc(C.CSV_NOT_BACKUP_NOTICE)}</p>
      <p class="muted" style="margin:10px 0 6px">書き出した内容がここに出ます。ダウンロードできない環境では、コピーして保管してください。読み込むときは、ここに貼り付けて「貼り付けた内容を読み込む」を押します。</p>
      <textarea class="input" id="ioText" spellcheck="false" aria-label="書き出し・読み込み用のテキスト"></textarea>
      <div class="form" style="margin-top:8px"><button class="btn ghost sm" data-act="copyIo">コピー</button><button class="btn ghost sm" data-act="importText">貼り付けた内容を読み込む</button></div>
      <div class="msg" id="ioMsg" aria-live="polite"></div>
    </section>
    ${saved.length ? `<section class="panel">
      <h2>退避したデータ</h2>
      <p class="muted">読み込み前のデータ・壊れていた保存データ・以前の版のデータを、消さずに残しています。押すと上の欄に出すので、確認・保管できます。</p>
      <div class="chips">${saved.map((k) => `<button class="chip" style="border:0" data-act="showSaved" data-key="${esc(k)}">${esc(k)}</button>`).join('')}</div>
    </section>` : ''}
    ${storage.warnings.length ? `<section class="panel"><h2>前回の読み込みで直した点</h2><ul class="warnlist">${storage.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></section>` : ''}
    <section class="panel">
      <h2>サンプルに戻す</h2>
      <p class="muted">サンプルの4作品に戻します。今の記録は消えます（直前なら「元に戻す」で戻せます）。</p>
      <button class="btn danger" data-act="reset">サンプルに戻す</button>
    </section>
    <section class="panel">
      <h2>このデモでできないこと</h2>
      <p class="muted" style="margin:0">書籍の検索、新刊の自動取得と通知、アカウントでの同期、ストアの購入履歴の取り込みは未対応です。作品と既刊数は手入力です。</p>
    </section>`;
}
function tryDownload(text, name, type) {
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch { /* ダウンロードできない環境 */ }
}
function importText(text) {
  const msg = $('#ioMsg');
  const r = C.parseBackupText(text);
  if (!r.ok) {
    msg.className = 'msg err';
    msg.innerHTML = `読み込めませんでした。今の記録は変えていません。<ul class="errlist">${r.errors.slice(0, 50).map((e) => `<li>${esc(e)}</li>`).join('')}</ul>${r.errors.length > 50 ? `<div>ほか ${r.errors.length - 50} 件</div>` : ''}`;
    return;
  }
  const warn = r.warnings.length ? `直して読み込む点が ${r.warnings.length} 件あります：<ul class="warnlist">${r.warnings.slice(0, 30).map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '';
  confirmBox(`${r.data.series.length}作品を読み込み、今の記録と置き換えます。今の記録は「退避したデータ」に残します。`, '置き換える', () => {
    try {
      lsSet(BEFORE_IMPORT_KEY, JSON.stringify(data));
    } catch {
      return toast('今の記録を退避できなかったので、読み込みを中止しました');
    }
    pushUndo();
    data = r.data;
    storage.warnings = r.warnings;
    save();
    ui.view = 'library';
    ui.active = null;
    render();
    scrollTo(0, 0);
    toast(`${r.data.series.length}作品を読み込みました`, true);
  }, true, warn);
}

/* ============ モーダル・トースト ============ */
let toastTimer;
function toast(msg, withUndo) {
  $('#toastMsg').textContent = msg;
  $('#toastUndo').hidden = !withUndo;
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), withUndo ? 6000 : 2600);
}
let modalReturnFocus = null;
function openModal(html) {
  modalReturnFocus = document.activeElement;
  $('#modalRoot').innerHTML = html;
  for (const el of document.querySelectorAll('.app, nav.bottom, #toast')) el.setAttribute('inert', '');
  const first = $('#modalRoot').querySelector('[autofocus], input, select, textarea, button');
  if (first) first.focus();
}
function closeModal() {
  if (!$('#modalRoot').innerHTML) return;
  $('#modalRoot').innerHTML = '';
  for (const el of document.querySelectorAll('[inert]')) el.removeAttribute('inert');
  if (modalReturnFocus && document.contains(modalReturnFocus)) modalReturnFocus.focus();
  modalReturnFocus = null;
}
function confirmBox(text, okLabel, fn, danger = true, extraHtml = '') {
  openModal(`<div class="modalbg" data-act="modalBg"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="cfT" aria-describedby="cfD">
    <h2 id="cfT">確認</h2><p id="cfD" style="margin:0">${esc(text)}</p>${extraHtml}
    <div class="actions"><button class="btn ghost" data-act="modalClose">やめる</button><button class="btn ${danger ? 'danger' : ''}" id="cfOk">${esc(okLabel)}</button></div></div></div>`);
  $('#cfOk').onclick = () => { closeModal(); fn(); };
  $('#cfOk').focus();
}
function addSeriesModal() {
  const L = C.LIMITS;
  openModal(`<div class="modalbg" data-act="modalBg"><form class="modal" id="addForm" role="dialog" aria-modal="true" aria-labelledby="adT" novalidate>
    <h2 id="adT">作品を追加</h2>
    <label class="field">作品名<input class="input" id="newTitle" required maxlength="${L.maxTitleLength}" placeholder="例：作品E" autofocus></label>
    <label class="field">種類<select class="input" id="newKind">${KINDS.map((k) => `<option>${k}</option>`).join('')}</select></label>
    <label class="field">既刊数（巻数がない本は 0、最大 ${L.maxKnownTotal}）<input class="input num" type="number" id="newTotal" min="0" max="${L.maxKnownTotal}" step="1" value="10" required inputmode="numeric"></label>
    <label class="field">主に買うストア<select class="input" id="newMain"><option value="">なし</option>${data.stores.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label>
    <label class="check"><input type="checkbox" id="newFill"> 既刊すべてをこのストアで所持として登録する</label>
    <div class="msg err" id="addMsg" aria-live="polite"></div>
    <div class="actions"><button type="button" class="btn ghost" data-act="modalClose">やめる</button><button class="btn">追加する</button></div>
  </form></div>`);
  $('#addForm').onsubmit = (e) => {
    e.preventDefault();
    const r = C.newSeries({ title: $('#newTitle').value, kind: $('#newKind').value, total: $('#newTotal').value, main: $('#newMain').value, fillMain: $('#newFill').checked });
    if (!r.ok) {
      $('#addMsg').textContent = r.error;
      return;
    }
    if (data.series.length >= L.maxSeries) {
      $('#addMsg').textContent = `作品は${L.maxSeries}までです`;
      return;
    }
    pushUndo();
    data.series.push(r.value);
    save();
    closeModal();
    ui.active = r.value.id;
    ui.brush = r.value.main || ui.brush;
    ui.anchor = null;
    ui.edit = false;
    render();
    scrollTo(0, 0);
    toast('作品を追加しました', true);
  };
}

/* ============ イベント ============ */
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;
  if (act === 'modalBg') {
    if (e.target === t) closeModal();
    return;
  }
  switch (act) {
    case 'nav': ui.view = t.dataset.view; ui.active = null; ui.anchor = null; closeModal(); render(); scrollTo(0, 0); break;
    case 'open': {
      ui.active = t.dataset.id; ui.anchor = null; ui.edit = false;
      const s = seriesById(ui.active);
      if (s && s.main) ui.brush = s.main;
      render(); scrollTo(0, 0); break;
    }
    case 'close': ui.active = null; ui.anchor = null; render(); break;
    case 'addSeries': addSeriesModal(); break;
    case 'modalClose': closeModal(); break;
    case 'undo': undo(); break;
    case 'brush': ui.brush = t.dataset.id; renderBrushes(); break;
    case 'rangeMode': ui.range = !ui.range; ui.anchor = null; renderBrushes(); renderGrid(); break;
    case 'vol':
      if (suppressClick) { suppressClick = false; return; }
      tapVolume(t.dataset.vid, e.shiftKey); break;
    case 'editTitle': ui.edit = !ui.edit; renderDetail($('#main')); if (ui.edit) $('#titleInput').focus(); break;
    case 'deleteSeries': {
      const s = seriesById(ui.active);
      confirmBox(`「${s.title}」を削除します。`, '削除する', () => {
        pushUndo(); data.series = data.series.filter((x) => x.id !== s.id); ui.active = null; save(); render(); toast('削除しました', true);
      });
      break;
    }
    case 'storeColor': {
      const st = storeById(t.dataset.id); pushUndo();
      st.color = PALETTE[(PALETTE.indexOf(st.color) + 1) % PALETTE.length]; save(); t.style.background = st.color; break;
    }
    case 'storeDelete': {
      const st = storeById(t.dataset.id);
      const n = data.series.reduce((a, s) => a + s.volumes.filter((v) => v.stores.includes(st.id)).length, 0);
      if (data.stores.length <= 1) return toast('ストアは1つ以上必要です');
      const go = () => {
        pushUndo();
        data.stores = data.stores.filter((x) => x.id !== st.id);
        data.series.forEach((s) => { s.volumes.forEach((v) => { v.stores = v.stores.filter((x) => x !== st.id); }); if (s.main === st.id) s.main = ''; });
        save(); render(); toast(`${st.name}を削除しました`, true);
      };
      n ? confirmBox(`${st.name}を削除します。${n}巻ぶんの「${st.name}で所持」の記録も消えます。`, '削除する', go) : go();
      break;
    }
    case 'exportJson': {
      const txt = C.serializeBackup(data);
      $('#ioText').value = txt; tryDownload(txt, 'bookshelf-hub-backup.json', 'application/json');
      $('#ioMsg').className = 'msg ok'; $('#ioMsg').textContent = '書き出しました。ダウンロードされない場合は「コピー」で保管してください。'; break;
    }
    case 'exportCsv': {
      const txt = C.exportBackupCsv(data, { bom: false }); $('#ioText').value = txt; tryDownload('﻿' + txt, 'bookshelf-hub.csv', 'text/csv');
      $('#ioMsg').className = 'msg ok'; $('#ioMsg').textContent = 'CSVを書き出しました（1行＝1巻）。CSVは完全バックアップではありません。'; break;
    }
    case 'copyIo': {
      const ta = $('#ioText'); if (!ta.value) return;
      navigator.clipboard.writeText(ta.value).then(() => toast('コピーしました')).catch(() => { ta.focus(); ta.select(); toast('選択しました。コピーしてください'); });
      break;
    }
    case 'showSaved': {
      const v = lsGet(t.dataset.key);
      $('#ioText').value = v || '';
      $('#ioMsg').className = 'msg'; $('#ioMsg').textContent = v ? `${t.dataset.key} の内容を表示しました。読み込む場合は「貼り付けた内容を読み込む」。` : '読めませんでした。';
      break;
    }
    case 'pickFile': $('#fileIn').click(); break;
    case 'importText': importText($('#ioText').value); break;
    case 'reset': confirmBox('サンプルの4作品に戻します。今の記録は消えます。', 'サンプルに戻す', () => {
      pushUndo(); data = seedData(); save(); ui.view = 'library'; render(); toast('サンプルに戻しました', true);
    }); break;
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'q') { ui.query = e.target.value; renderList(); }
  if (e.target.id === 'noteInput') updateNoteCount();
});
document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.id === 'kindFilter') { ui.kind = t.value; renderList(); }
  if (t.id === 'sortSel') { ui.sort = t.value; renderList(); }
  if (t.id === 'totalInput') {
    const s = seriesById(ui.active);
    const r = C.setKnownTotal(s, t.value);
    if (!r.ok) { t.value = s.total; return toast(r.error); }
    if (r.value.total === s.total) return; // 値が変わらない change（フォーカスが外れただけなど）は何もしない
    pushUndo();
    const before = s.total;
    replaceSeries(r.value);
    save(); refreshDetail();
    const kept = C.summarize(r.value).beyondKnownTotal.length;
    toast(`既刊数を${before}→${r.value.total}巻にしました${kept ? `。後ろの${kept}巻は記録があるので残しています` : ''}`, true);
  }
  if (t.id === 'mainSel') { const s = seriesById(ui.active); if (s.main === t.value) return; pushUndo(); s.main = t.value; save(); }
  if (t.id === 'noteInput') {
    const s = seriesById(ui.active);
    const v = t.value.normalize('NFKC');
    if ([...v].length > C.LIMITS.maxNoteLength) return toast(`メモは${C.LIMITS.maxNoteLength}文字までです`);
    if (v === s.note) return;
    pushUndo(); s.note = v; save(); toast('メモを保存しました');
  }
  if (t.dataset.storeName) {
    const st = storeById(t.dataset.storeName); const v = nfkc(t.value);
    if (!v || [...v].length > C.LIMITS.maxStoreNameLength) { t.value = st.name; return toast('ストア名を確認してください'); }
    if (data.stores.some((x) => x !== st && x.name === v)) { t.value = st.name; return toast('同じ名前のストアがあります'); }
    pushUndo(); st.name = v; save();
  }
  if (t.dataset.storeAlias) {
    const st = storeById(t.dataset.storeAlias); pushUndo();
    st.alias = nfkc(t.value).split(/[,、]/).map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 10); save();
  }
  if (t.id === 'fileIn' && t.files[0]) {
    if (t.files[0].size > 15 * 1024 * 1024) { t.value = ''; return toast('ファイルが大きすぎます（15MBまで）'); }
    const txt = await t.files[0].text(); $('#ioText').value = txt; importText(txt); t.value = '';
  }
});
document.addEventListener('submit', (e) => {
  const f = e.target;
  if (f.id === 'rangeForm') {
    e.preventDefault();
    const s = seriesById(ui.active);
    const r = C.applyRangeText(data, s, $('#rangeText').value);
    const msg = $('#rangeMsg');
    if (!r.ok) {
      msg.className = 'msg err';
      msg.textContent = '反映していません：\n' + r.errors.join('\n');
      return;
    }
    pushUndo(); replaceSeries(r.value); save(); refreshDetail();
    msg.className = 'msg ok'; msg.textContent = '反映しました。'; $('#rangeText').value = '';
    toast(`${r.touched}巻ぶん反映しました${r.created ? `（${r.created}巻を新しく追加）` : ''}`, true);
  }
  if (f.id === 'volForm') {
    e.preventDefault();
    const s = seriesById(ui.active);
    const r = C.addVolume(s, $('#volLabel').value);
    const msg = $('#volMsg');
    if (!r.ok) { msg.className = 'msg err'; msg.textContent = r.error; return; }
    pushUndo(); replaceSeries(r.value); save(); refreshDetail();
    $('#volLabel').value = ''; msg.className = 'msg ok'; msg.textContent = '追加しました。';
  }
  if (f.id === 'titleForm') {
    e.preventDefault();
    const v = nfkc($('#titleInput').value);
    if (v && [...v].length <= C.LIMITS.maxTitleLength) { pushUndo(); seriesById(ui.active).title = v; save(); }
    ui.edit = false; renderDetail($('#main'));
  }
  if (f.id === 'storeForm') {
    e.preventDefault();
    const name = nfkc($('#newStore').value);
    if (!name) return;
    if ([...name].length > C.LIMITS.maxStoreNameLength) return toast(`ストア名は${C.LIMITS.maxStoreNameLength}文字までです`);
    if (data.stores.length >= C.LIMITS.maxStores) return toast(`ストアは${C.LIMITS.maxStores}までです`);
    if (data.stores.some((s) => s.name === name)) return toast('同じ名前のストアがあります');
    pushUndo(); data.stores.push({ id: 's' + C.newId(), name, color: PALETTE[data.stores.length % PALETTE.length], alias: [] }); save(); render(); toast(`${name}を追加しました`);
  }
});

/* 長押しで範囲の始点（スマホ） */
let pressTimer = null, suppressClick = false, pressStart = null;
document.addEventListener('pointerdown', (e) => {
  const t = e.target.closest('.vol');
  if (!t) return;
  clearTimeout(pressTimer);
  pressStart = { x: e.clientX, y: e.clientY };
  pressTimer = setTimeout(() => {
    suppressClick = true;
    ui.anchor = t.dataset.vid;
    renderBrushes();
    renderGrid();
    if (navigator.vibrate) try { navigator.vibrate(15); } catch { /* 無視 */ }
    toast('始まりの巻を選びました。終わりの巻をタップしてください');
  }, 450);
});
['pointerup', 'pointercancel'].forEach((ev) => document.addEventListener(ev, () => clearTimeout(pressTimer)));
document.addEventListener('pointermove', (e) => {
  if (pressStart && (e.clientX - pressStart.x) ** 2 + (e.clientY - pressStart.y) ** 2 > 100) clearTimeout(pressTimer); // スクロールなら長押しにしない
});
document.addEventListener('pointerover', (e) => {
  const t = e.target.closest && e.target.closest('.vol');
  if (t && ui.anchor) previewRange(t.dataset.vid);
});
document.addEventListener('contextmenu', (e) => { if (e.target.closest('.vol')) e.preventDefault(); });

/* キーボード：数字でブラシ、Esc で範囲解除・モーダルを閉じる、Ctrl/⌘+Z で元に戻す、モーダル内の Tab を閉じ込める */
document.addEventListener('keydown', (e) => {
  const modal = $('#modalRoot .modal');
  if (modal) {
    if (e.key === 'Escape') { e.preventDefault(); return closeModal(); }
    if (e.key === 'Tab') {
      const items = [...modal.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    return;
  }
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); undo(); return; }
  if (e.key === 'Escape') { if (ui.anchor) { ui.anchor = null; renderBrushes(); renderGrid(); } return; }
  if (!ui.active || typing) return;
  const n = Number(e.key);
  if (n >= 1 && n <= 9) { const b = brushList()[n - 1]; if (b) { ui.brush = b.id; renderBrushes(); } }
});

if (!storage.writeBlocked && (storage.migratedFrom || lsGet(STORAGE_KEY) === null)) save();
render();
