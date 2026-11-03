/* AgroSat — Clima detalhado, exportar KML e memorial descritivo. */
'use strict';

// ======================= CLIMA =======================
const CL = { chart1: null, chart2: null, dados: null };
function periodoClima() {
  const v = $('clPer').value, hoje = new Date();
  if (v === 'custom') return { ini: $('clIni').value, fim: $('clFim').value };
  const ini = new Date(hoje); ini.setDate(ini.getDate() - (+v - 1));
  return { ini: isoDay(ini), fim: isoDay(hoje) };
}
async function buscarClima(lon, lat, ini, fim) {
  const hoje = new Date(), dias = Math.round((new Date(fim) - new Date(ini)) / 864e5) + 1;
  const diasAtras = Math.round((hoje - new Date(ini)) / 864e5);
  const vars = 'precipitation_sum,temperature_2m_max,temperature_2m_min';
  const base = `latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&timezone=auto&daily=${vars}`;
  let hist;
  if (diasAtras <= 90) {
    // previsão (cobre até 92 dias passados) + 7 dias à frente
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?${base}&past_days=${diasAtras}&forecast_days=8`);
    if (!r.ok) throw new Error('clima respondeu ' + r.status);
    hist = (await r.json()).daily;
  } else {
    // histórico (ERA5) até ~5 dias atrás + previsão para completar até hoje e 7 dias à frente
    const fimArq = new Date(Math.min(new Date(fim), hoje - 6 * 864e5));
    const [ra, rf] = await Promise.all([
      fetch(`https://archive-api.open-meteo.com/v1/archive?${base}&start_date=${ini}&end_date=${isoDay(fimArq)}`),
      fetch(`https://api.open-meteo.com/v1/forecast?${base}&past_days=7&forecast_days=8`),
    ]);
    if (!ra.ok) throw new Error('histórico de clima respondeu ' + ra.status);
    const a = (await ra.json()).daily, f = rf.ok ? (await rf.json()).daily : { time: [] };
    const ult = a.time[a.time.length - 1] || '';
    hist = { time: [...a.time], precipitation_sum: [...a.precipitation_sum], temperature_2m_max: [...a.temperature_2m_max], temperature_2m_min: [...a.temperature_2m_min] };
    f.time.forEach((t, i) => { if (t > ult) { hist.time.push(t); hist.precipitation_sum.push(f.precipitation_sum[i]); hist.temperature_2m_max.push(f.temperature_2m_max[i]); hist.temperature_2m_min.push(f.temperature_2m_min[i]); } });
  }
  return hist;
}
async function atualizarClima() {
  const f = farm(); if (!f) return;
  const { ini, fim } = periodoClima();
  if (!ini || !fim || ini > fim) return toast('Confira as datas do período.');
  const c = turf.centroid(farmFeature(f)).geometry.coordinates;
  $('clBtn').disabled = true; $('clResumo').innerHTML = '<p class="hint">Consultando clima…</p>';
  try {
    const d = await buscarClima(c[0], c[1], ini, fim);
    const hoje = isoDay(new Date()), tb = +$('clBase').value;
    const idx = d.time.map((t, i) => i).filter(i => d.time[i] >= ini && d.time[i] <= fim && d.time[i] <= hoje);
    const prev = d.time.map((t, i) => i).filter(i => d.time[i] > hoje).slice(0, 7);
    let acc = 0, gdd = 0;
    const serie = idx.map(i => {
      const p = d.precipitation_sum[i] || 0, tx = d.temperature_2m_max[i], tn = d.temperature_2m_min[i];
      acc += p; if (tx != null && tn != null) gdd += Math.max(0, (tx + tn) / 2 - tb);
      return { t: d.time[i], p, acc, tx, tn, gdd };
    });
    const ult = serie[serie.length - 1] || { acc: 0, gdd: 0 };
    const diasChuva = serie.filter(s => s.p >= 1).length;
    const maior = serie.reduce((m, s) => s.p > m.p ? s : m, { p: 0, t: '' });
    let seco = 0; for (let i = serie.length - 1; i >= 0 && serie[i].p < 1; i--) seco++;
    const med = k => { const v = serie.map(s => s[k]).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; };
    const tmax = Math.max(...serie.map(s => s.tx ?? -99)), tmin = Math.min(...serie.map(s => s.tn ?? 99));
    const chuvaPrev = prev.reduce((s, i) => s + (d.precipitation_sum[i] || 0), 0);
    CL.dados = { ini, fim, tb, serie, chuva: ult.acc, gdd: ult.gdd, diasChuva, maior, seco, tmaxMed: med('tx'), tminMed: med('tn'), tmax, tmin, chuvaPrev, prev: prev.map(i => ({ t: d.time[i], p: d.precipitation_sum[i] || 0, tx: d.temperature_2m_max[i], tn: d.temperature_2m_min[i] })) };
    desenharClima();
  } catch (e) { console.error(e); $('clResumo').innerHTML = `<p class="hint">Não consegui consultar o clima: ${esc(e.message)}</p>`; }
  finally { $('clBtn').disabled = false; }
}
function desenharClima() {
  const D = CL.dados; if (!D) return;
  $('clResumo').innerHTML = `
    <div class="kpis">
      <div class="kpi"><b>${fmt(D.chuva, 0)} mm</b><span>chuva acumulada</span></div>
      <div class="kpi"><b>${D.diasChuva}</b><span>dias com chuva (≥1 mm)</span></div>
      <div class="kpi"><b>${D.seco}</b><span>dias seguidos sem chuva</span></div>
      <div class="kpi"><b>${fmt(D.maior.p, 0)} mm</b><span>maior chuva${D.maior.t ? ' (' + dBR(D.maior.t).slice(0, 5) + ')' : ''}</span></div>
      <div class="kpi"><b>+${fmt(D.gdd, 0)}</b><span>soma térmica (°C·dia, base ${D.tb})</span></div>
      <div class="kpi"><b>${fmt(D.tmaxMed, 1)}° / ${fmt(D.tminMed, 1)}°</b><span>máx / mín médias</span></div>
    </div>
    <p class="hint">${dBR(D.ini)} a ${dBR(D.fim)} · extremos: ${fmt(D.tmax, 1)} °C e ${fmt(D.tmin, 1)} °C.</p>`;
  const lab = D.serie.map(s => dBR(s.t).slice(0, 5));
  const eixo = { ticks: { color: '#9db3a4', maxTicksLimit: 7, maxRotation: 0 }, grid: { display: false } };
  const yy = t => ({ ticks: { color: '#9db3a4' }, grid: { color: '#24382b' }, title: { display: true, text: t, color: '#9db3a4' } });
  const leg = { legend: { labels: { color: '#e8f0ea', boxWidth: 12 } } };
  if (CL.chart1) CL.chart1.destroy(); if (CL.chart2) CL.chart2.destroy();
  CL.chart1 = new Chart($('clChart1'), {
    data: { labels: lab, datasets: [
      { type: 'line', label: 'Acumulada (mm)', data: D.serie.map(s => s.acc), borderColor: '#5aa9ff', backgroundColor: 'rgba(90,169,255,.15)', fill: true, pointRadius: 0, tension: .2, yAxisID: 'y' },
      { type: 'bar', label: 'Diária (mm)', data: D.serie.map(s => s.p), backgroundColor: '#2f6fb3', yAxisID: 'y2' },
    ] },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, scales: { x: eixo, y: yy('acumulada (mm)'), y2: { position: 'right', ticks: { color: '#9db3a4' }, grid: { display: false } } }, plugins: leg },
  });
  CL.chart2 = new Chart($('clChart2'), {
    data: { labels: lab, datasets: [
      { type: 'line', label: `Soma térmica (base ${D.tb} °C)`, data: D.serie.map(s => s.gdd), borderColor: '#ff8a3d', backgroundColor: 'rgba(255,138,61,.12)', fill: true, pointRadius: 0, tension: .2, yAxisID: 'y' },
      { type: 'line', label: 'Máx (°C)', data: D.serie.map(s => s.tx), borderColor: '#ff5a5a', pointRadius: 0, borderWidth: 1.2, yAxisID: 'y2' },
      { type: 'line', label: 'Mín (°C)', data: D.serie.map(s => s.tn), borderColor: '#7ec8ff', pointRadius: 0, borderWidth: 1.2, yAxisID: 'y2' },
    ] },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, scales: { x: eixo, y: yy('°C·dia acumulado'), y2: { position: 'right', ticks: { color: '#9db3a4' }, grid: { display: false } } }, plugins: leg },
  });
  $('clPrev').innerHTML = D.prev.length ? `<h4>Previsão — próximos 7 dias · ${fmt(D.chuvaPrev, 0)} mm</h4><div class="prev">${D.prev.map(p => `<div><b>${dBR(p.t).slice(0, 5)}</b><span>${p.p >= 1 ? '🌧' : '☀'} ${fmt(p.p, 0)} mm</span><small>${fmt(p.tx, 0)}° / ${fmt(p.tn, 0)}°</small></div>`).join('')}</div>` : '';
}
$('clPer').onchange = () => { $('clCustom').hidden = $('clPer').value !== 'custom'; if ($('clPer').value !== 'custom') atualizarClima(); };
$('clBase').onchange = () => CL.dados && atualizarClima();
$('clBtn').onclick = atualizarClima;
(() => { const t = new Date(), f = new Date(); f.setMonth(f.getMonth() - 3); $('clIni').value = isoDay(f); $('clFim').value = isoDay(t); })();

// ======================= KML =======================
function baixar(nome, conteudo, tipo) {
  const blob = new Blob([conteudo], { type: tipo });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = nome;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const slug = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w]+/g, '_').replace(/^_|_$/g, '') || 'fazenda';
const xmlEsc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function kmlDaFazenda(f) {
  const poly = rings => `<Polygon><outerBoundaryIs><LinearRing><coordinates>${rings[0].map(c => `${c[0].toFixed(8)},${c[1].toFixed(8)},0`).join(' ')}</coordinates></LinearRing></outerBoundaryIs>${rings.slice(1).map(h => `<innerBoundaryIs><LinearRing><coordinates>${h.map(c => `${c[0].toFixed(8)},${c[1].toFixed(8)},0`).join(' ')}</coordinates></LinearRing></innerBoundaryIs>`).join('')}</Polygon>`;
  const pm = (nome, desc, polys, estilo) => `<Placemark><name>${xmlEsc(nome)}</name><description>${xmlEsc(desc)}</description><styleUrl>#${estilo}</styleUrl>${polys.length > 1 ? `<MultiGeometry>${polys.map(poly).join('')}</MultiGeometry>` : poly(polys[0])}</Placemark>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${xmlEsc(f.name)}</name>
<Style id="per"><LineStyle><color>ff00ffff</color><width>3</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style>
<Style id="div"><LineStyle><color>ffffffff</color><width>1.5</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style>
${pm(f.name, `Perímetro · ${fmt(f.area, 2)} ha${f.car ? ' · CAR ' + f.car : ''}`, f.polys, 'per')}
${(f.divs || []).length ? `<Folder><name>Divisões</name>${f.divs.map(d => pm(d.nome, `${fmt(areaHa([d.rings]), 2)} ha`, [d.rings], 'div')).join('')}</Folder>` : ''}
</Document></kml>`;
}
$('btnKML').onclick = () => { const f = farm(); if (f) { baixar(`${slug(f.name)}.kml`, kmlDaFazenda(f), 'application/vnd.google-earth.kml+xml'); toast('KML gerado.'); } };

// ======================= MEMORIAL DESCRITIVO =======================
function gms(v, pos, neg) {
  const s = v < 0 ? neg : pos; v = Math.abs(v);
  let g = Math.floor(v), m = Math.floor((v - g) * 60), sec = ((v - g) * 60 - m) * 60;
  if (sec >= 59.9995) { sec = 0; m++; } if (m >= 60) { m = 0; g++; }
  return `${g}°${String(m).padStart(2, '0')}'${sec.toFixed(3).replace('.', ',').padStart(6, '0')}" ${s}`;
}
function azGMS(az) {
  let g = Math.floor(az), m = Math.floor((az - g) * 60), s = Math.round(((az - g) * 60 - m) * 60);
  if (s === 60) { s = 0; m++; } if (m === 60) { m = 0; g++; }
  return `${g}°${String(m).padStart(2, '0')}'${String(s).padStart(2, '0')}"`;
}
function memorialDados(f) {
  const c = turf.centroid(farmFeature(f)).geometry.coordinates, epsg = utmEPSG(c[0], c[1]), fwd = toUTM(epsg);
  const zona = `${epsg % 100}${Math.floor(epsg / 100) === 327 ? 'S' : 'N'}`;
  let n = 0;
  const partes = f.polys.map((p, ip) => p.map((ring, ir) => {
    let pts = ring.slice(); if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
    pts = pts.filter((q, i) => i === 0 || q[0] !== pts[i - 1][0] || q[1] !== pts[i - 1][1]);
    // começa pelo vértice mais ao norte e segue no sentido horário (padrão de memorial)
    const u = pts.map(fwd);
    let area2 = 0; for (let i = 0; i < u.length; i++) { const a = u[i], b = u[(i + 1) % u.length]; area2 += a[0] * b[1] - b[0] * a[1]; }
    if (area2 > 0) { pts.reverse(); u.reverse(); }
    let i0 = 0; u.forEach((q, i) => { if (q[1] > u[i0][1]) i0 = i; });
    const P = pts.slice(i0).concat(pts.slice(0, i0)), U = u.slice(i0).concat(u.slice(0, i0));
    const vs = P.map((ll, i) => {
      const a = U[i], b = U[(i + 1) % U.length], dE = b[0] - a[0], dN = b[1] - a[1];
      let az = Math.atan2(dE, dN) * 180 / Math.PI; if (az < 0) az += 360;
      return { id: `V${++n}`, lat: ll[1], lon: ll[0], E: a[0], N: a[1], az, dist: Math.hypot(dE, dN) };
    });
    vs.forEach((v, i) => v.prox = vs[(i + 1) % vs.length].id);
    return { parte: ip + 1, furo: ir > 0, vs, perim: vs.reduce((s, v) => s + v.dist, 0) };
  })).flat();
  return { epsg, zona, partes, perim: partes.filter(p => !p.furo).reduce((s, p) => s + p.perim, 0) };
}
function gerarMemorial() {
  const f = farm(); if (!f) return;
  const M = memorialDados(f), cons = CONF.consultor;
  const m2 = v => fmt(v, 2), m3 = v => fmt(v, 3);
  const texto = M.partes.map(p => {
    const v0 = p.vs[0];
    const intro = p.furo ? `<b>Exclusão (área interna não pertencente ao imóvel)</b> — ` : M.partes.filter(x => !x.furo).length > 1 ? `<b>Gleba ${p.parte}</b> — ` : '';
    const trechos = p.vs.map((v, i) => `deste segue com azimute de ${azGMS(v.az)} e distância de ${m2(v.dist)} m até o vértice ${v.prox}${i === p.vs.length - 1 ? ', ponto inicial da descrição deste perímetro' : `, de coordenadas N ${m3(p.vs[i + 1].N)} m e E ${m3(p.vs[i + 1].E)} m`}`).join('; ');
    return `<p>${intro}Inicia-se a descrição deste perímetro no vértice ${v0.id}, de coordenadas N ${m3(v0.N)} m e E ${m3(v0.E)} m; ${trechos}.</p>`;
  }).join('');
  const tab = M.partes.map(p => `<table><tr><th>Vértice</th><th>Latitude</th><th>Longitude</th><th>N (m)</th><th>E (m)</th><th>Azimute</th><th>Distância (m)</th><th>Para</th></tr>${p.vs.map(v => `<tr><td>${v.id}</td><td>${gms(v.lat, 'N', 'S')}</td><td>${gms(v.lon, 'L', 'O')}</td><td>${m3(v.N)}</td><td>${m3(v.E)}</td><td>${azGMS(v.az)}</td><td>${m2(v.dist)}</td><td>${v.prox}</td></tr>`).join('')}</table>`).join('');
  const csv = ['vertice;latitude;longitude;N_utm;E_utm;azimute_graus;distancia_m;proximo']
    .concat(M.partes.flatMap(p => p.vs.map(v => [v.id, v.lat.toFixed(8), v.lon.toFixed(8), v.N.toFixed(3), v.E.toFixed(3), v.az.toFixed(6), v.dist.toFixed(2), v.prox].join(';')))).join('\n');
  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Memorial descritivo — ${esc(f.name)}</title>
<style>body{font:12.5px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1b1b1b;margin:0;padding:24px 28px;max-width:900px}
h1{font-size:19px;margin:0 0 4px;text-align:center}h2{font-size:14px;margin:18px 0 6px;color:#1a6b3c}
.cab{display:grid;grid-template-columns:1fr 1fr;gap:4px 18px;border:1px solid #ccc;border-radius:6px;padding:10px 12px;margin:12px 0}
p{text-align:justify}table{width:100%;border-collapse:collapse;font-size:11px;margin:6px 0 12px}th,td{border:1px solid #ccc;padding:3px 5px;text-align:right}th{background:#f2f5f3}td:first-child,th:first-child{text-align:left}
.bar{display:flex;gap:8px;justify-content:flex-end;margin-bottom:8px}.bar button{padding:7px 12px}.ass{margin-top:46px;text-align:center}.ass div{border-top:1px solid #333;width:320px;margin:0 auto;padding-top:4px}
.aviso{font-size:11px;color:#666;border-top:1px solid #ddd;padding-top:6px;margin-top:20px}@media print{.bar{display:none}body{padding:0}}</style></head><body>
<div class="bar"><button id="csv">Baixar planilha (CSV)</button><button onclick="print()">Imprimir / salvar PDF</button></div>
<h1>MEMORIAL DESCRITIVO</h1>
<div class="cab"><div><b>Imóvel:</b> ${esc(f.name)}</div><div><b>Proprietário/cliente:</b> ${esc(f.owner || '—')}</div>
<div><b>Área:</b> ${fmt(f.area, 4)} ha</div><div><b>Perímetro:</b> ${m2(M.perim)} m</div>
<div><b>UF:</b> ${esc(f.uf || '—')}</div><div><b>CAR:</b> ${esc(f.car || '—')}</div>
<div><b>Sistema:</b> SIRGAS 2000 · UTM fuso ${M.zona} (EPSG:${Math.floor(M.epsg / 100) === 327 ? 31960 + (M.epsg % 100) : 31954 + (M.epsg % 100)})</div><div><b>Vértices:</b> ${M.partes.reduce((s, p) => s + p.vs.length, 0)}</div></div>
<h2>Descrição do perímetro</h2>${texto}
<h2>Tabela de vértices</h2>${tab}
<div class="ass"><div>${esc(cons.nome || 'Responsável técnico')}${cons.empresa ? '<br>' + esc(cons.empresa) : ''}</div></div>
<p class="aviso">Gerado a partir do perímetro cadastrado no AgroSat (${f.car ? 'CAR' : 'arquivo enviado'}). Azimutes e distâncias calculados na projeção UTM (plano), sem levantamento de campo. Não substitui memorial de georreferenciamento certificado (Norma Técnica do INCRA/SIGEF), que exige levantamento por profissional credenciado.</p>
<script>document.getElementById('csv').onclick=()=>{const b=new Blob(['\\ufeff'+${JSON.stringify(csv)}],{type:'text/csv'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=${JSON.stringify(slug(f.name) + '_vertices.csv')};document.body.appendChild(a);a.click();};<\/script>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) { toast('Permita janelas pop-up para abrir o memorial.'); return; }
  w.document.open(); w.document.write(html); w.document.close();
}
$('btnMemo').onclick = gerarMemorial;

// abre o clima automaticamente ao entrar na aba; limpa ao trocar de fazenda
document.querySelector('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b && b.dataset.tab === 'clima' && !CL.dados) atualizarClima(); });
const _ofc = window.onFarmChange;
window.onFarmChange = f => { _ofc && _ofc(f); CL.dados = null; if (CL.chart1) { CL.chart1.destroy(); CL.chart1 = null; } if (CL.chart2) { CL.chart2.destroy(); CL.chart2 = null; } $('clResumo').innerHTML = ''; $('clPrev').innerHTML = ''; };
