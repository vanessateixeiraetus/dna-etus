# DNA ETUS — Publicar no Railway (produção)

Este projeto é a **versão de produção**: hospedagem própria, **banco de dados** e **login de verdade** para o avaliador.

## O que tem aqui
```
package.json          → configuração do projeto
server.js             → o servidor (API + login + telas)
public/index.html     → tela do COLABORADOR (pública, é o link que você compartilha)
private/avaliador.html→ painel do AVALIADOR (protegido por senha)
.gitignore
```

## Como funciona (resumo)
- **Link do colaborador** = o endereço principal do site (ex.: `https://seu-app.up.railway.app/`).
- **Painel do avaliador** = o mesmo endereço + `/avaliador` (ex.: `https://seu-app.up.railway.app/avaliador`). Ele pede **usuário e senha** (que você define). Lá dentro você lê as respostas de todos os colaboradores.
- As respostas ficam salvas no **banco de dados** (Postgres), acessíveis de qualquer lugar.

---

## Passo a passo (via GitHub — recomendado)

**1. Suba os arquivos no GitHub**
- Crie uma conta em **github.com** (se não tiver).
- Crie um repositório novo (botão **New**), ex.: `dna-etus`.
- Em **Add file → Upload files**, arraste **todo o conteúdo desta pasta** (o `package.json`, o `server.js`, a pasta `public` e a pasta `private`). Confirme (**Commit changes**).

**2. Crie o projeto no Railway**
- Entre em **railway.app** → **New Project** → **Deploy from GitHub repo** → escolha o repositório `dna-etus`.
- O Railway detecta o Node automaticamente e roda `npm install` + `npm start`.

**3. Adicione o banco de dados**
- Dentro do projeto, clique em **New → Database → Add PostgreSQL**.

**4. Configure as variáveis (no serviço do app, aba "Variables")**
Adicione:
- `ADMIN_USER` = o usuário do avaliador (ex.: `rh`)
- `ADMIN_PASSWORD` = uma **senha forte** (troque, não use a padrão!)
- `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`  *(referência ao Postgres que você criou; o Railway completa sozinho ao digitar)*
- `GEMINI_API_KEY` = a sua chave do Gemini (ver seção "Avaliação por IA" abaixo). *Opcional — sem ela, o sistema funciona, só não gera o relatório automático.*
- `GEMINI_MODEL` = opcional. Padrão: `gemini-2.5-flash`. Se der erro de "modelo não encontrado", troque por `gemini-2.0-flash` ou `gemini-1.5-flash`.

**5. Gere o endereço público**
- No serviço do app → **Settings → Networking → Generate Domain**.
- Isso cria a URL pública (ex.: `https://dna-etus-production.up.railway.app`).

**6. Pronto!**
- **Compartilhe com os colaboradores**: a URL principal.
- **Você acessa o painel**: a URL + `/avaliador`, e entra com o `ADMIN_USER` e `ADMIN_PASSWORD` que definiu.

---

## Segurança e LGPD
- Troque a `ADMIN_PASSWORD` por uma senha forte e **não compartilhe** o `/avaliador`.
- O app já pede **nome + consentimento** ao colaborador antes de começar.
- O painel do avaliador e a lista de respostas **só abrem com login**; a tela do colaborador não consegue ler respostas de ninguém.

## Avaliação por IA (Gemini) — grátis para começar

1. Acesse **aistudio.google.com/apikey** (entre com sua conta Google) e clique em **Create API key**.
2. Copie a chave.
3. No Railway → serviço do app → **Variables** → adicione `GEMINI_API_KEY` = (a chave).
4. Para testar se ficou tudo certo, abra no navegador: `SUA_URL/api/ia-teste` (vai pedir o login do avaliador). Deve responder `"ok": true` com uma amostra. Se vier erro de modelo, ajuste a variável `GEMINI_MODEL`.

Pronto: a partir daí, cada resposta enviada é **avaliada automaticamente pela IA**, e o relatório aparece no topo das respostas do candidato, no painel do avaliador.

> Você pode trocar de IA depois (ex.: OpenAI) só mudando o código do servidor — nada fica preso. E lembre da LGPD: o plano gratuito pode usar os dados para treino; para candidatos reais, avalie um plano que garanta não treinar com os seus dados.

## Observações
- Sem o Postgres (passo 3), o app até roda, mas os dados podem se perder num novo deploy. **Para uso real, faça o passo 3.**
- Esta versão **coleta e organiza** as respostas com login e banco. A **avaliação automática por IA** (relatório com notas por competência) é a próxima fase — a base já está pronta para recebê-la.
- Um desenvolvedor (mesmo júnior) familiarizado com Railway faz esses passos em ~15 minutos. Se tiver um, entregue esta pasta a ele.
