/* AgroSat — liga as novas funções (cadastro por CAR/pino, situação, configurações, relatório) à interface. */
'use strict';

$('fmUF').innerHTML = UFS.map(u => `<option${u === 'MA' ? ' selected' : ''}>${u}</option>`).join('');

// ----- modo de cadastro -----
let fmMode = 'car';
function setMode(m) {
  fmMode = m;
  document.querySelectorAll('#fmMode button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
  document.querySelectorAll('#farmForm [data-for]').forEach(el => el.hidden = el.dataset.for !== m);
  $('fmSave').textContent = m === 'pino' ? 'Escolher no mapa' : 'Salvar';
}
$('fmMode').onclick = e => { const b = e.target.closest('button'); if (b) setMode(b.dataset.m); };
setMode('car');
const _openFarm = $('btnAddFarm').onclick;
const abrirCadastro = () => { _openFarm(); $('fmUF').value = (farm() && farm().uf) || 'MA'; setMode(fmMode); };
$('btnAddFarm').onclick = abrirCadastro; $('btnAddFarm2').onclick = abrirCadastro;

function criarFazenda(meta, polys0, car) {
  const o = organizarPerimetro(polys0);
  const f = { id: 'f' + Date.now().toString(36), name: meta.name, owner: meta.owner, uf: meta.uf, car: car || null, polys: o.polys, divs: o.divs, area: areaHa(o.polys), created: new Date().toISOString() };
  S.farms.push(f); selectFarm(f.id);
  toast(`${f.name} cadastrada: ${fmt(f.area, 1)} ha${f.divs.length ? ` em ${f.divs.length} divisões` : ''}.`);
}
function polysDoCAR(ft) {
  const p = polysFromGeoJSON({ type: 'FeatureCollection', features: [ft] });
  if (!p.length) throw new Error('O CAR veio sem perímetro.');
  return p;
}

$('farmForm').onsubmit = async e => {
  e.preventDefault(); $('fmErr').textContent = '';
  const meta = { name: $('fmName').value.trim(), owner: $('fmOwner').value.trim(), uf: $('fmUF').value };
  if (!meta.name) return $('fmErr').textContent = 'Informe o nome da fazenda.';
  $('fmSave').disabled = true;
  try {
    if (fmMode === 'arq') {
      const file = $('fmFile').files[0]; if (!file) throw new Error('Escolha o arquivo do perímetro.');
      const polys = await readPerimeter(file);
      $('farmModal').hidden = true; criarFazenda(meta, polys);
    } else if (fmMode === 'car') {
      const cod = $('fmCar').value; if (!cod.trim()) throw new Error('Informe o código do CAR.');
      $('fmSave').textContent = 'Buscando…';
      const ft = await carPorCodigo(cod);
      meta.uf = cod.trim().slice(0, 2).toUpperCase();
      $('farmModal').hidden = true; criarFazenda(meta, polysDoCAR(ft), pick(ft.properties, 'cod_imovel') || cod.trim().toUpperCase());
    } else {
      precisaPonte();
      $('farmModal').hidden = true; iniciarPino(meta);
    }
  } catch (err) { console.error(err); $('fmErr').textContent = err.message || 'Falhou.'; }
  finally { $('fmSave').disabled = false; setMode(fmMode); }
};

// ----- pino no mapa -----
let pinMeta = null;
function iniciarPino(meta) {
  pinMeta = meta; $('pinbar').hidden = false; document.querySelector('.mapwrap').classList.add('pinning');
  if (!farm()) map.setView([-3.95, -45.6], 9);
}
function pararPino() { pinMeta = null; $('pinbar').hidden = true; document.querySelector('.mapwrap').classList.remove('pinning'); }
$('pinCancel').onclick = pararPino;
map.on('click', async ev => {
  if (!pinMeta) return;
  const meta = pinMeta; pararPino();
  busy(true, 'Procurando o CAR neste ponto…');
  try {
    const fs = await carNoPonto(ev.latlng.lng, ev.latlng.lat, meta.uf);
    if (!fs.length) { toast(`Nenhum CAR (${meta.uf}) neste ponto. Tente outro ponto ou confira o estado.`, 6000); return; }
    const usar = ft => criarFazenda(meta, polysDoCAR(ft), pick(ft.properties, 'cod_imovel'));
    if (fs.length === 1) return usar(fs[0]);
    $('pickList').innerHTML = fs.map((ft, k) => {
      const p = ft.properties;
      return `<button class="scene pick" data-k="${k}"><div><div class="d">${esc(pick(p, 'cod_imovel') || 'CAR')}</div><div class="m">${STATUS_CAR[pick(p, 'status_imovel')] || ''} · ${ha(+pick(p, 'area') || turf.area(ft) / 1e4)} · ${esc(pick(p, 'municipio') || '')}</div></div></button>`;
    }).join('');
    $('pickModal').hidden = false;
    $('pickList').onclick = e => { const b = e.target.closest('.pick'); if (!b) return; $('pickModal').hidden = true; usar(fs[+b.dataset.k]); };
  } catch (err) { console.error(err); toast('Não consegui consultar o CAR: ' + err.message, 6000); }
  finally { busy(false); }
});
$('pickCancel').onclick = () => $('pickModal').hidden = true;

// ----- configurações -----
$('btnConf').onclick = () => {
  const c = CONF.consultor;
  $('cfProxy').value = CONF.proxy; $('cfNome').value = c.nome || ''; $('cfEmp').value = c.empresa || ''; $('cfCont').value = c.contato || '';
  $('cfProxyMsg').textContent = ''; $('confModal').hidden = false;
};
$('cfCancel').onclick = () => $('confModal').hidden = true;
$('confForm').onsubmit = e => {
  e.preventDefault();
  store('agrosat.proxy', $('cfProxy').value.trim());
  store('agrosat.consultor', { nome: $('cfNome').value.trim(), empresa: $('cfEmp').value.trim(), contato: $('cfCont').value.trim() });
  $('confModal').hidden = true; toast('Configurações salvas.');
};
$('cfTest').onclick = async () => {
  const u = $('cfProxy').value.trim().replace(/\/+$/, '');
  if (!u) return $('cfProxyMsg').textContent = 'Cole o endereço do servidor-ponte.';
  $('cfProxyMsg').textContent = 'Testando…';
  try { const r = await fetch(u + '/saude'); const j = await r.json(); $('cfProxyMsg').textContent = j.ok ? '✅ Servidor-ponte funcionando.' : 'Respondeu, mas não como esperado.'; }
  catch (e) { $('cfProxyMsg').textContent = '❌ Não respondeu. Confira o endereço.'; }
};

// ----- situação, relatório, camadas -----
$('btnDiag').onclick = rodarDiagnostico;
$('btnReport').onclick = gerarRelatorio;
let ctrlCamadas = null;
window.onFarmChange = f => {
  limparDiag(); S.diag = null; $('diagBox').innerHTML = '';
  if (ctrlCamadas) { Object.values(ctrlCamadas._agro).forEach(l => l.remove()); ctrlCamadas.remove(); ctrlCamadas = null; }
  if (!f) return;
  $('farmCar').textContent = f.car ? `CAR ${f.car}` : (f.uf ? `Estado: ${f.uf}` : '');
  const ref = camadasReferencia(f.uf);
  ctrlCamadas = L.control.layers(null, ref, { collapsed: true, position: 'topright' }).addTo(map);
  ctrlCamadas._agro = ref;
};
if (farm()) window.onFarmChange(farm());
