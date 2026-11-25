// Servidor de monitoramento - Shopping Night
// Guarda os dados em memória (somem ao reiniciar). O banco de dados entra na próxima etapa.
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const { ADMIN_USER, ADMIN_PASS } = process.env;
if (!ADMIN_USER || !ADMIN_PASS) {
  console.error('Defina ADMIN_USER e ADMIN_PASS nas variáveis de ambiente.');
  process.exit(1);
}
const SECRET = process.env.SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SECRET) console.warn('Aviso: defina SECRET (senão os logins caem a cada reinício).');
const ORIGENS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

const app = express();
app.set('trust proxy', true);
app.use(cors({ origin: (o, cb) => cb(null, !o || ORIGENS.includes(o)) }));
app.use(express.json({ limit: '5kb', type: ['application/json', 'text/plain'] }));

// ---------- memória ----------
const sessoes = new Map();   // sid -> sessão
let eventos = [];            // últimas ações
let pedidos = [];
let visitas = [];            // horários (ms) das visitas, últimas 24h
const produtos = {};         // produto -> visualizações
const cliquesTotal = { n: 0, compart: 0 };
let proxId = 1;

const agora = () => Date.now();
const txt = (v, n = 60) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const horaBA = d => Number(new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', hourCycle: 'h23', timeZone: 'America/Bahia' }).format(d));

function dispositivo(ua = '') {
  const d = /ipad|tablet/i.test(ua) ? 'Tablet' : /mobi|android|iphone/i.test(ua) ? 'Celular' : 'Computador';
  const so = /windows/i.test(ua) ? 'Windows' : /android/i.test(ua) ? 'Android' : /iphone|ipad|ios/i.test(ua) ? 'iOS' : /mac/i.test(ua) ? 'macOS' : /linux/i.test(ua) ? 'Linux' : 'Outro';
  return { d, so };
}
function origem(ref = '') {
  const r = ref.toLowerCase();
  if (!r) return 'Direto';
  if (r.includes('google')) return 'Google';
  if (r.includes('instagram')) return 'Instagram';
  if (r.includes('whatsapp') || r.includes('wa.me')) return 'WhatsApp';
  if (r.includes('facebook')) return 'Facebook';
  return 'Direto';
}

// localização aproximada pelo IP (só cidade/estado; best-effort)
const geoCache = new Map();
async function geo(ip) {
  if (geoCache.has(ip)) return geoCache.get(ip);
  let r = { cidade: '', uf: '' };
  try {
    const j = await (await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: AbortSignal.timeout(3000) })).json();
    if (j && j.success) r = { cidade: j.city || '', uf: j.region_code || '' };
  } catch (_) {}
  geoCache.set(ip, r);
  return r;
}

function addEvento(texto) {
  eventos.unshift({ id: proxId++, t: new Date().toISOString(), texto });
  if (eventos.length > 200) eventos.length = 200;
}

// ---------- limite de requisições ----------
const limites = new Map();
function limitar(chave, max, janelaMs) {
  const n = agora(), l = limites.get(chave) || { c: 0, ate: n + janelaMs };
  if (n > l.ate) { l.c = 0; l.ate = n + janelaMs; }
  l.c++; limites.set(chave, l);
  return l.c <= max;
}

// ---------- rotas públicas (o site da loja envia aqui) ----------
const TIPOS = new Set(['visita', 'ping', 'clique', 'produto', 'zoom', 'compartilhar', 'cadastro', 'pedido']);

app.get('/', (_, res) => res.send('Servidor Shopping Night online'));

app.post('/api/evento', async (req, res) => {
  const o = req.headers.origin;
  if (o && !ORIGENS.includes(o)) return res.sendStatus(403);
  if (!limitar('ev:' + req.ip, 120, 60000)) return res.sendStatus(429);

  const b = req.body || {};
  const sid = txt(b.sid, 64);
  if (!/^[\w-]{8,64}$/.test(sid) || !TIPOS.has(b.tipo)) return res.sendStatus(400);

  let s = sessoes.get(sid);
  if (!s) {
    const dv = dispositivo(req.headers['user-agent']);
    s = { sid, nome: '', bairro: '', cidade: '', uf: '', d: dv.d, so: dv.so, origem: origem(txt(b.ref, 200)), inicio: agora(), ultimo: agora(), cliques: 0 };
    sessoes.set(sid, s);
    visitas.push(agora());
    geo(req.ip).then(g => { s.cidade = g.cidade; s.uf = g.uf; });
    addEvento('Novo visitante no site');
  }
  s.ultimo = agora();
  if (txt(b.nome, 40)) s.nome = txt(b.nome, 40);
  if (txt(b.bairro)) s.bairro = txt(b.bairro);
  if (txt(b.cidade)) s.cidade = txt(b.cidade);
  const quem = s.nome || 'Visitante';
  const prod = txt(b.produto, 60);

  if (b.tipo === 'clique') { s.cliques++; cliquesTotal.n++; addEvento(`${quem} clicou em ${prod || 'um item'}`); }
  if (b.tipo === 'zoom') { s.cliques++; cliquesTotal.n++; addEvento(`${quem} ampliou a foto de ${prod}`); }
  if (b.tipo === 'compartilhar') { cliquesTotal.compart++; addEvento(`${quem} compartilhou o link`); }
  if (b.tipo === 'cadastro') addEvento(`${quem} fez cadastro`);
  if (b.tipo === 'pedido') {
    const valor = Math.max(0, Math.min(100000, Number(b.valor) || 0));
    pedidos.unshift({ id: proxId++, usuario: quem, produto: prod, valor, t: new Date().toISOString() });
    if (pedidos.length > 500) pedidos.length = 500;
    addEvento(`${quem} fez um pedido: ${prod} (R$ ${valor.toFixed(2).replace('.', ',')})`);
  }
  if (prod && ['clique', 'produto', 'zoom', 'pedido'].includes(b.tipo)) produtos[prod] = (produtos[prod] || 0) + 1;
  res.sendStatus(204);
});

// ---------- login do painel ----------
const sha = v => crypto.createHash('sha256').update(String(v)).digest();
const igual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const assina = p => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');

app.post('/api/login', (req, res) => {
  if (!limitar('lg:' + req.ip, 5, 15 * 60000)) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde 15 minutos.' });
  const { usuario, senha } = req.body || {};
  if (!igual(usuario || '', ADMIN_USER) || !igual(senha || '', ADMIN_PASS)) return res.status(401).json({ erro: 'Usuário ou senha incorretos.' });
  const corpo = Buffer.from(JSON.stringify({ u: ADMIN_USER, exp: agora() + 12 * 3600e3 })).toString('base64url');
  res.json({ token: corpo + '.' + assina(corpo) });
});

function auth(req, res, next) {
  const [corpo, sig] = (req.headers.authorization || '').replace('Bearer ', '').split('.');
  try {
    if (!corpo || !sig || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(assina(corpo)))) throw 0;
    if (JSON.parse(Buffer.from(corpo, 'base64url')).exp < agora()) throw 0;
    next();
  } catch (_) { res.status(401).json({ erro: 'Sessão expirada. Faça login de novo.' }); }
}

// ---------- dados do painel ----------
app.get('/api/resumo', auth, (req, res) => {
  const n = agora(), dia = n - 24 * 3600e3;
  const lista = [...sessoes.values()].sort((a, b) => b.ultimo - a.ultimo);
  const hoje = lista.filter(s => s.inicio >= dia);
  const on = s => n - s.ultimo < 30000;

  const horas = [];
  for (let i = 23; i >= 0; i--) {
    const ini = n - (i + 1) * 3600e3, fim = n - i * 3600e3;
    horas.push({ h: horaBA(new Date(fim)), v: visitas.filter(t => t > ini && t <= fim).length });
  }
  const cont = (campo, chaves) => chaves.map(k => hoje.filter(s => s[campo] === k).length);
  const dur = s => Math.round((s.ultimo - s.inicio) / 1000);

  res.json({
    atualizado: new Date().toISOString(),
    online: lista.filter(on).length,
    acessos: hoje.length,
    cliques: cliquesTotal.n,
    compartilhamentos: cliquesTotal.compart,
    tempoMedio: hoje.length ? Math.round(hoje.reduce((a, s) => a + dur(s), 0) / hoje.length) : 0,
    horas,
    visitantes: lista.slice(0, 30).map(s => ({ nome: s.nome || 'Visitante', bairro: s.bairro, cidade: s.cidade, uf: s.uf, dispositivo: s.d, so: s.so, online: on(s), tempo: dur(s), origem: s.origem })),
    produtos: Object.entries(produtos).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([nome, v]) => ({ nome, v })),
    origens: ['Google', 'WhatsApp', 'Instagram', 'Facebook', 'Direto'].map((k, i) => ({ nome: k, v: cont('origem', ['Google', 'WhatsApp', 'Instagram', 'Facebook', 'Direto'])[i] })),
    dispositivos: ['Celular', 'Computador', 'Tablet'].map((k, i) => ({ nome: k, v: cont('d', ['Celular', 'Computador', 'Tablet'])[i] })),
    pedidos: pedidos.slice(0, 50),
    eventos: eventos.slice(0, 30)
  });
});

// limpeza periódica da memória
setInterval(() => {
  const dia = agora() - 24 * 3600e3;
  for (const [k, s] of sessoes) if (s.ultimo < dia) sessoes.delete(k);
  visitas = visitas.filter(t => t > dia);
  limites.clear();
}, 10 * 60000);

app.listen(process.env.PORT || 3000, () => console.log('Servidor rodando'));
