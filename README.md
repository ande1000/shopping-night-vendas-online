# Servidor Shopping Night

## 1) GitHub
Crie um repositório (ex.: `shopping-night-servidor`) e suba **estes arquivos**:
`server.js`, `package.json`, `package-lock.json`, `.gitignore`, `.env.example`, `README.md`.
(Nunca suba senhas nem o arquivo `.env`.)

## 2) Render (Web Service)
- New > Web Service > conecte o repositório
- Runtime: **Node**
- Build Command: `npm install`
- Start Command: `npm start`
- Em **Environment**, crie: `ADMIN_USER`, `ADMIN_PASS`, `SECRET`, `ALLOWED_ORIGINS`
  (modelo no `.env.example`; use senha forte e um SECRET longo e aleatório)

Teste: abrir `https://SEU-SERVIDOR.onrender.com/` deve mostrar "Servidor Shopping Night online".

## Rotas
- `POST /api/evento`  (site da loja) tipos: visita, ping, clique, produto, zoom, compartilhar, cadastro, pedido
- `POST /api/login`   (painel) { usuario, senha } -> token válido por 12h
- `GET  /api/resumo`  (painel) header `Authorization: Bearer TOKEN`

Obs.: os dados ficam na memória e somem quando o Render reinicia. O banco de dados entra na próxima etapa.
