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

/* ===== Áreas da ETUS para o cálculo de ADERÊNCIA (compatibilidade) =====
   Para ACRESCENTAR uma área depois, é só copiar uma linha abaixo e trocar o
   nome e a descrição. A IA passa a pontuar a compatibilidade com essa área
   automaticamente. Ex.: ['Dados', 'analisa métricas e transforma números em decisões'] */
const AREAS_ETUS = [
  ['Aquisição', 'traz novos usuários (leads) por anúncios em Google, TikTok, Instagram e Facebook'],
  ['Retenção',  'ativa os leads, mantém a base engajada e cria um relacionamento recorrente'],
  ['Receita',   'monetiza a audiência com recomendações de produtos e anúncios']
];
const AREAS_TXT = AREAS_ETUS.map(function (a) { return '- ' + a[0] + ': ' + a[1]; }).join('\n');

const PROMPT_IA =
"Você é um avaliador(a) de RH experiente e imparcial. Abaixo estão as respostas de um(a) candidato(a) ao assessment DNA ETUS. Avalie SOMENTE com base nas evidências das respostas, sem inventar nada.\n\n" +
"Para cada competência, dê uma nota de 0 a 10 e uma justificativa curta citando trechos:\n" +
"- Raciocínio lógico e analítico\n- Resolução de problemas\n- Priorização\n- Curiosidade / investigação\n- Comunicação (clareza e simplicidade)\n- Colaboração\n- Humildade intelectual\n- Foco em resultados\n\n" +
"Regras: respostas vagas, genéricas, repetidas ou sem raciocínio recebem nota baixa (explique). Seja justo e baseie-se só nas evidências. Avalie o raciocínio e o posicionamento, nunca opiniões pessoais, políticas ou religiosas.\n\n" +
"Ao final entregue, nesta ordem:\n" +
"1) PONTOS FORTES (até 3);\n" +
"2) PONTOS A DESENVOLVER (até 3) com uma sugestão prática cada;\n" +
"3) ADERÊNCIA POR ÁREA: para CADA área abaixo, dê uma nota de 0 a 100 (%) de compatibilidade com base nas evidências das respostas e uma frase curta justificando. Depois indique a ÁREA DE MAIOR ENCAIXE. Áreas da ETUS:\n" + AREAS_TXT + "\n" +
"4) RESUMO em 3 linhas para o RH;\n" +
"5) DEVOLUTIVA EMPÁTICA de 3 linhas para o(a) candidato(a).\n";

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
  `).then(() => {
    // Coluna de CPF (para bloquear repetição) e tabela de liberação para refazer.
    return pool.query('ALTER TABLE respostas ADD COLUMN IF NOT EXISTS cpf TEXT');
  }).then(() => {
    return pool.query('CREATE TABLE IF NOT EXISTS refazer_liberado (cpf TEXT PRIMARY KEY, criado_em TIMESTAMPTZ DEFAULT now())');
  }).then(() => console.log('Postgres pronto.'))
    .catch(e => console.error('Erro ao iniciar o banco:', e.message));
} else {
  console.log('Sem DATABASE_URL — usando armazenamento em arquivo (data.json). Adicione um Postgres no Railway para persistência garantida.');
}

const FILE = path.join(__dirname, 'data.json');
function fileRead() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return []; } }
function fileWrite(arr) { fs.writeFileSync(FILE, JSON.stringify(arr)); }
function toInt(v) { const n = parseInt(v, 10); return isNaN(n) ? null : n; }

/* ---------------- Controle por CPF (uma vez por pessoa) ---------------- */
const ALLOWFILE = path.join(__dirname, 'refazer.json');
function fileReadAllow() { try { return JSON.parse(fs.readFileSync(ALLOWFILE, 'utf8')); } catch (e) { return []; } }
function fileWriteAllow(arr) { fs.writeFileSync(ALLOWFILE, JSON.stringify(arr)); }
function normCpf(v) { return String(v || '').replace(/\D/g, ''); }

async function cpfJaFez(cpf) {
  cpf = normCpf(cpf); if (!cpf) return false;
  if (pool) { const r = await pool.query('SELECT 1 FROM respostas WHERE cpf=$1 LIMIT 1', [cpf]); return r.rowCount > 0; }
  return fileRead().some(x => normCpf(x.cpf) === cpf);
}
async function cpfLiberado(cpf) {
  cpf = normCpf(cpf); if (!cpf) return false;
  if (pool) { const r = await pool.query('SELECT 1 FROM refazer_liberado WHERE cpf=$1 LIMIT 1', [cpf]); return r.rowCount > 0; }
  return fileReadAllow().indexOf(cpf) >= 0;
}
async function podeFazer(cpf) {
  cpf = normCpf(cpf);
  if (cpf.length !== 11) return { podeFazer: false, motivo: 'CPF inválido' };
  if (!(await cpfJaFez(cpf))) return { podeFazer: true };
  if (await cpfLiberado(cpf)) return { podeFazer: true };
  return { podeFazer: false, motivo: 'Este CPF já realizou o teste.' };
}
async function liberarRefazer(cpf) {
  cpf = normCpf(cpf); if (!cpf) return;
  if (pool) { await pool.query('INSERT INTO refazer_liberado (cpf) VALUES ($1) ON CONFLICT (cpf) DO NOTHING', [cpf]); }
  else { const a = fileReadAllow(); if (a.indexOf(cpf) < 0) { a.push(cpf); fileWriteAllow(a); } }
}
async function consumirLiberacao(cpf) {
  cpf = normCpf(cpf); if (!cpf) return;
  if (pool) { await pool.query('DELETE FROM refazer_liberado WHERE cpf=$1', [cpf]); }
  else { fileWriteAllow(fileReadAllow().filter(x => x !== cpf)); }
}

async function saveResposta(p) {
  if (pool) {
    await pool.query(
      'INSERT INTO respostas (nome,email,data,cpf,indice_case,indice_case2,payload) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [p.nome || '', p.email || '', p.data || '', normCpf(p.cpf), toInt(p.indiceCase), toInt(p.indiceCase2), p]
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
    const cpf = normCpf(body.cpf);
    if (cpf) {                                   // bloqueio "uma vez por CPF" (a menos que liberado)
      const check = await podeFazer(cpf);
      if (!check.podeFazer) return res.status(409).json({ ok: false, erro: check.motivo || 'CPF já realizou o teste' });
    }
    const ia = await avaliarComIA(body);        // avalia com a IA (se a chave estiver configurada)
    body.avaliacaoIA = ia.texto;
    if (ia.erro) { body.avaliacaoErro = ia.erro; console.error('IA:', ia.erro); }
    await saveResposta(body);
    if (cpf) await consumirLiberacao(cpf);        // consome a liberação (vale para uma nova tentativa)
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e) });
  }
});

// Verifica se um CPF pode iniciar o teste (público) — usado antes de começar.
app.post('/api/verificar', async (req, res) => {
  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    res.json(await podeFazer(body && body.cpf));
  } catch (e) {
    res.status(400).json({ podeFazer: false, motivo: 'erro' });
  }
});

// Libera um CPF para refazer o teste (protegido) — usado pelo avaliador.
app.post('/api/liberar-refazer', auth, async (req, res) => {
  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    const cpf = normCpf(body && body.cpf);
    if (cpf.length !== 11) return res.status(400).json({ ok: false, erro: 'CPF inválido' });
    await liberarRefazer(cpf);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, erro: String(e) });
  }
});

app.get('/api/respostas', auth, async (req, res) => {
  try { res.json(await listRespostas()); }
  catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// Apagar TODAS as respostas (protegido) — usado para limpar dados de teste.
app.delete('/api/respostas', auth, async (req, res) => {
  try {
    if (pool) { await pool.query('DELETE FROM respostas'); await pool.query('DELETE FROM refazer_liberado'); }
    else { fileWrite([]); fileWriteAllow([]); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
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
