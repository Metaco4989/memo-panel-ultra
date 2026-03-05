// ==UserScript==
// @name         Memo Panel Ultra – ChatGPTメモ管理パネル
// @namespace    https://github.com/metaco4989/memo-panel-ultra
// @version      5.1.1
// @description  ブラウザ常駐メモ。タイトル/タグ/フォルダ/検索履歴/Markdownプレビュー/Excel&CSV/ChatGPT→Memo(会話タイトル自動取得)/ピン留め/フォルダ別エクスポート/ドラッグ救済/最小化ミニバー
// @author       metaco4989
// @match        *://*/*
// @updateURL    https://raw.githubusercontent.com/metaco4989/memo-panel-ultra/main/memo-panel-ultra.user.js
// @downloadURL  https://raw.githubusercontent.com/metaco4989/memo-panel-ultra/main/memo-panel-ultra.user.js
// @require      https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// ==/UserScript==

(() => {
  'use strict';
  // Firefoxの about:newtab / about:home には注入できない（仕様）

  // ===== Storage (GM preferred) =====
  const hasGM = (typeof GM_getValue === 'function') && (typeof GM_setValue === 'function');
  const store = {
    get(key, def = null) {
      try {
        if (hasGM) {
          const v = GM_getValue(key);
          return (v === undefined) ? def : v;
        }
        const v = localStorage.getItem(key);
        return (v === null) ? def : v;
      } catch { return def; }
    },
    set(key, val) {
      if (hasGM) return GM_setValue(key, val);
      return localStorage.setItem(key, String(val));
    },
    del(key) {
      if (hasGM && typeof GM_deleteValue === 'function') return GM_deleteValue(key);
      return localStorage.removeItem(key);
    }
  };

  // ===== Keys / State =====
  const APP_STATE_KEY = 'pekun_memo_ultra_v5_state';
  const MEMO_SITE_KEY = () => `pekun_memo_ultra_v5_site:${location.hostname}`;
  const MEMO_GLOBAL_KEY = 'pekun_memo_ultra_v5_global';
  const FOLDERS_KEY = 'pekun_memo_ultra_v5_folders';
  const SEARCH_HISTORY_KEY = 'pekun_memo_ultra_v5_search_history';

  const DEFAULTS = {
    visible: true,
    minimized: false,
    mode: 'global',          // 'global' or 'site'
    chatgptTarget: 'global', // ChatGPT→Memo 保存先
    pos: { right: 18, bottom: 18 },
    size: { w: 460, h: 380 },
    opacity: 0.98,
    listOpen: true,
    mdPreview: false,
    folderFilter: '__ALL__'  // '__ALL__' or folder name
  };

  const safeParse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
  const loadState = () => {
    const raw = store.get(APP_STATE_KEY, '');
    return { ...DEFAULTS, ...(raw ? safeParse(raw, {}) : {}) };
  };
  const saveState = (st) => store.set(APP_STATE_KEY, JSON.stringify(st));
  const getMemoKey = (mode) => (mode === 'site' ? MEMO_SITE_KEY() : MEMO_GLOBAL_KEY);

  // ===== Time =====
  const pad2 = (n) => String(n).padStart(2, '0');
  const nowStamp = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };

  // ===== Helpers =====
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const isChatGPT = () => /(^|\.)chatgpt\.com$/i.test(location.hostname);

  const insertAtCursor = (ta, text) => {
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    ta.value = before + text + after;
    const caret = (before + text).length;
    ta.setSelectionRange(caret, caret);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const toggleChecklistLine = (ta) => {
    const v = ta.value;
    const pos = ta.selectionStart ?? v.length;

    const lineStart = v.lastIndexOf('\n', pos - 1) + 1;
    const lineEndIdx = v.indexOf('\n', pos);
    const lineEnd = lineEndIdx === -1 ? v.length : lineEndIdx;

    const line = v.slice(lineStart, lineEnd);
    let newLine = line;
    if (line.includes('- [ ]')) newLine = line.replace('- [ ]', '- [x]');
    else if (line.includes('- [x]')) newLine = line.replace('- [x]', '- [ ]');
    else if (line.includes('- [X]')) newLine = line.replace('- [X]', '- [ ]');
    else return;

    ta.value = v.slice(0, lineStart) + newLine + v.slice(lineEnd);
    const newPos = clamp(pos + (newLine.length - line.length), 0, ta.value.length);
    ta.setSelectionRange(newPos, newPos);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const xmlEscape = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');

  // ===== Block format (v5.1) =====
  // ## <datetime> | folder:<name> | pin | <title> | #tag #tag2
  // content...
  // ---
  const extractTagsFromText = (s) =>
    Array.from(new Set((String(s ?? '').match(/#[^\s#]+/g) || []).map(t => t.trim())));

  const parseHeader = (head) => {
    const parts = head.split('|').map(s => s.trim()).filter(Boolean);
    const datetime = (parts[0] || '').trim();
    let folder = '';
    let title = '';
    let tagsRaw = '';
    let pinned = false;

    for (let i = 1; i < parts.length; i++) {
      const p = parts[i];

      if (/^folder\s*:/i.test(p)) folder = p.replace(/^folder\s*:/i, '').trim();
      else if (/^pin$/i.test(p) || /^pinned$/i.test(p) || /^📌$/.test(p)) pinned = true;
      else if (p.startsWith('#') || p.includes(' #')) tagsRaw += (tagsRaw ? ' ' : '') + p;
      else {
        if (!title) title = p;
        else tagsRaw += (tagsRaw ? ' ' : '') + p;
      }
    }

    const tags = Array.from(new Set((tagsRaw.match(/#[^\s#]+/g) || []).map(t => t.trim())));
    return { datetime, folder, title, tags, pinned };
  };

  const buildHeader = ({ datetime, folder, title, tags, pinned }) => {
    const tagStr = (tags && tags.length) ? tags.join(' ') : '';
    const folderStr = folder ? `folder:${folder}` : '';
    const segs = [datetime];
    if (folderStr) segs.push(folderStr);
    if (pinned) segs.push('pin');
    if (title) segs.push(title);
    if (tagStr) segs.push(tagStr);
    return `## ${segs.join(' | ')}`.trimEnd();
  };

  const parseBlocks = (text) => {
    const lines = String(text ?? '').split('\n');
    const blocks = [];
    let cur = null;

    const flush = () => {
      if (!cur) return;
      cur.content = cur.content.join('\n').trimEnd();
      blocks.push(cur);
      cur = null;
    };

    for (const line of lines) {
      if (line.startsWith('## ')) {
        flush();
        const head = line.slice(3).trim();
        const h = parseHeader(head);
        cur = { ...h, content: [] };
        continue;
      }
      if (line.trim() === '---') { flush(); continue; }
      if (cur) cur.content.push(line);
    }
    flush();
    return blocks;
  };

  const makeBlock = ({ title = '', tags = [], folder = '', pinned = false } = {}) => {
    const header = buildHeader({ datetime: nowStamp(), folder, title, tags, pinned });
    return `${header}\n\n\n---\n\n`;
  };

  const normalizeFilename = (s) => String(s || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

  // ===== Export =====
  const downloadTextFile = (filename, mime, text) => {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    (document.body || document.documentElement).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  };

  const csvEscape = (s) => {
    const t = String(s ?? '');
    if (/[",\n\r]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
    return t;
  };

  const blocksToCSV = (blocks) => {
    const rows = [['datetime', 'folder', 'pinned', 'title', 'tags', 'content']];
    for (const b of blocks) rows.push([b.datetime, b.folder || '', b.pinned ? '1' : '0', b.title || '', (b.tags||[]).join(' '), b.content || '']);
    return rows.map(r => r.map(csvEscape).join(',')).join('\r\n');
  };

  const exportCSVBlocks = (blocks, filenameBase) => {
    const csv = blocksToCSV(blocks);
    downloadTextFile(`${filenameBase}.csv`, 'text/csv;charset=utf-8', '\ufeff' + csv);
  };

  const blocksToExcelXML = (blocks) => {
    const rows = [['datetime', 'folder', 'pinned', 'title', 'tags', 'content']];
    for (const b of blocks) rows.push([b.datetime, b.folder || '', b.pinned ? '1' : '0', b.title || '', (b.tags||[]).join(' '), b.content || '']);

    const sheetRows = rows.map(r => `<Row>${r.map(v => `<Cell><Data ss:Type="String">${xmlEscape(v)}</Data></Cell>`).join('')}</Row>`).join('');
    return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <Worksheet ss:Name="Memo">
  <Table>
   ${sheetRows}
  </Table>
 </Worksheet>
</Workbook>`;
  };

  const exportExcelBlocks = (blocks, filenameBase) => {
    const xml = blocksToExcelXML(blocks);
    downloadTextFile(`${filenameBase}.xls`, 'application/vnd.ms-excel;charset=utf-8', xml);
  };

  // ===== Search History =====
  const loadSearchHistory = () => {
    const arr = store.get(SEARCH_HISTORY_KEY, '[]');
    const parsed = typeof arr === 'string' ? safeParse(arr, []) : arr;
    return Array.isArray(parsed) ? parsed : [];
  };
  const saveSearchHistory = (word) => {
    const w = (word || '').trim();
    if (!w) return;
    let hist = loadSearchHistory();
    hist = hist.filter(x => x !== w);
    hist.unshift(w);
    hist = hist.slice(0, 20);
    store.set(SEARCH_HISTORY_KEY, JSON.stringify(hist));
  };

  // ===== Folder list =====
  const loadFolders = () => {
    const raw = store.get(FOLDERS_KEY, '[]');
    const parsed = typeof raw === 'string' ? safeParse(raw, []) : raw;
    const base = Array.isArray(parsed) ? parsed : [];
    const defaults = ['ChatGPT', 'Amazon', '個人'];
    const merged = Array.from(new Set([...defaults, ...base].filter(Boolean)));
    return merged;
  };
  const saveFolders = (folders) => store.set(FOLDERS_KEY, JSON.stringify(Array.from(new Set(folders)).filter(Boolean)));

  // ===== UI inject guard =====
  if (window.__pekunMemoUltraInjectedV511) return;
  window.__pekunMemoUltraInjectedV511 = true;

  const state = loadState();
  let folders = loadFolders();

  // ===== UI =====
  const host = document.createElement('div');
  host.style.all = 'initial';
  host.style.position = 'fixed';
  host.style.zIndex = '2147483647';
  host.style.right = `${state.pos.right}px`;
  host.style.bottom = `${state.pos.bottom}px`;
  host.style.width = `${state.size.w}px`;
  host.style.height = `${state.size.h}px`;
  host.style.opacity = String(state.opacity);
  host.style.display = state.visible ? 'block' : 'none';
  host.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';

  const shadow = host.attachShadow({ mode: 'open' });

  const css = document.createElement('style');
  css.textContent = `
    .wrap{width:100%;height:100%;background:#fff;color:#111827;border:1px solid rgba(17,24,39,0.16);border-radius:14px;box-shadow:0 14px 38px rgba(0,0,0,0.22);overflow:hidden;display:flex;flex-direction:column;position:relative;}
    .bar{height:42px;display:flex;align-items:center;gap:8px;padding:0 10px;background:#f3f4f6;border-bottom:1px solid rgba(17,24,39,0.10);user-select:none;cursor:move;}
    .title{font-size:12px;opacity:0.95;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .pill{font-size:11px;padding:2px 8px;border-radius:999px;background:#fff;border:1px solid rgba(17,24,39,0.12);cursor:pointer;user-select:none;}
    .btn{width:28px;height:28px;border-radius:10px;display:grid;place-items:center;background:#fff;border:1px solid rgba(17,24,39,0.14);cursor:pointer;user-select:none;font-size:13px;}
    .btnWide{height:28px;padding:0 10px;border-radius:10px;display:inline-flex;align-items:center;gap:6px;background:#fff;border:1px solid rgba(17,24,39,0.14);cursor:pointer;user-select:none;font-size:12px;white-space:nowrap;}
    .btn:hover,.pill:hover,.btnWide:hover{background:#eef2ff;}
    .select{height:28px;border-radius:10px;border:1px solid rgba(17,24,39,0.14);background:#fff;font-size:12px;padding:0 8px;outline:none;}
    .content{flex:1;display:flex;min-height:0;}
    .side{width:170px;border-right:1px solid rgba(17,24,39,0.10);background:#fbfbfd;display:flex;flex-direction:column;min-height:0;}
    .side.hidden{display:none;}
    .searchWrap{padding:8px;border-bottom:1px solid rgba(17,24,39,0.08);display:flex;flex-direction:column;gap:6px;}
    .search{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:10px;border:1px solid rgba(17,24,39,0.14);outline:none;font-size:12px;background:#fff;color:#111827;}
    .list{flex:1;overflow:auto;padding:6px;display:flex;flex-direction:column;gap:6px;}
    .item{border:1px solid rgba(17,24,39,0.12);background:#fff;border-radius:12px;padding:6px 8px;cursor:pointer;user-select:none;}
    .item:hover{background:#eef2ff;}
    .itemTitle{font-size:12px;font-weight:600;line-height:1.2;display:flex;align-items:center;gap:6px;}
    .pinMark{font-size:12px;}
    .itemMeta{font-size:10px;opacity:0.8;margin-top:2px;line-height:1.2;}
    .main{flex:1;display:flex;flex-direction:column;min-width:0;}
    textarea{flex:1;width:100%;border:0;outline:none;resize:none;background:#fff;color:#111827;padding:10px;font-size:13px;line-height:1.35;box-sizing:border-box;}
    .preview{flex:1;overflow:auto;padding:10px;font-size:13px;line-height:1.45;box-sizing:border-box;}
    .preview h1,.preview h2,.preview h3{margin:10px 0 6px;}
    .preview code{background:#f3f4f6;padding:1px 4px;border-radius:6px;}
    .preview pre{background:#111827;color:#f9fafb;padding:10px;border-radius:12px;overflow:auto;}
    .preview pre code{background:transparent;color:inherit;padding:0;}
    .footer{height:30px;display:flex;align-items:center;justify-content:space-between;padding:0 10px;font-size:11px;color:#374151;border-top:1px solid rgba(17,24,39,0.10);background:#f9fafb;cursor:move;user-select:none;}
    .resize{position:absolute;right:6px;bottom:6px;width:16px;height:16px;cursor:nwse-resize;opacity:0.75;user-select:none;}
    .dot{width:3px;height:3px;background:rgba(17,24,39,0.65);border-radius:50%;display:inline-block;margin:1px;}
    .minimized .content,.minimized .footer{display:none;}
    /* ===== Minibar ===== */
    .miniLabel{font-size:12px;font-weight:600;display:none;align-items:center;gap:6px;}
    .minimized .miniLabel{display:inline-flex;}
    .minimized .hideOnMin{display:none !important;}
    .minimized .bar{height:36px;}
  `;
  shadow.appendChild(css);

  const wrap = document.createElement('div');
  wrap.className = 'wrap';

  const bar = document.createElement('div');
  bar.className = 'bar';

  // ★最小化時にだけ出すラベル
  const miniLabel = document.createElement('div');
  miniLabel.className = 'miniLabel';
  miniLabel.textContent = 'memo📃';

  const titleEl = document.createElement('div');
  titleEl.className = 'title';

  const modePill = document.createElement('div');
  modePill.className = 'pill';

  const folderSel = document.createElement('select');
  folderSel.className = 'select';
  folderSel.title = 'フォルダ表示フィルタ';

  const btnFolderMng = document.createElement('div'); btnFolderMng.className='btn'; btnFolderMng.title='フォルダ管理'; btnFolderMng.textContent='📁';

  const btnList = document.createElement('div'); btnList.className='btn'; btnList.title='一覧の表示/非表示'; btnList.textContent='≡';
  const btnMD   = document.createElement('div'); btnMD.className='btn';   btnMD.title='Markdownプレビュー'; btnMD.textContent='MD';
  const btnPin  = document.createElement('div'); btnPin.className='btn';  btnPin.title='ピン留め切替（カーソルのブロック）'; btnPin.textContent='📌';
  const btnDate = document.createElement('div'); btnDate.className='btn'; btnDate.title='日付挿入'; btnDate.textContent='📅';
  const btnBox  = document.createElement('div'); btnBox.className='btn';  btnBox.title='チェックボックス挿入'; btnBox.textContent='☐';
  const btnNew  = document.createElement('div'); btnNew.className='btn';  btnNew.title='新規ブロック(Alt+N)'; btnNew.textContent='＋';
  const btnCSV  = document.createElement('div'); btnCSV.className='btnWide'; btnCSV.title='CSV(Alt+C)'; btnCSV.textContent='CSV';
  const btnXLS  = document.createElement('div'); btnXLS.className='btnWide'; btnXLS.title='Excel(Alt+E)'; btnXLS.textContent='Excel';
  const btnMin  = document.createElement('div'); btnMin.className='btn'; btnMin.title='最小化'; btnMin.textContent='—';
  const btnHide = document.createElement('div'); btnHide.className='btn'; btnHide.title='非表示(Alt+M)'; btnHide.textContent='×';

  // ★最小化で隠すやつにクラスを付ける
  titleEl.classList.add('hideOnMin');
  modePill.classList.add('hideOnMin');
  folderSel.classList.add('hideOnMin');
  btnFolderMng.classList.add('hideOnMin');
  btnList.classList.add('hideOnMin');
  btnMD.classList.add('hideOnMin');
  btnPin.classList.add('hideOnMin');
  btnDate.classList.add('hideOnMin');
  btnBox.classList.add('hideOnMin');
  btnNew.classList.add('hideOnMin');
  btnCSV.classList.add('hideOnMin');
  btnXLS.classList.add('hideOnMin');
  // btnMin, btnHide は残す（付けない）

  // bar構成（ミニラベル→通常群→最小化/非表示）
  bar.appendChild(miniLabel);   // ★最小化時だけ表示
  bar.appendChild(titleEl);
  bar.appendChild(modePill);
  bar.appendChild(folderSel);
  bar.appendChild(btnFolderMng);
  bar.appendChild(btnList);
  bar.appendChild(btnMD);
  bar.appendChild(btnPin);
  bar.appendChild(btnDate);
  bar.appendChild(btnBox);
  bar.appendChild(btnNew);
  bar.appendChild(btnCSV);
  bar.appendChild(btnXLS);
  bar.appendChild(btnMin);
  bar.appendChild(btnHide);

  const content = document.createElement('div'); content.className='content';
  const side = document.createElement('div'); side.className='side';
  const searchWrap = document.createElement('div'); searchWrap.className='searchWrap';

  const search = document.createElement('input'); search.className='search'; search.type='text';
  search.placeholder='検索（タイトル/本文/#タグ）';
  const searchList = document.createElement('datalist');
  searchList.id = `memoSearchHist_${Math.random().toString(36).slice(2)}`;
  search.setAttribute('list', searchList.id);

  searchWrap.appendChild(search);
  searchWrap.appendChild(searchList);

  const list = document.createElement('div'); list.className='list';
  side.appendChild(searchWrap); side.appendChild(list);

  const main = document.createElement('div'); main.className='main';
  const ta = document.createElement('textarea');
  const preview = document.createElement('div');
  preview.className = 'preview';
  preview.style.display = state.mdPreview ? 'block' : 'none';
  ta.style.display = state.mdPreview ? 'none' : 'block';

  main.appendChild(ta);
  main.appendChild(preview);

  content.appendChild(side);
  content.appendChild(main);

  const footer = document.createElement('div'); footer.className='footer';
  const statusLeft = document.createElement('div');
  const statusRight = document.createElement('div');
  footer.appendChild(statusLeft); footer.appendChild(statusRight);

  const resize = document.createElement('div'); resize.className='resize'; resize.title='サイズ変更';
  resize.innerHTML = `<span class="dot"></span><span class="dot"></span><span class="dot"></span><br/><span class="dot"></span><span class="dot"></span><span class="dot"></span><br/><span class="dot"></span><span class="dot"></span><span class="dot"></span>`;

  wrap.appendChild(bar);
  wrap.appendChild(content);
  wrap.appendChild(footer);
  wrap.appendChild(resize);

  shadow.appendChild(wrap);
  document.documentElement.appendChild(host);

  const updateHeader = () => {
    const modeLabel = state.mode === 'site' ? `サイト(${location.hostname})` : '共通';
    titleEl.textContent = `Memo Ultra v5.1 / ${modeLabel}`;
    modePill.textContent = state.mode === 'site' ? 'サイト別' : '共通メモ';
    statusLeft.textContent = `${hasGM ? 'TM Storage' : 'localStorage'} / ${modeLabel}`;
    btnMD.style.background = state.mdPreview ? '#eef2ff' : '#fff';
  };

  const applyListOpen = () => side.classList.toggle('hidden', !state.listOpen);

  const keepInViewport = () => {
    const r = host.getBoundingClientRect();
    const margin = 8;

    let newRight = state.pos.right;
    let newBottom = state.pos.bottom;

    if (r.left < margin) newRight = clamp(newRight + (margin - r.left), 0, window.innerWidth - 80);
    if (r.top < margin) newBottom = clamp(newBottom + (margin - r.top), 0, window.innerHeight - 40);

    if (r.right > window.innerWidth - margin) newRight = clamp(newRight + (r.right - (window.innerWidth - margin)), 0, window.innerWidth - 80);
    if (r.bottom > window.innerHeight - margin) newBottom = clamp(newBottom + (r.bottom - (window.innerHeight - margin)), 0, window.innerHeight - 40);

    state.pos.right = newRight;
    state.pos.bottom = newBottom;
    host.style.right = `${newRight}px`;
    host.style.bottom = `${newBottom}px`;
    saveState(state);
  };

  // ★最小化をミニバー（memo📃 + — + ×）にする
  const applyMinimized = () => {
    if (state.minimized) {
      wrap.classList.add('minimized');
      host.style.height = '36px';
      host.style.width = '160px';   // ←好みで 120〜220 に変えてOK
    } else {
      wrap.classList.remove('minimized');
      host.style.width = `${state.size.w}px`;
      host.style.height = `${state.size.h}px`;
    }
    keepInViewport();
  };

  const setVisible = (v) => {
    state.visible = v;
    host.style.display = v ? 'block' : 'none';
    saveState(state);
  };

  const getMemoText = () => store.get(getMemoKey(state.mode), '') ?? '';
  const setMemoText = (text) => store.set(getMemoKey(state.mode), text);

  const renderSearchHistory = () => {
    const hist = loadSearchHistory();
    searchList.innerHTML = '';
    for (const w of hist) {
      const opt = document.createElement('option');
      opt.value = w;
      searchList.appendChild(opt);
    }
  };

  const renderFolderSelect = () => {
    folderSel.innerHTML = '';
    const optAll = document.createElement('option');
    optAll.value = '__ALL__';
    optAll.textContent = '全て';
    folderSel.appendChild(optAll);

    for (const f of folders) {
      const opt = document.createElement('option');
      opt.value = f;
      opt.textContent = f;
      folderSel.appendChild(opt);
    }
    folderSel.value = state.folderFilter || '__ALL__';
  };

  const getAllBlocks = () => parseBlocks(ta.value);

  const getFilteredBlocks = () => {
    const q = (search.value || '').trim().toLowerCase();
    const f = state.folderFilter || '__ALL__';
    const blocks = getAllBlocks();

    const filtered = blocks.filter(b => {
      if (f !== '__ALL__' && (b.folder || '') !== f) return false;
      if (!q) return true;
      const hay = `${b.datetime}\n${b.folder}\n${b.title}\n${(b.tags||[]).join(' ')}\n${b.content}`.toLowerCase();
      return hay.includes(q);
    });

    filtered.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    return filtered;
  };

  const renderList = () => {
    const blocks = getFilteredBlocks();
    list.innerHTML = '';
    for (const b of blocks) {
      const el = document.createElement('div');
      el.className = 'item';
      const t = (b.title || '').trim() || '(no title)';
      const folder = b.folder ? `📁${b.folder}` : '';
      const meta = `${b.datetime}${folder ? ' / ' + folder : ''}${b.tags?.length ? ' / ' + b.tags.join(' ') : ''}`;

      el.innerHTML = `<div class="itemTitle"><span class="pinMark"></span><span class="t"></span></div><div class="itemMeta"></div>`;
      const pinMark = el.querySelector('.pinMark');
      pinMark.textContent = b.pinned ? '📌' : '';
      el.querySelector('.t').textContent = t;
      el.querySelector('.itemMeta').textContent = meta;

      el.addEventListener('click', () => {
        const header = buildHeader(b);
        const idx = ta.value.indexOf(header);
        if (idx >= 0) {
          state.mdPreview = false;
          ta.style.display = 'block';
          preview.style.display = 'none';
          updateHeader();
          saveState(state);

          ta.focus();
          ta.setSelectionRange(idx, idx);
          const before = ta.value.slice(0, idx);
          const lineCount = before.split('\n').length;
          ta.scrollTop = Math.max(0, (lineCount - 5) * 18);
        }
      });

      list.appendChild(el);
    }
  };

  const renderPreview = () => {
    const blocks = getFilteredBlocks();
    const parts = blocks.map(b => {
      const headerLine =
        `### ${b.pinned ? '📌 ' : ''}${b.title || '(no title)'}\n\n` +
        `- ${b.datetime}` +
        `${b.folder ? ` / folder: **${b.folder}**` : ''}` +
        `${b.tags?.length ? ` / ${b.tags.join(' ')}` : ''}\n\n`;
      const body = b.content || '';
      return `${headerLine}\n${body}\n\n---\n`;
    });
    const md = parts.join('\n');

    if (typeof marked !== 'undefined' && marked?.parse) preview.innerHTML = marked.parse(md);
    else preview.innerHTML = `<pre>${xmlEscape(md)}</pre>`;
  };

  const forceSave = () => {
    setMemoText(ta.value);
    statusRight.textContent = `保存: ${nowStamp()}`;
    setTimeout(() => (statusRight.textContent = '保存済み'), 900);
    renderList();
    if (state.mdPreview) renderPreview();
  };

  const promptNewBlock = () => {
    const folder = prompt(`フォルダ名（空OK）\n例: ChatGPT / Amazon / 個人`, state.folderFilter !== '__ALL__' ? state.folderFilter : '') ?? '';
    const t = prompt('タイトル（空でもOK）', '') ?? '';
    const tagLine = prompt('タグ（例: #rme #chatgpt  空でもOK）', '') ?? '';
    const tags = extractTagsFromText(tagLine);

    const f = folder.trim();
    if (f && !folders.includes(f)) {
      folders = Array.from(new Set([...folders, f]));
      saveFolders(folders);
      renderFolderSelect();
    }

    const block = makeBlock({ title: t.trim(), tags, folder: f, pinned: false });
    ta.value = block + ta.value;
    const firstNL = ta.value.indexOf('\n');
    ta.setSelectionRange(firstNL + 2, firstNL + 2);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    forceSave();
    ta.scrollTop = 0;
  };

  const manageFolders = () => {
    const cmd = prompt(
`フォルダ管理
- 追加: + フォルダ名
- 削除: - フォルダ名
- 一覧: list

例)
+ 仕事
- 個人
`, 'list');
    if (!cmd) return;
    const c = cmd.trim();
    if (c === 'list') {
      alert(`フォルダ一覧:\n${folders.map(x => `- ${x}`).join('\n')}`);
      return;
    }
    if (c.startsWith('+')) {
      const name = c.slice(1).trim();
      if (!name) return;
      if (!folders.includes(name)) folders.push(name);
      folders = Array.from(new Set(folders));
      saveFolders(folders);
      renderFolderSelect();
      alert(`追加した: ${name}`);
      return;
    }
    if (c.startsWith('-')) {
      const name = c.slice(1).trim();
      if (!name) return;
      folders = folders.filter(x => x !== name);
      saveFolders(folders);
      if (state.folderFilter === name) state.folderFilter = '__ALL__';
      saveState(state);
      renderFolderSelect();
      renderList();
      alert(`削除した: ${name}\n※既存メモのfolder表記は消えない（表示フィルタだけの話）`);
      return;
    }
    alert('コマンドが分からない。+ / - / list のどれかで入れて。');
  };

  // ===== ピン留め（カーソル位置のブロック） =====
  const findCurrentBlockHeaderRange = () => {
    const v = ta.value;
    const pos = ta.selectionStart ?? 0;

    const before = v.slice(0, pos);
    const headerStart = before.lastIndexOf('\n## ');
    const hs = headerStart >= 0 ? headerStart + 1 : (v.startsWith('## ') ? 0 : -1);
    if (hs < 0) return null;

    const headerLineEnd = v.indexOf('\n', hs);
    const he = headerLineEnd >= 0 ? headerLineEnd : v.length;

    if (!v.slice(hs, hs + 3).startsWith('## ')) return null;
    return { start: hs, end: he };
  };

  const togglePinCurrentBlock = () => {
    const r = findCurrentBlockHeaderRange();
    if (!r) return;

    const line = ta.value.slice(r.start, r.end);
    const head = line.slice(3).trim();
    const b = parseHeader(head);

    const newHeader = buildHeader({
      datetime: b.datetime,
      folder: b.folder,
      pinned: !b.pinned,
      title: b.title,
      tags: b.tags
    });

    ta.value = ta.value.slice(0, r.start) + newHeader + ta.value.slice(r.end);
    const delta = newHeader.length - line.length;
    const p = (ta.selectionStart ?? 0) + delta;
    ta.setSelectionRange(p, p);

    ta.dispatchEvent(new Event('input', { bubbles: true }));
    forceSave();
  };

  // ===== フォルダごとエクスポート =====
  const exportMenu = (kind) => {
    const choice = prompt(
`エクスポート範囲を選んで
1) 今見えてる範囲（検索+フォルダフィルタ）
2) 現在フォルダだけ（フォルダフィルタが全ての場合は全部）
3) 全フォルダを分割で一括（複数ファイルDL）

数字だけ入力（1/2/3）
`, '1');

    if (!choice) return;

    const all = getAllBlocks();
    const filtered = getFilteredBlocks();

    const doExport = (blocks, base) => {
      const stamp = nowStamp().replace(/[: ]/g, '-');
      const name = `${normalizeFilename(base)}_${stamp}`;
      if (kind === 'csv') exportCSVBlocks(blocks, name);
      else exportExcelBlocks(blocks, name);
    };

    if (choice.trim() === '1') {
      doExport(filtered, `memo_view_${state.mode === 'site' ? location.hostname : 'global'}`);
      return;
    }

    if (choice.trim() === '2') {
      const f = state.folderFilter || '__ALL__';
      const blocks = (f === '__ALL__') ? all : all.filter(b => (b.folder || '') === f);
      doExport(blocks, `memo_folder_${f === '__ALL__' ? 'ALL' : f}`);
      return;
    }

    if (choice.trim() === '3') {
      const map = new Map();
      for (const b of all) {
        const key = (b.folder || '').trim() || '(none)';
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(b);
      }

      for (const [k, arr] of map.entries()) {
        arr.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
      }

      const ok = confirm(`全フォルダを分割で一括エクスポートするよ。\nフォルダ数: ${map.size}\n複数ファイルが連続でダウンロードされる。OK？`);
      if (!ok) return;

      for (const [folderName, blocks] of map.entries()) {
        doExport(blocks, `memo_${folderName}`);
      }
      return;
    }

    alert('1/2/3 のどれかで入れて。');
  };

  // Buttons
  btnFolderMng.addEventListener('click', manageFolders);
  folderSel.addEventListener('change', () => {
    state.folderFilter = folderSel.value || '__ALL__';
    saveState(state);
    renderList();
    if (state.mdPreview) renderPreview();
  });

  btnList.addEventListener('click', () => { state.listOpen = !state.listOpen; saveState(state); applyListOpen(); });
  btnMD.addEventListener('click', () => {
    state.mdPreview = !state.mdPreview;
    saveState(state);
    ta.style.display = state.mdPreview ? 'none' : 'block';
    preview.style.display = state.mdPreview ? 'block' : 'none';
    updateHeader();
    if (state.mdPreview) renderPreview();
  });
  btnPin.addEventListener('click', () => togglePinCurrentBlock());
  btnDate.addEventListener('click', () => { insertAtCursor(ta, nowStamp()); forceSave(); });
  btnBox.addEventListener('click',  () => { insertAtCursor(ta, '- [ ] '); forceSave(); });
  btnNew.addEventListener('click',  () => promptNewBlock());
  btnCSV.addEventListener('click',  () => exportMenu('csv'));
  btnXLS.addEventListener('click',  () => exportMenu('xls'));
  btnMin.addEventListener('click',  () => { state.minimized = !state.minimized; saveState(state); applyMinimized(); });
  btnHide.addEventListener('click', () => setVisible(false));
  modePill.addEventListener('click', () => {
    state.mode = (state.mode === 'site') ? 'global' : 'site';
    saveState(state);
    updateHeader();
    ta.value = getMemoText();
    renderList();
    if (state.mdPreview) renderPreview();
  });

  // オプション：ミニバーの memo📃 をダブルクリックで復帰（誤爆少なめ）
  miniLabel.addEventListener('dblclick', () => {
    state.minimized = false;
    saveState(state);
    applyMinimized();
  });

  // Autosave
  let timer = null;
  ta.addEventListener('input', () => {
    statusRight.textContent='編集中…';
    clearTimeout(timer);
    timer = setTimeout(forceSave, 250);
  });

  let searchTimer = null;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      saveSearchHistory(search.value);
      renderSearchHistory();
    }, 600);
    renderList();
    if (state.mdPreview) renderPreview();
  });
  search.addEventListener('change', () => {
    saveSearchHistory(search.value);
    renderSearchHistory();
  });

  // Hotkeys
  window.addEventListener('keydown', (e) => {
    if (e.altKey && (e.key === 'm' || e.key === 'M')) { e.preventDefault(); setVisible(!state.visible); return; }
    if (e.altKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); if (!state.visible) setVisible(true); promptNewBlock(); return; }
    if (e.altKey && (e.key === 'x' || e.key === 'X')) { e.preventDefault(); if (!state.mdPreview) { toggleChecklistLine(ta); forceSave(); } return; }
    if (e.altKey && (e.key === 'p' || e.key === 'P')) { e.preventDefault(); if (!state.mdPreview) togglePinCurrentBlock(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); if (!state.mdPreview) forceSave(); return; }
    if (e.altKey && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); exportMenu('csv'); return; }
    if (e.altKey && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); exportMenu('xls'); return; }
    if (e.key === 'Escape') {
      state.pos.right = 18; state.pos.bottom = 18;
      host.style.right = '18px'; host.style.bottom = '18px';
      state.visible = true; host.style.display = 'block';
      state.minimized = false; saveState(state);
      applyMinimized();
      return;
    }
  }, { capture: true });

  // Drag (bar + footer)
  let dragging=false, sx=0, sy=0, sr=0, sb=0;
  const startDrag = (e) => {
    if (e.button !== 0) return;

    const t = e.target;
    if (t && (t.closest?.('.btn') || t.closest?.('.btnWide') || t.closest?.('.select') || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) {
      return;
    }

    dragging=true; sx=e.clientX; sy=e.clientY;
    sr=parseInt(host.style.right||'18',10);
    sb=parseInt(host.style.bottom||'18',10);
    e.preventDefault();
  };

  bar.addEventListener('mousedown', startDrag);
  footer.addEventListener('mousedown', startDrag);

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx=e.clientX-sx, dy=e.clientY-sy;
    const nr=clamp(sr-dx,0,window.innerWidth-80);
    const nb=clamp(sb-dy,0,window.innerHeight-40);
    host.style.right=`${nr}px`; host.style.bottom=`${nb}px`;
    state.pos.right=nr; state.pos.bottom=nb;
  });
  window.addEventListener('mouseup', () => { if (!dragging) return; dragging=false; saveState(state); });

  // Resize
  let resizing=false, rx=0, ry=0, rw=0, rh=0;
  resize.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (state.minimized) return;
    resizing=true; rx=e.clientX; ry=e.clientY;
    const r=host.getBoundingClientRect(); rw=r.width; rh=r.height;
    e.preventDefault(); e.stopPropagation();
  });
  window.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    const nw=clamp(Math.round(rw+(e.clientX-rx)),360,900);
    const nh=clamp(Math.round(rh+(e.clientY-ry)),240,800);
    host.style.width=`${nw}px`; host.style.height=`${nh}px`;
    state.size.w=nw; state.size.h=nh;
  });
  window.addEventListener('mouseup', () => { if (!resizing) return; resizing=false; saveState(state); keepInViewport(); });

  // ===== ChatGPT title auto =====
  const getChatGPTConversationTitle = () => {
    const dt = (document.title || '').trim();
    const cleaned = dt.replace(/\s*[-|]\s*ChatGPT\s*$/i, '').trim();
    if (cleaned && cleaned.toLowerCase() !== 'chatgpt') return cleaned;

    const h1 = document.querySelector('main h1');
    if (h1 && h1.textContent?.trim()) return h1.textContent.trim();

    return '';
  };

  const appendBlockToMemo = (mode, title, tags, body, folder = '', pinned = false) => {
    const key = getMemoKey(mode);
    const header = buildHeader({ datetime: nowStamp(), folder, pinned, title: title || 'ChatGPT', tags: tags || [] });
    const block = `${header}\n\n${(body || '').trim()}\n\n---\n\n`;
    const cur = store.get(key, '') ?? '';
    const next = block + cur;
    store.set(key, next);

    if (state.mode === mode) {
      ta.value = next;
      renderList();
      if (state.mdPreview) renderPreview();
    }
    if (!state.visible) setVisible(true);
    ta.scrollTop = 0;
    statusRight.textContent = 'ChatGPT→Memo 追加';
    setTimeout(() => (statusRight.textContent = '保存済み'), 900);
  };

  const addChatGPTButtons = () => {
    if (!isChatGPT()) return;
    const mark = 'data-pekun-memo-ultra-btn';
    const btnStyle = `display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:4px 10px;border-radius:999px;border:1px solid rgba(17,24,39,0.18);background:#fff;cursor:pointer;user-select:none;margin:6px 0;`;

    const inject = () => {
      const msgs = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
      for (const msg of msgs) {
        if (msg.querySelector?.(`[${mark}="1"]`)) continue;

        const btn = document.createElement('button');
        btn.setAttribute(mark, '1');
        btn.type = 'button';
        btn.textContent = '→ Memo';
        btn.setAttribute('style', btnStyle);

        btn.addEventListener('click', () => {
          const text = (msg.innerText || '').trim();
          if (!text) return;

          const chatTitle = getChatGPTConversationTitle();
          const tags = extractTagsFromText(text).slice(0, 12);
          const title = chatTitle || 'ChatGPT';
          const body = chatTitle ? `ChatGPT: ${chatTitle}\n\n${text}` : text;

          const targetMode = state.chatgptTarget === 'site' ? 'site' : 'global';

          const folder = 'ChatGPT';
          if (!folders.includes(folder)) {
            folders = Array.from(new Set([...folders, folder]));
            saveFolders(folders);
            renderFolderSelect();
          }

          appendBlockToMemo(targetMode, title, tags, body, folder, false);
        });

        msg.prepend(btn);
      }
    };

    const mo = new MutationObserver(inject);
    mo.observe(document.documentElement, { childList: true, subtree: true });
    inject();
  };

  // Init
  updateHeader();
  applyListOpen();
  applyMinimized();
  renderFolderSelect();
  renderSearchHistory();

  ta.value = getMemoText();
  statusRight.textContent = '保存済み';
  renderList();
  if (state.mdPreview) renderPreview();

  addChatGPTButtons();
})();
