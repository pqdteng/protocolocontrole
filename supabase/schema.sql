-- =====================================================================
-- Protocolo Controle — banco de dados no Supabase (Postgres)
--
-- Como usar: Supabase → SQL Editor → New query → colar este arquivo
-- inteiro → Run. Rode UMA vez, num projeto novo.
--
-- Equivale ao Code.gs v29-90 (mesmos limites e mensagens de erro).
-- O aluno nunca grava direto nas tabelas sensíveis: tudo passa pelas
-- funções (RPC) no fim do arquivo, que conferem as regras no servidor.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Utilitários
-- ---------------------------------------------------------------------

-- "Hoje" no horário de Brasília (o Code.gs usava o fuso do projeto)
create or replace function public.hoje_br() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'America/Sao_Paulo')::date
$$;

-- Texto livre (matéria, tópico...): sem caracteres de controle, sem < >,
-- sem = + - @ no início (igual a limparTexto do Code.gs)
create or replace function public.limpar_texto(t text, maximo int) returns text
language sql immutable set search_path = '' as $$
  select left(btrim(regexp_replace(
           btrim(regexp_replace(regexp_replace(coalesce(t, ''), '[[:cntrl:]]+', ' ', 'g'), '[<>]', '', 'g')),
           '^[=+\-@[:space:]]+', '')), maximo)
$$;

-- Codinome: o único texto de um aluno que os outros veem (igual a limparNick)
create or replace function public.limpar_nick(t text) returns text
language sql immutable set search_path = '' as $$
  select left(btrim(regexp_replace(
           btrim(regexp_replace(regexp_replace(regexp_replace(coalesce(t, ''),
             '[[:cntrl:]]+', ' ', 'g'), '[<>"''`&\\/=]', '', 'g'), '[[:space:]]+', ' ', 'g')),
           '^[+\-@]+', '')), 20)
$$;

-- Número vindo do aplicativo (aceita vírgula); negativo ou inválido vira 0 (igual a numeroSeguro)
create or replace function public.numero_seguro(t text) returns numeric
language plpgsql immutable set search_path = '' as $$
declare m text;
begin
  m := substring(replace(coalesce(t, ''), ',', '.') from '^[[:space:]]*([0-9]*\.?[0-9]+)');
  if m is null then return 0; end if;
  return greatest(m::numeric, 0);
exception when others then
  return 0;
end $$;

-- "dd/MM/yyyy" → date (data impossível vira erro "Data inválida.")
create or replace function public.data_br(t text) returns date
language plpgsql immutable set search_path = '' as $$
declare p text[];
begin
  p := regexp_match(btrim(coalesce(t, '')), '^([0-9]{1,2})/([0-9]{1,2})/([0-9]{4})$');
  if p is null then raise exception 'Data inválida.'; end if;
  return make_date(p[3]::int, p[2]::int, p[1]::int);
exception when others then
  raise exception 'Data inválida.';
end $$;

-- ---------------------------------------------------------------------
-- 1. Tabelas
-- ---------------------------------------------------------------------

-- Aba Usuarios (uma linha por aluno; o login fica no Supabase Auth)
create table if not exists public.perfis (
  id               uuid primary key references auth.users(id) on delete cascade,
  email            text not null check (email = lower(email)),
  nickname         text not null check (char_length(nickname) between 3 and 20),
  avatar           text check (avatar is null or (char_length(avatar) <= 40000
                     and avatar ~ '^data:image/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$')),
  expira_em        timestamptz,            -- vazio = vitalício
  origem           text not null default '',
  ciclo            jsonb not null default '[]'::jsonb check (jsonb_typeof(ciclo) = 'array'),
  edital_ativo     text not null default '' check (char_length(edital_ativo) <= 300),
  progresso_edital jsonb not null default '{}'::jsonb check (jsonb_typeof(progresso_edital) = 'object'),
  is_admin         boolean not null default false,
  cadastro_em      timestamptz not null default now(),
  ultimo_acesso    date
);
-- e-mail e codinome únicos sem diferenciar maiúsculas
create unique index if not exists perfis_email_unico on public.perfis (lower(email));
create unique index if not exists perfis_nick_unico on public.perfis (lower(nickname));

-- Aba Base_Dashboard (um lançamento por linha)
create table if not exists public.lancamentos (
  id           bigint generated always as identity primary key,
  user_id      uuid not null default auth.uid() references public.perfis(id) on delete cascade,
  criado_em    timestamptz not null default now(),
  data_estudo  date not null,
  materia      text not null check (char_length(materia) between 1 and 120),
  topico       text not null check (char_length(topico) between 1 and 200),
  link         text not null default '' check (char_length(link) <= 300),
  tempo_min    int  not null default 0 check (tempo_min between 0 and 960),
  questoes     int  not null default 0 check (questoes between 0 and 1000),
  acertos      int  not null default 0 check (acertos >= 0 and acertos <= questoes),
  fase         smallint not null default 1 check (fase between 1 and 4),
  metodologia  text not null default '' check (char_length(metodologia) <= 80),
  -- colunas K/L: fase 4 com 85%+ de acerto
  consolidado  boolean generated always as (fase = 4 and questoes > 0 and acertos >= 0.85 * questoes) stored
);
create index if not exists lancamentos_usuario_dia on public.lancamentos (user_id, data_estudo);
create index if not exists lancamentos_dia on public.lancamentos (data_estudo);

-- Coluna Z (escudos de ofensiva): uma linha por escudo comprado
create table if not exists public.escudos (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references public.perfis(id) on delete cascade,
  comprado_em  date not null default public.hoje_br(),
  usado_em     date            -- dia sem estudo que ele cobriu (vazio = guardado)
);
create index if not exists escudos_usuario on public.escudos (user_id);

-- Aba Base_Editais (catálogo mapeado pelo administrador)
create table if not exists public.editais_base (
  id          bigint generated always as identity primary key,
  concurso    text not null,
  banca       text not null default '',
  bloco       text not null default '',
  materia     text not null default '',
  topico      text not null default '',
  link_master text not null default ''
);
create index if not exists editais_base_concurso on public.editais_base (concurso, id);

-- Aba Pedidos_Editais
create table if not exists public.pedidos_editais (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references public.perfis(id) on delete cascade,
  concurso      text not null check (char_length(concurso) between 3 and 200),
  status        text not null default 'Pendente' check (status in ('Pendente', 'Mapeado', 'Recusado')),
  criado_em     timestamptz not null default now(),
  respondido_em timestamptz
);
create index if not exists pedidos_usuario on public.pedidos_editais (user_id, criado_em);

-- Aba Lista_Espera
create table if not exists public.lista_espera (
  email     text primary key check (email = lower(email)),
  criado_em timestamptz not null default now()
);

-- E-mails liberados pelo admin (compra / liberação manual) que ainda não criaram a conta
-- (na planilha: linha com e-mail e validade, mas sem senha)
create table if not exists public.acessos_liberados (
  email     text primary key check (email = lower(email)),
  expira_em timestamptz,
  origem    text not null default '',
  criado_em timestamptz not null default now()
);

-- Senhas antigas da planilha (hash SHA-256 "h1$salt$hash"). Só a função de login de
-- transição (Edge Function, com a chave de serviço) lê esta tabela; a linha é apagada
-- no primeiro login do aluno, quando a senha passa para o Supabase Auth.
create table if not exists public.legado_senhas (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  hash          text not null,
  tentativas    int not null default 0,
  bloqueado_ate timestamptz
);

-- Aba Metricas
create table if not exists public.metricas_diarias (
  data              date primary key,
  total_usuarios    int not null,
  novos_cadastros   int not null,
  acessaram_hoje    int not null,
  ativos_7d         int not null,
  estudaram_hoje    int not null,
  estudaram_7d      int not null,
  lancamentos_hoje  int not null,
  questoes_hoje     int not null,
  vagas_fundador    int not null
);

-- ---------------------------------------------------------------------
-- 2. Quem pode o quê (RLS)
--    Regra geral: o aluno lê só o que é dele; gravações passam pelas
--    funções da seção 4. Rankings e comparativos saem por função, sem
--    expor e-mail de ninguém.
-- ---------------------------------------------------------------------

create or replace function public.eh_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.is_admin from public.perfis p where p.id = auth.uid()), false)
$$;

alter table public.perfis            enable row level security;
alter table public.lancamentos       enable row level security;
alter table public.escudos           enable row level security;
alter table public.editais_base      enable row level security;
alter table public.pedidos_editais   enable row level security;
alter table public.lista_espera      enable row level security;
alter table public.acessos_liberados enable row level security;
alter table public.legado_senhas     enable row level security;
alter table public.metricas_diarias  enable row level security;

revoke all on public.perfis, public.lancamentos, public.escudos, public.editais_base,
              public.pedidos_editais, public.lista_espera, public.acessos_liberados,
              public.legado_senhas, public.metricas_diarias
  from anon, authenticated;

grant select on public.perfis, public.lancamentos, public.escudos,
                public.editais_base, public.pedidos_editais to authenticated;

-- Chave de serviço (script de cópia e função login-legado): acesso total, sem RLS
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

create policy perfis_leitura on public.perfis for select to authenticated
  using (id = auth.uid() or public.eh_admin());
create policy lancamentos_leitura on public.lancamentos for select to authenticated
  using (user_id = auth.uid());
create policy escudos_leitura on public.escudos for select to authenticated
  using (user_id = auth.uid());
create policy editais_leitura on public.editais_base for select to authenticated
  using (true);
create policy pedidos_leitura on public.pedidos_editais for select to authenticated
  using (user_id = auth.uid() or public.eh_admin());
-- lista_espera, acessos_liberados, legado_senhas e metricas_diarias: sem acesso pelo app

-- ---------------------------------------------------------------------
-- 3. Regras automáticas (gatilhos)
-- ---------------------------------------------------------------------

-- Todo lançamento (novo, retificado ou importado) passa por aqui:
-- limpa os textos, confere os limites e o teto diário (igual a validarLancamento + verificarTetoDia)
create or replace function public.validar_lancamento() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  ignorar bigint := -1;
  n int; soma_q int; soma_t int;
begin
  -- Cópia da planilha (chave de serviço): o histórico antigo entra como está (o script já limpou os dados)
  if coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role'
     or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role' then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    ignorar := old.id;
    new.user_id := old.user_id;
    new.criado_em := old.criado_em;
  end if;

  new.materia     := public.limpar_texto(new.materia, 120);
  new.topico      := public.limpar_texto(new.topico, 200);
  new.link        := public.limpar_texto(new.link, 300);
  new.metodologia := public.limpar_texto(new.metodologia, 80);

  if new.questoes > 1000 then raise exception 'Máximo de 1000 questões por lançamento.'; end if;
  if new.acertos > new.questoes then raise exception 'Os acertos não podem ser maiores que as questões.'; end if;
  if new.tempo_min > 960 then raise exception 'Tempo máximo de 16h por lançamento.'; end if;
  if new.data_estudo < date '2020-01-01' or new.data_estudo > public.hoje_br() + 2 then
    raise exception 'Data fora do período permitido.';
  end if;
  if new.materia = '' or new.topico = '' then raise exception 'Matéria e tópico são obrigatórios.'; end if;
  if new.fase is null or new.fase not between 1 and 4 then new.fase := 1; end if;

  -- Um aluno por vez (substitui o LockService): dois envios simultâneos não furam o teto
  perform pg_advisory_xact_lock(hashtext(new.user_id::text));
  select count(*), coalesce(sum(l.questoes), 0), coalesce(sum(l.tempo_min), 0)
    into n, soma_q, soma_t
    from public.lancamentos l
   where l.user_id = new.user_id and l.data_estudo = new.data_estudo and l.id <> ignorar;

  if n + 1 > 50 then
    raise exception 'Teto diário: máximo de 50 lançamentos por dia de estudo.';
  end if;
  if soma_q + new.questoes > 1500 then
    raise exception 'Teto diário: máximo de 1500 questões por dia de estudo (já registradas nesta data: %).', soma_q;
  end if;
  if soma_t + new.tempo_min > 1080 then
    raise exception 'Teto diário: máximo de 18h por dia de estudo (já registrados nesta data: % min).', soma_t;
  end if;
  return new;
end $$;

drop trigger if exists lancamentos_validar on public.lancamentos;
create trigger lancamentos_validar before insert or update on public.lancamentos
  for each row execute function public.validar_lancamento();

-- Codinome sempre limpo, também quando o admin edita pelo painel do Supabase
create or replace function public.validar_perfil() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.nickname := public.limpar_nick(new.nickname);
  if char_length(new.nickname) < 3 then
    raise exception 'Codinome inválido (mínimo de 3 caracteres, sem símbolos especiais).';
  end if;
  new.edital_ativo := left(regexp_replace(coalesce(new.edital_ativo, ''), '[[:cntrl:]]+', ' ', 'g'), 300);
  return new;
end $$;

drop trigger if exists perfis_validar on public.perfis;
create trigger perfis_validar before insert or update on public.perfis
  for each row execute function public.validar_perfil();

-- Conta nova no Supabase Auth → cria o perfil (regras do cadastro do Code.gs)
create or replace function public.criar_perfil_novo_usuario() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  nick_pedido text := public.limpar_nick(new.raw_user_meta_data ->> 'nickname');
  nick text;
  lib public.acessos_liberados%rowtype;
  exp timestamptz;
  orig text;
begin
  -- Alunos trazidos da planilha: o script de migração cria o perfil com os dados antigos
  if coalesce(new.raw_app_meta_data ->> 'importado', '') = 'true' then
    return new;
  end if;

  nick := nick_pedido;
  if char_length(nick) < 3 then
    nick := 'Aluno_' || (1000 + floor(random() * 9000))::int;
  end if;
  while exists (select 1 from public.perfis p where lower(p.nickname) = lower(nick)) loop
    if char_length(nick_pedido) >= 3 then
      raise exception 'O codinome "%" já está em uso. Escolha outro.', nick;
    end if;
    nick := 'Aluno_' || (1000 + floor(random() * 9000))::int;
  end loop;

  select * into lib from public.acessos_liberados a where a.email = lower(new.email);
  if found then
    exp := lib.expira_em;
    orig := lib.origem;
    delete from public.acessos_liberados a where a.email = lower(new.email);
  elsif (select count(*) from public.perfis) + (select count(*) from public.acessos_liberados) >= 100 then
    raise exception 'As vagas de fundador foram preenchidas.';
  else
    exp := now() + interval '5 years';
    orig := 'FUNDADOR';
  end if;

  insert into public.perfis (id, email, nickname, expira_em, origem)
  values (new.id, lower(new.email), nick, exp, orig);
  return new;
end $$;

drop trigger if exists auth_criar_perfil on auth.users;
create trigger auth_criar_perfil after insert on auth.users
  for each row execute function public.criar_perfil_novo_usuario();

-- ---------------------------------------------------------------------
-- 4. Funções chamadas pelo aplicativo (substituem as "ações" do Code.gs)
-- ---------------------------------------------------------------------

-- Sessão válida e assinatura em dia (o portão do doPost/doGet)
create or replace function public.exigir_acesso() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := auth.uid(); exp timestamptz;
begin
  if uid is null then raise exception 'Sessão inválida. Faça login novamente.'; end if;
  select p.expira_em into exp from public.perfis p where p.id = uid;
  if not found then raise exception 'Sessão inválida. Faça login novamente.'; end if;
  if exp is not null and exp < now() then raise exception 'Sua assinatura expirou.'; end if;
  return uid;
end $$;

-- ===== Cadastro (antes de criar a conta) =====

-- acao=vagas
create or replace function public.vagas_fundador() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'status', 'sucesso',
    'restantes', greatest(0, 100 - (select count(*) from public.perfis) - (select count(*) from public.acessos_liberados)),
    'limite', 100, 'anos', 5)
$$;

-- Conferência antes do signUp: e-mail, codinome livre e vaga de fundador.
-- Sem vaga, o e-mail entra na lista de espera (como no Code.gs).
create or replace function public.preparar_cadastro(p_email text, p_nickname text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  em text := lower(btrim(coalesce(p_email, '')));
  nick text := public.limpar_nick(p_nickname);
  lib public.acessos_liberados%rowtype;
begin
  if em !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    return jsonb_build_object('status', 'erro', 'mensagem', 'E-mail inválido.');
  end if;
  if char_length(nick) < 3 then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Codinome inválido (mínimo de 3 caracteres, sem símbolos especiais).');
  end if;
  if exists (select 1 from public.perfis p where lower(p.email) = em) then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Conta já ativada!');
  end if;
  if exists (select 1 from public.perfis p where lower(p.nickname) = lower(nick)) then
    return jsonb_build_object('status', 'erro', 'mensagem', format('O codinome "%s" já está em uso. Escolha outro.', nick));
  end if;
  select * into lib from public.acessos_liberados a where a.email = em;
  if found then
    if lib.expira_em is not null and lib.expira_em < now() then
      return jsonb_build_object('status', 'erro', 'mensagem', 'Assinatura expirada.');
    end if;
    return jsonb_build_object('status', 'sucesso', 'nickname', nick);
  end if;
  if (select count(*) from public.perfis) + (select count(*) from public.acessos_liberados) >= 100 then
    insert into public.lista_espera (email) values (em) on conflict do nothing;
    return jsonb_build_object('status', 'erro', 'mensagem',
      'As vagas de fundador foram preenchidas. Você entrou na lista de espera e será avisado quando o acesso abrir.');
  end if;
  return jsonb_build_object('status', 'sucesso', 'nickname', nick);
end $$;

-- ===== Leitura do painel (o antigo doGet) =====

create or replace function public.ranking_geral() returns jsonb
language sql stable security definer set search_path = '' as $$
  with base as (
    select p.nickname as nick, l.data_estudo as d, l.questoes as q, l.acertos as a
      from public.lancamentos l join public.perfis p on p.id = l.user_id
  ), hoje as (select public.hoje_br() as h)
  select jsonb_build_object(
    'diario',  (select coalesce(jsonb_agg(r order by r.q desc), '[]') from (
                  select nick, sum(q) as q, sum(a) as a from base, hoje where d = h
                   group by nick order by sum(q) desc limit 20) r),
    'semanal', (select coalesce(jsonb_agg(r order by r.q desc), '[]') from (
                  select nick, sum(q) as q, sum(a) as a from base, hoje
                   where date_trunc('week', d) = date_trunc('week', h)
                   group by nick order by sum(q) desc limit 20) r),
    'mensal',  (select coalesce(jsonb_agg(r order by r.q desc), '[]') from (
                  select nick, sum(q) as q, sum(a) as a from base, hoje
                   where date_trunc('month', d) = date_trunc('month', h)
                   group by nick order by sum(q) desc limit 20) r),
    'geral',   (select coalesce(jsonb_agg(r order by r.q desc), '[]') from (
                  select nick, sum(q) as q, sum(a) as a from base
                   group by nick order by sum(q) desc limit 50) r))
$$;

create or replace function public.comparativo_geral() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'disciplinas', coalesce((select jsonb_object_agg(materia, jsonb_build_object('q', q, 'a', a)) from (
                      select materia, sum(questoes) as q, sum(acertos) as a
                        from public.lancamentos where questoes > 0 group by materia) x), '{}'),
    'mensal',      coalesce((select jsonb_object_agg(m, jsonb_build_object('q', q, 'a', a)) from (
                      select to_char(data_estudo, 'MM/YYYY') as m, sum(questoes) as q, sum(acertos) as a
                        from public.lancamentos where questoes > 0 group by 1) y), '{}'))
$$;

-- Fotos dos codinomes que aparecem no ranking
create or replace function public.avatares(p_nicks text[]) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(p.nickname, p.avatar), '{}')
    from public.perfis p
   where lower(p.nickname) in (select lower(x) from unnest(p_nicks[1:60]) x)
     and p.avatar is not null and p.avatar <> ''
$$;

-- Escudos e moedas no formato que o aplicativo já usa
create or replace function public.moedas_ganhas(uid uuid) returns int
language sql stable security definer set search_path = '' as $$
  select coalesce(sum((q >= 100)::int * 50 + (t >= 120)::int * 50), 0)::int
    from (select sum(questoes) as q, sum(tempo_min) as t
            from public.lancamentos where user_id = uid group by data_estudo) d
$$;

create or replace function public.resumo_escudos(uid uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with e as (select * from public.escudos where user_id = uid),
       g as (select public.moedas_ganhas(uid) as ganhas, (select count(*) from e)::int as compras)
  select jsonb_build_object(
    'escudos', jsonb_build_object(
      'compras', coalesce((select jsonb_agg(to_char(comprado_em, 'YYYY-MM-DD') order by comprado_em, id) from e), '[]'),
      'usados',  coalesce((select jsonb_agg(to_char(usado_em, 'DD/MM/YYYY') order by usado_em) from e where usado_em is not null), '[]')),
    'moedas', (select jsonb_build_object('ganhas', ganhas, 'gastas', compras * 300,
                                         'saldo', greatest(0, ganhas - compras * 300)) from g))
$$;

create or replace function public.pedidos_admin() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.eh_admin() then return null; end if;
  return jsonb_build_object(
    'pendentes', (select count(*) from public.pedidos_editais where status = 'Pendente'),
    'lista', coalesce((select jsonb_agg(x order by x.ordem desc) from (
       select pe.id, pe.id as ordem,
              to_char(pe.criado_em at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') as data,
              p.email, pe.concurso, pe.status, '' as respondido
         from public.pedidos_editais pe join public.perfis p on p.id = pe.user_id
        where pe.status = 'Pendente'
        order by pe.id desc limit 50) x), '[]'));
end $$;

create or replace function public.meus_pedidos() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x order by x.ordem desc), '[]') from (
    select pe.id as ordem,
           to_char(pe.criado_em at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') as data,
           pe.concurso, pe.status,
           coalesce(to_char(pe.respondido_em at time zone 'America/Sao_Paulo', 'DD/MM/YYYY'), '') as respondido
      from public.pedidos_editais pe
     where pe.user_id = auth.uid()
     order by pe.id desc limit 10) x
$$;

-- Catálogo de editais no formato antigo: { "Concurso": [ {banca, bloco, mat, top, linkMaster}, ... ] }
create or replace function public.catalogo_editais() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(concurso, itens), '{}') from (
    select concurso, jsonb_agg(jsonb_build_object('banca', banca, 'bloco', bloco, 'mat', materia,
                                                  'top', topico, 'linkMaster', link_master) order by id) as itens
      from public.editais_base where btrim(concurso) <> '' group by concurso) c
$$;

-- Tudo o que o painel precisa numa chamada só (substitui o doGet).
-- "dados" sai no mesmo formato da Base_Dashboard (cabeçalho + linhas de texto),
-- para o aplicativo continuar funcionando sem mudar os gráficos.
create or replace function public.carregar_painel() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.exigir_acesso();
  p public.perfis%rowtype;
  lb jsonb;
  nicks text[];
begin
  update public.perfis set ultimo_acesso = public.hoje_br()
   where id = uid and ultimo_acesso is distinct from public.hoje_br();
  select * into p from public.perfis where id = uid;
  lb := public.ranking_geral();
  select array_agg(distinct e ->> 'nick') into nicks
    from jsonb_each(lb) t, jsonb_array_elements(t.value) e;

  return jsonb_build_object(
    'status', 'sucesso',
    'nickname', p.nickname,
    'avatar', coalesce(p.avatar, ''),
    'expiration', case when p.expira_em is null then 'Vitalício'
                       else to_char(p.expira_em at time zone 'America/Sao_Paulo', 'DD/MM/YYYY') end,
    'cicloNuvem', case when p.ciclo = '[]'::jsonb then '' else p.ciclo::text end,
    'editalAtivo', p.edital_ativo,
    'progressoEdital', p.progresso_edital::text,
    'dados', jsonb_build_array(jsonb_build_array('Carimbo', 'Data', 'Matéria', 'Tópico', 'Link', 'Tempo',
                                                 'Questões', 'Acertos', 'Fase', 'Metodologia', 'Status', 'Consolidação', 'Email'))
             || coalesce((select jsonb_agg(jsonb_build_array(
                    to_char(l.criado_em at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI:SS'),
                    to_char(l.data_estudo, 'DD/MM/YYYY'), l.materia, l.topico, l.link,
                    l.tempo_min::text, l.questoes::text, l.acertos::text, l.fase::text, l.metodologia,
                    case when l.consolidado then 'OK' else '' end,
                    case when l.consolidado then 'CONSOLIDADO' else '' end,
                    p.email) order by l.criado_em, l.id)
                  from public.lancamentos l where l.user_id = uid), '[]'),
    'leaderboards', lb,
    'avatares', public.avatares(coalesce(nicks, '{}')),
    'comparativoGeral', public.comparativo_geral(),
    'escudos', public.resumo_escudos(uid) -> 'escudos',
    'pedidosAdmin', public.pedidos_admin());
end $$;

-- ===== Gravações =====

-- acao=lancamento
create or replace function public.lancar(d jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.exigir_acesso();
begin
  insert into public.lancamentos (user_id, data_estudo, materia, topico, link, tempo_min, questoes, acertos, fase, metodologia)
  values (uid, public.data_br(d ->> 'dataEstudo'), coalesce(d ->> 'materia', ''), coalesce(d ->> 'topico', ''),
          coalesce(d ->> 'tipoLink', ''), round(public.numero_seguro(d ->> 'tempo')),
          floor(public.numero_seguro(d ->> 'questoes')), floor(public.numero_seguro(d ->> 'acertos')),
          case when (d ->> 'fase') ~ '^[1-4]$' then (d ->> 'fase')::smallint else 1 end,
          coalesce(d ->> 'metodologia', ''));
  return jsonb_build_object('status', 'sucesso');
end $$;

-- acao=retificar_ultimo
create or replace function public.retificar_ultimo(d jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.exigir_acesso(); alvo bigint;
begin
  select id into alvo from public.lancamentos where user_id = uid order by criado_em desc, id desc limit 1;
  if alvo is null then raise exception 'Nenhum lançamento encontrado.'; end if;
  update public.lancamentos set
    data_estudo = public.data_br(d ->> 'dataEstudo'),
    materia = coalesce(d ->> 'materia', ''), topico = coalesce(d ->> 'topico', ''),
    link = coalesce(d ->> 'tipoLink', ''), tempo_min = round(public.numero_seguro(d ->> 'tempo')),
    questoes = floor(public.numero_seguro(d ->> 'questoes')), acertos = floor(public.numero_seguro(d ->> 'acertos')),
    fase = case when (d ->> 'fase') ~ '^[1-4]$' then (d ->> 'fase')::smallint else 1 end,
    metodologia = coalesce(d ->> 'metodologia', '')
  where id = alvo;
  return jsonb_build_object('status', 'sucesso');
end $$;

-- acao=importar_historico (até 2000 linhas; repetidas e acima do teto são ignoradas, não derrubam o resto)
create or replace function public.importar_historico(itens jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.exigir_acesso();
  it jsonb;
  v_data date; v_mat text; v_top text; v_t int; v_q int; v_a int;
  importados int := 0; ignorados int := 0; ignorados_teto int := 0;
begin
  if jsonb_typeof(itens) <> 'array' or jsonb_array_length(itens) = 0 then
    raise exception 'Nenhum lançamento enviado.';
  end if;
  if jsonb_array_length(itens) > 2000 then raise exception 'Limite de 2000 linhas por importação.'; end if;

  for it in select * from jsonb_array_elements(itens) loop
    begin
      v_data := public.data_br(it ->> 'data');
      v_mat := public.limpar_texto(it ->> 'mat', 120);
      v_top := public.limpar_texto(it ->> 'top', 200);
      v_t := round(public.numero_seguro(it ->> 't'));
      v_q := floor(public.numero_seguro(it ->> 'q'));
      v_a := floor(public.numero_seguro(it ->> 'a'));
      if exists (select 1 from public.lancamentos l
                  where l.user_id = uid and l.data_estudo = v_data and lower(l.materia) = lower(v_mat)
                    and lower(l.topico) = lower(v_top) and l.tempo_min = v_t and l.questoes = v_q and l.acertos = v_a) then
        ignorados := ignorados + 1;
        continue;
      end if;
      insert into public.lancamentos (user_id, data_estudo, materia, topico, tempo_min, questoes, acertos, fase, metodologia)
      values (uid, v_data, v_mat, v_top, v_t, v_q, v_a, 4, coalesce(it ->> 'met', ''));
      importados := importados + 1;
    exception when others then
      ignorados := ignorados + 1;
      if sqlerrm like 'Teto diário%' then ignorados_teto := ignorados_teto + 1; end if;
    end;
  end loop;
  return jsonb_build_object('status', 'sucesso', 'importados', importados, 'ignorados', ignorados, 'ignoradosTeto', ignorados_teto);
end $$;

-- acao=apagar_historico (sem histórico não há moedas: zera os escudos também)
create or replace function public.apagar_historico() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); n int;
begin
  if uid is null then raise exception 'Sessão inválida. Faça login novamente.'; end if;
  delete from public.lancamentos where user_id = uid;
  get diagnostics n = row_count;
  delete from public.escudos where user_id = uid;
  return jsonb_build_object('status', 'sucesso', 'apagados', n);
end $$;

-- acao=salvar_ciclo_nuvem
create or replace function public.salvar_ciclo(p_ciclo jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.exigir_acesso();
begin
  if p_ciclo is null or jsonb_typeof(p_ciclo) <> 'array' then raise exception 'Ciclo inválido.'; end if;
  if length(p_ciclo::text) > 45000 then raise exception 'Ciclo grande demais para ser salvo.'; end if;
  update public.perfis set ciclo = p_ciclo where id = uid;
  return jsonb_build_object('status', 'sucesso');
end $$;

-- acao=salvar_progresso_edital
create or replace function public.salvar_progresso_edital(p_edital text, p_progresso jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.exigir_acesso();
begin
  if p_progresso is null or jsonb_typeof(p_progresso) <> 'object' then raise exception 'Progresso inválido.'; end if;
  if length(p_progresso::text) > 315000 then raise exception 'Progresso grande demais para ser salvo.'; end if;
  update public.perfis set edital_ativo = coalesce(p_edital, ''), progresso_edital = p_progresso where id = uid;
  return jsonb_build_object('status', 'sucesso');
end $$;

-- acao=updateProfile (codinome repetido ganha sufixo _2, _3..., como antes; p_avatar null = mantém a foto)
create or replace function public.atualizar_perfil(p_nickname text, p_avatar text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.exigir_acesso();
  base text := public.limpar_nick(p_nickname);
  nick text;
  sufixo int := 2;
begin
  if char_length(base) < 3 then
    raise exception 'Codinome inválido (mínimo de 3 caracteres, sem símbolos especiais).';
  end if;
  if p_avatar is not null and p_avatar <> ''
     and (char_length(p_avatar) > 40000 or p_avatar !~ '^data:image/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$') then
    raise exception 'Foto inválida. Use PNG, JPG ou WEBP.';
  end if;
  nick := base;
  while exists (select 1 from public.perfis where lower(nickname) = lower(nick) and id <> uid) loop
    nick := left(base, 17) || '_' || sufixo;
    sufixo := sufixo + 1;
  end loop;
  update public.perfis
     set nickname = nick,
         avatar = case when p_avatar is null then avatar else nullif(p_avatar, '') end
   where id = uid;
  return jsonb_build_object('status', 'sucesso', 'nickname', nick);
end $$;

-- acao=comprar_escudo
create or replace function public.comprar_escudo() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.exigir_acesso(); guardados int; compras int; ganhas int;
begin
  perform pg_advisory_xact_lock(hashtext(uid::text));
  select count(*) filter (where usado_em is null), count(*) into guardados, compras
    from public.escudos where user_id = uid;
  if guardados >= 2 then raise exception 'Você já tem 2 escudos guardados (o máximo).'; end if;
  ganhas := public.moedas_ganhas(uid);
  if ganhas - compras * 300 < 300 then
    raise exception 'Moedas insuficientes: o escudo custa 300 e você tem %.', greatest(0, ganhas - compras * 300);
  end if;
  insert into public.escudos (user_id) values (uid);
  return jsonb_build_object('status', 'sucesso') || public.resumo_escudos(uid);
end $$;

-- acao=usar_escudos (datas "dd/MM/yyyy" de dias sem estudo; cada uma gasta o escudo guardado mais antigo)
create or replace function public.usar_escudos(p_datas text[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.exigir_acesso();
  dias date[];
  d date;
  esc record;
begin
  if p_datas is null or cardinality(p_datas) = 0 or cardinality(p_datas) > 2 then
    raise exception 'Datas inválidas.';
  end if;
  perform pg_advisory_xact_lock(hashtext(uid::text));
  select array_agg(x order by x) into dias from (select public.data_br(t) as x from unnest(p_datas) t) s;
  if cardinality(array(select distinct unnest(dias))) <> cardinality(dias) then
    raise exception 'Datas inválidas.';
  end if;

  foreach d in array dias loop
    if d >= public.hoje_br() then raise exception 'Só dias que já passaram podem ser protegidos.'; end if;
    if exists (select 1 from public.escudos where user_id = uid and usado_em = d) then
      raise exception 'Dia já protegido: %', to_char(d, 'DD/MM/YYYY');
    end if;
    if exists (select 1 from public.lancamentos where user_id = uid and data_estudo = d) then
      raise exception 'Você estudou em %: não precisa de escudo.', to_char(d, 'DD/MM/YYYY');
    end if;
    select id, comprado_em into esc from public.escudos
     where user_id = uid and usado_em is null order by comprado_em, id limit 1;
    if not found then raise exception 'Escudos insuficientes.'; end if;
    if esc.comprado_em > d then
      raise exception 'O escudo foi comprado depois de % e não cobre esse dia.', to_char(d, 'DD/MM/YYYY');
    end if;
    update public.escudos set usado_em = d where id = esc.id;
  end loop;
  return jsonb_build_object('status', 'sucesso') || public.resumo_escudos(uid);
end $$;

-- acao=solicitar_edital
create or replace function public.solicitar_edital(p_concurso text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.exigir_acesso(); c text := public.limpar_texto(p_concurso, 200);
begin
  if char_length(c) < 3 then raise exception 'Informe o nome do concurso e o cargo.'; end if;
  perform pg_advisory_xact_lock(hashtext(uid::text));
  if exists (select 1 from public.pedidos_editais
              where user_id = uid and status = 'Pendente' and lower(concurso) = lower(c)) then
    raise exception 'Você já pediu este edital. Ele está aguardando mapeamento.';
  end if;
  if (select count(*) from public.pedidos_editais where user_id = uid and status = 'Pendente') >= 5 then
    raise exception 'Você já tem 5 pedidos aguardando. Espere algum ser respondido.';
  end if;
  insert into public.pedidos_editais (user_id, concurso) values (uid, c);
  return jsonb_build_object('status', 'sucesso', 'pedidos', public.meus_pedidos());
end $$;

-- acao=atualizar_pedido (só o administrador)
create or replace function public.atualizar_pedido(p_id bigint, p_status text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not public.eh_admin() then raise exception 'Ação restrita ao administrador.'; end if;
  if p_status not in ('Pendente', 'Mapeado', 'Recusado') then raise exception 'Status inválido.'; end if;
  update public.pedidos_editais
     set status = p_status, respondido_em = case when p_status = 'Pendente' then null else now() end
   where id = p_id;
  if not found then raise exception 'Pedido não encontrado.'; end if;
  return jsonb_build_object('status', 'sucesso', 'pedidosAdmin', public.pedidos_admin());
end $$;

-- ===== Métricas diárias (agendar com pg_cron, ver MIGRACAO.md) =====
create or replace function public.registrar_metricas() returns void
language plpgsql security definer set search_path = '' as $$
declare
  hoje date := public.hoje_br();
  lim7 date := public.hoje_br() - 6;
begin
  insert into public.metricas_diarias as m values (
    hoje,
    (select count(*) from public.perfis),
    (select count(*) from public.perfis where (cadastro_em at time zone 'America/Sao_Paulo')::date = hoje),
    (select count(*) from public.perfis where ultimo_acesso = hoje),
    (select count(*) from public.perfis where ultimo_acesso >= lim7),
    (select count(distinct user_id) from public.lancamentos where (criado_em at time zone 'America/Sao_Paulo')::date = hoje),
    (select count(distinct user_id) from public.lancamentos where (criado_em at time zone 'America/Sao_Paulo')::date >= lim7),
    (select count(*) from public.lancamentos where (criado_em at time zone 'America/Sao_Paulo')::date = hoje),
    (select coalesce(sum(questoes), 0) from public.lancamentos where (criado_em at time zone 'America/Sao_Paulo')::date = hoje),
    greatest(0, 100 - (select count(*) from public.perfis) - (select count(*) from public.acessos_liberados))
  )
  on conflict (data) do update set
    total_usuarios = excluded.total_usuarios, novos_cadastros = excluded.novos_cadastros,
    acessaram_hoje = excluded.acessaram_hoje, ativos_7d = excluded.ativos_7d,
    estudaram_hoje = excluded.estudaram_hoje, estudaram_7d = excluded.estudaram_7d,
    lancamentos_hoje = excluded.lancamentos_hoje, questoes_hoje = excluded.questoes_hoje,
    vagas_fundador = excluded.vagas_fundador;
end $$;

-- ---------------------------------------------------------------------
-- 5. Quem pode chamar cada função
--    (no Postgres toda função nasce liberada para todos: fecha e libera uma a uma)
-- ---------------------------------------------------------------------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as assinatura
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname not in ('hoje_br', 'limpar_texto', 'limpar_nick', 'numero_seguro', 'data_br') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.assinatura);
  end loop;
end $$;

-- Antes do login (tela de cadastro)
grant execute on function public.vagas_fundador() to anon, authenticated;
grant execute on function public.preparar_cadastro(text, text) to anon, authenticated;

-- Aluno logado
grant execute on function
  public.carregar_painel(), public.catalogo_editais(), public.meus_pedidos(),
  public.lancar(jsonb), public.retificar_ultimo(jsonb), public.importar_historico(jsonb),
  public.apagar_historico(), public.salvar_ciclo(jsonb), public.salvar_progresso_edital(text, jsonb),
  public.atualizar_perfil(text, text), public.comprar_escudo(), public.usar_escudos(text[]),
  public.solicitar_edital(text), public.atualizar_pedido(bigint, text)
to authenticated;

-- Usadas pelas políticas de acesso e pelo login (confere se a assinatura está em dia)
grant execute on function public.eh_admin(), public.exigir_acesso() to authenticated;
