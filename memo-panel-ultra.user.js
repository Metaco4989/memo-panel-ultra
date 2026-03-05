// ==UserScript==
// @name         Memo Panel Ultra
// @namespace    http://tampermonkey.net/
// @version      4.0.1
// @description  ChatGPTメモ管理パネル
// @author       metaco4989
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// ==/UserScript==

(() => {
  'use strict';
  // Firefoxの about:newtab / about:home にはTampermonkeyが基本注入できない（仕様）なので、そこだけは出ない。

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
  const APP_STATE_KEY = 'pekun_memo_ultra_v4_state';
  const MEMO_SITE_KEY = () => `pekun_memo_ultra_v4_site:${location.hostname}`;
  const MEMO_GLOBAL_KEY = 'pekun_memo_ultra_v4_global';

  const DEFAULTS = {
    visible: true,
    minimized: false,
    mode: 'global',          // 'global' or 'site'
    chatgptTarget: 'global', // ChatGPT→Memo 保存先
    pos: { right: 18, bottom: 18 },
    size: { w: 440, h: 360 },
    opacity: 0.98,
    listOpen: true
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
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n)); // ←修正
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

  // ===== Block format =====
  // ## <datetime> | <title> | #tag #tag2
  // content...
  // ---
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
        const parts = head.split('|').map(s => s.trim());
        const datetime = (parts[0] || '').trim();
        const title = (parts[1] || '').trim();
        const tagsRaw = (parts.slice(2).join(' | ') || '').trim();
        const tags = Array.from(new Set((tagsRaw.match(/#[^\s#]+/g) || []).map(t => t.trim())));
        cur = { datetime, title, tags, content: [] };
        continue;
      }
      if (line.trim() === '---') { flush(); continue; }
      if (cur) cur.content.push(line);
    }
    flush();
    return blocks;
  };

  const buildHeader = ({ datetime, title, tags }) => {
    const tagStr = (tags && tags.length) ? tags.join(' ') : '';
    return `## ${datetime} | ${title || ''} | ${tagStr}`.trimEnd();
  };

  const extractTagsFromText = (s) =>
    Array.from(new Set((String(s ?? '').match(/#[^\s#]+/g) || []).map(t => t.trim())));

  const makeBlock = ({ title = '', tags = [] } = {}) => {
    const header = buildHeader({ datetime: nowStamp(), title, tags });
    return `${header}\n\n\n---\n\n`;
  };

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

  const exportCSV = (memoText) => {
    const blocks = parseBlocks(memoText);
    const rows = [['datetime', 'title', 'tags', 'content']];
    for (const b of blocks) rows.push([b.datetime, b.title, (b.tags||[]).join(' '), b.content || '']);
    const csv = rows.map(r => r.map(csvEscape).join(',')).join('\r\n');
    downloadTextFile(`memo_${nowStamp().replace(/[: ]/g, '-')}.csv`, 'text/csv;charset=utf-8', '\ufeff' + csv);
  };

  const exportExcelXML = (memoText) => {
    const blocks = parseBlocks(memoText);
    const rows = [['datetime', 'title', 'tags', 'content']];
    for (const b of blocks) rows.push([b.datetime, b.title, (b.tags||[]).join(' '), b.content || '']);

    const xmlEscape = (s) =>
      String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

    const sheetRows = rows.map(r => `<Row>${r.map(v => `<Cell><Data ss:Type="String">${xmlEscape(v)}</Data></Cell>`).join('')}</Row>`).join('');
    const xml =
`<?xml version="1.0"?>
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
    downloadTextFile(`memo_${nowStamp().replace(/[: ]/g, '-')}.xls`, 'application/vnd.ms-excel;charset=utf-8', xml);
  };

  // ===== UI inject guard =====
  if (window.__pekunMemoUltraInjectedV4) return;
  window.__pekunMemoUltraInjectedV4 = true;

  const state = loadState();

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
    .content{flex:1;display:flex;min-height:0;}
    .side{width:160px;border-right:1px solid rgba(17,24,39,0.10);background:#fbfbfd;display:flex;flex-direction:column;min-height:0;}
    .side.hidden{display:none;}
    .searchWrap{padding:8px;border-bottom:1px solid rgba(17,24,39,0.08);}
    .search{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:10px;border:1px solid rgba(17,24,39,0.14);outline:none;font-size:12px;background:#fff;color:#111827;}
    .list{flex:1;overflow:auto;padding:6px;display:flex;flex-direction:column;gap:6px;}
    .item{border:1px solid rgba(17,24,39,0.12);background:#fff;border-radius:12px;padding:6px 8px;cursor:pointer;user-select:none;}
    .item:hover{background:#eef2ff;}
    .itemTitle{font-size:12px;font-weight:600;line-height:1.2;}
    .itemMeta{font-size:10px;opacity:0.8;margin-top:2px;line-height:1.2;}
    .main{flex:1;display:flex;flex-direction:column;min-width:0;}
    textarea{flex:1;width:100%;border:0;outline:none;resize:none;background:#fff;color:#111827;padding:10px;font-size:13px;line-height:1.35;box-sizing:border-box;}
    .footer{height:30px;display:flex;align-items:center;justify-content:space-between;padding:0 10px;font-size:11px;color:#374151;border-top:1px solid rgba(17,24,39,0.10);background:#f9fafb;}
    .resize{position:absolute;right:6px;bottom:6px;width:16px;height:16px;cursor:nwse-resize;opacity:0.75;user-select:none;}
    .dot{width:3px;height:3px;background:rgba(17,24,39,0.65);border-radius:50%;display:inline-block;margin:1px;}
    .minimized .content,.minimized .footer{display:none;}
  `;
  shadow.appendChild(css);

  const wrap = document.createElement('div');
  wrap.className = 'wrap';

  const bar = document.createElement('div');
  bar.className = 'bar';

  const titleEl = document.createElement('div');
  titleEl.className = 'title';

  const modePill = document.createElement('div');
  modePill.className = 'pill';

  const btnList = document.createElement('div'); btnList.className='btn'; btnList.title='一覧の表示/非表示'; btnList.textContent='≡';
  const btnDate = document.createElement('div'); btnDate.className='btn'; btnDate.title='日付挿入'; btnDate.textContent='📅';
  const btnBox  = document.createElement('div'); btnBox.className='btn';  btnBox.title='チェックボックス挿入'; btnBox.textContent='☐';
  const btnNew  = document.createElement('div'); btnNew.className='btn';  btnNew.title='新規ブロック(Alt+N)'; btnNew.textContent='＋';
  const btnCSV  = document.createElement('div'); btnCSV.className='btnWide'; btnCSV.title='CSV(Alt+C)'; btnCSV.textContent='CSV';
  const btnXLS  = document.createElement('div'); btnXLS.className='btnWide'; btnXLS.title='Excel(Alt+E)'; btnXLS.textContent='Excel';
  const btnMin  = document.createElement('div'); btnMin.className='btn'; btnMin.title='最小化'; btnMin.textContent='—';
  const btnHide = document.createElement('div'); btnHide.className='btn'; btnHide.title='非表示(Alt+M)'; btnHide.textContent='×';

  bar.appendChild(titleEl);
  bar.appendChild(modePill);
  bar.appendChild(btnList);
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
  const search = document.createElement('input'); search.className='search'; search.type='text'; search.placeholder='検索（タイトル/本文/#タグ）';
  searchWrap.appendChild(search);
  const list = document.createElement('div'); list.className='list';
  side.appendChild(searchWrap); side.appendChild(list);

  const main = document.createElement('div'); main.className='main';
  const ta = document.createElement('textarea');
  main.appendChild(ta);

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
    titleEl.textContent = `Memo Ultra / ${modeLabel}`;
    modePill.textContent = state.mode === 'site' ? 'サイト別' : '共通メモ';
    statusLeft.textContent = `${hasGM ? 'TM Storage' : 'localStorage'} / ${modeLabel}`;
  };

  const applyListOpen = () => side.classList.toggle('hidden', !state.listOpen);
  const applyMinimized = () => {
    if (state.minimized) {
      wrap.classList.add('minimized');
      host.style.height = '42px';
      host.style.width = `${clamp(state.size.w, 320, 900)}px`;
    } else {
      wrap.classList.remove('minimized');
      host.style.width = `${state.size.w}px`;
      host.style.height = `${state.size.h}px`;
    }
  };

  const setVisible = (v) => {
    state.visible = v;
    host.style.display = v ? 'block' : 'none';
    saveState(state);
  };

  const getMemoText = () => store.get(getMemoKey(state.mode), '') ?? '';
  const setMemoText = (text) => store.set(getMemoKey(state.mode), text);

  const renderList = () => {
    const q = (search.value || '').trim().toLowerCase();
    const blocks = parseBlocks(ta.value);
    list.innerHTML = '';
    for (const b of blocks) {
      const hay = `${b.datetime}\n${b.title}\n${(b.tags||[]).join(' ')}\n${b.content}`.toLowerCase();
      if (q && !hay.includes(q)) continue;

      const el = document.createElement('div');
      el.className = 'item';
      const t = (b.title || '').trim() || '(no title)';
      el.innerHTML = `<div class="itemTitle"></div><div class="itemMeta"></div>`;
      el.querySelector('.itemTitle').textContent = t;
      el.querySelector('.itemMeta').textContent = `${b.datetime}${b.tags?.length ? ' / ' + b.tags.join(' ') : ''}`;

      el.addEventListener('click', () => {
        const header = buildHeader(b);
        const idx = ta.value.indexOf(header);
        if (idx >= 0) {
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

  const forceSave = () => {
    setMemoText(ta.value);
    statusRight.textContent = `保存: ${nowStamp()}`;
    setTimeout(() => (statusRight.textContent = '保存済み'), 900);
    renderList();
  };

  const promptNewBlock = () => {
    const t = prompt('タイトル（空でもOK）', '') ?? '';
    const tagLine = prompt('タグ（例: #rme #chatgpt  空でもOK）', '') ?? '';
    const tags = extractTagsFromText(tagLine);
    const block = makeBlock({ title: t.trim(), tags });
    ta.value = block + ta.value;
    const firstNL = ta.value.indexOf('\n');
    ta.setSelectionRange(firstNL + 2, firstNL + 2);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    forceSave();
    ta.scrollTop = 0;
  };

  // Buttons
  btnList.addEventListener('click', () => { state.listOpen = !state.listOpen; saveState(state); applyListOpen(); });
  btnDate.addEventListener('click', () => { insertAtCursor(ta, nowStamp()); forceSave(); });
  btnBox.addEventListener('click',  () => { insertAtCursor(ta, '- [ ] '); forceSave(); });
  btnNew.addEventListener('click',  () => promptNewBlock());
  btnCSV.addEventListener('click',  () => exportCSV(ta.value));
  btnXLS.addEventListener('click',  () => exportExcelXML(ta.value));
  btnMin.addEventListener('click',  () => { state.minimized = !state.minimized; saveState(state); applyMinimized(); });
  btnHide.addEventListener('click', () => setVisible(false));
  modePill.addEventListener('click', () => { state.mode = (state.mode === 'site') ? 'global' : 'site'; saveState(state); updateHeader(); ta.value = getMemoText(); renderList(); });

  // Autosave
  let timer = null;
  ta.addEventListener('input', () => { statusRight.textContent='編集中…'; clearTimeout(timer); timer = setTimeout(forceSave, 250); });
  search.addEventListener('input', renderList);

  // Hotkeys
  window.addEventListener('keydown', (e) => {
    if (e.altKey && (e.key === 'm' || e.key === 'M')) { e.preventDefault(); setVisible(!state.visible); return; }
    if (e.altKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); if (!state.visible) setVisible(true); promptNewBlock(); return; }
    if (e.altKey && (e.key === 'x' || e.key === 'X')) { e.preventDefault(); toggleChecklistLine(ta); forceSave(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); forceSave(); return; }
    if (e.altKey && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); exportCSV(ta.value); return; }
    if (e.altKey && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); exportExcelXML(ta.value); return; }
  }, { capture: true });

  // Drag
  let dragging=false, sx=0, sy=0, sr=0, sb=0;
  bar.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging=true; sx=e.clientX; sy=e.clientY;
    sr=parseInt(host.style.right||'18',10);
    sb=parseInt(host.style.bottom||'18',10);
    e.preventDefault();
  });
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
    const nh=clamp(Math.round(rh+(e.clientY-ry)),220,800);
    host.style.width=`${nw}px`; host.style.height=`${nh}px`;
    state.size.w=nw; state.size.h=nh;
  });
  window.addEventListener('mouseup', () => { if (!resizing) return; resizing=false; saveState(state); });

  // ChatGPT → Memo
  const appendToTop = true;
  const appendBlockToMemo = (mode, title, tags, body) => {
    const key = getMemoKey(mode);
    const header = buildHeader({ datetime: nowStamp(), title: title || 'ChatGPT', tags: tags || [] });
    const block = `${header}\n\n${(body || '').trim()}\n\n---\n\n`;
    const cur = store.get(key, '') ?? '';
    const next = appendToTop ? (block + cur) : (cur + '\n' + block);
    store.set(key, next);

    if (state.mode === mode) { ta.value = next; renderList(); }
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
          const tags = extractTagsFromText(text).slice(0, 12);
          const target = state.chatgptTarget === 'site' ? 'site' : 'global';
          appendBlockToMemo(target, 'ChatGPT', tags, text);
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
  ta.value = getMemoText();
  statusRight.textContent = '保存済み';
  renderList();
  addChatGPTButtons();

})();
