# Migração para o Supabase

Decisões tomadas em 20/11/2026:

- **Senhas:** migração transparente. O aluno entra com a senha de sempre e não percebe a troca.
- **Plano:** Free para começar. Sobe para o Pro quando houver alunos pagantes.
- **Domínio próprio:** fica para depois. O site continua no GitHub Pages.
- **Virada:** a data será marcada quando tudo estiver testado em paralelo.

## Do Google Sheets para o Supabase

| Hoje (planilha / Code.gs)                      | No Supabase                                                      |
|------------------------------------------------|------------------------------------------------------------------|
| Aba **Usuarios** (e-mail, senha, codinome…)    | Login no **Supabase Auth** e dados do aluno na tabela `perfis`   |
| Senha `h1$salt$hash`                           | Tabela `legado_senhas`, apagada no 1º login de cada aluno        |
| Linha com e-mail liberado e sem senha          | Tabela `acessos_liberados`                                       |
| Coluna Z (escudos, em JSON)                    | Tabela `escudos` (uma linha por escudo)                          |
| Aba **Base_Dashboard**                         | Tabela `lancamentos` (colunas K/L calculadas sozinhas)           |
| Aba **Base_Editais**                           | Tabela `editais_base` (você edita pelo Table Editor, como planilha) |
| Aba **Pedidos_Editais**                        | Tabela `pedidos_editais`                                         |
| Aba **Lista_Espera**                           | Tabela `lista_espera`                                            |
| Aba **Metricas** e gatilho das 23h             | Tabela `metricas_diarias`, agendada pelo `pg_cron`               |
| Ações do `doPost` e do `doGet`                 | Funções SQL (RPC) com os mesmos nomes de regra e as mesmas mensagens |
| `LockService` (trava)                          | Trava por aluno no próprio banco (`pg_advisory_xact_lock`)       |
| `CacheService`                                 | Não é necessário: o banco responde direto                        |
| Radar de Editais (RSS)                         | Edge Function `radar` (fase 2)                                   |

**Segurança.**
- Cada aluno só lê o que é dele (RLS).
- Rankings e comparativos saem por funções que nunca mostram e-mails.
- Campos sensíveis (`expira_em`, `is_admin`, escudos) não podem ser alterados pelo aplicativo, só pelas funções que conferem as regras.

## Fase 1: criar o projeto (você, cerca de 20 minutos)

1. **Criar o projeto.**
   - Entre em <https://supabase.com> e faça login com o GitHub `pqdteng`.
   - Clique em **New project** e preencha:
     - Nome: `protocolo-controle`
     - Região: **South America (São Paulo)**
     - Plano: **Free**
   - Crie uma **senha do banco** forte e guarde no seu gerenciador de senhas. Não mande essa senha para ninguém, nem para mim.
2. **Criar o banco.** Vá em **SQL Editor → New query**, cole o conteúdo de `supabase/schema.sql` e clique em **Run**. Deve aparecer *Success. No rows returned*.
3. **Testar as regras.** Abra outra query, cole `supabase/teste_cenarios.sql` e clique em **Run**.
   - O resultado esperado é **TODOS OS CENÁRIOS PASSARAM**.
   - O teste desfaz tudo no fim: nenhum dado fica no banco.
   - Se aparecer `FALHOU: …`, me mande um print.
4. **Configurar o login** em **Authentication → Sign In / Providers → Email**:
   - deixe **Enable Email provider** ligado;
   - desligue **Confirm email** por enquanto. Hoje a plataforma também não confirma e-mail. Ligamos quando o SMTP próprio estiver pronto (item 7).
5. **Endereço do site.** Em **Authentication → URL Configuration**, coloque em **Site URL** o endereço do site no GitHub Pages.
6. **Agendar as métricas diárias.**
   - Em **Database → Extensions**, ligue o `pg_cron`.
   - No SQL Editor, rode:
     ```sql
     select cron.schedule('metricas-diarias', '0 2 * * *', 'select public.registrar_metricas()');
     ```
     O horário é 02h UTC, que equivale a 23h de Brasília.
7. **E-mail de recuperação de senha.**
   - O e-mail padrão do Supabase só envia para os membros do projeto e tem limite muito baixo.
   - Crie uma conta grátis no **Resend** (<https://resend.com>, 3.000 e-mails por mês) ou no **Brevo**.
   - Depois preencha os dados em **Authentication → Emails → SMTP Settings**. Posso guiar esse passo.
8. **Me envie** o que fica em **Project Settings → API**:
   - a **Project URL**;
   - a chave **anon / publishable**. Ela é pública por natureza e vai no `index.html`; a proteção vem das regras do banco.
   - **Nunca** me envie a `service_role` / `secret key`. Ela só vai nas Propriedades do script do Apps Script, colada por você.

## Fase 2: código de transição (pronto; os passos abaixo são seus)

O código já está no repositório:

- [`fase2.sql`](fase2.sql): pequenos ajustes no banco já criado.
- [`functions/login-legado`](functions/login-legado/index.ts): login com a senha da planilha. Confere o hash antigo e passa a senha para o Supabase Auth.
- [`functions/radar`](functions/radar/index.ts): Radar de Editais (RSS) fora do Apps Script.
- [`../apps-script/MigrarSupabase.gs`](../apps-script/MigrarSupabase.gs): cópia da planilha para o Supabase.
- Adaptador no `index.html`:
  - com `?backend=supabase`, o navegador passa a usar o banco novo;
  - aparece o selo verde **SUPABASE · TESTE** no canto da tela;
  - `?backend=sheets` volta ao normal;
  - sem o parâmetro, nada muda para os alunos.

### Passo a passo

1. **Ajuste do banco:** no SQL Editor, rode `supabase/fase2.sql`. Deve aparecer *Fase 2 aplicada*.
2. **Função `login-legado`:**
   1. Vá em **Edge Functions → Deploy a new function → Via Editor**.
   2. Dê o nome `login-legado` e cole o conteúdo de `supabase/functions/login-legado/index.ts`.
   3. Clique em **Deploy**.
   4. Na aba **Details** da função, **desligue** "Verify JWT with legacy secret" (ou "Enforce JWT verification"). O aluno ainda não está logado quando chama essa função.
3. **Função `radar`:**
   1. Repita o caminho do item 2 com o nome `radar`, colando `supabase/functions/radar/index.ts`.
   2. Aqui a verificação de JWT fica **ligada**.
4. **Cópia da planilha:**
   1. Abra o Apps Script da planilha e clique em **+ → Script**.
   2. Dê o nome `MigrarSupabase` e cole `apps-script/MigrarSupabase.gs`.
   3. Em **Configurações do projeto → Propriedades do script**, adicione:
      - `SUPABASE_URL` = `https://nydspkbnbahclgkjfotc.supabase.co`
      - `SUPABASE_SECRET` = a chave **secreta**. Fica em Supabase → Project Settings → API Keys, em *Secret keys* (`sb_secret_…`) ou na `service_role` antiga. Ela fica só aqui; não mande para ninguém.
   4. Selecione `migrarParaSupabase` e clique em **▶ Executar**. O Google vai pedir autorização para conectar a um serviço externo.
   5. No **Registro de execução** aparece um resumo. Ele tem só contagens, sem dados pessoais. Me mande esse resumo.
   - Não é preciso publicar nova versão do Web App: a cópia roda pelo editor.
5. **Ensaio:** quando o `index.html` novo estiver no GitHub, abra o site com `?backend=supabase` no fim do endereço e entre com o seu e-mail e a senha de sempre.

### E-mail de recuperação de senha (antes da virada)

A tela "Esqueci minha senha" continua pedindo um **código de 6 dígitos**. Para isso:

- Configure o SMTP próprio (Fase 1, item 7).
- Em **Authentication → Emails → Templates → Reset password**, troque o texto por algo como:
  > Seu código para redefinir a senha do Protocolo Controle é: **{{ .Token }}**
  > Ele vale por 1 hora. Se não foi você que pediu, ignore esta mensagem.

## Fase 3: ensaio (nós dois)

- Copiar os dados reais, entrar com a sua conta em `?backend=supabase` e conferir painel, ranking, lançamento, escudos, edital e pedidos.
- Comparar os totais da planilha com os do Supabase.

## Fase 4: virada (domingo, 22/11/2026, às 21h)

A versão da virada (v29-92) já está pronta na branch `virada-supabase`, testada e ainda não publicada. Com ela:
- sem nenhum parâmetro, todos passam a usar o Supabase;
- `?backend=sheets` vira o **plano B**: aparece o selo amarelo "PLANILHA · PLANO B", e um clique volta ao padrão;
- quem estava logado pela planilha cai na tela de login uma vez e entra com a mesma senha.

### Roteiro
1. **20h30 — aviso aos alunos.**
   > Hoje às 21h a plataforma fica em manutenção por uns 30 minutos (troca de servidor). Depois é só entrar com o mesmo e-mail e senha de sempre.
2. **21h00 — você:** no Apps Script, rode `migrarParaSupabase` (última cópia) e me mande o resumo.
3. **Eu:** confiro o resumo, junto a branch `virada-supabase` na `main` e publico a v29-92 (o GitHub Pages leva 1–2 minutos).
4. **Você:**
   - abra o site **sem** parâmetro e use Ctrl + F5;
   - entre com a sua senha e confira o painel;
   - faça um lançamento de teste e apague-o com "retificar".
5. **Depois da virada:**
   - **Não rode mais `migrarParaSupabase`.** Ele apagaria no Supabase os lançamentos feitos depois da virada.
   - No Apps Script, em **Acionadores** (ícone de relógio), exclua o `registrarMetricasDiarias`. As métricas passam a ser gravadas pelo `pg_cron` no Supabase (Fase 1, item 6).
   - Rode `backupSupabase` uma vez (▶) para autorizar o acesso ao Drive e depois `instalarBackupSemanal` uma vez.
   - A planilha continua no Drive, intacta, como registro de tudo até a virada.

### Se algo der errado
- **Um aluno com problema:** ele usa `?backend=sheets` enquanto investigamos.
- **Problema geral:** eu publico de novo a v29-91, e todos voltam para a planilha. O que foi lançado no Supabase nesse meio-tempo fica guardado lá.

## Backup semanal (Supabase → Google Drive)

O arquivo [`apps-script/BackupSupabase.gs`](../apps-script/BackupSupabase.gs) roda toda segunda-feira, por volta das 3h, e cria na pasta **Backups Protocolo Controle** do seu Drive:
- `backup_AAAA-MM-DD.json`: cópia completa e exata, que é o arquivo que serve para restaurar;
- a planilha **Backup Protocolo Controle AAAA-MM-DD**: uma aba por tabela, para consulta.

Backups com mais de 8 semanas vão para a lixeira do Drive. As senhas antigas não entram no backup.

**Para instalar:**
1. No Apps Script, clique em **+ → Script**, dê o nome `BackupSupabase` e cole o conteúdo do arquivo.
2. Rode `backupSupabase` (▶) e autorize o acesso ao Drive.
3. Rode `instalarBackupSemanal` uma vez.

## Pendências que continuam com você

- A importação de CSV marca tudo como consolidado (fase 4). O comportamento foi mantido igual; decidir se muda.
- No plano Free não há backup automático. Antes de ter alunos pagantes, passar ao Pro ou agendar uma exportação semanal.

## Fase 3: Flashcards (v29-94)

1. No **SQL Editor**, rode `supabase/fase3_flashcards.sql`. Deve aparecer *Flashcards instalados*.
2. Rode `supabase/teste_flashcards.sql`. O resultado esperado é **FLASHCARDS OK**, e nada fica gravado.
3. Só depois disso a versão nova do site é publicada.
4. No Apps Script, atualize o `BackupSupabase.gs` com a versão do repositório, que inclui as tabelas `flashcards` e `revisoes_flashcards` no backup.
