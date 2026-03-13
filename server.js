const express = require('express');
const session = require('express-session');
const multer  = require('multer');
const XLSX    = require('xlsx');
const bcrypt  = require('bcryptjs');
const path    = require('path');

const app = express();

// ─────────────────────────────────────────────────────────────
// USUÁRIOS
// ─────────────────────────────────────────────────────────────
const USERS = [
  { id:1, name:'Vitor',       username:'vitor',       passwordHash: bcrypt.hashSync('pontofacil2026',10), role:'admin'  },
  { id:2, name:'Coordenador', username:'coordenador', passwordHash: bcrypt.hashSync('coord123',10),       role:'viewer' },
  { id:3, name:'Supervisor',  username:'supervisor',  passwordHash: bcrypt.hashSync('super123',10),       role:'viewer' },
];

// Dados em memória: { "2026-02-09": { techs:[...], supervisors:[...], processedAt:"..." } }
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
  const dates = Object.keys(dataByDate).sort((a, b) => b.localeCompare(a));
  res.json({ dates });
});

// ── Dados de uma data ────────────────────────────────────────
app.get('/api/data', requireAuth, (req, res) => {
  const dates = Object.keys(dataByDate).sort((a, b) => b.localeCompare(a));
  const date  = req.query.date || (dates.length ? dates[0] : null);
  if (!date || !dataByDate[date]) return res.json({ ready: false });
  const entry = dataByDate[date];
  res.json({ ready: true, date, techs: entry.techs, supervisors: entry.supervisors, processedAt: entry.processedAt });
});

// ── Processar upload ─────────────────────────────────────────
app.post('/api/process',
  requireAuth, requireAdmin,
  upload.fields([
    { name: 'pontomais', maxCount: 1 },
    { name: 'producao',  maxCount: 1 },
    { name: 'servicos',  maxCount: 1 },
  ]),
  (req, res) => {
    try {
      const pmRaw   = parseExcel(req.files['pontomais'][0].buffer);
      const prodRaw = parseExcel(req.files['producao'][0].buffer);
      const servRaw = parseExcel(req.files['servicos'][0].buffer);

      const result = buildData(pmRaw, prodRaw, servRaw);
      const now    = new Date().toISOString();

      Object.entries(result).forEach(([date, entry]) => {
        dataByDate[date] = { ...entry, processedAt: now };
      });

      const dates     = Object.keys(result).sort((a,b) => b.localeCompare(a));
      const totalTech = dates.reduce((acc, d) => acc + result[d].techs.length, 0);

      res.json({ ok: true, dates, totalTechs: totalTech, processedAt: now });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao processar planilhas: ' + err.message });
    }
  }
);

// ── Excluir data ─────────────────────────────────────────────
app.delete('/api/data/:date', requireAuth, requireAdmin, (req, res) => {
  delete dataByDate[req.params.date];
  res.json({ ok: true });
});

// ── Helpers de parsing ────────────────────────────────────────
function parseExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
}

function toObj(raw) {
  const h = raw[0];
  return raw.slice(1).map(r => { const o = {}; h.forEach((k, i) => o[k] = r[i]); return o; });
}

const norm = s => s ? String(s).trim().toUpperCase() : '';

// "Seg, 09/02/2026" → "2026-02-09"  |  Excel serial  |  "2026-02-09"
function parseDate(val) {
  if (!val) return null;
  if (typeof val === 'number') {
    // Excel serial date (days since 1900-01-01 with leap year bug)
    const d = new Date(Math.round((val - 25569) * 86400 * 1000));
    const y = d.getUTCFullYear(), m = d.getUTCMonth()+1, day = d.getUTCDate();
    return `${y}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  }
  const s = String(val).trim();
  // "Seg, 09/02/2026" or "09/02/2026"
  const m1 = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m1) return `${m1[3]}-${m1[2]}-${m1[1]}`;
  // "2026-02-09"
  const m2 = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m2) return m2[1];
  // Timestamp string from pandas-like "2026-02-09 00:00:00"
  if (s.length >= 10 && s[4] === '-') return s.slice(0, 10);
  return null;
}

function parseTime(val) {
  if (!val) return null;
  const s = String(val).trim();
  // "08:30" or "08:30:00"
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (m) return parseInt(m[1]) * 60 + parseInt(m[2]);
  // Excel fraction of day
  if (typeof val === 'number' && val < 1) {
    const totalMin = Math.round(val * 1440);
    return totalMin;
  }
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

// ── buildData ────────────────────────────────────────────────
// Returns { "2026-02-09": { techs:[...], supervisors:[...] }, ... }
function buildData(pmRaw, prodRaw, servRaw) {
  const pmRows   = toObj(pmRaw);
  const prodRows = toObj(prodRaw);
  const servRows = toObj(servRaw);

  // ── PontoMais: group by date → tech → sorted punches
  const pmByDateTech = {};
  pmRows.forEach(r => {
    const n    = norm(r['Nome']); if (!n) return;
    const date = parseDate(r['Data']); if (!date) return;
    if (!pmByDateTech[date]) pmByDateTech[date] = {};
    if (!pmByDateTech[date][n]) pmByDateTech[date][n] = [];
    pmByDateTech[date][n].push(r);
  });
  Object.values(pmByDateTech).forEach(byTech =>
    Object.values(byTech).forEach(arr =>
      arr.sort((a, b) => (parseTime(a['Hora']) ?? 9999) - (parseTime(b['Hora']) ?? 9999))
    )
  );

  // ── Producao: group by date → tech
  const prodByDateTech = {};
  prodRows.forEach(r => {
    const n    = norm(r['NOME']); if (!n) return;
    const date = parseDate(r['Data']); if (!date) return;
    if (!prodByDateTech[date]) prodByDateTech[date] = {};
    prodByDateTech[date][n] = r;
  });

  // ── Servicos: group by tech → first valid service (no date column)
  const skipRe = /refeição|refeicao|antecipação|antecipacao|escritório|escritorio/i;
  const servByTech = {};
  servRows.forEach(r => {
    const n = norm(r['Recurso']); if (!n) return;
    if (skipRe.test(String(r['Tipo de Atividade'] || ''))) return;
    if (String(r['Status'] || '') === 'Cancelada') return;
    const lat = parseFloat(r['Latitude']), lng = parseFloat(r['Longitude']);
    if (isNaN(lat) || isNaN(lng)) return;
    const mins = parseTime(r['Início Previsto']);
    if (!servByTech[n] || (mins !== null && mins < (servByTech[n]._mins ?? 9999)))
      servByTech[n] = { ...r, _mins: mins };
  });

  // ── Build result per date
  const result = {};

  Object.entries(pmByDateTech).forEach(([date, byTech]) => {
    const prodByTech = prodByDateTech[date] || {};
    const supervisorSet = new Set();
    const techs = [];

    Object.entries(byTech).forEach(([name, rows]) => {
      const prod = prodByTech[name];
      const serv = servByTech[name];

      const supervisor = prod ? String(prod['Supervisor de Rede'] || '').trim() : '';
      if (supervisor) supervisorSet.add(supervisor);

      // Build punch objects (all punches sorted by time)
      const punches = rows.map((r, idx) => {
        let lat = null, lng = null;
        const geo = r['Geolocalização'] || r['Geolocalização original'];
        if (geo && String(geo).includes(',')) {
          const p = String(geo).split(',');
          lat = parseFloat(p[0]); lng = parseFloat(p[1]);
          if (isNaN(lat) || isNaN(lng)) { lat = null; lng = null; }
        }
        return {
          num: idx + 1,
          hora:     r['Hora'],
          mins:     parseTime(r['Hora']),
          end:      r['Endereço aprox. detectado'],
          ajustado: String(r['Ajustado'] || '').toLowerCase() === 'sim',
          foto:     extractImg(r['Fotografia']),
          lat, lng,
        };
      });

      const p1 = punches[0] || {};

      const servLat  = serv ? parseFloat(serv['Latitude'])  : null;
      const servLng  = serv ? parseFloat(serv['Longitude']) : null;
      const servTipo = serv ? serv['Tipo de Atividade'] : null;
      const servHora = serv ? serv['Início Previsto']   : null;
      const servPon  = serv ? serv['PON']               : null;

      let servEnd = null;
      if (serv) {
        const parts = [];
        if (String(serv['Endereço CTO']||'').trim()) parts.push(String(serv['Endereço CTO']).trim());
        if (String(serv['Bairro']||'').trim())       parts.push(String(serv['Bairro']).trim());
        if (String(serv['Cidade']||'').trim())       parts.push(String(serv['Cidade']).trim());
        if (parts.length) servEnd = parts.join(' — ');
      }

      let distanceM = null;
      if (p1.lat && p1.lng && servLat && servLng)
        distanceM = haversine(p1.lat, p1.lng, servLat, servLng);

      const expected  = 8 * 60 + 30;
      const timeDelta = p1.mins != null ? p1.mins - expected : null;

      let cardStatus = 'ok';
      if (p1.ajustado)          cardStatus = 'ajustado';
      else if (!serv)           cardStatus = 'no-service';
      else if (timeDelta > 10)  cardStatus = 'late';
      else if (timeDelta < -30) cardStatus = 'early';
      else if (distanceM > 500) cardStatus = 'warn';

      techs.push({
        nome: name, supervisor,
        punches,
        // First punch shortcuts
        puntoHora: p1.hora, puntoMins: p1.mins, puntoEnd: p1.end,
        puntoAjustado: p1.ajustado, foto: p1.foto, pontLat: p1.lat, pontLng: p1.lng,
        ignitionOn: prod ? prod['IGNICAO ON'] : null,
        servTipo, servHora, servEnd, servPon, servLat, servLng,
        distanceM, timeDelta, cardStatus,
      });
    });

    const ord = { late:0, warn:1, ajustado:2, early:3, 'no-service':4, ok:5 };
    techs.sort((a, b) => (ord[a.cardStatus] ?? 9) - (ord[b.cardStatus] ?? 9));

    result[date] = {
      techs,
      supervisors: [...supervisorSet].sort(),
    };
  });

  return result;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PontoFácil rodando em http://localhost:${PORT}`));
