const express = require('express');
const session = require('express-session');
const multer  = require('multer');
const XLSX    = require('xlsx');
const bcrypt  = require('bcryptjs');
const path    = require('path');

const app = express();

// ─────────────────────────────────────────────────────────────
// USUÁRIOS
// Para gerar hash de nova senha, rode:
//   node -e "const b=require('bcryptjs'); console.log(b.hashSync('SENHA',10))"
// ─────────────────────────────────────────────────────────────
const USERS = [
  { id:1, name:'Vitor',       username:'vitor',       passwordHash: bcrypt.hashSync('pontofacil2026',10), role:'admin'  },
  { id:2, name:'Coordenador', username:'coordenador', passwordHash: bcrypt.hashSync('coord123',10),       role:'viewer' },
  { id:3, name:'Supervisor',  username:'supervisor',  passwordHash: bcrypt.hashSync('super123',10),       role:'viewer' },
];

// Dados por data: { "2026-02-09": { data: [...], processedAt: "..." }, ... }
let dataByDate = {};

const storage = multer.memoryStorage();
const upload  = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'pontofacil-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 },
}));

function requireAuth(req, res, next)  { if (req.session.userId) return next(); res.status(401).json({ error: 'Não autenticado' }); }
function requireAdmin(req, res, next) { if (req.session.role === 'admin') return next(); res.status(403).json({ error: 'Acesso restrito' }); }

// ── Auth ─────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = USERS.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.passwordHash))
    return res.status(401).json({ error: 'Usuário ou senha incorretos' });
  req.session.userId   = user.id;
  req.session.userName = user.name;
  req.session.role     = user.role;
  res.json({ ok: true, name: user.name, role: user.role });
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, name: req.session.userName, role: req.session.role });
});

// ── Datas disponíveis ────────────────────────────────────────
app.get('/api/dates', requireAuth, (req, res) => {
  const dates = Object.keys(dataByDate).sort((a, b) => b.localeCompare(a)); // mais recente primeiro
  res.json({ dates });
});

// ── Dados de uma data específica ─────────────────────────────
app.get('/api/data', requireAuth, (req, res) => {
  const date = req.query.date; // ex: "2026-02-09"
  if (date) {
    const entry = dataByDate[date];
    if (!entry) return res.json({ ready: false });
    return res.json({ ready: true, date, data: entry.data, processedAt: entry.processedAt });
  }
  // Sem data: retorna a mais recente
  const dates = Object.keys(dataByDate).sort((a, b) => b.localeCompare(a));
  if (!dates.length) return res.json({ ready: false });
  const latest = dates[0];
  const entry  = dataByDate[latest];
  res.json({ ready: true, date: latest, data: entry.data, processedAt: entry.processedAt });
});

// ── Upload e processamento ───────────────────────────────────
app.post('/api/process',
  requireAuth, requireAdmin,
  upload.fields([
    { name: 'pontomais', maxCount: 1 },
    { name: 'producao',  maxCount: 1 },
    { name: 'servicos',  maxCount: 1 },
    { name: 'date',      maxCount: 1 },  // campo de texto com a data
  ]),
  (req, res) => {
    try {
      const dateStr = req.body.date; // "2026-02-09"
      if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr))
        return res.status(400).json({ error: 'Data inválida. Use o formato AAAA-MM-DD.' });

      const pmRaw   = parseExcel(req.files['pontomais'][0].buffer);
      const prodRaw = parseExcel(req.files['producao'][0].buffer);
      const servRaw = parseExcel(req.files['servicos'][0].buffer);

      const data = buildData(pmRaw, prodRaw, servRaw);
      dataByDate[dateStr] = { data, processedAt: new Date().toISOString() };

      res.json({ ok: true, date: dateStr, count: data.length, processedAt: dataByDate[dateStr].processedAt });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao processar planilhas: ' + err.message });
    }
  }
);

// ── Excluir data ─────────────────────────────────────────────
app.delete('/api/data/:date', requireAuth, requireAdmin, (req, res) => {
  const date = req.params.date;
  if (dataByDate[date]) { delete dataByDate[date]; res.json({ ok: true }); }
  else res.status(404).json({ error: 'Data não encontrada' });
});

// ── Helpers ──────────────────────────────────────────────────
function parseExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
}

function toObj(raw) {
  const h = raw[0];
  return raw.slice(1).map(r => { const o = {}; h.forEach((k, i) => o[k] = r[i]); return o; });
}

const norm = s => s ? String(s).trim().toUpperCase() : '';

function parseTime(t) {
  if (!t) return null;
  const p = String(t).trim().split(':');
  if (p.length >= 2) { const h = parseInt(p[0]), m = parseInt(p[1]); if (!isNaN(h) && !isNaN(m)) return h * 60 + m; }
  return null;
}

function extractImg(html) {
  if (!html) return null;
  const m = String(html).match(/src=["']([^"']+)["']/);
  if (!m) return null;
  let u = m[1].trim();
  if (u.startsWith('//')) u = 'https:' + u;
  return u.startsWith('http') ? u : null;
}

function haversine(la1, lo1, la2, lo2) {
  const R = 6371000, dL = (la2-la1)*Math.PI/180, dO = (lo2-lo1)*Math.PI/180;
  const a = Math.sin(dL/2)**2 + Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dO/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function buildData(pmRaw, prodRaw, servRaw) {
  const pmRows   = toObj(pmRaw);
  const prodRows = toObj(prodRaw);
  const servRows = toObj(servRaw);

  const pmByTech = {};
  pmRows.forEach(r => {
    const n = norm(r['Nome']); if (!n) return;
    const mins = parseTime(r['Hora']);
    if (!pmByTech[n] || (mins !== null && mins < pmByTech[n]._mins))
      pmByTech[n] = { ...r, _mins: mins };
  });

  const prodByTech = {};
  prodRows.forEach(r => { const n = norm(r['NOME']); if (n) prodByTech[n] = r; });

  const skipRe = /refeição|refeicao|antecipação|antecipacao|escritório|escritorio/i;
  const servByTech = {};
  servRows.forEach(r => {
    const n = norm(r['Recurso']); if (!n) return;
    if (skipRe.test(String(r['Tipo de Atividade'] || ''))) return;
    if (String(r['Status'] || '') === 'Cancelada') return;
    const lat = parseFloat(r['Latitude']), lng = parseFloat(r['Longitude']);
    if (isNaN(lat) || isNaN(lng)) return;
    const mins = parseTime(r['Início Previsto']);
    if (!servByTech[n] || (mins !== null && mins < servByTech[n]._mins))
      servByTech[n] = { ...r, _mins: mins };
  });

  const result = [];
  Object.keys(pmByTech).forEach(name => {
    const pm   = pmByTech[name];
    const prod = prodByTech[name];
    const serv = servByTech[name];

    const puntoHora     = pm['Hora'];
    const puntoMins     = pm._mins;
    const puntoEnd      = pm['Endereço aprox. detectado'];
    const puntoAjustado = String(pm['Ajustado'] || '').toLowerCase() === 'sim';
    const foto          = extractImg(pm['Fotografia']);

    let pontLat = null, pontLng = null;
    const geo = pm['Geolocalização'] || pm['Geolocalização original'];
    if (geo && String(geo).includes(',')) {
      const p = String(geo).split(',');
      pontLat = parseFloat(p[0]); pontLng = parseFloat(p[1]);
      if (isNaN(pontLat) || isNaN(pontLng)) { pontLat = null; pontLng = null; }
    }

    const ignitionOn = prod ? prod['IGNICAO ON']       : null;
    const status     = prod ? prod['STATUS_RESUMIDO']  : null;
    const servLat    = serv ? parseFloat(serv['Latitude'])  : null;
    const servLng    = serv ? parseFloat(serv['Longitude']) : null;
    const servTipo   = serv ? serv['Tipo de Atividade'] : null;
    const servHora   = serv ? serv['Início Previsto']   : null;
    const servPon    = serv ? serv['PON']               : null;

    let servEnd = null;
    if (serv) {
      const parts = [];
      if (serv['Endereço CTO'] && String(serv['Endereço CTO']).trim()) parts.push(String(serv['Endereço CTO']).trim());
      if (serv['Bairro']       && String(serv['Bairro']).trim())       parts.push(String(serv['Bairro']).trim());
      if (serv['Cidade']       && String(serv['Cidade']).trim())       parts.push(String(serv['Cidade']).trim());
      if (parts.length) servEnd = parts.join(' — ');
    }

    let distanceM = null;
    if (pontLat && pontLng && servLat && servLng)
      distanceM = haversine(pontLat, pontLng, servLat, servLng);

    const expected  = 8 * 60 + 30;
    const timeDelta = puntoMins !== null ? puntoMins - expected : null;

    let cardStatus = 'ok';
    if (puntoAjustado)       cardStatus = 'ajustado';
    else if (!serv)          cardStatus = 'no-service';
    else if (timeDelta > 10) cardStatus = 'late';
    else if (timeDelta < -30)cardStatus = 'early';
    else if (distanceM > 500)cardStatus = 'warn';

    result.push({
      nome: name, puntoHora, puntoMins, puntoEnd, puntoAjustado, foto,
      pontLat, pontLng, ignitionOn, status,
      servTipo, servHora, servEnd, servPon, servLat, servLng,
      distanceM, timeDelta, cardStatus,
    });
  });

  const ord = { late:0, warn:1, ajustado:2, early:3, 'no-service':4, ok:5 };
  return result.sort((a, b) => (ord[a.cardStatus] ?? 9) - (ord[b.cardStatus] ?? 9));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PontoFácil rodando em http://localhost:${PORT}`));
