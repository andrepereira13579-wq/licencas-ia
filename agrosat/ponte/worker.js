/* AgroSat — servidor-ponte (Cloudflare Worker)
   Repassa consultas do app para as bases públicas do governo, que não aceitam
   chamadas diretas do navegador. Só repassa para os endereços da lista abaixo.

   Rotas:
     /?url=<endereço>                         repassa a consulta (GET)
     /focos?bbox=oeste,sul,leste,norte&dias=10  focos de queimada INPE dentro da área
     /saude                                   teste rápido ("ok")
*/

const PERMITIDOS = [
  'geoserver.car.gov.br',          // CAR / SICAR
  'acervofundiario.incra.gov.br',  // SIGEF / INCRA
  'siscom.ibama.gov.br',           // Embargos IBAMA
  'terrabrasilis.dpi.inpe.br',     // PRODES / INPE
  'dataserver-coids.inpe.br',      // Queimadas / INPE
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
}

async function repassar(alvo) {
  let u;
  try { u = new URL(alvo); } catch { return json({ erro: 'endereço inválido' }, 400); }
  if (!PERMITIDOS.includes(u.hostname)) return json({ erro: 'endereço não permitido: ' + u.hostname }, 403);
  const r = await fetch(u.toString(), {
    headers: { 'User-Agent': UA, 'Accept': '*/*' },
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  const h = new Headers(CORS);
  h.set('Content-Type', r.headers.get('Content-Type') || 'application/octet-stream');
  h.set('Cache-Control', 'public, max-age=1800');
  return new Response(r.body, { status: r.status, headers: h });
}

function diaUTC(deslocDias) {
  const d = new Date(Date.now() - deslocDias * 86400000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

async function focos(params) {
  const b = (params.get('bbox') || '').split(',').map(Number);
  if (b.length !== 4 || b.some(isNaN)) return json({ erro: 'bbox inválido' }, 400);
  const dias = Math.min(30, Math.max(1, +params.get('dias') || 10));
  const base = 'https://dataserver-coids.inpe.br/queimadas/queimadas/focos/csv/diario/Brasil/';
  const saida = [], lidos = [];
  await Promise.all(Array.from({ length: dias + 1 }, async (_, k) => {
    const nome = `focos_diario_br_${diaUTC(k)}.csv`;
    try {
      const r = await fetch(base + nome, { headers: { 'User-Agent': UA }, cf: { cacheTtl: k === 0 ? 1800 : 86400, cacheEverything: true } });
      if (!r.ok) return;
      const txt = await r.text();
      const linhas = txt.split(/\r?\n/);
      const cab = linhas[0].split(',').map(s => s.trim().toLowerCase());
      const iLat = cab.indexOf('lat'), iLon = cab.indexOf('lon');
      if (iLat < 0 || iLon < 0) return;
      lidos.push(nome);
      for (let i = 1; i < linhas.length; i++) {
        const c = linhas[i].split(',');
        if (c.length < cab.length) continue;
        const lat = +c[iLat], lon = +c[iLon];
        if (lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3]) {
          const o = {}; cab.forEach((k2, j) => o[k2] = c[j]); saida.push(o);
        }
      }
    } catch (e) { /* dia sem arquivo: ignora */ }
  }));
  return json({ arquivos: lidos.sort(), focos: saida });
}

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u = new URL(req.url);
    if (u.pathname === '/saude') return json({ ok: true });
    if (u.pathname === '/focos') return focos(u.searchParams);
    const alvo = u.searchParams.get('url');
    if (!alvo) return json({ erro: 'informe ?url=' }, 400);
    try { return await repassar(alvo); }
    catch (e) { return json({ erro: 'falha ao consultar a base: ' + e.message }, 502); }
  },
};
