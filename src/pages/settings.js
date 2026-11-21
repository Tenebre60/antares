(async () => {
  const s = await antares.settings();
  const eng = $('#engine');
  eng.innerHTML = Object.entries(s.searchEngines).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  eng.value = s.searchEngine;
  $('#startup').value = s.startup;
  $('#homeurl').value = s.homepage === 'antares://newtab' ? '' : s.homepage;
  $('#theme').value = s.theme;
  $('#layoutmode').value = s.layoutMode || 'auto';
  $('#rpanel').checked = s.rightPanel !== false;
  $('#bbar').checked = s.showBookmarksBar;
  $('#askdl').checked = s.askDownloadLocation;
  $('#trackers').checked = s.blockTrackers;
  $('#https').checked = s.httpsOnly;
  $('#gpc').checked = s.gpc;
  $('#tabsleep').checked = s.tabSleep;
  const showFilters = (n, when) => { $('#filters').textContent = `${n.toLocaleString('pt-BR')} regras · ${when ? 'atualizadas em ' + new Date(when).toLocaleDateString('pt-BR') : 'lista incluída nesta versão'}`; };
  showFilters(s.filters, s.filtersUpdated);
  if (s.exceptions) $('#exc').textContent = `${s.exceptions} exceção(ões) salva(s): pop-ups permitidos, sites sem bloqueio e permissões lembradas.`;
  const showEngine = (u) => {
    let t = `Chromium ${s.chrome} (Electron ${s.electron}) · versão do Antares de ${new Date(s.buildDate + 'T12:00').toLocaleDateString('pt-BR')}. `;
    if (u.error && !u.checked) t += 'Não foi possível verificar agora (sem internet?).';
    else if (!u.checked) t += 'Ainda não verificado.';
    else if (u.latest && u.latest !== u.current && u.latest.localeCompare(u.current, undefined, { numeric: true }) > 0) t += `⚠ Há uma correção de segurança disponível (Electron ${u.latest}). Instale uma versão nova do Antares.`;
    else if (!u.supported) t += '⚠ Esta linha do Chromium não recebe mais correções. Instale uma versão nova do Antares.';
    else t += `✓ Em dia (verificado ${new Date(u.checked).toLocaleString('pt-BR')}).`;
    $('#engine-state').textContent = t;
  };
  showEngine(s.update);
  $('#dldir').textContent = 'Pasta atual: ' + s.downloadsDir;
  if (s.blocked) $('#blocked').textContent += ` ${s.blocked.toLocaleString('pt-BR')} bloqueados nesta sessão.`;
  $('#ver').textContent = `Versão ${s.version} · Chromium ${s.chrome} · Electron ${s.electron}`;

  const set = async (patch) => { await antares.setSettings(patch); toast('Configuração salva'); };
  eng.onchange = () => set({ searchEngine: eng.value });
  $('#startup').onchange = () => set({ startup: $('#startup').value });
  $('#theme').onchange = () => set({ theme: $('#theme').value });
  $('#layoutmode').onchange = () => set({ layoutMode: $('#layoutmode').value });
  $('#rpanel').onchange = () => set({ rightPanel: $('#rpanel').checked });
  $('#bbar').onchange = () => set({ showBookmarksBar: $('#bbar').checked });
  $('#askdl').onchange = () => set({ askDownloadLocation: $('#askdl').checked });
  $('#trackers').onchange = () => set({ blockTrackers: $('#trackers').checked });
  $('#https').onchange = () => set({ httpsOnly: $('#https').checked });
  $('#gpc').onchange = () => set({ gpc: $('#gpc').checked });
  $('#tabsleep').onchange = () => set({ tabSleep: $('#tabsleep').checked });
  $('#updfilters').onclick = async () => {
    $('#updfilters').disabled = true; $('#updfilters').textContent = 'Atualizando…';
    const r = await antares.updateFilters();
    $('#updfilters').disabled = false; $('#updfilters').textContent = 'Atualizar agora';
    showFilters(r.filters, r.filtersUpdated); toast(r.ok ? 'Listas atualizadas' : 'Não foi possível atualizar agora');
  };
  $('#chkupd').onclick = async () => { $('#engine-state').textContent = 'Verificando…'; showEngine(await antares.checkUpdate()); };
  $('#clrexc').onclick = async () => { await antares.clearExceptions(); $('#exc').textContent = 'Nenhuma exceção salva.'; toast('Exceções removidas'); };
  $('#homeurl').onchange = async () => {
    const v = $('#homeurl').value.trim();
    const url = v ? await antares.resolve(v) : 'antares://newtab';
    $('#homeurl').value = v ? url : '';
    set({ homepage: url });
  };

  const refreshDefault = async () => {
    const d = await antares.isDefault();
    $('#default-state').textContent = d ? 'O Antares é o seu navegador padrão. ✓' : 'Abra links do Windows e de outros apps no Antares.';
    $('#mkdefault').hidden = d;
  };
  $('#mkdefault').onclick = async () => {
    await antares.setDefault();
    if (s.platform === 'win32') toast('Nas Configurações do Windows, escolha Antares para HTTP e HTTPS');
    setTimeout(refreshDefault, 1500);
  };
  refreshDefault();
  window.addEventListener('focus', refreshDefault);

  $('#doclear').onclick = async () => {
    const opts = {
      range: Number($('#range').value), history: $('#c-history').checked, cookies: $('#c-cookies').checked,
      cache: $('#c-cache').checked, downloads: $('#c-downloads').checked, permissions: $('#c-perms').checked,
    };
    $('#doclear').disabled = true;
    await antares.clearData(opts);
    $('#doclear').disabled = false;
    toast('Dados limpos');
  };
})();
