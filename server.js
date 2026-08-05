/* ================================================================
   DNA ETUS — Servidor de produção
   - Serve a tela do colaborador (pública) em "/"
   - Serve o painel do avaliador (protegido por senha) em "/avaliador"
   - POST /api/respostas  -> salva uma resposta (público)
   - GET  /api/respostas  -> lista as respostas (protegido por senha)
   Banco: Postgres (se houver DATABASE_URL) ou arquivo local (fallback).
   ================================================================ */
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '3mb' }));
app.use(express.text({ type: ['text/plain', 'application/*'], limit: '3mb' }));

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'troque-esta-senha';

/* ---------------- Avaliação por IA (Gemini) ---------------- */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const PROMPT_IA =
"Você é um avaliador(a) de RH experiente e imparcial. Abaixo estão as respostas de um(a) candidato(a) ao assessment DNA ETUS. Avalie SOMENTE com base nas evidências das respostas — não invente nada.\n\n" +
"Para cada competência, dê uma nota de 0 a 10 e uma justificativa curta citando trechos:\n" +
"- Raciocínio lógico e analítico\n- Resolução de problemas\n- Priorização\n- Curiosidade / investigação\n- Comunicação (clareza e simplicidade)\n- Colaboração\n- Humildade intelectual\n- Foco em resultados\n\n" +
"Regras: respostas vagas, genéricas, repetidas ou sem raciocínio recebem nota baixa (explique). Seja justo e baseie-se só nas evidências. Avalie o raciocínio e o posicionamento, nunca opiniões pessoais, políticas ou religiosas.\n\n" +
"Ao final entregue: 1) PONTOS FORTES (até 3); 2) PONTOS A DESENVOLVER (até 3) com uma sugestão prática cada; 3) RESUMO em 3 linhas para o RH; 4) DEVOLUTIVA EMPÁTICA de 3 linhas para o(a) candidato(a).\n";

function respostasParaTexto(payload) {
  const rows = (payload && payload.rows) || [];
  return rows.map(function (r) {
    if (r[1] === '') return '\n### ' + String(r[0]).replace('__', '');
    return '• ' + r[0] + '\n' + r[1];
  }).join('\n');
}

async function avaliarComIA(payload) {
  if (!GEMINI_API_KEY) return { texto: '', erro: 'sem GEMINI_API_KEY' };
  try {
    const prompt = PROMPT_IA + '\n=== RESPOSTAS DO CANDIDATO ===\nNome: ' +
      ((payload && payload.nome) || '') + '\n' + respostasParaTexto(payload);
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(GEMINI_MODEL) + ':generateContent?key=' + GEMINI_API_KEY;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const j = await r.json();
    const txt = j && j.candidates && j.candidates[0] && j.candidates[0].content &&
      j.candidates[0].content.parts && j.candidates[0].content.parts[0] &&
      j.candidates[0].content.parts[0].text;
    if (txt) return { texto: txt, erro: '' };
    return { texto: '', erro: (j && j.error && j.error.message) || 'resposta vazia da IA' };
  } catch (e) {
    return { texto: '', erro: String(e) };
  }
}

/* ---------------- Banco de dados ---------------- */
let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  pool.query(`
    CREATE TABLE IF NOT EXISTS respostas (
      id SERIAL PRIMARY KEY,
      criado_em TIMESTAMPTZ DEFAULT now(),
      nome TEXT, email TEXT, data TEXT,
      indice_case INTEGER, indice_case2 INTEGER,
      payload JSONB
    )
  `).then(() => console.log('Postgres pronto.'))
    .catch(e => console.error('Erro ao iniciar o banco:', e.message));
} else {
  console.log('Sem DATABASE_URL — usando armazenamento em arquivo (data.json). Adicione um Postgres no Railway para persistência garantida.');
}

const FILE = path.join(__dirname, 'data.json');
function fileRead() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return []; } }
function fileWrite(arr) { fs.writeFileSync(FILE, JSON.stringify(arr)); }
function toInt(v) { const n = parseInt(v, 10); return isNaN(n) ? null : n; }

async function saveResposta(p) {
  if (pool) {
    await pool.query(
      'INSERT INTO respostas (nome,email,data,indice_case,indice_case2,payload) VALUES ($1,$2,$3,$4,$5,$6)',
      [p.nome || '', p.email || '', p.data || '', toInt(p.indiceCase), toInt(p.indiceCase2), p]
    );
  } else {
    const arr = fileRead();
    arr.push(Object.assign({ criado_em: new Date().toISOString() }, p));
    fileWrite(arr);
  }
}
async function listRespostas() {
  if (pool) {
    const r = await pool.query('SELECT payload FROM respostas ORDER BY id DESC');
    return r.rows.map(row => row.payload);
  }
  return fileRead().slice().reverse();
}

/* ---------------- Login do avaliador (Basic Auth) ---------------- */
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const parts = h.split(' ');
  if (parts[0] === 'Basic' && parts[1]) {
    const dec = Buffer.from(parts[1], 'base64').toString();
    const i = dec.indexOf(':');
    const u = dec.slice(0, i), p = dec.slice(i + 1);
    if (u === ADMIN_USER && p === ADMIN_PASSWORD) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="DNA ETUS - Avaliador"');
  return res.status(401).send('Acesso restrito ao RH.');
}

/* ---------------- Rotas ---------------- */
app.post('/api/respostas', async (req, res) => {
  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    if (!body || typeof body !== 'object') return res.status(400).json({ ok: false });
    const ia = await avaliarComIA(body);        // avalia com a IA (se a chave estiver configurada)
    body.avaliacaoIA = ia.texto;
    if (ia.erro) { body.avaliacaoErro = ia.erro; console.error('IA:', ia.erro); }
    await saveResposta(body);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e) });
  }
});

app.get('/api/respostas', auth, async (req, res) => {
  try { res.json(await listRespostas()); }
  catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// Teste rápido da IA (protegido) — verifica chave e modelo.
app.get('/api/ia-teste', auth, async (req, res) => {
  if (!GEMINI_API_KEY) return res.json({ ok: false, motivo: 'GEMINI_API_KEY não configurada' });
  const r = await avaliarComIA({ nome: 'Teste', rows: [['Pergunta', 'Responda apenas: OK']] });
  res.json({ ok: !!r.texto, modelo: GEMINI_MODEL, amostra: (r.texto || '').slice(0, 120), erro: r.erro });
});

// Painel do avaliador — protegido; NÃO fica na pasta pública.
app.get('/avaliador', auth, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'avaliador.html'));
});

// Tela do colaborador (pública) e demais estáticos.
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('DNA ETUS rodando na porta ' + PORT));
