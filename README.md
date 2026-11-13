# Protocolo Controle — plataforma de estudo reverso

Plataforma de organização de estudos para concursos: lançamento de questões por fase, edital verticalizado, GPS de direcionamento, ranking e gamificação.

## Estrutura

| Arquivo | O que é | Onde roda |
|---|---|---|
| `index.html` | Front-end completo (HTML + CSS + JS) | GitHub (página publicada) |
| `apps-script/Code.gs` | Backend (API) | Google Apps Script ligado à planilha |

A planilha usa as abas `Usuarios`, `Base_Dashboard`, `Base_Editais`, `Pedidos_Editais`, `Lista_Espera` e `Metricas`.

## Fluxo de trabalho

1. Edite `index.html` e/ou `apps-script/Code.gs`.
2. Veja o que mudou: `git diff`
3. Registre a versão:
   ```
   git add -A
   git commit -m "v29-75: o que mudou"
   git tag v29-75
   ```

## Deploy (sempre nesta ordem)

1. **Apps Script primeiro** — se `Code.gs` mudou: cole no editor do Apps Script →
   *Implantar → Gerenciar implantações → editar (lápis) → Versão: Nova versão → Implantar*.
   Assim a URL (`WEBHOOK_URL` no `index.html`) continua a mesma.
2. **Front-end depois** — suba o `index.html` no GitHub.

Motivo: o front novo pode chamar ações que só o backend novo conhece; o contrário costuma ser compatível.

## Cache do servidor (desde a v29-76)

Para não reler a planilha inteira a cada clique, o Apps Script guarda resultados em cache:

| O quê | Validade | Atualiza na hora quando... |
|---|---|---|
| Lançamentos do aluno | 1 h | o próprio aluno lança, retifica, importa ou apaga |
| Ranking e comparativo | 5 min | qualquer aluno grava algo e sincroniza; troca de codinome |
| Fotos do ranking | 6 h | o aluno troca a foto ou o codinome |
| Catálogo de editais | 10 min | — |
| Radar | 30 min | — |

**Editou a planilha à mão** (corrigiu um lançamento, cadastrou edital, mudou um codinome)?
No editor do Apps Script, escolha a função `limparCaches` e clique em ▶ Executar: tudo é relido na próxima sincronização.

## Comandos úteis

| Quero... | Comando |
|---|---|
| Ver o histórico de versões | `git log --oneline --decorate` |
| Ver o que mudou entre duas versões | `git diff v29-73 v29-74` |
| Ver só os arquivos alterados | `git diff --stat v29-72 v29-74` |
| Recuperar o arquivo de uma versão antiga | `git show v29-72:index.html > index-v29-72.html` |

## Histórico anterior

As versões anteriores à v28-53 (base, V17 … v28) continuam nas pastas de backup em `DASHBOARD_TCE\`.
