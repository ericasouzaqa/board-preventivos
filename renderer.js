/* ═══════════════════════════════════════════════════════════════════════
   Board de Cards Preventivos — renderer.js
   Contexto: Electron renderer (contextIsolation=true, sandbox=true)
   CSP: script-src 'self' — SEM 'unsafe-inline'. style-src COM 'unsafe-inline'
   (necessário para o RTE e as barras do dashboard — ver index.html).
   Toda interatividade passa por addEventListener + delegação via [data-action].
   Persistência: localStorage (modo local) OU arquivo JSON em pasta
   compartilhada via IPC (modo compartilhado) — ver window.electronAPI.data.
   ═══════════════════════════════════════════════════════════════════════ */

'use strict';

// ─── Storage keys ───────────────────────────────────────────────────────
// v3: adiciona Squads e migra "link"/"linkCard" (string) para "links" (array).
const KEY_SQUADS_V2  = 'bcp_squads_v3';
const KEY_SPRINTS_V2 = 'bcp_sprints_v3';
const KEY_CARDS_V2   = 'bcp_cards_v3';
const KEY_CONFIG_V2  = 'bcp_config_v3';
// chaves antigas (v2) — lidas uma única vez para migração
const KEY_SPRINTS_OLD = 'bcp_sprints_v2';
const KEY_CARDS_OLD   = 'bcp_cards_v2';
const KEY_CONFIG_OLD  = 'bcp_config_v2';

const DATA_FILE_LABEL = 'board-preventivos-data.json';

// ─── Cache em memória (fonte de verdade para toda a UI síncrona) ───────
// Todas as funções de render leem daqui de forma síncrona — a persistência
// (local ou em arquivo) acontece de forma assíncrona por trás, sem travar
// a interface. Isso evita ter que tornar toda a árvore de render assíncrona.
let DB = { squads: [], sprints: [], cards: [], config: {} };
let syncStatus = 'local'; // 'local' | 'syncing' | 'synced' | 'error'

function localRead(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function localWrite(key, data) {
  try { localStorage.setItem(key, JSON.stringify(data)); return true; }
  catch { return false; }
}

// ─── Migração v2 → v3 (Squad + links[]) ────────────────────────────────
function migrateIfNeeded() {
  const alreadyV3 = localStorage.getItem(KEY_SQUADS_V2) !== null || localStorage.getItem(KEY_SPRINTS_V2) !== null;
  if (alreadyV3) return;

  const oldSprints = localRead(KEY_SPRINTS_OLD, []);
  const oldCards   = localRead(KEY_CARDS_OLD, []);
  const oldConfig  = localRead(KEY_CONFIG_OLD, {});
  if (!oldSprints.length && !oldCards.length) return; // nada pra migrar

  const defaultSquad = { id: uid('sq'), nome: 'Squad Padrão', criadoEm: now() };
  const newSprints = oldSprints.map(s => ({
    ...s,
    squadId: defaultSquad.id,
    links: s.link ? [{ label: 'Principal', url: s.link }] : [],
    _version: 1, _editedBy: oldConfig.nomeUsuario || null, _editedAt: s.atualizadaEm || now()
  }));
  newSprints.forEach(s => delete s.link);

  const newCards = oldCards.map(c => ({
    ...c,
    links: c.linkCard ? [{ label: 'Principal', url: c.linkCard }] : [],
    _version: 1, _editedBy: c.criadoPor || null, _editedAt: c.atualizadoEm || now()
  }));
  newCards.forEach(c => delete c.linkCard);

  localWrite(KEY_SQUADS_V2, [defaultSquad]);
  localWrite(KEY_SPRINTS_V2, newSprints);
  localWrite(KEY_CARDS_V2, newCards);
  localWrite(KEY_CONFIG_V2, oldConfig);
}

// ─── Camada de persistência (local ou arquivo compartilhado) ──────────
async function loadFromDisk() {
  const config = localRead(KEY_CONFIG_V2, {});
  DB.config = config;

  if (config.pastaCompartilhada && window.electronAPI?.data) {
    syncStatus = 'syncing';
    updateSyncIndicator();
    const res = await window.electronAPI.data.read(config.pastaCompartilhada);
    if (res.ok && res.data) {
      DB.squads  = res.data.squads  || [];
      DB.sprints = res.data.sprints || [];
      DB.cards   = res.data.cards   || [];
      DB._mtimeMs = res.mtimeMs;
      syncStatus = 'synced';
    } else if (res.ok && !res.data) {
      // Arquivo ainda não existe na pasta — primeira pessoa a usar essa pasta.
      DB.squads = localRead(KEY_SQUADS_V2, []);
      DB.sprints = localRead(KEY_SPRINTS_V2, []);
      DB.cards = localRead(KEY_CARDS_V2, []);
      await persistNow(); // cria o arquivo já com os dados locais atuais
      syncStatus = 'synced';
    } else {
      // Falha de leitura (pasta indisponível, sem permissão, etc.) — cai para local.
      DB.squads = localRead(KEY_SQUADS_V2, []);
      DB.sprints = localRead(KEY_SPRINTS_V2, []);
      DB.cards = localRead(KEY_CARDS_V2, []);
      syncStatus = 'error';
    }
    window.electronAPI.data.watchStart(config.pastaCompartilhada);
  } else {
    DB.squads = localRead(KEY_SQUADS_V2, []);
    DB.sprints = localRead(KEY_SPRINTS_V2, []);
    DB.cards = localRead(KEY_CARDS_V2, []);
    syncStatus = 'local';
  }
  updateSyncIndicator();
}

let persistTimer = null;
function persist() {
  // Sempre grava local também (cache rápido + fallback se a pasta ficar indisponível)
  localWrite(KEY_SQUADS_V2, DB.squads);
  localWrite(KEY_SPRINTS_V2, DB.sprints);
  localWrite(KEY_CARDS_V2, DB.cards);

  if (!DB.config.pastaCompartilhada || !window.electronAPI?.data) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 250);
}

async function persistNow() {
  if (!DB.config.pastaCompartilhada || !window.electronAPI?.data) return;
  syncStatus = 'syncing';
  updateSyncIndicator();
  const payload = { schemaVersion: 3, squads: DB.squads, sprints: DB.sprints, cards: DB.cards,
    _meta: { lastWriteBy: DB.config.nomeUsuario || null, lastWriteAt: now() } };
  const res = await window.electronAPI.data.write(DB.config.pastaCompartilhada, payload);
  syncStatus = res.ok ? 'synced' : 'error';
  if (res.ok) DB._mtimeMs = res.mtimeMs;
  updateSyncIndicator();
}

function updateSyncIndicator() {
  const el = document.getElementById('syncIndicator');
  if (!el) return;
  const labels = {
    local:   { text: '💻 Somente local', cls: 'sync-local' },
    syncing: { text: '🔄 Sincronizando…', cls: 'sync-syncing' },
    synced:  { text: '☁️ Sincronizado', cls: 'sync-synced' },
    error:   { text: '⚠️ Erro de sincronização', cls: 'sync-error' },
  };
  const l = labels[syncStatus] || labels.local;
  el.textContent = l.text;
  el.className = 'sync-indicator ' + l.cls;
}

// Recarrega quando outra colega salva (fs.watch avisa via IPC)
function onExternalChange() {
  showToast('☁️ Novos dados sincronizados — atualizando…');
  loadFromDisk().then(() => {
    renderBoard();
    if (!document.getElementById('abaDashboard').classList.contains('hidden')) {
      dashGenerated = false;
      renderDashboard();
    }
  });
}

// ─── Store — API síncrona sobre o cache DB ─────────────────────────────
const Store = {
  getSquads()  { return DB.squads; },
  getSprints() { return DB.sprints; },
  getCards()   { return DB.cards; },
  getConfig()  { return DB.config; },

  getSprintsBySquad(squadId) { return DB.sprints.filter(s => s.squadId === squadId); },
  getCardsBySprint(sprintId) { return DB.cards.filter(c => c.sprintId === sprintId); },

  upsertSquad(squad) {
    const idx = DB.squads.findIndex(s => s.id === squad.id);
    if (idx >= 0) DB.squads[idx] = squad; else DB.squads.unshift(squad);
    persist();
  },
  deleteSquad(id) {
    const sprintIds = DB.sprints.filter(s => s.squadId === id).map(s => s.id);
    DB.squads = DB.squads.filter(s => s.id !== id);
    DB.sprints = DB.sprints.filter(s => s.squadId !== id);
    DB.cards = DB.cards.filter(c => !sprintIds.includes(c.sprintId));
    persist();
  },
  upsertSprint(sprint) {
    const idx = DB.sprints.findIndex(s => s.id === sprint.id);
    if (idx >= 0) DB.sprints[idx] = sprint; else DB.sprints.unshift(sprint);
    persist();
  },
  deleteSprint(id) {
    DB.sprints = DB.sprints.filter(s => s.id !== id);
    DB.cards = DB.cards.filter(c => c.sprintId !== id);
    persist();
  },
  upsertCard(card) {
    const idx = DB.cards.findIndex(c => c.id === card.id);
    if (idx >= 0) DB.cards[idx] = card; else DB.cards.push(card);
    persist();
  },
  deleteCard(id) {
    DB.cards = DB.cards.filter(c => c.id !== id);
    persist();
  },
  saveConfig(obj) {
    DB.config = Object.assign(DB.config, obj);
    localWrite(KEY_CONFIG_V2, DB.config);
  }
};

// ─── Proteção contra sobrescrita (conflito) ────────────────────────────
// Antes de salvar um item que já existia, recarrega o arquivo compartilhado
// e compara _version. Se divergiu, houve edição concorrente de outra pessoa
// no MESMO item — mostra diálogo de comparação em vez de sobrescrever.
async function checkConflict(kind, id, versionOpened) {
  if (!DB.config.pastaCompartilhada || !window.electronAPI?.data || !id) return null;
  const res = await window.electronAPI.data.read(DB.config.pastaCompartilhada);
  if (!res.ok || !res.data) return null;
  const remoteList = kind === 'sprint' ? res.data.sprints : res.data.cards;
  const remoteItem = (remoteList || []).find(x => x.id === id);
  if (!remoteItem) return null; // item novo ou removido remotamente — sem conflito de edição
  if ((remoteItem._version || 1) !== versionOpened) {
    return remoteItem; // conflito: alguém já salvou uma versão mais nova
  }
  return null;
}

let pendingConflict = null; // { kind, localData, remoteData, applyFn }

function abrirDialogoConflito(kind, localData, remoteData, applyFn) {
  pendingConflict = { kind, localData, remoteData, applyFn };
  const label = kind === 'sprint' ? 'Sprint' : 'Card';
  document.getElementById('conflictTitle').textContent = `Conflito de edição — ${label}`;
  document.getElementById('conflictRemoteWho').textContent = remoteData._editedBy || 'outra colega';
  document.getElementById('conflictRemoteWhen').textContent = fmtDateTime(remoteData._editedAt);
  const campo = kind === 'sprint' ? 'titulo' : 'titulo';
  document.getElementById('conflictLocalPreview').textContent  = resumoParaConflito(kind, localData);
  document.getElementById('conflictRemotePreview').textContent = resumoParaConflito(kind, remoteData);
  document.getElementById('conflictBackdrop').classList.add('open');
}

function resumoParaConflito(kind, item) {
  if (kind === 'sprint') {
    return `Sprint ${item.numero} · ${item.status} · ${(item.participantes||[]).join(', ') || 'sem participantes'}`;
  }
  return `${item.numero || '(sem número)'} — ${item.titulo || '(sem título)'} · ${item.bugsPrevenidos} bugs`;
}

function fecharDialogoConflito() {
  document.getElementById('conflictBackdrop').classList.remove('open');
  pendingConflict = null;
}

function resolverConflito(escolha) {
  if (!pendingConflict) return;
  const { kind, localData, remoteData, applyFn } = pendingConflict;
  if (escolha === 'manter-minha') {
    // Grava a versão local por cima, avançando a versão a partir da remota.
    const merged = { ...localData, _version: (remoteData._version || 1) + 1 };
    applyFn(merged);
  } else if (escolha === 'usar-dela') {
    // Descarta a edição local, mantém a versão da colega, e reabre o item atualizado.
    if (kind === 'sprint') { Store.upsertSprint(remoteData); renderBoard(); }
    else { Store.upsertCard(remoteData); renderBoard(); }
    showToast('✓ Mantida a versão da colega.');
  } else if (escolha === 'duplicar') {
    const dup = { ...localData, id: uid(kind === 'sprint' ? 'sp' : 'card'), _version: 1 };
    applyFn(dup, true);
  }
  fecharDialogoConflito();
}

// ─── Sanitização anti-XSS ─────────────────────────────────────────────
function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

function sanitizeRichText(html) {
  if (!html) return '';
  const ALLOWED_TAGS = new Set([
    'b','strong','i','em','u','s','strike','del',
    'ul','ol','li','p','br','span','a','div',
    'h1','h2','h3','h4','blockquote','code','pre','input'
  ]);
  const ALLOWED_ATTRS = { 'a': ['href'], 'span': ['style'], 'input': ['type','checked'], 'div': [], 'p': [], 'li': [] };

  function sanitizeStyle(style) {
    const allowed = [];
    const hexRe = /^#[0-9a-fA-F]{3,8}$/;
    const rgbRe = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/;
    for (const part of (style || '').split(';')) {
      const [prop, ...rest] = part.split(':');
      const p = (prop || '').trim().toLowerCase();
      const v = rest.join(':').trim();
      if ((p === 'color' || p === 'background-color') && (hexRe.test(v) || rgbRe.test(v))) allowed.push(p + ':' + v);
    }
    return allowed.join(';');
  }

  const tmp = document.createElement('div');
  tmp.innerHTML = html;

  function clean(node) {
    const toRemove = [];
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase();
        if (!ALLOWED_TAGS.has(tag)) {
          while (child.firstChild) node.insertBefore(child.firstChild, child);
          toRemove.push(child);
        } else {
          const allowed = ALLOWED_ATTRS[tag] || [];
          const attrsToRemove = [];
          for (const attr of child.attributes) if (!allowed.includes(attr.name)) attrsToRemove.push(attr.name);
          attrsToRemove.forEach(a => child.removeAttribute(a));
          if (tag === 'a') {
            const href = child.getAttribute('href') || '';
            try { const p = new URL(href); if (p.protocol !== 'http:' && p.protocol !== 'https:') child.removeAttribute('href'); }
            catch { child.removeAttribute('href'); }
          }
          if (tag === 'input' && child.getAttribute('type') !== 'checkbox') child.setAttribute('type', 'checkbox');
          if (tag === 'span' && child.hasAttribute('style')) {
            const safe = sanitizeStyle(child.getAttribute('style'));
            if (safe) child.setAttribute('style', safe); else child.removeAttribute('style');
          }
          clean(child);
        }
      } else if (child.nodeType !== Node.TEXT_NODE) toRemove.push(child);
    }
    toRemove.forEach(n => n.parentNode && n.parentNode.removeChild(n));
  }
  clean(tmp);
  return tmp.innerHTML;
}

function renderDescricaoReadonly(html) {
  const safe = sanitizeRichText(html);
  const tmp = document.createElement('div');
  tmp.innerHTML = safe;
  tmp.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.setAttribute('disabled', ''));
  return tmp.innerHTML;
}

// Valida e normaliza URL (só http/https). Retorna null se inválida.
function normalizeUrl(url) {
  const u = (url || '').trim();
  if (!u) return null;
  try {
    const p = new URL(u);
    if (p.protocol !== 'http:' && p.protocol !== 'https:') return null;
    return u;
  } catch { return null; }
}

// ─── IDs / datas ────────────────────────────────────────────────────────
const uid = (prefix) => prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
const now = () => new Date().toISOString();
const fmtDate = (iso) => { if (!iso) return '—'; const [y,m,d] = iso.split('-'); return d+'/'+m+'/'+y; };
const fmtDateTime = (iso) => {
  if (!iso) return '—';
  try { const d = new Date(iso); return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'}); }
  catch { return '—'; }
};

const CARD_TEMPLATE =
  '<p><strong>📋 Descrição do Problema</strong></p><p><br></p>' +
  '<p><strong>✅ O que foi realizado?</strong></p><p><br></p>' +
  '<p><strong>🚨 Qual impacto foi evitado?</strong></p><p><br></p>' +
  '<p><strong>📎 Evidências</strong></p><p><br></p>' +
  '<p><strong>📝 Observações</strong></p><p><br></p>';

async function openExternal(url) {
  if (!url) return;
  const safe = normalizeUrl(url);
  if (!safe) return;
  if (window.electronAPI?.openExternal) await window.electronAPI.openExternal(safe);
  else window.open(safe, '_blank', 'noopener,noreferrer');
}

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ─── Estado global ─────────────────────────────────────────────────────
let expandedSquads  = new Set();
let expandedSprints = new Set();
let dashGenerated   = false;
let activeFilter    = 'todos';

function mostrarAba(nome) {
  ['board', 'dashboard', 'sobre'].forEach(id => {
    const cap = id[0].toUpperCase() + id.slice(1);
    document.getElementById('aba' + cap)?.classList.toggle('hidden', id !== nome);
    document.getElementById('tabBtn' + cap)?.classList.toggle('active', id === nome);
  });
  if (nome === 'dashboard') renderDashboard();
}

// ─── Render Board: Squad → Sprint → Card ───────────────────────────────
function renderBoard() {
  const squads    = Store.getSquads();
  const container = document.getElementById('sprintList');
  const countEl   = document.getElementById('boardCount');
  const emptyEl   = document.getElementById('boardEmpty');
  const totalSprints = Store.getSprints().length;
  const totalCards   = Store.getCards().length;

  ['todos','favoritos','arquivados'].forEach(f => {
    document.getElementById('filter-' + f)?.classList.toggle('active', activeFilter === f);
  });

  countEl.textContent = squads.length + ' squad' + (squads.length===1?'':'s') +
    ' · ' + totalSprints + ' sprint' + (totalSprints===1?'':'s') +
    ' · ' + totalCards + ' card' + (totalCards===1?'':'s');

  if (!squads.length) {
    container.innerHTML = '';
    emptyEl.classList.remove('hidden');
    return;
  }

  const squadsVisiveis = squads.filter(sq => {
    if (activeFilter === 'todos') return true;
    const sprintIds = Store.getSprintsBySquad(sq.id).map(s => s.id);
    const cards = Store.getCards().filter(c => sprintIds.includes(c.sprintId));
    if (activeFilter === 'favoritos')  return cards.some(c => c.favorito && !c.arquivado);
    if (activeFilter === 'arquivados') return cards.some(c => c.arquivado);
    return true;
  });

  if (!squadsVisiveis.length) {
    container.innerHTML = `<div class="empty-inline">Nenhum card encontrado para o filtro selecionado.</div>`;
    emptyEl.classList.add('hidden');
    return;
  }

  emptyEl.classList.add('hidden');
  container.innerHTML = squadsVisiveis.map(sq => renderSquadItem(sq)).join('');
  expandedSquads.forEach(id => document.getElementById('squad-' + id)?.classList.add('expanded'));
  expandedSprints.forEach(id => document.getElementById('sprint-' + id)?.classList.add('expanded'));
}

function renderLinksInline(links, cssClass) {
  if (!links || !links.length) return '';
  return links.map(l =>
    `<a href="#" class="${cssClass}" data-action="open-external" data-url="${escapeHtml(l.url)}" title="${escapeHtml(l.url)}">${escapeHtml(l.label || 'Link')}</a>`
  ).join('');
}

function renderSquadItem(sq) {
  const sprints = Store.getSprintsBySquad(sq.id);
  const totalCardsSquad = sprints.reduce((a, s) => a + Store.getCardsBySprint(s.id).length, 0);
  const idSafe = escapeHtml(sq.id);

  const sprintsVisiveis = sprints.filter(s => {
    if (activeFilter === 'todos') return true;
    const cards = Store.getCardsBySprint(s.id);
    if (activeFilter === 'favoritos')  return cards.some(c => c.favorito && !c.arquivado);
    if (activeFilter === 'arquivados') return cards.some(c => c.arquivado);
    return true;
  });

  const sprintsHtml = sprintsVisiveis.length
    ? sprintsVisiveis.map(s => renderSprintItem(s)).join('')
    : `<div class="cards-empty">Nenhuma sprint${activeFilter !== 'todos' ? ' para este filtro' : ''} nesta squad.</div>`;

  return `
<div class="squad-item" id="squad-${idSafe}">
  <div class="squad-header" data-action="toggle-squad" data-id="${idSafe}">
    <div class="sprint-chevron squad-chevron">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="9 18 15 12 9 6"/></svg>
    </div>
    <span class="squad-badge">👥 ${escapeHtml(sq.nome)}</span>
    <span class="squad-meta">${sprints.length} sprint${sprints.length===1?'':'s'} · ${totalCardsSquad} card${totalCardsSquad===1?'':'s'}</span>
    <div class="sprint-actions">
      <button class="icon-btn" title="Nova sprint" data-action="nova-sprint" data-squad-id="${idSafe}">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
      <button class="icon-btn" title="Editar squad" data-action="editar-squad" data-id="${idSafe}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
      <button class="icon-btn icon-btn-danger" title="Excluir squad" data-action="excluir-squad" data-id="${idSafe}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
      </button>
    </div>
  </div>
  <div class="squad-body" data-action="stop">
    ${sprintsHtml}
  </div>
</div>`;
}

function renderSprintItem(s) {
  const statusClass = { andamento: 'status-andamento', concluida: 'status-concluida', arquivada: 'status-arquivada' }[s.status] || 'status-andamento';
  const statusLabel = { andamento: 'Em andamento', concluida: 'Concluída', arquivada: 'Arquivada' }[s.status] || s.status;

  const allSprintCards = Store.getCardsBySprint(s.id);
  const cards = allSprintCards.filter(c => {
    if (activeFilter === 'arquivados') return c.arquivado;
    if (activeFilter === 'favoritos')  return c.favorito && !c.arquivado;
    return !c.arquivado;
  });
  const totalBugs     = allSprintCards.reduce((a,c) => a + (Number(c.bugsPrevenidos)||0), 0);
  const totalHoras    = allSprintCards.reduce((a,c) => a + (Number(c.horasEconomizadas)||0), 0);
  const numArquivados = allSprintCards.filter(c => c.arquivado).length;

  const participantesChips = (s.participantes || []).map(p => `<span class="participante-chip">${escapeHtml(p)}</span>`).join('');
  const linksHtml = renderLinksInline(s.links, 'sprint-link-chip');

  const cardsHtml = cards.length
    ? cards.map(c => renderCardItem(c)).join('')
    : `<div class="cards-empty">Nenhum card${activeFilter !== 'todos' ? ' para este filtro' : ''} nesta sprint.</div>`;

  const sprintIdSafe = escapeHtml(s.id);

  return `
<div class="sprint-item" id="sprint-${sprintIdSafe}">
  <div class="sprint-header" data-action="toggle-sprint" data-id="${sprintIdSafe}">
    <div class="sprint-chevron">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="9 18 15 12 9 6"/></svg>
    </div>
    <span class="sprint-badge">Sprint ${escapeHtml(String(s.numero))}</span>
    <div class="sprint-info">
      <div class="sprint-meta-row">
        <span class="status-badge ${statusClass}">${escapeHtml(statusLabel)}</span>
        <span class="sprint-meta-item">${escapeHtml(fmtDate(s.inicio))} → ${escapeHtml(fmtDate(s.fim))}</span>
        <span class="sprint-meta-item">${cards.length} card${cards.length===1?'':'s'}</span>
        ${totalBugs  ? `<span class="sprint-meta-item accent-amber">🛡 ${totalBugs} bugs</span>` : ''}
        ${totalHoras ? `<span class="sprint-meta-item accent-teal">⏱ ${totalHoras}h</span>` : ''}
      </div>
    </div>
    <div class="sprint-actions">
      <button class="icon-btn" title="Adicionar card" data-action="novo-card" data-sprint-id="${sprintIdSafe}">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
      <button class="icon-btn" title="Editar sprint" data-action="editar-sprint" data-id="${sprintIdSafe}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
      <button class="icon-btn icon-btn-danger" title="Excluir sprint" data-action="excluir-sprint" data-id="${sprintIdSafe}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
      </button>
    </div>
  </div>

  <div class="sprint-body" data-action="stop">
    <div class="sprint-detail-row">
      <div class="sprint-detail-group">
        <span class="sprint-detail-label">Links da Sprint</span>
        <div class="links-chips">${linksHtml || '<span class="muted small">Nenhum link cadastrado</span>'}</div>
      </div>
      <div class="sprint-detail-group">
        <span class="sprint-detail-label">Participantes</span>
        <div class="participantes-chips">${participantesChips || '<span class="muted small">Nenhum cadastrado</span>'}</div>
      </div>
    </div>

    <div class="cards-header">
      <span class="cards-header-title">
        Cards (${cards.length})
        ${numArquivados ? `<span class="archived-badge" title="${numArquivados} arquivado${numArquivados>1?'s':''}">📦 ${numArquivados}</span>` : ''}
      </span>
      <button class="btn btn-primary btn-sm" data-action="novo-card" data-sprint-id="${sprintIdSafe}">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Novo Card
      </button>
    </div>
    ${cardsHtml}
  </div>
</div>`;
}

function renderCardItem(c) {
  const idSafe = escapeHtml(c.id);
  const primeiroLink = (c.links && c.links[0]) ? c.links[0] : null;
  const numHtml = primeiroLink
    ? `<a href="#" class="card-numero" data-action="open-external" data-url="${escapeHtml(primeiroLink.url)}" title="${escapeHtml(primeiroLink.url)}">${escapeHtml(c.numero || '—')}</a>`
    : `<span class="card-numero no-link">${escapeHtml(c.numero || '—')}</span>`;

  const linksExtras = (c.links || []).slice(1);
  const linksHtml = linksExtras.length ? `<div class="card-links-row">${renderLinksInline(linksExtras, 'card-link-chip')}</div>` : '';

  const descHtml = c.descricao
    ? `<div class="card-desc" id="desc-${idSafe}">${renderDescricaoReadonly(c.descricao)}</div>
       <button class="link-btn" data-action="toggle-desc" data-id="${idSafe}">Ver mais ↓</button>`
    : '';

  const favClass  = c.favorito  ? 'icon-btn btn-fav active' : 'icon-btn btn-fav';
  const favTitle  = c.favorito  ? 'Remover favorito' : 'Favoritar';
  const archTitle = c.arquivado ? 'Desarquivar' : 'Arquivar';
  const archIcon  = c.arquivado ? '📂' : '📦';
  const cardClass = 'card-item' + (c.arquivado ? ' card-archived' : '') + (c.favorito && !c.arquivado ? ' card-favorited' : '');

  const atualizado = c.atualizadoEm && c.atualizadoEm !== c.criadoEm
    ? `<span>· Atualizado ${escapeHtml(fmtDateTime(c.atualizadoEm))}</span>` : '';

  const excluidoMetricasBadge = c.considerarMetricas === false
    ? `<span class="metrica-off-badge" title="Este card não entra nas métricas do Dashboard">Ø métricas</span>` : '';

  return `
<div class="${cardClass}" id="card-${idSafe}">
  <div class="card-top">
    ${numHtml}
    <span class="card-titulo">${escapeHtml(c.titulo || '—')}</span>
    <div class="card-actions">
      <button class="${favClass}" title="${favTitle}" data-action="favoritar-card" data-id="${idSafe}">⭐</button>
      <button class="icon-btn" title="${archTitle}" data-action="arquivar-card" data-id="${idSafe}"><span>${archIcon}</span></button>
      <button class="icon-btn" title="Duplicar" data-action="duplicar-card" data-id="${idSafe}">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      </button>
      <button class="icon-btn" title="Editar" data-action="editar-card" data-id="${idSafe}">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
      <button class="icon-btn icon-btn-danger" title="Excluir" data-action="excluir-card" data-id="${idSafe}">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
      </button>
    </div>
  </div>
  ${linksHtml}
  <div class="card-metrics">
    <span class="card-metric bugs">🛡 <span class="val">${escapeHtml(String(c.bugsPrevenidos || 0))}</span> bug${c.bugsPrevenidos===1?'':'s'} prevenido${c.bugsPrevenidos===1?'':'s'}</span>
    ${c.horasEconomizadas ? `<span class="card-metric horas">⏱ <span class="val">${escapeHtml(String(c.horasEconomizadas))}</span>h economizada${c.horasEconomizadas===1?'':'s'}</span>` : ''}
  </div>
  <div class="card-footer">
    <span>Criado por <span class="card-autor">${escapeHtml(c.criadoPor || '—')}</span></span>
    ${c.responsavel ? `<span>·</span><span>Responsável <span class="card-autor">${escapeHtml(c.responsavel)}</span></span>` : ''}
    <span>·</span>
    <span title="Criado em">${escapeHtml(fmtDateTime(c.criadoEm))}</span>
    ${atualizado}
    ${excluidoMetricasBadge}
  </div>
  ${descHtml}
</div>`;
}

function toggleSquad(id) {
  const el = document.getElementById('squad-' + id);
  if (!el) return;
  el.classList.toggle('expanded');
  if (el.classList.contains('expanded')) expandedSquads.add(id); else expandedSquads.delete(id);
}
function toggleSprint(id) {
  const el = document.getElementById('sprint-' + id);
  if (!el) return;
  el.classList.toggle('expanded');
  if (el.classList.contains('expanded')) expandedSprints.add(id); else expandedSprints.delete(id);
}
function toggleDesc(cardId) {
  const desc = document.getElementById('desc-' + cardId);
  const btn  = desc?.nextElementSibling;
  if (!desc) return;
  desc.classList.toggle('expanded');
  if (btn) btn.textContent = desc.classList.contains('expanded') ? 'Ver menos ↑' : 'Ver mais ↓';
}

function setFilter(f) { activeFilter = f; renderBoard(); }

// ─── Modal Squad ────────────────────────────────────────────────────────
let editingSquadId = null;

function abrirModalSquad(id = null) {
  editingSquadId = id;
  const sq = id ? Store.getSquads().find(x => x.id === id) : null;
  document.getElementById('modalSquadTitle').textContent = sq ? 'Editar Squad' : 'Nova Squad';
  document.getElementById('squadNome').value = sq ? sq.nome : '';
  document.getElementById('modalSquad').classList.add('open');
  document.getElementById('squadNome').focus();
}
function fecharModalSquad() {
  document.getElementById('modalSquad').classList.remove('open');
  editingSquadId = null;
}
function salvarSquad() {
  const nome = document.getElementById('squadNome').value.trim();
  if (!nome) { showToast('⚠ Nome da squad é obrigatório.'); return; }
  const existing = editingSquadId ? Store.getSquads().find(s => s.id === editingSquadId) : null;
  const squad = { id: editingSquadId || uid('sq'), nome, criadoEm: existing ? existing.criadoEm : now() };
  Store.upsertSquad(squad);
  fecharModalSquad();
  renderBoard();
  showToast(editingSquadId ? '✓ Squad atualizada.' : '✓ Squad criada.');
}

// ─── Links dinâmicos (Sprint e Card) ───────────────────────────────────
let sprintLinksAtual = [];
let cardLinksAtual   = [];

function renderLinksEditor(containerId, links) {
  const wrap = document.getElementById(containerId);
  if (!links.length) {
    wrap.innerHTML = '<div class="links-empty">Nenhum link adicionado ainda.</div>';
    return;
  }
  wrap.innerHTML = links.map((l, i) => `
    <div class="link-row" data-idx="${i}">
      <input type="text" class="link-label-input" placeholder="Rótulo (ex: Jira)" value="${escapeHtml(l.label)}" data-link-field="label" data-idx="${i}" data-target="${containerId}">
      <input type="url" class="link-url-input" placeholder="https://..." value="${escapeHtml(l.url)}" data-link-field="url" data-idx="${i}" data-target="${containerId}">
      <button class="icon-btn icon-btn-danger" data-action="remover-link" data-target="${containerId}" data-idx="${i}" title="Remover">✕</button>
    </div>
  `).join('');
}

function adicionarLink(containerId) {
  const arr = containerId === 'sprintLinksContainer' ? sprintLinksAtual : cardLinksAtual;
  arr.push({ label: '', url: '' });
  renderLinksEditor(containerId, arr);
}

function removerLink(containerId, idx) {
  const arr = containerId === 'sprintLinksContainer' ? sprintLinksAtual : cardLinksAtual;
  arr.splice(idx, 1);
  renderLinksEditor(containerId, arr);
}

function atualizarCampoLink(containerId, idx, field, value) {
  const arr = containerId === 'sprintLinksContainer' ? sprintLinksAtual : cardLinksAtual;
  if (!arr[idx]) return;
  arr[idx][field] = value;
}

// Filtra links vazios/incompletos e valida URL antes de salvar.
function linksValidosParaSalvar(arr) {
  return arr
    .map(l => ({ label: (l.label || '').trim() || 'Link', url: normalizeUrl(l.url) }))
    .filter(l => l.url);
}

// ─── Modal Sprint ──────────────────────────────────────────────────────
let editingSprintId = null;
let editingSprintSquadCtx = null;
let editingSprintVersion = 1;
let participantesAtual = [];

function abrirModalSprint(id = null, squadId = null) {
  editingSprintId = id;
  editingSprintSquadCtx = squadId;
  const s = id ? Store.getSprints().find(x => x.id === id) : null;
  editingSprintVersion = s ? (s._version || 1) : 1;

  document.getElementById('modalSprintTitle').textContent = s ? 'Editar Sprint' : 'Nova Sprint';

  const squadSel = document.getElementById('sprintSquad');
  squadSel.innerHTML = Store.getSquads().map(sq =>
    `<option value="${escapeHtml(sq.id)}" ${(sq.id === (s?.squadId || squadId)) ? 'selected' : ''}>${escapeHtml(sq.nome)}</option>`).join('');

  document.getElementById('sprintNumero').value = s ? s.numero : '';
  document.getElementById('sprintInicio').value = s ? s.inicio : '';
  document.getElementById('sprintFim').value    = s ? s.fim    : '';
  document.getElementById('sprintStatus').value = s ? s.status : 'andamento';

  participantesAtual = s ? [...(s.participantes || [])] : [];
  renderParticipantesChips();

  sprintLinksAtual = s ? (s.links || []).map(l => ({...l})) : [];
  renderLinksEditor('sprintLinksContainer', sprintLinksAtual);

  document.getElementById('modalSprint').classList.add('open');
  document.getElementById('sprintNumero').focus();
}
function fecharModalSprint() {
  document.getElementById('modalSprint').classList.remove('open');
  editingSprintId = null;
}

function renderParticipantesChips() {
  const wrap = document.getElementById('participantesChips');
  wrap.innerHTML = participantesAtual.map((p, i) =>
    `<span class="tag-chip">${escapeHtml(p)}<span class="tag-chip-remove" data-action="remover-participante" data-id="${i}">×</span></span>`
  ).join('');
}
function removerParticipante(idx) { participantesAtual.splice(idx, 1); renderParticipantesChips(); }

function participanteKeydown(e) {
  const input = document.getElementById('participanteInput');
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    const v = input.value.trim().replace(/,$/, '');
    if (v && !participantesAtual.includes(v)) { participantesAtual.push(v); renderParticipantesChips(); }
    input.value = '';
  }
}

async function salvarSprint() {
  const pInput = document.getElementById('participanteInput');
  const pVal = pInput.value.trim();
  if (pVal && !participantesAtual.includes(pVal)) { participantesAtual.push(pVal); pInput.value=''; renderParticipantesChips(); }

  const squadId = document.getElementById('sprintSquad').value;
  if (!squadId) { showToast('⚠ Selecione uma squad.'); return; }

  const numero = parseInt(document.getElementById('sprintNumero').value, 10);
  if (!numero || numero < 1) { showToast('⚠ Número da sprint é obrigatório.'); return; }

  const inicio = document.getElementById('sprintInicio').value;
  const fim    = document.getElementById('sprintFim').value;
  if (inicio && fim && fim < inicio) { showToast('⚠ Data de fim anterior à de início.'); return; }

  const existing = editingSprintId ? Store.getSprints().find(s => s.id === editingSprintId) : null;
  const nomeUsuario = DB.config.nomeUsuario || null;

  const buildSprint = (overrideVersion) => ({
    id: editingSprintId || uid('sp'),
    squadId,
    numero,
    titulo: 'Sprint ' + numero,
    inicio, fim,
    status: document.getElementById('sprintStatus').value,
    participantes: participantesAtual.slice(),
    links: linksValidosParaSalvar(sprintLinksAtual),
    criadaEm: existing ? (existing.criadaEm || now()) : now(),
    atualizadaEm: now(),
    _version: overrideVersion != null ? overrideVersion : ((existing?._version || 0) + 1),
    _editedBy: nomeUsuario,
    _editedAt: now()
  });

  if (editingSprintId) {
    const remote = await checkConflict('sprint', editingSprintId, editingSprintVersion);
    if (remote) {
      const local = buildSprint(editingSprintVersion);
      abrirDialogoConflito('sprint', local, remote, (finalData, isNew) => {
        Store.upsertSprint(finalData);
        fecharModalSprint();
        renderBoard();
        showToast(isNew ? '✓ Sprint duplicada como nova.' : '✓ Sprint salva.');
      });
      return;
    }
  }

  const sprint = buildSprint();
  Store.upsertSprint(sprint);
  fecharModalSprint();
  renderBoard();
  showToast(editingSprintId ? '✓ Sprint atualizada.' : '✓ Sprint criada.');
}

// ─── Modal Card ────────────────────────────────────────────────────────
let editingCardId    = null;
let editingSprintCtx = null;
let editingCardVersion = 1;

function abrirModalCard(cardId = null, sprintId = null) {
  editingCardId    = cardId;
  editingSprintCtx = sprintId;
  const c = cardId ? Store.getCards().find(x => x.id === cardId) : null;
  editingCardVersion = c ? (c._version || 1) : 1;

  document.getElementById('modalCardTitle').textContent = c ? 'Editar Card' : 'Novo Card';

  const sel = document.getElementById('cardSprint');
  sel.innerHTML = Store.getSprints()
    .map(s => `<option value="${escapeHtml(s.id)}" ${(s.id === (c?.sprintId || sprintId)) ? 'selected' : ''}>Sprint ${escapeHtml(String(s.numero))}</option>`)
    .join('');

  const config = Store.getConfig();
  document.getElementById('cardNumero').value    = c ? (c.numero || '') : '';
  document.getElementById('cardTitulo').value    = c ? (c.titulo  || '') : '';
  document.getElementById('cardBugs').value      = c ? (c.bugsPrevenidos ?? '') : '';
  document.getElementById('cardHoras').value     = c ? (c.horasEconomizadas ?? '') : '';
  document.getElementById('cardCriadoPor').value = c ? (c.criadoPor || '') : (config.nomeUsuario || '');
  document.getElementById('cardResponsavel').value = c ? (c.responsavel || '') : '';
  document.getElementById('cardConsiderarMetricas').checked = c ? (c.considerarMetricas !== false) : true;

  cardLinksAtual = c ? (c.links || []).map(l => ({...l})) : [];
  renderLinksEditor('cardLinksContainer', cardLinksAtual);

  const rteBody = document.getElementById('rteBody');
  rteBody.innerHTML = c ? sanitizeRichText(c.descricao || '') : CARD_TEMPLATE;

  document.getElementById('modalCard').classList.add('open');
  document.getElementById('cardNumero').focus();
}
function fecharModalCard() {
  document.getElementById('modalCard').classList.remove('open');
  editingCardId = editingSprintCtx = null;
}

async function salvarCard() {
  const sprintId = document.getElementById('cardSprint').value;
  if (!sprintId) { showToast('⚠ Selecione uma sprint.'); return; }

  const bugs = parseInt(document.getElementById('cardBugs').value, 10);
  if (isNaN(bugs) || bugs < 0) { showToast('⚠ Bugs prevenidos é obrigatório (≥ 0).'); return; }

  const horasRaw = document.getElementById('cardHoras').value;
  const horas = horasRaw === '' ? null : parseFloat(horasRaw);

  const rteBody = document.getElementById('rteBody');
  rteBody.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.toggleAttribute('checked', cb.checked));

  const existing = editingCardId ? Store.getCards().find(c => c.id === editingCardId) : null;
  const nomeUsuario = DB.config.nomeUsuario || document.getElementById('cardCriadoPor').value.trim();

  const buildCard = (overrideVersion) => ({
    id: editingCardId || uid('card'),
    sprintId,
    numero: document.getElementById('cardNumero').value.trim(),
    links: linksValidosParaSalvar(cardLinksAtual),
    titulo: document.getElementById('cardTitulo').value.trim(),
    bugsPrevenidos: bugs,
    horasEconomizadas: horas,
    criadoPor: document.getElementById('cardCriadoPor').value.trim(),
    responsavel: document.getElementById('cardResponsavel').value.trim(),
    considerarMetricas: document.getElementById('cardConsiderarMetricas').checked,
    descricao: sanitizeRichText(rteBody.innerHTML),
    favorito: existing ? (existing.favorito || false) : false,
    arquivado: existing ? (existing.arquivado || false) : false,
    criadoEm: existing ? (existing.criadoEm || now()) : now(),
    atualizadoEm: now(),
    _version: overrideVersion != null ? overrideVersion : ((existing?._version || 0) + 1),
    _editedBy: nomeUsuario,
    _editedAt: now()
  });

  if (editingCardId) {
    const remote = await checkConflict('card', editingCardId, editingCardVersion);
    if (remote) {
      const local = buildCard(editingCardVersion);
      abrirDialogoConflito('card', local, remote, (finalData, isNew) => {
        Store.upsertCard(finalData);
        expandedSprints.add(finalData.sprintId);
        fecharModalCard();
        renderBoard();
        showToast(isNew ? '✓ Card duplicado como novo.' : '✓ Card salvo.');
      });
      return;
    }
  }

  const card = buildCard();
  Store.upsertCard(card);
  expandedSprints.add(sprintId);
  fecharModalCard();
  renderBoard();
  showToast(editingCardId ? '✓ Card atualizado.' : '✓ Card criado.');
}

function duplicarCard(cardId) {
  const c = Store.getCards().find(x => x.id === cardId);
  if (!c) return;
  const novo = Object.assign({}, c, {
    id: uid('card'),
    numero: c.numero ? c.numero + '-cópia' : '',
    titulo: (c.titulo || '') + ' (cópia)',
    favorito: false, arquivado: false,
    criadoEm: now(), atualizadoEm: now(),
    _version: 1, _editedBy: DB.config.nomeUsuario || null, _editedAt: now()
  });
  Store.upsertCard(novo);
  expandedSprints.add(novo.sprintId);
  renderBoard();
  showToast('✓ Card duplicado.');
}

function toggleFavorito(cardId) {
  const c = Store.getCards().find(x => x.id === cardId);
  if (!c) return;
  const updated = Object.assign({}, c, { favorito: !c.favorito, atualizadoEm: now(), _version: (c._version||1)+1 });
  Store.upsertCard(updated);
  renderBoard();
  showToast(updated.favorito ? '⭐ Card favoritado.' : '✓ Favorito removido.');
}
function toggleArquivar(cardId) {
  const c = Store.getCards().find(x => x.id === cardId);
  if (!c) return;
  const updated = Object.assign({}, c, { arquivado: !c.arquivado, atualizadoEm: now(), _version: (c._version||1)+1 });
  Store.upsertCard(updated);
  renderBoard();
  showToast(updated.arquivado ? '📦 Card arquivado.' : '📂 Card desarquivado.');
}

// ─── Confirmação de exclusão ───────────────────────────────────────────
let pendingDelete = null;
function confirmarExclusao(tipo, id) {
  pendingDelete = { tipo, id };
  const msgs = {
    squad: 'Excluir esta squad e todas as suas sprints e cards? Esta ação não pode ser desfeita.',
    sprint: 'Excluir esta sprint e todos os seus cards? Esta ação não pode ser desfeita.',
    card: 'Excluir este card? Esta ação não pode ser desfeita.'
  };
  document.getElementById('confirmMsg').textContent = msgs[tipo];
  document.getElementById('confirmBackdrop').classList.add('open');
}
function fecharConfirm() {
  document.getElementById('confirmBackdrop').classList.remove('open');
  pendingDelete = null;
}
function executarExclusao() {
  if (!pendingDelete) return;
  const { tipo, id } = pendingDelete;
  if (tipo === 'squad') { Store.deleteSquad(id); expandedSquads.delete(id); showToast('✓ Squad excluída.'); }
  else if (tipo === 'sprint') { Store.deleteSprint(id); expandedSprints.delete(id); showToast('✓ Sprint excluída.'); }
  else { Store.deleteCard(id); showToast('✓ Card excluído.'); }
  fecharConfirm();
  renderBoard();
  dashGenerated = false;
}

// ─── Rich Text Editor ──────────────────────────────────────────────────
function rteCmd(cmd, value = null) { document.getElementById('rteBody').focus(); document.execCommand(cmd, false, value); }
function rteInsertLink() {
  const url = prompt('URL do link (https://...):');
  if (!url) return;
  const safe = normalizeUrl(url);
  if (!safe) { showToast('⚠ URL inválida ou protocolo não permitido.'); return; }
  rteCmd('createLink', safe);
}
function rteSetColor(type, value) {
  document.execCommand('styleWithCSS', false, true);
  rteCmd(type === 'text' ? 'foreColor' : 'hiliteColor', value);
}
function rteInsertChecklist() {
  document.getElementById('rteBody').focus();
  document.execCommand('insertHTML', false, '<div><input type="checkbox"> &ZeroWidthSpace;</div>');
}
function rteInsertTemplate() {
  const rteBody = document.getElementById('rteBody');
  if (!rteBody) return;
  if (!rteBody.textContent.trim()) rteBody.innerHTML = CARD_TEMPLATE;
  else { rteBody.focus(); document.execCommand('insertHTML', false, '<br>' + CARD_TEMPLATE); }
}

// ─── Boas-vindas / Config de usuário ───────────────────────────────────
function abrirModalBoasVindas() {
  document.getElementById('modalBoasVindas').classList.add('open');
  document.getElementById('nomeUsuarioInput').focus();
}
function fecharModalBoasVindas() { document.getElementById('modalBoasVindas').classList.remove('open'); }

function salvarNomeUsuario() {
  const nome = (document.getElementById('nomeUsuarioInput').value || '').trim();
  if (!nome) { showToast('⚠ Informe seu nome para continuar.'); return; }
  Store.saveConfig({ nomeUsuario: nome });
  const sobreNome = document.getElementById('sobreNomeUsuario');
  if (sobreNome) sobreNome.value = nome;
  fecharModalBoasVindas();
  abrirModalPastaCompartilhada();
}
function salvarNomeSobre() {
  const nome = (document.getElementById('sobreNomeUsuario').value || '').trim();
  if (!nome) { showToast('⚠ Nome não pode ser vazio.'); return; }
  Store.saveConfig({ nomeUsuario: nome });
  showToast('✓ Nome atualizado.');
}

// ─── Configuração de pasta compartilhada ───────────────────────────────
function abrirModalPastaCompartilhada() {
  document.getElementById('modalPasta').classList.add('open');
}
function fecharModalPastaCompartilhada() {
  document.getElementById('modalPasta').classList.remove('open');
  if (!DB.config.pastaConfigurada) Store.saveConfig({ pastaConfigurada: true }); // não pergunta de novo
}

async function escolherPastaCompartilhada() {
  if (!window.electronAPI?.data) { showToast('⚠ Recurso disponível apenas no aplicativo desktop.'); return; }
  const res = await window.electronAPI.data.pickFolder();
  if (!res.ok || res.canceled) return;
  Store.saveConfig({ pastaCompartilhada: res.folderPath, pastaConfigurada: true });
  document.getElementById('modalPasta').classList.remove('open');
  showToast('☁️ Conectando à pasta compartilhada…');
  await loadFromDisk();
  renderBoard();
  updateSobrePasta();
}

function usarSomenteLocal() {
  Store.saveConfig({ pastaConfigurada: true });
  document.getElementById('modalPasta').classList.remove('open');
  showToast('💻 Usando armazenamento local neste computador.');
}

async function desconectarPastaCompartilhada() {
  if (window.electronAPI?.data) await window.electronAPI.data.watchStop();
  Store.saveConfig({ pastaCompartilhada: null });
  syncStatus = 'local';
  updateSyncIndicator();
  updateSobrePasta();
  showToast('✓ Desconectado da pasta compartilhada. Dados continuam salvos localmente.');
}

function updateSobrePasta() {
  const el = document.getElementById('sobrePastaAtual');
  if (!el) return;
  el.textContent = DB.config.pastaCompartilhada || 'Nenhuma (somente local)';
  const btnDesconectar = document.getElementById('btnDesconectarPasta');
  if (btnDesconectar) btnDesconectar.classList.toggle('hidden', !DB.config.pastaCompartilhada);
}

// ─── Dashboard ─────────────────────────────────────────────────────────
// Foco em indicadores de negócio (Squads, Sprints, Cards, Bugs Prevenidos).
// Horas Economizadas continua no cadastro do Card (campo opcional), mas não
// é mais destaque visual aqui. Cards com considerarMetricas=false continuam
// visíveis no board normalmente, mas são excluídos de TODO cálculo abaixo.
let dashScope = 'geral'; // 'geral' | 'squad' | 'sprint'

function cardsParaMetricas() {
  return Store.getCards().filter(c => c.considerarMetricas !== false);
}

function renderDashboard() {
  const genWrap  = document.getElementById('dashGenerate');
  const dashData = document.getElementById('dashData');
  if (!dashGenerated) { genWrap.classList.remove('hidden'); dashData.classList.add('hidden'); return; }
  genWrap.classList.add('hidden'); dashData.classList.remove('hidden');

  renderDashScopeSelectors();

  const allCards = cardsParaMetricas();
  let squads  = Store.getSquads();
  let sprints = Store.getSprints();
  let cards   = allCards;

  if (dashScope === 'squad') {
    const squadId = document.getElementById('dashScopeSquad')?.value;
    if (squadId) {
      squads  = squads.filter(s => s.id === squadId);
      sprints = sprints.filter(s => s.squadId === squadId);
      const sprintIds = sprints.map(s => s.id);
      cards = allCards.filter(c => sprintIds.includes(c.sprintId));
    }
  } else if (dashScope === 'sprint') {
    const sprintId = document.getElementById('dashScopeSprint')?.value;
    if (sprintId) {
      sprints = sprints.filter(s => s.id === sprintId);
      squads  = squads.filter(sq => sprints.some(s => s.squadId === sq.id));
      cards = allCards.filter(c => c.sprintId === sprintId);
    }
  }

  const totalBugs = cards.reduce((a,c) => a + (Number(c.bugsPrevenidos)||0), 0);

  // ── KPIs principais (4, com cores fixas) ──────────────────────────────
  set('kpiSquads', squads.length);
  set('kpiSprints', sprints.length);
  set('kpiCards', cards.length);
  set('kpiBugs', totalBugs);

  // ── Top Sprints / Top Cards (bugs) ────────────────────────────────────
  const sprintBugs = sprints.map(s => {
    const sc = cards.filter(c => c.sprintId === s.id);
    return { s, bugs: sc.reduce((a,c) => a + (Number(c.bugsPrevenidos)||0), 0) };
  }).sort((a,b) => b.bugs - a.bugs);

  document.getElementById('topSprint').innerHTML = sprintBugs.length
    ? sprintBugs.slice(0,5).map((x,i) => `<div class="dash-top-item"><span class="dash-rank">#${i+1}</span><span class="dash-top-name">Sprint ${escapeHtml(String(x.s.numero))}</span><span class="dash-top-val">${x.bugs} bug${x.bugs===1?'':'s'}</span></div>`).join('')
    : '<div class="muted small pad">Sem dados</div>';

  const sortedCards = cards.slice().sort((a,b) => (Number(b.bugsPrevenidos)||0) - (Number(a.bugsPrevenidos)||0));
  document.getElementById('topCards').innerHTML = sortedCards.length
    ? sortedCards.slice(0,5).map((c,i) => `<div class="dash-top-item"><span class="dash-rank">#${i+1}</span><span class="dash-top-name">${escapeHtml(c.numero || c.titulo || '—')}</span><span class="dash-top-val gold">${Number(c.bugsPrevenidos)||0} bug${(Number(c.bugsPrevenidos)||0)===1?'':'s'}</span></div>`).join('')
    : '<div class="muted small pad">Sem dados</div>';

  // ── Bugs Prevenidos por Squad ──────────────────────────────────────────
  const squadBugs = squads.map(sq => {
    const sprintIds = Store.getSprintsBySquad(sq.id).map(s => s.id).filter(id => sprints.some(s=>s.id===id));
    const bugs = cards.filter(c => sprintIds.includes(c.sprintId)).reduce((a,c)=>a+(Number(c.bugsPrevenidos)||0),0);
    return { sq, bugs };
  }).sort((a,b) => b.bugs - a.bugs);
  const maxSquadBugs = squadBugs.length ? Math.max(...squadBugs.map(x=>x.bugs), 1) : 1;
  document.getElementById('bugsPerSquad').innerHTML = squadBugs.length
    ? squadBugs.map(x => `<div class="dash-bar-row"><div class="dash-bar-label"><span class="dash-bar-name">👥 ${escapeHtml(x.sq.nome)}</span><span class="dash-bar-num">${x.bugs}</span></div><div class="dash-bar-track"><div class="dash-bar-fill bar-azul" style="width:${Math.round(x.bugs/maxSquadBugs*100)}%"></div></div></div>`).join('')
    : '<div class="muted small">Sem dados</div>';

  // ── Bugs Prevenidos por Sprint ──────────────────────────────────────────
  const maxBugs = sprintBugs.length ? Math.max(...sprintBugs.map(x=>x.bugs), 1) : 1;
  document.getElementById('bugsPerSprint').innerHTML = sprintBugs.length
    ? sprintBugs.slice(0,8).map(x => `<div class="dash-bar-row"><div class="dash-bar-label"><span class="dash-bar-name">Sprint ${escapeHtml(String(x.s.numero))}</span><span class="dash-bar-num">${x.bugs}</span></div><div class="dash-bar-track"><div class="dash-bar-fill bar-turquesa" style="width:${Math.round(x.bugs/maxBugs*100)}%"></div></div></div>`).join('')
    : '<div class="muted small">Sem dados</div>';

  // ── Bugs Prevenidos por Responsável ─────────────────────────────────────
  const byResp = {};
  cards.forEach(c => {
    const r = (c.responsavel || '').trim() || 'Sem responsável definido';
    byResp[r] = (byResp[r] || 0) + (Number(c.bugsPrevenidos) || 0);
  });
  const sortedResp = Object.entries(byResp).sort((a,b) => b[1] - a[1]);
  const maxResp = sortedResp.length ? Math.max(...sortedResp.map(([,v])=>v), 1) : 1;
  document.getElementById('bugsPerResponsavel').innerHTML = sortedResp.length
    ? sortedResp.slice(0,8).map(([name,bugs]) => `<div class="dash-bar-row"><div class="dash-bar-label"><span class="dash-bar-name">${escapeHtml(name)}</span><span class="dash-bar-num">${bugs}</span></div><div class="dash-bar-track"><div class="dash-bar-fill bar-roxo" style="width:${Math.round(bugs/maxResp*100)}%"></div></div></div>`).join('')
    : '<div class="muted small">Sem dados</div>';
}

function renderDashScopeSelectors() {
  const wrap = document.getElementById('dashScopeExtra');
  ['dashScopeGeral','dashScopeSquadBtn','dashScopeSprintBtn'].forEach(id => {
    document.getElementById(id)?.classList.toggle('active', document.getElementById(id)?.dataset.scope === dashScope);
  });
  if (dashScope === 'squad') {
    wrap.innerHTML = `<select id="dashScopeSquad" class="dash-scope-select">${Store.getSquads().map(sq => `<option value="${escapeHtml(sq.id)}">${escapeHtml(sq.nome)}</option>`).join('')}</select>`;
  } else if (dashScope === 'sprint') {
    wrap.innerHTML = `<select id="dashScopeSprint" class="dash-scope-select">${Store.getSprints().map(s => `<option value="${escapeHtml(s.id)}">Sprint ${escapeHtml(String(s.numero))}</option>`).join('')}</select>`;
  } else {
    wrap.innerHTML = '';
  }
}

function setDashScope(scope) {
  dashScope = scope;
  renderDashboard();
}

function set(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function gerarDashboard() { dashGenerated = true; dashScope = 'geral'; renderDashboard(); }

// ─── Delegação de eventos ──────────────────────────────────────────────
function handleAction(el) {
  const action = el.dataset.action;
  const id = el.dataset.id;
  switch (action) {
    case 'stop': return;
    case 'nova-squad':          return abrirModalSquad(null);
    case 'editar-squad':        return abrirModalSquad(id);
    case 'excluir-squad':       return confirmarExclusao('squad', id);
    case 'toggle-squad':        return toggleSquad(id);
    case 'nova-sprint':         return abrirModalSprint(null, el.dataset.squadId);
    case 'editar-sprint':       return abrirModalSprint(id, null);
    case 'excluir-sprint':      return confirmarExclusao('sprint', id);
    case 'toggle-sprint':       return toggleSprint(id);
    case 'novo-card':           return abrirModalCard(null, el.dataset.sprintId);
    case 'editar-card':         return abrirModalCard(id, null);
    case 'excluir-card':        return confirmarExclusao('card', id);
    case 'duplicar-card':       return duplicarCard(id);
    case 'favoritar-card':      return toggleFavorito(id);
    case 'arquivar-card':       return toggleArquivar(id);
    case 'toggle-desc':         return toggleDesc(id);
    case 'open-external':       return openExternal(el.dataset.url);
    case 'set-filter':          return setFilter(el.dataset.filter);
    case 'mostrar-aba':         return mostrarAba(el.dataset.aba);
    case 'fechar-modal-squad':  return fecharModalSquad();
    case 'fechar-modal-sprint': return fecharModalSprint();
    case 'fechar-modal-card':   return fecharModalCard();
    case 'fechar-boas-vindas':  return fecharModalBoasVindas();
    case 'fechar-confirm':      return fecharConfirm();
    case 'salvar-squad':        return salvarSquad();
    case 'salvar-sprint':       return salvarSprint();
    case 'salvar-card':         return salvarCard();
    case 'salvar-nome-usuario': return salvarNomeUsuario();
    case 'salvar-nome-sobre':   return salvarNomeSobre();
    case 'executar-exclusao':   return executarExclusao();
    case 'rte-cmd':              return rteCmd(el.dataset.cmd);
    case 'rte-checklist':        return rteInsertChecklist();
    case 'rte-link':             return rteInsertLink();
    case 'rte-template':         return rteInsertTemplate();
    case 'remover-participante': return removerParticipante(Number(id));
    case 'gerar-dashboard':      return gerarDashboard();
    case 'dash-scope':           return setDashScope(el.dataset.scope);
    case 'focus-participante':   return document.getElementById('participanteInput').focus();
    case 'adicionar-link':       return adicionarLink(el.dataset.target);
    case 'remover-link':         return removerLink(el.dataset.target, Number(el.dataset.idx));
    case 'escolher-pasta':       return escolherPastaCompartilhada();
    case 'usar-somente-local':   return usarSomenteLocal();
    case 'fechar-modal-pasta':   return fecharModalPastaCompartilhada();
    case 'desconectar-pasta':    return desconectarPastaCompartilhada();
    case 'fechar-conflito':      return fecharDialogoConflito();
    case 'resolver-manter-minha': return resolverConflito('manter-minha');
    case 'resolver-usar-dela':    return resolverConflito('usar-dela');
    case 'resolver-duplicar':     return resolverConflito('duplicar');
  }
}

// ─── Inicialização ─────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    e.preventDefault();
    handleAction(el);
  });

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset && el.dataset.linkField) {
      atualizarCampoLink(el.dataset.target, Number(el.dataset.idx), el.dataset.linkField, el.value);
    }
  });

  // Selects dinâmicos do escopo do Dashboard (Por Squad / Por Sprint)
  document.addEventListener('change', (e) => {
    if (e.target.id === 'dashScopeSquad' || e.target.id === 'dashScopeSprint') renderDashboard();
  });

  document.getElementById('participanteInput')?.addEventListener('keydown', participanteKeydown);
  document.getElementById('nomeUsuarioInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') salvarNomeUsuario(); });
  document.getElementById('rteColorText')?.addEventListener('change', (e) => rteSetColor('text', e.target.value));
  document.getElementById('rteColorBg')?.addEventListener('change', (e) => rteSetColor('bg', e.target.value));

  if (window.electronAPI?.data) window.electronAPI.data.onChange(onExternalChange);

  migrateIfNeeded();
  await loadFromDisk();

  // Cria squad padrão se não houver nenhuma (primeiro uso do app)
  if (!DB.squads.length) {
    DB.squads.push({ id: uid('sq'), nome: 'Squad Padrão', criadoEm: now() });
    persist();
  }

  const config = Store.getConfig();
  if (!config.nomeUsuario) {
    abrirModalBoasVindas();
  } else if (!config.pastaConfigurada) {
    abrirModalPastaCompartilhada();
  }

  const sobreNome = document.getElementById('sobreNomeUsuario');
  if (sobreNome) sobreNome.value = config.nomeUsuario || '';
  updateSobrePasta();

  renderBoard();
  mostrarAba('board');
});
