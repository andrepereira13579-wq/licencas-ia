/* AgroSat — consultas às bases públicas (CAR, SIGEF, IBAMA, PRODES, INPE Queimadas, clima)
   e relatório. Usa o servidor-ponte (Cloudflare Worker) para as bases do governo. */
'use strict';

const UFS = ['AC','AL','AM','AP','BA','CE','DF','ES','GO','MA','MG','MS','MT','PA','PB','PE','PI','PR','RJ','RN','RO','RR','RS','SC','SE','SP','TO'];
const CONF = {
  get proxy() { return (store('agrosat.proxy') || window.AGROSAT_PROXY || '').replace(/\/+$/, ''); },
  get consultor() { return store('agrosat.consultor') || window.AGROSAT_CONSULTOR || {}; },
  raioKm: 5,        // entorno analisado para embargos e focos
  diasFocos: 10,
};
const STATUS_CAR = { AT: 'Ativo', PE: 'Pendente', SU: 'Suspenso', CA: 'Cancelado' };

// ---------- Acesso às bases ----------
function precisaPonte() {
  if (!CONF.proxy) throw new Error('Configure o endereço do servidor-ponte (⚙ Configurações).');
}
const viaPonte = url => `${CONF.proxy}/?url=${encodeURIComponent(url)}`;

async function getGeo(url) {
  precisaPonte();
  const r = await fetch(viaPonte(url));
  const txt = await r.text();
  if (!r.ok) throw new Error(`base respondeu ${r.status}`);
  let fc;
  const t = txt.trim();
  if (t.startsWith('{')) fc = JSON.parse(t);
  else if (t.startsWith('<')) {
    if (/ServiceException|ExceptionReport/i.test(t)) throw new Error('a base recusou a consulta');
    fc = gmlToGeoJSON(t);
  } else throw new Error('resposta inesperada da base');
  fc.features = (fc.features || []).filter(f => f && f.geometry);
  fc.features.forEach(fixAxis);
  return fc;
}
// Alguns servidores devolvem latitude/longitude invertidas. No Brasil a longitude fica entre −75 e −28.
function fixAxis(f) {
  let first = null;
  turf.coordEach(f, c => { if (!first) first = c; });
  if (first && (first[0] > -28 || first[0] < -75) && first[1] <= -28 && first[1] >= -75) turf.coordEach(f, c => { const x = c[0]; c[0] = c[1]; c[1] = x; });
}
// GML simples (MapServer/i3Geo) -> GeoJSON
function gmlToGeoJSON(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const members = [...doc.getElementsByTagNameNS('*', 'featureMember'), ...doc.getElementsByTagNameNS('*', 'member')];
  const parseCoords = el => {
    const pl = el.getElementsByTagNameNS('*', 'posList')[0];
    if (pl) { const n = pl.textContent.trim().split(/\s+/).map(Number); const out = []; for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i], n[i + 1]]); return out; }
    const cs = el.getElementsByTagNameNS('*', 'coordinates')[0];
    if (cs) return cs.textContent.trim().split(/\s+/).map(p => p.split(',').slice(0, 2).map(Number));
    return [];
  };
  const features = [];
  for (const m of members) {
    const feat = m.firstElementChild; if (!feat) continue;
    const polys = [...feat.getElementsByTagNameNS('*', 'Polygon')].map(pg => {
      const rings = [];
      const outer = pg.getElementsByTagNameNS('*', 'outerBoundaryIs')[0] || pg.getElementsByTagNameNS('*', 'exterior')[0];
      if (outer) rings.push(parseCoords(outer));
      [...pg.getElementsByTagNameNS('*', 'innerBoundaryIs'), ...pg.getElementsByTagNameNS('*', 'interior')].forEach(h => rings.push(parseCoords(h)));
      return rings;
    }).filter(r => r.length && r[0].length > 3);
    if (!polys.length) continue;
    const props = {};
    for (const c of feat.children) if (c.children.length === 0) props[c.localName] = c.textContent;
    features.push({ type: 'Feature', properties: props, geometry: polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys } });
  }
  return { type: 'FeatureCollection', features };
}
const bboxStr = b => b.map(v => v.toFixed(6)).join(',');

// CAR (SICAR)
const carWFS = (uf, extra) => `https://geoserver.car.gov.br/geoserver/sicar/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=sicar:sicar_imoveis_${uf.toLowerCase()}&outputFormat=application/json&srsName=EPSG:4326&maxFeatures=200${extra}`;
async function carPorCodigo(cod) {
  cod = cod.trim().toUpperCase().replace(/\s+/g, '');
  const uf = cod.slice(0, 2);
  if (!UFS.includes(uf)) throw new Error('Código do CAR deve começar com a sigla do estado, ex.: MA-2110005-...');
  const fc = await getGeo(carWFS(uf, `&CQL_FILTER=${encodeURIComponent(`cod_imovel='${cod}'`)}`));
  if (!fc.features.length) throw new Error('CAR não encontrado. Confira o código.');
  return fc.features[0];
}
async function carNaArea(b, uf) { return (await getGeo(carWFS(uf, `&bbox=${bboxStr(b)}`))).features; }
async function carNoPonto(lon, lat, uf) {
  const d = 0.0008, fs = await carNaArea([lon - d, lat - d, lon + d, lat + d], uf);
  const pt = turf.point([lon, lat]);
  return fs.filter(f => { try { return turf.booleanPointInPolygon(pt, f); } catch { return false; } });
}
// SIGEF (INCRA, temas por estado)
async function sigefNaArea(b, uf) {
  const out = [];
  for (const tema of [`certificada_sigef_particular_${uf.toLowerCase()}`, `certificada_sigef_publico_${uf.toLowerCase()}`]) {
    const base = `https://acervofundiario.incra.gov.br/i3geo/ogc.php?tema=${tema}&service=WFS&version=1.0.0&request=GetFeature&typename=${tema}&bbox=${bboxStr(b)}`;
    let fc = null;
    try { fc = await getGeo(base + '&outputformat=geojson'); } catch (e) { fc = await getGeo(base); }
    fc.features.forEach(f => f.properties._tema = tema.includes('publico') ? 'Público' : 'Particular');
    out.push(...fc.features);
  }
  return out;
}
// Embargos IBAMA
async function embargosNaArea(b) {
  return (await getGeo(`https://siscom.ibama.gov.br/geoserver/publica/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=publica:vw_brasil_adm_embargo_a&outputFormat=application/json&srsName=EPSG:4326&maxFeatures=500&bbox=${bboxStr(b)}`)).features;
}
// PRODES (Amazônia Legal e Cerrado)
async function prodesNaArea(b) {
  const out = [];
  for (const [ws, nome] of [['prodes-legal-amz', 'Amazônia Legal'], ['prodes-cerrado-nb', 'Cerrado']]) {
    try {
      const fc = await getGeo(`https://terrabrasilis.dpi.inpe.br/geoserver/${ws}/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=${ws}:yearly_deforestation&outputFormat=application/json&srsName=EPSG:4326&maxFeatures=2000&bbox=${bboxStr(b)}`);
      fc.features.forEach(f => f.properties._fonte = nome); out.push(...fc.features);
    } catch (e) { if (ws === 'prodes-cerrado-nb' && !out.length) throw e; }
  }
  return out;
}
// Focos de queimada INPE
async function focosNaArea(b, dias) {
  precisaPonte();
  const r = await fetch(`${CONF.proxy}/focos?bbox=${bboxStr(b)}&dias=${dias}`);
  if (!r.ok) throw new Error(`ponte respondeu ${r.status}`);
  return r.json();
}
// Clima (Open-Meteo, sem chave)
async function climaNoPonto(lon, lat) {
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m&daily=precipitation_sum,temperature_2m_max,temperature_2m_min&past_days=30&forecast_days=7&timezone=auto`;
  const r = await fetch(u); if (!r.ok) throw new Error(`clima respondeu ${r.status}`);
  return r.json();
}

// ---------- Geometria auxiliar ----------
function farmFeature(f) { return f.polys.length === 1 ? turf.polygon(f.polys[0]) : turf.multiPolygon(f.polys); }
function interHa(a, b) {
  try { const i = turf.intersect(a, b); return i ? turf.area(i) / 1e4 : 0; } catch (e) { return 0; }
}
function distKm(farmF, feat) {
  try {
    if (interHa(farmF, feat) > 0) return 0;
    const line = turf.polygonToLine(farmF);
    let best = Infinity;
    turf.coordEach(feat, c => {
      const lines = line.type === 'FeatureCollection' ? line.features : [line];
      for (const l of lines) best = Math.min(best, turf.pointToLineDistance(turf.point(c), l, { units: 'kilometers' }));
    });
    return best;
  } catch (e) { return NaN; }
}
const ha = (v, d) => `${fmt(v, d != null ? d : v < 10 ? 2 : v < 100 ? 1 : 0)} ha`;
const pick = (p, ...ks) => { for (const k of ks) { const hit = Object.keys(p).find(x => x.toLowerCase() === k); if (hit && p[hit] !== null && p[hit] !== '') return p[hit]; } return null; };

// ---------- Diagnóstico ----------
const DL = { group: null };
function limparDiag() { if (DL.group) { DL.group.remove(); DL.group = null; } }

async function rodarDiagnostico() {
  const f = farm(); if (!f) return;
  const box = $('diagBox'); limparDiag();
  const F = farmFeature(f);
  const fb = turf.bbox(F);
  const viz = turf.bbox(turf.buffer(F, CONF.raioKm, { units: 'kilometers' }));
  const centro = turf.centroid(F).geometry.coordinates;
  const uf = f.uf || 'MA';
  DL.group = L.layerGroup().addTo(map);
  const secoes = [
    ['car', 'CAR e sobreposições', () => carNaArea(fb, uf)],
    ['sigef', 'SIGEF / INCRA', () => sigefNaArea(fb, uf)],
    ['emb', 'Embargos IBAMA', () => embargosNaArea(viz)],
    ['prodes', 'Desmatamento PRODES', () => prodesNaArea(fb)],
    ['fogo', `Focos de queimada (${CONF.diasFocos} dias)`, () => focosNaArea(viz, CONF.diasFocos)],
    ['clima', 'Clima', () => climaNoPonto(centro[0], centro[1])],
  ];
  box.innerHTML = secoes.map(([k, t]) => `<div class="dcard" id="d-${k}"><div class="dh"><span class="dot wait"></span><b>${t}</b></div><div class="db hint">Consultando…</div></div>`).join('');
  S.diag = { data: new Date().toISOString(), itens: {} };
  $('btnDiag').disabled = true;
  await Promise.all(secoes.map(async ([k, t, fn]) => {
    try {
      const res = await fn();
      const out = RENDER[k](res, F, f);
      S.diag.itens[k] = { titulo: t, ...out };
    } catch (e) {
      console.error(k, e);
      S.diag.itens[k] = { titulo: t, nivel: 'erro', resumo: 'Não consegui consultar agora: ' + e.message, detalhes: '' };
    }
    pintarCard(k);
  }));
  $('btnDiag').disabled = false;
}
function pintarCard(k) {
  const it = S.diag.itens[k], el = $('d-' + k); if (!el) return;
  el.querySelector('.dot').className = 'dot ' + it.nivel;
  el.querySelector('.db').className = 'db';
  el.querySelector('.db').innerHTML = `<p class="dres">${it.resumo}</p>${it.detalhes ? `<details><summary>Detalhes</summary>${it.detalhes}</details>` : ''}${it.extra || ''}`;
  if (it.chart) it.chart();
}
function camada(feats, style, popup) {
  feats.forEach(ft => L.geoJSON(ft, { style, pointToLayer: (g, ll) => L.circleMarker(ll, style) }).bindPopup(popup(ft)).addTo(DL.group));
}
const tabela = (cab, linhas) => `<table class="tb"><tr>${cab.map(c => `<th>${c}</th>`).join('')}</tr>${linhas.map(l => `<tr>${l.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;

const RENDER = {
  car(feats, F, f) {
    const areaF = turf.area(F) / 1e4;
    const rows = feats.map(ft => {
      const p = ft.properties, oh = interHa(F, ft);
      return { ft, cod: pick(p, 'cod_imovel') || '—', st: pick(p, 'status_imovel') || '', area: +pick(p, 'area', 'num_area') || turf.area(ft) / 1e4, mun: pick(p, 'municipio', 'nom_munici') || '', tipo: pick(p, 'tipo_imovel') || '', cond: pick(p, 'condicao', 'des_condic') || '', oh };
    }).filter(r => r.oh > 0.01).sort((a, b) => b.oh - a.oh);
    camada(rows.map(r => r.ft), { color: '#ffd400', weight: 2, fill: false }, ft => `<b>CAR</b><br>${esc(pick(ft.properties, 'cod_imovel') || '')}`);
    const proprio = f.car ? rows.find(r => r.cod === f.car) : rows.find(r => r.oh / areaF > 0.8);
    const outros = rows.filter(r => r !== proprio && r.oh > 0.5);
    let nivel = 'ok', resumo;
    if (!rows.length) { nivel = 'alerta'; resumo = 'Nenhum CAR encontrado sobre esta área.'; }
    else {
      resumo = proprio ? `CAR <b>${esc(proprio.cod)}</b> · ${STATUS_CAR[proprio.st] || proprio.st || 'situação não informada'} · ${ha(proprio.area)} declarados${proprio.mun ? ' · ' + esc(proprio.mun) : ''}.` : 'Nenhum CAR cobre a maior parte da área.';
      if (proprio && ['SU', 'CA'].includes(proprio.st)) nivel = 'grave';
      else if (proprio && proprio.st === 'PE') nivel = 'alerta';
      if (outros.length) { nivel = nivel === 'grave' ? 'grave' : 'alerta'; resumo += ` <b>${outros.length} outro(s) CAR sobreposto(s)</b>, somando ${ha(outros.reduce((s, r) => s + r.oh, 0))} dentro da área.`; }
    }
    return { nivel, resumo, detalhes: rows.length ? tabela(['Código CAR', 'Situação', 'Área declarada', 'Sobre a fazenda'], rows.map(r => [esc(r.cod), STATUS_CAR[r.st] || esc(r.st), ha(r.area), `${ha(Math.min(r.oh, areaF))} (${fmt(Math.min(100, r.oh / areaF * 100), 0)}%)`])) : '' };
  },
  sigef(feats, F) {
    const areaF = turf.area(F) / 1e4;
    const rows = feats.map(ft => ({ ft, p: ft.properties, oh: interHa(F, ft) })).filter(r => r.oh > 0.01).sort((a, b) => b.oh - a.oh);
    camada(rows.map(r => r.ft), { color: '#00e5ff', weight: 2, fill: false }, ft => `<b>SIGEF</b><br>${esc(pick(ft.properties, 'nome_area', 'parcela_co', 'codigo_imo') || '')}`);
    const cob = rows.reduce((s, r) => s + r.oh, 0);
    let nivel = 'ok', resumo;
    if (!rows.length) { nivel = 'alerta'; resumo = 'Nenhuma parcela certificada no SIGEF sobre esta área. A área pode não estar georreferenciada/certificada no INCRA.'; }
    else { if (cob / areaF < 0.8) nivel = 'alerta'; resumo = `${rows.length} parcela(s) certificada(s) cobrindo ${ha(cob)} (${fmt(Math.min(100, cob / areaF * 100), 0)}% da área).${rows.length > 1 ? ' Confira se todas pertencem ao mesmo imóvel.' : ''}${cob / areaF < 0.8 ? ' Parte da área não está certificada.' : ''}`; }
    return { nivel, resumo, detalhes: rows.length ? tabela(['Denominação', 'Código/parcela', 'Tipo', 'Sobre a fazenda'], rows.map(r => [esc(pick(r.p, 'nome_area', 'nome_imove', 'denominaca') || '—'), esc(pick(r.p, 'parcela_co', 'codigo_imo', 'cod_imovel') || '—'), r.p._tema || '', ha(r.oh)])) : '' };
  },
  emb(feats, F) {
    const rows = feats.map(ft => {
      const p = ft.properties, oh = interHa(F, ft);
      return { ft, oh, km: oh > 0 ? 0 : distKm(F, ft), tad: pick(p, 'num_tad', 'numero_tad', 'seq_tad') || '—', data: (pick(p, 'dat_embarg', 'data_tad', 'dat_ult_al') || '').slice(0, 10), mun: pick(p, 'municipio', 'nom_munici') || '', inf: pick(p, 'des_infrac', 'des_tad', 'infracao') || '', area: +pick(p, 'qtd_area_e', 'area_ha', 'qtd_area_d') || turf.area(ft) / 1e4 };
    }).filter(r => r.oh > 0 || r.km <= CONF.raioKm).sort((a, b) => a.km - b.km);
    camada(rows.map(r => r.ft), { color: '#ff3b3b', weight: 2, fillColor: '#ff3b3b', fillOpacity: .35 }, ft => `<b>Embargo IBAMA</b><br>TAD ${esc(pick(ft.properties, 'num_tad', 'seq_tad') || '')}`);
    const dentro = rows.filter(r => r.oh > 0), perto = rows.filter(r => !r.oh);
    let nivel = 'ok', resumo = `Nenhum embargo do IBAMA na área nem em até ${CONF.raioKm} km.`;
    if (dentro.length) { nivel = 'grave'; resumo = `<b>${dentro.length} embargo(s) dentro da área</b>, somando ${ha(dentro.reduce((s, r) => s + r.oh, 0))}.`; }
    if (perto.length) { if (nivel === 'ok') nivel = 'alerta'; resumo += ` ${perto.length} embargo(s) no entorno de ${CONF.raioKm} km.`; resumo = resumo.replace(`Nenhum embargo do IBAMA na área nem em até ${CONF.raioKm} km. `, 'Nenhum embargo dentro da área. '); }
    return { nivel, resumo, detalhes: rows.length ? tabela(['TAD', 'Data', 'Infração', 'Área', 'Distância'], rows.map(r => [esc(r.tad), r.data ? dBR(r.data) : '—', esc(String(r.inf).slice(0, 90)), ha(r.area), r.oh ? `<b>dentro (${ha(r.oh)})</b>` : `${fmt(r.km, 1)} km`])) : '' };
  },
  prodes(feats, F) {
    const rows = feats.map(ft => {
      const p = ft.properties; let ano = +pick(p, 'year', 'ano');
      if (!ano) { const m = String(pick(p, 'class_name', 'main_class') || '').match(/(19|20)\d\d/); ano = m ? +m[0] : NaN; }
      return { ft, ano, oh: interHa(F, ft), fonte: p._fonte };
    }).filter(r => r.oh > 0.05);
    camada(rows.map(r => r.ft), { color: '#ff9800', weight: 1, fillColor: '#ff9800', fillOpacity: .45 }, ft => `<b>PRODES</b><br>${esc(pick(ft.properties, 'year', 'class_name') || '')}`);
    const porAno = {}; rows.forEach(r => { const k = Number.isNaN(r.ano) ? 's/ano' : r.ano; porAno[k] = (porAno[k] || 0) + r.oh; });
    const pos2008 = rows.filter(r => r.ano >= 2009).reduce((s, r) => s + r.oh, 0);
    const total = rows.reduce((s, r) => s + r.oh, 0);
    let nivel = 'ok', resumo = 'Nenhuma supressão de vegetação nativa mapeada pelo PRODES dentro da área.';
    if (rows.length) {
      nivel = pos2008 > 0 ? 'alerta' : 'ok';
      resumo = `${ha(total)} de supressão mapeada pelo PRODES dentro da área${pos2008 > 0 ? `, sendo <b>${ha(pos2008)} depois de 2008</b> (após o marco de 22/07/2008 do Código Florestal; verifique se havia autorização)` : ', toda até 2008'}.`;
    }
    const anos = Object.keys(porAno).sort();
    return { nivel, resumo, detalhes: anos.length ? tabela(['Ano', 'Área na fazenda'], anos.map(a => [a, ha(porAno[a])])) + '<p class="hint">PRODES: mapeamento anual do INPE (Landsat, 30 m). Áreas pequenas podem não aparecer.</p>' : '' };
  },
  fogo(res, F) {
    const fs = (res.focos || []).map(o => ({ o, pt: turf.point([+o.lon, +o.lat]) }));
    const dentro = fs.filter(x => { try { return turf.booleanPointInPolygon(x.pt, F); } catch { return false; } });
    const perto = fs.filter(x => !dentro.includes(x)).map(x => ({ ...x, km: distKm(F, x.pt) })).filter(x => x.km <= CONF.raioKm);
    [...dentro, ...perto].forEach(x => L.circleMarker([+x.o.lat, +x.o.lon], { radius: 6, color: '#fff', weight: 1, fillColor: '#ff5a00', fillOpacity: 1 }).bindPopup(`<b>Foco de queimada</b><br>${esc(x.o.data_hora_gmt || '')}<br>${esc(x.o.satelite || '')}`).addTo(DL.group));
    let nivel = 'ok', resumo = `Nenhum foco de queimada na área nem em até ${CONF.raioKm} km nos últimos ${CONF.diasFocos} dias.`;
    if (dentro.length) { nivel = 'grave'; resumo = `<b>${dentro.length} foco(s) dentro da área</b> nos últimos ${CONF.diasFocos} dias${perto.length ? `, e mais ${perto.length} a menos de ${CONF.raioKm} km` : ''}.`; }
    else if (perto.length) { nivel = 'alerta'; resumo = `${perto.length} foco(s) a menos de ${CONF.raioKm} km nos últimos ${CONF.diasFocos} dias. O mais próximo a ${fmt(Math.min(...perto.map(p => p.km)), 1)} km.`; }
    const all = [...dentro.map(x => ({ ...x, km: 0 })), ...perto].sort((a, b) => String(b.o.data_hora_gmt).localeCompare(String(a.o.data_hora_gmt)));
    return { nivel, resumo, detalhes: all.length ? tabela(['Data/hora (UTC)', 'Satélite', 'Distância', 'Dias sem chuva'], all.slice(0, 50).map(x => [esc(x.o.data_hora_gmt || ''), esc(x.o.satelite || ''), x.km ? `${fmt(x.km, 1)} km` : '<b>dentro</b>', esc(x.o.numero_dias_sem_chuva || '—')])) : '' };
  },
  clima(j) {
    const d = j.daily, hoje = isoDay(new Date());
    const idx = d.time.findIndex(t => t >= hoje);
    const passado = d.precipitation_sum.slice(0, idx < 0 ? d.time.length : idx), futuro = idx < 0 ? [] : d.precipitation_sum.slice(idx);
    const chuva30 = passado.reduce((s, v) => s + (v || 0), 0), chuva7 = futuro.reduce((s, v) => s + (v || 0), 0);
    let semChuva = 0; for (let i = passado.length - 1; i >= 0 && (passado[i] || 0) < 1; i--) semChuva++;
    const c = j.current || {};
    const resumo = `Agora: <b>${fmt(c.temperature_2m, 0)} °C</b>, umidade ${fmt(c.relative_humidity_2m, 0)}%. Chuva nos últimos 30 dias: <b>${fmt(chuva30, 0)} mm</b> · ${semChuva} dia(s) seguidos sem chuva. Previsão para 7 dias: <b>${fmt(chuva7, 0)} mm</b>.`;
    const id = 'climaChart' + Date.now();
    return {
      nivel: 'info', resumo, extra: `<div class="chartbox sm"><canvas id="${id}"></canvas></div>`,
      dados: { chuva30, chuva7, semChuva, temp: c.temperature_2m },
      chart: () => {
        const el = document.getElementById(id); if (!el) return;
        if (S.climaChart) S.climaChart.destroy();
        S.climaChart = new Chart(el, {
          data: {
            labels: d.time.map(t => dBR(t).slice(0, 5)),
            datasets: [
              { type: 'bar', label: 'Chuva (mm)', data: d.precipitation_sum, backgroundColor: d.time.map(t => t >= hoje ? '#5aa9ff' : '#2f6fb3'), yAxisID: 'y' },
              { type: 'line', label: 'Máx (°C)', data: d.temperature_2m_max, borderColor: '#f2c14e', pointRadius: 0, tension: .3, yAxisID: 'y2' },
            ],
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            scales: { y: { ticks: { color: '#9db3a4' }, grid: { color: '#24382b' }, title: { display: true, text: 'mm', color: '#9db3a4' } }, y2: { position: 'right', ticks: { color: '#9db3a4' }, grid: { display: false } }, x: { ticks: { color: '#9db3a4', maxTicksLimit: 8, maxRotation: 0 }, grid: { display: false } } },
            plugins: { legend: { labels: { color: '#e8f0ea' } } },
          },
        });
      },
    };
  },
};

// ---------- Camadas de referência no mapa (WMS: só imagem, não precisa da ponte) ----------
function camadasReferencia(uf) {
  uf = (uf || 'MA').toLowerCase();
  const o = { format: 'image/png', transparent: true, version: '1.1.1', maxZoom: 19 };
  return {
    'CAR (imóveis)': L.tileLayer.wms('https://geoserver.car.gov.br/geoserver/sicar/wms', { ...o, layers: `sicar:sicar_imoveis_${uf}` }),
    'SIGEF particular': L.tileLayer.wms(`https://acervofundiario.incra.gov.br/i3geo/ogc.php?tema=certificada_sigef_particular_${uf}`, { ...o, layers: `certificada_sigef_particular_${uf}` }),
    'Embargos IBAMA': L.tileLayer.wms('https://siscom.ibama.gov.br/geoserver/publica/wms', { ...o, layers: 'publica:vw_brasil_adm_embargo_a' }),
    'PRODES Cerrado': L.tileLayer.wms('https://terrabrasilis.dpi.inpe.br/geoserver/prodes-cerrado-nb/wms', { ...o, layers: 'prodes-cerrado-nb:yearly_deforestation' }),
    'PRODES Amazônia': L.tileLayer.wms('https://terrabrasilis.dpi.inpe.br/geoserver/prodes-legal-amz/wms', { ...o, layers: 'prodes-legal-amz:yearly_deforestation' }),
  };
}

// ---------- Relatório (imprimir / salvar em PDF) ----------
function imagemNDVIcomContorno() {
  const res = S.result; if (!res || res.isDiff) return null;
  const f = farm(), g = res.g, fwd = toUTM(g.epsg);
  const img = new Image(); img.src = renderCanvas(res, 'ndvi');
  return new Promise(ok => {
    img.onload = () => {
      const k = Math.max(1, Math.round(900 / Math.max(g.W, g.H)));
      const cv = document.createElement('canvas'); cv.width = g.W * k; cv.height = g.H * k;
      const ctx = cv.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.imageSmoothingEnabled = false; ctx.drawImage(img, 0, 0, cv.width, cv.height);
      const desenha = (rings, lw) => rings.forEach(r => {
        ctx.lineWidth = lw; ctx.beginPath();
        r.forEach((c, i) => { const [x, y] = fwd(c); const px = (x - g.bbox[0]) / g.res * k, py = (g.bbox[3] - y) / g.res * k; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
        ctx.closePath(); ctx.stroke();
      });
      ctx.strokeStyle = '#111';
      (f.divs || []).forEach(dv => {
        desenha(dv.rings, 1);
        const c = turf.centroid(turf.polygon(dv.rings)).geometry.coordinates, [x, y] = fwd(c);
        ctx.font = `bold ${Math.max(11, 6 * k)}px system-ui`; ctx.textAlign = 'center'; ctx.fillStyle = '#111';
        ctx.fillText(dv.nome, (x - g.bbox[0]) / g.res * k, (g.bbox[3] - y) / g.res * k);
      });
      ctx.lineWidth = 2;
      f.polys.forEach(p => p.forEach(r => {
        ctx.beginPath();
        r.forEach((c, i) => { const [x, y] = fwd(c); const px = (x - g.bbox[0]) / g.res * k, py = (g.bbox[3] - y) / g.res * k; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
        ctx.closePath(); ctx.stroke();
      }));
      ok(cv.toDataURL('image/png'));
    };
  });
}
async function gerarRelatorio() {
  const f = farm(); if (!f) return;
  const cons = CONF.consultor;
  const ndvi = await imagemNDVIcomContorno();
  const st = S.result && !S.result.isDiff ? S.result.stats : null;
  let serieImg = null;
  if (S.chart && S.seriesData && S.seriesData.length) {
    // redesenha o gráfico em fundo branco para impressão
    const cv = document.createElement('canvas'); cv.width = 900; cv.height = 320; cv.style.cssText = 'position:fixed;left:-9999px'; document.body.appendChild(cv);
    const ch = new Chart(cv, { type: 'line', data: { labels: S.seriesData.map(r => dBR(r.date)), datasets: [{ label: 'NDVI', data: S.seriesData.map(r => r.ndvi), borderColor: '#1a9850', tension: .3 }, { label: 'NDRE', data: S.seriesData.map(r => r.ndre), borderColor: '#d4a017', borderDash: [4, 3], tension: .3 }] }, options: { animation: false, responsive: false, scales: { y: { min: 0, max: 1 } } } });
    serieImg = cv.toDataURL('image/png'); ch.destroy(); cv.remove();
  }
  const cor = { ok: '#1a9850', alerta: '#e0a800', grave: '#d73027', erro: '#888', info: '#2f6fb3' };
  const rot = { ok: 'Sem pendências', alerta: 'Atenção', grave: 'Crítico', erro: 'Não consultado', info: 'Informativo' };
  const diag = S.diag ? ['car', 'sigef', 'emb', 'prodes', 'fogo', 'clima'].map(k => S.diag.itens[k]).filter(Boolean) : [];
  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório — ${esc(f.name)}</title>
<style>
 body{font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1b1b1b;margin:0;padding:24px 28px;max-width:900px}
 header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #1a9850;padding-bottom:10px;margin-bottom:16px}
 h1{font-size:20px;margin:0} h2{font-size:15px;margin:22px 0 8px;color:#1a6b3c;border-bottom:1px solid #ddd;padding-bottom:4px}
 .sub{color:#555;font-size:12px} .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
 .k{border:1px solid #ddd;border-radius:8px;padding:8px} .k b{display:block;font-size:17px}
 table{width:100%;border-collapse:collapse;font-size:12px;margin-top:6px} th,td{border:1px solid #ddd;padding:4px 6px;text-align:left} th{background:#f2f5f3}
 .tag{display:inline-block;color:#fff;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:700}
 img{max-width:100%} .item{margin-bottom:10px;page-break-inside:avoid} details{display:block} summary{display:none}
 .grad{height:10px;border-radius:5px;background:linear-gradient(90deg,#a50026,#f46d43,#fee08b,#a6d96a,#1a9850,#006837);margin:4px 0}
 footer{margin-top:26px;border-top:1px solid #ddd;padding-top:8px;font-size:11px;color:#666}
 @media print{body{padding:0} button{display:none}}
</style></head><body>
<div style="text-align:right;margin-bottom:10px"><button onclick="print()" style="padding:8px 14px">Imprimir / salvar PDF</button></div>
<header><div><h1>Relatório da propriedade — ${esc(f.name)}</h1>
<div class="sub">${f.owner ? 'Cliente: ' + esc(f.owner) + ' · ' : ''}${ha(f.area)} · ${esc(f.uf || '')}${f.car ? ' · CAR ' + esc(f.car) : ''}</div></div>
<div class="sub" style="text-align:right">${cons.nome ? '<b>' + esc(cons.nome) + '</b><br>' : ''}${cons.empresa ? esc(cons.empresa) + '<br>' : ''}${cons.contato ? esc(cons.contato) + '<br>' : ''}Emitido em ${dBR(isoDay(new Date()))}</div></header>
${diag.length ? `<h2>Situação ambiental e fundiária</h2>${diag.map(d => `<div class="item"><span class="tag" style="background:${cor[d.nivel]}">${rot[d.nivel]}</span> <b>${d.titulo}</b><div>${d.resumo}</div>${d.detalhes || ''}</div>`).join('')}` : '<p class="sub">Situação não verificada (aba Situação).</p>'}
${ndvi ? `<h2>Vigor da vegetação — ${dBR(S.result.it.properties.datetime)}</h2>
<div style="display:grid;grid-template-columns:1.4fr 1fr;gap:14px;align-items:start"><div><img src="${ndvi}"><div class="grad"></div><div class="sub" style="display:flex;justify-content:space-between"><span>NDVI baixo</span><span>NDVI alto</span></div></div>
<div><div class="grid" style="grid-template-columns:1fr 1fr">${st ? `<div class="k"><b>${fmt(st.mean)}</b>NDVI médio</div><div class="k"><b>${S.result.statsRE ? fmt(S.result.statsRE.mean) : '—'}</b>NDRE médio</div><div class="k"><b>${fmt(st.p10)}</b>pior 10%</div><div class="k"><b>${fmt(st.p90)}</b>melhor 10%</div>` : ''}</div>${tabelaDivs(S.result.divStats)}</div></div>` : '<p class="sub">Nenhuma imagem de satélite aberta (aba Imagens).</p>'}
${typeof CL !== 'undefined' && CL.dados ? `<h2>Clima — ${dBR(CL.dados.ini)} a ${dBR(CL.dados.fim)}</h2><div class="grid"><div class="k"><b>${fmt(CL.dados.chuva, 0)} mm</b>chuva acumulada</div><div class="k"><b>${CL.dados.diasChuva}</b>dias com chuva</div><div class="k"><b>${CL.dados.seco}</b>dias seguidos sem chuva</div><div class="k"><b>+${fmt(CL.dados.gdd, 0)}</b>soma térmica (base ${CL.dados.tb} °C)</div><div class="k"><b>${fmt(CL.dados.tmaxMed, 1)}° / ${fmt(CL.dados.tminMed, 1)}°</b>máx / mín médias</div><div class="k"><b>${fmt(CL.dados.chuvaPrev, 0)} mm</b>previsão 7 dias</div></div>` : ''}
${serieImg ? `<h2>Histórico de NDVI</h2><img src="${serieImg}"><p class="sub">${$('serieSum').textContent}</p>` : ''}
<footer>Fontes: SICAR/SFB (CAR), INCRA/Acervo Fundiário (SIGEF), IBAMA/SISCOM (embargos), INPE/TerraBrasilis (PRODES), INPE/Programa Queimadas (focos), Open-Meteo (clima), Copernicus Sentinel-2/ESA (imagens). Dados públicos consultados na data de emissão; não substituem certidões oficiais.</footer>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) { toast('Permita janelas pop-up para abrir o relatório.'); return; }
  w.document.open(); w.document.write(html); w.document.close();
}
