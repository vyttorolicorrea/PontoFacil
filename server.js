const express = require('express');
const session = require('express-session');
const multer  = require('multer');
const XLSX    = require('xlsx');
const bcrypt  = require('bcryptjs');
const path    = require('path');
const app     = express();

// ─────────────────────────────────────────────────────────────
// USUÁRIOS FIXOS (admins configurados diretamente no código)
// ─────────────────────────────────────────────────────────────
const FIXED_USERS = [
  { id:1, name:'Vitor', username:'vitor', passwordHash: bcrypt.hashSync('pontofacil2026',10), role:'admin', email:'vitor@email.com' },
];

// Usuários aprovados dinamicamente (cadastro via app)
let dynamicUsers   = [];  // { id, name, telId, cargo, email, username, passwordHash, role:'viewer', approved:true }
let pendingUsers   = [];  // { id, name, telId, cargo, email, passwordHash, requestedAt }
let nextUserId     = 100;

// Dados processados: { "2026-02-09": { techs:[...], supervisors:[...], processedAt } }
let dataByDate = {};

const storage = multer.memoryStorage();
const upload  = multer({ storage, limits: { fileSize: 50*1024*1024 } });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'pontofacil-secret-2026',
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 8*60*60*1000 },
}));

// ── Auth helpers ─────────────────────────────────────────────
function allUsers()    { return [...FIXED_USERS, ...dynamicUsers]; }
function requireAuth(req,res,next)  { if(req.session.userId) return next(); res.status(401).json({error:'Não autenticado'}); }
function requireAdmin(req,res,next) { if(req.session.role==='admin') return next(); res.status(403).json({error:'Acesso restrito'}); }

// ── Auth routes ───────────────────────────────────────────────
app.post('/api/login', (req,res) => {
  const { username, password } = req.body;
  const user = allUsers().find(u => u.username===username);
  if (!user || !bcrypt.compareSync(password, user.passwordHash))
    return res.status(401).json({error:'Usuário ou senha incorretos'});
  req.session.userId   = user.id;
  req.session.userName = user.name;
  req.session.role     = user.role;
  res.json({ ok:true, name:user.name, role:user.role });
});

app.post('/api/logout', (req,res) => { req.session.destroy(()=>res.json({ok:true})); });

app.get('/api/me', (req,res) => {
  if (!req.session.userId) return res.json({loggedIn:false});
  const user = allUsers().find(u=>u.id===req.session.userId);
  const allowedSupervisors = (user && user.allowedSupervisors) ? user.allowedSupervisors : [];
  res.json({ loggedIn:true, name:req.session.userName, role:req.session.role, allowedSupervisors });
});

// ── Registro (primeiro acesso) ────────────────────────────────
app.post('/api/register', (req,res) => {
  const { name, telId, cargo, email, password } = req.body;
  if (!name||!telId||!cargo||!email||!password)
    return res.status(400).json({error:'Preencha todos os campos'});
  if (password.length < 6)
    return res.status(400).json({error:'Senha deve ter pelo menos 6 caracteres'});

  const allU = allUsers();
  const username = email.toLowerCase().trim();

  if (allU.find(u=>u.email===email) || pendingUsers.find(u=>u.email===email))
    return res.status(400).json({error:'E-mail já cadastrado ou aguardando aprovação'});

  pendingUsers.push({
    id: nextUserId++,
    name: name.trim(),
    telId: telId.trim(),
    cargo: cargo.trim(),
    email: email.toLowerCase().trim(),
    username,
    passwordHash: bcrypt.hashSync(password, 10),
    requestedAt: new Date().toISOString(),
  });
  res.json({ ok:true });
});

// ── Admin: usuários pendentes ─────────────────────────────────
app.get('/api/pending-users', requireAuth, requireAdmin, (req,res) => {
  res.json({ users: pendingUsers });
});

app.post('/api/approve-user/:id', requireAuth, requireAdmin, (req,res) => {
  const id   = parseInt(req.params.id);
  const idx  = pendingUsers.findIndex(u=>u.id===id);
  if (idx===-1) return res.status(404).json({error:'Não encontrado'});
  const u    = pendingUsers.splice(idx,1)[0];
  dynamicUsers.push({ ...u, role:'viewer', approved:true });
  res.json({ ok:true });
});

app.delete('/api/pending-user/:id', requireAuth, requireAdmin, (req,res) => {
  const id  = parseInt(req.params.id);
  const idx = pendingUsers.findIndex(u=>u.id===id);
  if (idx===-1) return res.status(404).json({error:'Não encontrado'});
  pendingUsers.splice(idx,1);
  res.json({ ok:true });
});

// Lista usuários aprovados
app.get('/api/users', requireAuth, requireAdmin, (req,res) => {
  res.json({ users: dynamicUsers.map(u=>({id:u.id,name:u.name,telId:u.telId,cargo:u.cargo,email:u.email,role:u.role,allowedSupervisors:u.allowedSupervisors||[]})) });
});

// Update allowed supervisors for a user
app.put('/api/user/:id/supervisors', requireAuth, requireAdmin, (req,res) => {
  const id  = parseInt(req.params.id);
  const idx = dynamicUsers.findIndex(u=>u.id===id);
  if (idx===-1) return res.status(404).json({error:'Não encontrado'});
  const { supervisors } = req.body; // array of supervisor names
  if (!Array.isArray(supervisors)) return res.status(400).json({error:'supervisors deve ser array'});
  dynamicUsers[idx].allowedSupervisors = supervisors;
  res.json({ ok:true });
});

// Get all known supervisors across all loaded dates
app.get('/api/all-supervisors', requireAuth, requireAdmin, (req,res) => {
  const set = new Set();
  Object.values(dataByDate).forEach(entry => entry.supervisors.forEach(s=>set.add(s)));
  res.json({ supervisors: [...set].sort() });
});

app.delete('/api/user/:id', requireAuth, requireAdmin, (req,res) => {
  const id  = parseInt(req.params.id);
  const idx = dynamicUsers.findIndex(u=>u.id===id);
  if (idx===-1) return res.status(404).json({error:'Não encontrado'});
  dynamicUsers.splice(idx,1);
  res.json({ ok:true });
});

// ── Dados ─────────────────────────────────────────────────────
app.get('/api/dates', requireAuth, (req,res) => {
  const dates = Object.keys(dataByDate).sort((a,b)=>b.localeCompare(a));
  res.json({ dates });
});

app.get('/api/data', requireAuth, (req,res) => {
  const dates = Object.keys(dataByDate).sort((a,b)=>b.localeCompare(a));
  const date  = req.query.date || (dates.length?dates[0]:null);
  if (!date||!dataByDate[date]) return res.json({ready:false});
  const entry = dataByDate[date];

  // Filter techs by user's allowed supervisors (admin sees all)
  const user = allUsers().find(u=>u.id===req.session.userId);
  const allowed = (user && user.allowedSupervisors && user.allowedSupervisors.length)
    ? user.allowedSupervisors : null;
  const techs = allowed
    ? entry.techs.filter(t => allowed.includes(t.supervisor))
    : entry.techs;
  const supervisors = allowed
    ? entry.supervisors.filter(s => allowed.includes(s))
    : entry.supervisors;

  res.json({ ready:true, date, techs, supervisors, processedAt:entry.processedAt });
});

// Listar todos os dados (para painel admin)
app.get('/api/admin/all-data', requireAuth, requireAdmin, (req,res) => {
  const summary = Object.entries(dataByDate)
    .sort((a,b)=>b[0].localeCompare(a[0]))
    .map(([date,entry]) => ({
      date,
      processedAt: entry.processedAt,
      count: entry.techs.length,
      techs: entry.techs.map(t=>({ nome:t.nome, supervisor:t.supervisor, cardStatus:t.cardStatus, cardStatuses:t.cardStatuses })),
    }));
  res.json({ data: summary });
});

// Deletar data inteira
app.delete('/api/data/:date', requireAuth, requireAdmin, (req,res) => {
  const date = req.params.date;
  if (!dataByDate[date]) return res.status(404).json({error:'Data não encontrada'});
  delete dataByDate[date];
  res.json({ ok:true });
});

// Deletar técnico específico de uma data
app.delete('/api/data/:date/tech/:techName', requireAuth, requireAdmin, (req,res) => {
  const date = req.params.date;
  const name = decodeURIComponent(req.params.techName);
  if (!dataByDate[date]) return res.status(404).json({error:'Data não encontrada'});
  const before = dataByDate[date].techs.length;
  dataByDate[date].techs = dataByDate[date].techs.filter(t=>t.nome!==name);
  // Rebuild supervisors list
  dataByDate[date].supervisors = [...new Set(dataByDate[date].techs.map(t=>t.supervisor).filter(Boolean))].sort();
  if (dataByDate[date].techs.length===before)
    return res.status(404).json({error:'Técnico não encontrado'});
  res.json({ ok:true });
});

// ── Upload ────────────────────────────────────────────────────
app.post('/api/process',
  requireAuth, requireAdmin,
  upload.fields([{name:'pontomais',maxCount:1},{name:'producao',maxCount:1},{name:'servicos',maxCount:1}]),
  (req,res) => {
    try {
      const pmRaw   = parseExcel(req.files['pontomais'][0].buffer);
      const prodRaw = parseExcel(req.files['producao'][0].buffer);
      const servRaw = parseExcel(req.files['servicos'][0].buffer);
      const result  = buildData(pmRaw, prodRaw, servRaw);
      const now     = new Date().toISOString();
      Object.entries(result).forEach(([date,entry])=>{ dataByDate[date]={...entry,processedAt:now}; });
      const dates    = Object.keys(result).sort((a,b)=>b.localeCompare(a));
      const total    = dates.reduce((acc,d)=>acc+result[d].techs.length,0);
      res.json({ ok:true, dates, totalTechs:total, processedAt:now });
    } catch(err) {
      console.error(err);
      res.status(500).json({error:'Erro ao processar planilhas: '+err.message});
    }
  }
);

// ── Helpers ───────────────────────────────────────────────────
function parseExcel(buffer) {
  const wb = XLSX.read(buffer,{type:'buffer',cellDates:false});
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws,{header:1,defval:null,raw:true});
}
function toObj(raw){ const h=raw[0]; return raw.slice(1).map(r=>{const o={};h.forEach((k,i)=>o[k]=r[i]);return o;}); }
const norm = s=>s?String(s).trim().toUpperCase():'';

function parseDate(val){
  if(!val) return null;
  if(typeof val==='number'){const d=new Date(Math.round((val-25569)*86400*1000));const y=d.getUTCFullYear(),m=d.getUTCMonth()+1,day=d.getUTCDate();return `${y}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`;}
  const s=String(val).trim();
  const m1=s.match(/(\d{2})\/(\d{2})\/(\d{4})/);if(m1)return`${m1[3]}-${m1[2]}-${m1[1]}`;
  const m2=s.match(/^(\d{4}-\d{2}-\d{2})/);if(m2)return m2[1];
  if(s.length>=10&&s[4]==='-')return s.slice(0,10);
  return null;
}
function parseTime(val){
  if(!val) return null;
  const s=String(val).trim();
  const m=s.match(/^(\d{1,2}):(\d{2})/);if(m)return parseInt(m[1])*60+parseInt(m[2]);
  if(typeof val==='number'&&val<1)return Math.round(val*1440);
  return null;
}
function extractImg(html){
  if(!html)return null;
  const m=String(html).match(/src=["']([^"']+)["']/);if(!m)return null;
  let u=m[1].trim();if(u.startsWith('//'))u='https:'+u;
  return u.startsWith('http')?u:null;
}
function haversine(la1,lo1,la2,lo2){
  const R=6371000,dL=(la2-la1)*Math.PI/180,dO=(lo2-lo1)*Math.PI/180;
  const a=Math.sin(dL/2)**2+Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dO/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

function buildData(pmRaw,prodRaw,servRaw){
  const pmRows=toObj(pmRaw), prodRows=toObj(prodRaw), servRows=toObj(servRaw);

  // PontoMais grouped by date → tech → sorted punches
  const pmByDateTech={};
  pmRows.forEach(r=>{
    const n=norm(r['Nome']);if(!n)return;
    const date=parseDate(r['Data']);if(!date)return;
    if(!pmByDateTech[date])pmByDateTech[date]={};
    if(!pmByDateTech[date][n])pmByDateTech[date][n]=[];
    pmByDateTech[date][n].push(r);
  });
  Object.values(pmByDateTech).forEach(byTech=>Object.values(byTech).forEach(arr=>arr.sort((a,b)=>(parseTime(a['Hora'])??9999)-(parseTime(b['Hora'])??9999))));

  // Producao by date → tech
  const prodByDateTech={};
  prodRows.forEach(r=>{
    const n=norm(r['NOME']);if(!n)return;
    const date=parseDate(r['Data']);if(!date)return;
    if(!prodByDateTech[date])prodByDateTech[date]={};
    prodByDateTech[date][n]=r;
  });

  // Servicos: first valid service per tech (no date column)
  const skipRe=/refeição|refeicao|antecipação|antecipacao|escritório|escritorio/i;
  const servByTech={};
  servRows.forEach(r=>{
    const n=norm(r['Recurso']);if(!n)return;
    if(skipRe.test(String(r['Tipo de Atividade']||'')))return;
    if(String(r['Status']||'')==='Cancelada')return;
    const lat=parseFloat(r['Latitude']),lng=parseFloat(r['Longitude']);
    if(isNaN(lat)||isNaN(lng))return;
    const mins=parseTime(r['Início Previsto']);
    if(!servByTech[n]||(mins!==null&&mins<(servByTech[n]._mins??9999)))
      servByTech[n]={...r,_mins:mins};
  });

  const result={};
  Object.entries(pmByDateTech).forEach(([date,byTech])=>{
    const prodByTech=prodByDateTech[date]||{};
    const supervisorSet=new Set();
    const techs=[];

    Object.entries(byTech).forEach(([name,rows])=>{
      const prod=prodByTech[name];
      const serv=servByTech[name];
      const supervisor=prod?String(prod['Supervisor de Rede']||'').trim():'';
      if(supervisor)supervisorSet.add(supervisor);

      const punches=rows.map((r,idx)=>{
        let lat=null,lng=null;
        const geo=r['Geolocalização']||r['Geolocalização original'];
        if(geo&&String(geo).includes(',')){const p=String(geo).split(',');lat=parseFloat(p[0]);lng=parseFloat(p[1]);if(isNaN(lat)||isNaN(lng)){lat=null;lng=null;}}
        return{num:idx+1,hora:r['Hora'],mins:parseTime(r['Hora']),end:r['Endereço aprox. detectado'],ajustado:String(r['Ajustado']||'').toLowerCase()==='sim',foto:extractImg(r['Fotografia']),lat,lng};
      });

      const p1=punches[0]||{};
      const servLat=serv?parseFloat(serv['Latitude']):null;
      const servLng=serv?parseFloat(serv['Longitude']):null;

      let servEnd=null;
      if(serv){const parts=[];if(String(serv['Endereço CTO']||'').trim())parts.push(String(serv['Endereço CTO']).trim());if(String(serv['Bairro']||'').trim())parts.push(String(serv['Bairro']).trim());if(String(serv['Cidade']||'').trim())parts.push(String(serv['Cidade']).trim());if(parts.length)servEnd=parts.join(' — ');}

      const distanceM=(p1.lat&&p1.lng&&servLat&&servLng)?haversine(p1.lat,p1.lng,servLat,servLng):null;
      const expected=8*60+30;
      const timeDelta=p1.mins!=null?p1.mins-expected:null;

      // MULTI-STATUS: build array of all applicable statuses
      const cardStatuses=[];
      if(p1.ajustado)       cardStatuses.push('ajustado');
      if(!serv)             cardStatuses.push('no-service');
      if(timeDelta!==null&&timeDelta>10)  cardStatuses.push('late');
      if(timeDelta!==null&&timeDelta<-30) cardStatuses.push('early');
      if(distanceM!==null&&distanceM>500) cardStatuses.push('warn');
      if(!cardStatuses.length) cardStatuses.push('ok');

      // Primary status for filtering and card border (priority order)
      const priority=['ajustado','no-service','late','warn','early','ok'];
      const cardStatus=priority.find(s=>cardStatuses.includes(s))||'ok';

      techs.push({
        nome:name, supervisor, punches,
        puntoHora:p1.hora, puntoMins:p1.mins, puntoEnd:p1.end,
        puntoAjustado:p1.ajustado, foto:p1.foto, pontLat:p1.lat, pontLng:p1.lng,
        ignitionOn:prod?prod['IGNICAO ON']:null,
        servTipo:serv?serv['Tipo de Atividade']:null,
        servHora:serv?serv['Início Previsto']:null,
        servEnd, servPon:serv?serv['PON']:null, servLat, servLng,
        distanceM, timeDelta, cardStatus, cardStatuses,
      });
    });

    const ord={late:0,warn:1,ajustado:2,early:3,'no-service':4,ok:5};
    techs.sort((a,b)=>(ord[a.cardStatus]??9)-(ord[b.cardStatus]??9));
    result[date]={techs, supervisors:[...supervisorSet].sort()};
  });

  return result;
}

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`PontoFácil rodando em http://localhost:${PORT}`));
