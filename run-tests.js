// Teste de execução real (Chromium via Playwright) do Board de Cards Preventivos.
// NÃO é o Electron real (não há rede/npm disponível neste ambiente para instalá-lo),
// mas é o mesmo motor Chromium/Blink que o Electron embute — o meta tag de CSP e a
// interpretação de onclick/onchange/inline style são idênticas nesse nível.
// window.electronAPI (exposto via preload no Electron real) não existe aqui, então
// openExternal() cai no fallback window.open() já previsto no próprio renderer.js.

const { chromium } = require('playwright');
const path = require('path');

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra: extra || '' });
  console.log((cond ? 'OK   ' : 'FAIL ') + name + (extra ? '  -- ' + extra : ''));
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const cspViolations = [];
  const consoleErrors = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (/Content Security Policy|Refused to/i.test(text)) cspViolations.push(text);
    if (msg.type() === 'error') consoleErrors.push(text);
  });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

  // Intercepta window.open (usado pelo fallback de openExternal fora do Electron)
  await page.addInitScript(() => {
    window.__openedUrls = [];
    window.open = (url) => { window.__openedUrls.push(url); return null; };
  });

  const fileUrl = 'file://' + path.join(__dirname, '..', 'index.html');
  await page.goto(fileUrl);

  // Sempre começa limpo
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForTimeout(200);

  // ── 1. Modal inicial (boas-vindas) ────────────────────────────────────
  const welcomeOpen = await page.evaluate(() => document.getElementById('modalBoasVindas').classList.contains('open'));
  check('Modal inicial aparece (localStorage vazio)', welcomeOpen);

  // ── 2. Salvar nome ─────────────────────────────────────────────────────
  await page.fill('#nomeUsuarioInput', 'Erica Souza');
  await page.click('[data-action="save-name-welcome"]');
  await page.waitForTimeout(100);
  const nomeSalvo = await page.evaluate(() => JSON.parse(localStorage.getItem('bcp_config_v2') || '{}').nomeUsuario);
  const welcomeClosed = await page.evaluate(() => !document.getElementById('modalBoasVindas').classList.contains('open'));
  check('Salvar nome grava no Store e fecha modal', nomeSalvo === 'Erica Souza' && welcomeClosed);

  // ── 3. Criar Sprint ────────────────────────────────────────────────────
  await page.click('header [data-action="open-sprint-modal"]');
  await page.waitForTimeout(50);
  const sprintModalOpen = await page.evaluate(() => document.getElementById('modalSprint').classList.contains('open'));
  check('Modal de sprint abre via header', sprintModalOpen);

  await page.fill('#sprintNumero', '42');
  await page.fill('#sprintInicio', '2026-09-01');
  await page.fill('#sprintFim', '2026-09-14');
  await page.fill('#sprintLink', 'https://jira.example.com/sprint/42');
  // Participantes via Enter (testa onkeydown -> keydown delegado)
  await page.fill('#participanteInput', 'Larissa');
  await page.press('#participanteInput', 'Enter');
  await page.fill('#participanteInput', 'Joao');
  await page.press('#participanteInput', 'Enter');
  const chipCount = await page.evaluate(() => document.querySelectorAll('#participantesChips .tag-chip').length);
  check('Participantes adicionados via Enter (keydown delegado)', chipCount === 2, 'chips=' + chipCount);

  await page.click('[data-action="save-sprint"]');
  await page.waitForTimeout(100);
  let sprints = await page.evaluate(() => JSON.parse(localStorage.getItem('bcp_sprints_v2') || '[]'));
  check('Criar Sprint grava no Store', sprints.length === 1 && sprints[0].numero === 42, JSON.stringify(sprints[0] && sprints[0].numero));

  const sprintId = sprints[0].id;

  // ── 4. Editar Sprint ───────────────────────────────────────────────────
  await page.click(`[data-action="open-sprint-modal"][data-sprint-id="${sprintId}"]`);
  await page.waitForTimeout(50);
  await page.fill('#sprintLink', 'https://jira.example.com/sprint/42-editado');
  await page.click('[data-action="save-sprint"]');
  await page.waitForTimeout(100);
  sprints = await page.evaluate(() => JSON.parse(localStorage.getItem('bcp_sprints_v2') || '[]'));
  check('Editar Sprint atualiza o link', sprints[0].link.endsWith('editado'));

  // ── 5. Expandir / Recolher Sprint ─────────────────────────────────────
  await page.click(`[data-action="toggle-sprint"][data-sprint-id="${sprintId}"]`);
  let expanded = await page.evaluate((id) => document.getElementById('sprint-' + id).classList.contains('expanded'), sprintId);
  check('Expandir Sprint', expanded === true);
  await page.click(`[data-action="toggle-sprint"][data-sprint-id="${sprintId}"]`);
  expanded = await page.evaluate((id) => document.getElementById('sprint-' + id).classList.contains('expanded'), sprintId);
  check('Recolher Sprint', expanded === false);
  // deixa expandida para os próximos testes
  await page.click(`[data-action="toggle-sprint"][data-sprint-id="${sprintId}"]`);

  // Clique nos botões de ação da sprint (dentro do header) não deve
  // colapsar a sprint (regressão do antigo stopPropagation)
  await page.click(`[data-action="confirm-delete"][data-type="sprint"]`).catch(() => {});
  await page.click('[data-action="close-confirm"]');
  expanded = await page.evaluate((id) => document.getElementById('sprint-' + id).classList.contains('expanded'), sprintId);
  check('Clique nos botões do header da sprint não fecha o accordion (sem stopPropagation)', expanded === true);

  // ── 6. Criar Card ──────────────────────────────────────────────────────
  await page.click(`[data-action="open-card-modal"][data-sprint-id="${sprintId}"]`);
  await page.waitForTimeout(50);
  const cardModalOpen = await page.evaluate(() => document.getElementById('modalCard').classList.contains('open'));
  const templateApplied = await page.evaluate(() => document.getElementById('rteBody').innerHTML.includes('Descrição do Problema'));
  check('Modal de card abre com template padrão pré-carregado', cardModalOpen && templateApplied);

  await page.fill('#cardNumero', 'SC-4405');
  await page.fill('#cardLinkCard', 'https://jira.example.com/SC-4405');
  await page.fill('#cardTitulo', 'Ajuste de validação de CPF');
  await page.fill('#cardBugs', '3');
  await page.fill('#cardHoras', '2.5');
  await page.fill('#cardCriadoPor', 'Erica Souza');

  // ── Rich Text Editor: negrito, itálico, cores, link, checklist, template ──
  await page.click('#rteBody');
  await page.keyboard.type('Texto de teste do RTE');
  await page.evaluate(() => {
    // seleciona todo o texto do RTE antes de aplicar negrito
    const el = document.getElementById('rteBody');
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.click('[data-action="rte-cmd"][data-cmd="bold"]');
  let boldApplied = await page.evaluate(() => document.getElementById('rteBody').innerHTML.includes('<b>') || document.getElementById('rteBody').innerHTML.includes('<strong>') || document.getElementById('rteBody').innerHTML.includes('font-weight'));
  check('RTE: negrito aplica formatação', boldApplied);

  await page.fill('input[data-rte-color="text"]', '#ff0000');
  await page.dispatchEvent('input[data-rte-color="text"]', 'change');
  await page.waitForTimeout(50);
  const rteHtmlAfterColor = await page.evaluate(() => document.getElementById('rteBody').innerHTML);
  check('RTE: cor do texto aplicada via delegação de change', /color/i.test(rteHtmlAfterColor), rteHtmlAfterColor.slice(0, 120));

  await page.click('[data-action="rte-insert-checklist"]');
  const hasChecklist = await page.evaluate(() => document.getElementById('rteBody').innerHTML.includes('checkbox'));
  check('RTE: inserir checklist', hasChecklist);

  await page.click('[data-action="save-card"]');
  await page.waitForTimeout(100);
  let cards = await page.evaluate(() => JSON.parse(localStorage.getItem('bcp_cards_v2') || '[]'));
  check('Criar Card grava no Store', cards.length === 1 && cards[0].numero === 'SC-4405', JSON.stringify(cards[0] && cards[0].numero));

  const cardId = cards[0].id;

  // ── 7. Editar Card ─────────────────────────────────────────────────────
  await page.click(`[data-action="open-card-modal"][data-card-id="${cardId}"]`);
  await page.waitForTimeout(50);
  await page.fill('#cardTitulo', 'Ajuste de validação de CPF (revisado)');
  await page.click('[data-action="save-card"]');
  await page.waitForTimeout(100);
  cards = await page.evaluate(() => JSON.parse(localStorage.getItem('bcp_cards_v2') || '[]'));
  check('Editar Card atualiza o título', cards[0].titulo.includes('revisado'));

  // ── 8. Favoritar Card ──────────────────────────────────────────────────
  await page.click(`[data-action="toggle-favorito"][data-card-id="${cardId}"]`);
  await page.waitForTimeout(50);
  cards = await page.evaluate(() => JSON.parse(localStorage.getItem('bcp_cards_v2') || '[]'));
  check('Favoritar Card', cards[0].favorito === true);

  // ── 9. Duplicar Card ───────────────────────────────────────────────────
  await page.click(`[data-action="duplicar-card"][data-card-id="${cardId}"]`);
  await page.waitForTimeout(100);
  cards = await page.evaluate(() => JSON.parse(localStorage.getItem('bcp_cards_v2') || '[]'));
  check('Duplicar Card cria uma cópia', cards.length === 2 && cards[1].titulo.includes('cópia'));
  const dupId = cards[1].id;

  // ── 10. Arquivar Card ──────────────────────────────────────────────────
  await page.click(`[data-action="toggle-arquivar"][data-card-id="${dupId}"]`);
  await page.waitForTimeout(50);
  cards = await page.evaluate(() => JSON.parse(localStorage.getItem('bcp_cards_v2') || '[]'));
  check('Arquivar Card', cards.find(c => c.id === dupId).arquivado === true);

  // ── 11. Hyperlinks (Sprint e Card) — sem navegação real, via window.open mockado ──
  await page.click(`a[data-action="open-external"][data-url*="jira.example.com/sprint"]`);
  await page.click(`a[data-action="open-external"][data-url*="SC-4405"]`);
  const openedUrls = await page.evaluate(() => window.__openedUrls);
  check('Hyperlinks da Sprint e do Card disparam abertura externa', openedUrls.some(u => u.includes('sprint')) && openedUrls.some(u => u.includes('SC-4405')), JSON.stringify(openedUrls));

  // ── 12. Inserir Template (em card vazio) ───────────────────────────────
  await page.click(`[data-action="open-card-modal"][data-sprint-id="${sprintId}"]`);
  await page.waitForTimeout(50);
  await page.evaluate(() => { document.getElementById('rteBody').innerHTML = ''; });
  await page.click('[data-action="rte-insert-template"]');
  const templateReinserted = await page.evaluate(() => document.getElementById('rteBody').innerHTML.includes('Descrição do Problema'));
  check('Inserir Template no RTE', templateReinserted);
  await page.click('[data-action="close-card-modal"]');

  // ── 13. Filtros (Todos / Favoritos / Arquivados) ───────────────────────
  await page.click('[data-action="set-filter"][data-filter="favoritos"]');
  await page.waitForTimeout(50);
  let favVisible = await page.evaluate((id) => !!document.getElementById('card-' + id), cardId);
  check('Filtro Favoritos mostra o card favoritado', favVisible);

  await page.click('[data-action="set-filter"][data-filter="arquivados"]');
  await page.waitForTimeout(50);
  let arqVisible = await page.evaluate((id) => !!document.getElementById('card-' + id), dupId);
  check('Filtro Arquivados mostra o card arquivado', arqVisible);

  await page.click('[data-action="set-filter"][data-filter="todos"]');
  await page.waitForTimeout(50);

  // ── 14. Dashboard ──────────────────────────────────────────────────────
  await page.click('[data-action="show-tab"][data-tab="dashboard"]');
  await page.waitForTimeout(50);
  await page.click('[data-action="generate-dashboard"]');
  await page.waitForTimeout(100);
  const kpiCards = await page.evaluate(() => document.getElementById('kpiCards').textContent);
  const kpiBugs  = await page.evaluate(() => document.getElementById('kpiBugs').textContent);
  // 2 cards (original 3 bugs + cópia duplicada 3 bugs) = 6 bugs totais
  check('Dashboard gera KPIs a partir dos dados reais', kpiCards === '2' && kpiBugs === '6', 'kpiCards=' + kpiCards + ' kpiBugs=' + kpiBugs);

  // barras dinâmicas (style="width:...%") — exatamente o que a CSP antiga bloqueava
  const barWidth = await page.evaluate(() => {
    const el = document.querySelector('#bugsPerSprint .dash-bar-fill');
    return el ? el.style.width : null;
  });
  check('Barras do dashboard renderizam style inline (width) sem bloqueio de CSP', !!barWidth && barWidth !== '', 'width=' + barWidth);

  await page.click('[data-action="show-tab"][data-tab="board"]');

  // ── 15. Excluir Card (o card duplicado está arquivado, então precisa do
  //        filtro "Arquivados" para ficar visível na lista — mesmo
  //        comportamento de antes da correção, não é regressão) ──────────
  await page.click('[data-action="set-filter"][data-filter="arquivados"]');
  await page.waitForTimeout(50);
  await page.click(`[data-action="confirm-delete"][data-type="card"][data-id="${dupId}"]`);
  await page.waitForTimeout(50);
  await page.click('[data-action="execute-delete"]');
  await page.waitForTimeout(100);
  cards = await page.evaluate(() => JSON.parse(localStorage.getItem('bcp_cards_v2') || '[]'));
  check('Excluir Card remove do Store', cards.length === 1 && !cards.find(c => c.id === dupId));
  await page.click('[data-action="set-filter"][data-filter="todos"]');
  await page.waitForTimeout(50);

  // ── 16. Fechar modal clicando fora (backdrop) ──────────────────────────
  await page.click(`[data-action="open-card-modal"][data-card-id="${cardId}"]`);
  await page.waitForTimeout(50);
  // clique dentro do modal não deve fechar
  await page.click('#modalCard .modal-title');
  let stillOpen = await page.evaluate(() => document.getElementById('modalCard').classList.contains('open'));
  check('Clique dentro do modal não fecha (sem stopPropagation inline)', stillOpen === true);
  // clique no backdrop (fora do .modal) fecha
  await page.mouse.click(5, 5);
  await page.waitForTimeout(50);
  let closedNow = await page.evaluate(() => !document.getElementById('modalCard').classList.contains('open'));
  check('Clique no backdrop fecha o modal', closedNow === true);

  // ── 17. Excluir Sprint ──────────────────────────────────────────────────
  await page.click(`[data-action="confirm-delete"][data-type="sprint"][data-id="${sprintId}"]`);
  await page.waitForTimeout(50);
  await page.click('[data-action="execute-delete"]');
  await page.waitForTimeout(100);
  sprints = await page.evaluate(() => JSON.parse(localStorage.getItem('bcp_sprints_v2') || '[]'));
  cards   = await page.evaluate(() => JSON.parse(localStorage.getItem('bcp_cards_v2') || '[]'));
  check('Excluir Sprint remove sprint e cascade nos cards', sprints.length === 0 && cards.length === 0);

  // ── 18. Empty state volta a aparecer ────────────────────────────────────
  const emptyVisible = await page.evaluate(() => !document.getElementById('boardEmpty').classList.contains('hidden'));
  check('Empty state reaparece após excluir tudo', emptyVisible);

  // ── CSP: nenhuma violação em toda a sessão ─────────────────────────────
  check('Zero violações de CSP durante todo o fluxo', cspViolations.length === 0, cspViolations.join(' | '));
  check('Zero erros de console (excluindo CSP, já checado acima)', consoleErrors.filter(e => !/Content Security Policy|Refused to/i.test(e)).length === 0,
    consoleErrors.filter(e => !/Content Security Policy|Refused to/i.test(e)).join(' | '));

  await browser.close();

  const failed = results.filter(r => !r.ok);
  console.log('\n=== RESUMO: ' + (results.length - failed.length) + '/' + results.length + ' passaram ===');
  if (failed.length) {
    console.log('FALHAS:');
    failed.forEach(f => console.log(' - ' + f.name + (f.extra ? ' (' + f.extra + ')' : '')));
    process.exit(1);
  }
  process.exit(0);
})();
