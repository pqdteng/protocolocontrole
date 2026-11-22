-- =====================================================================
-- Fase 4 — Biblioteca de assuntos (links do TEC reaproveitados entre editais)
-- Rodar UMA vez no SQL Editor ("Run without RLS" se perguntar).
--
-- Como funciona:
--   • assuntos        → cada assunto existe uma vez só (matéria + assunto)
--   • assuntos_links  → os links de cada assunto, UM POR BANCA
--                       (banca vazia = link que vale para qualquer banca)
--   • editais_base    → cada linha do edital aponta para um assunto (assunto_id).
--                       O link_master da linha passa a ser só uma EXCEÇÃO daquele edital.
--
-- Qual link o aluno vê (nesta ordem):
--   1. a exceção do próprio edital (link_master preenchido na linha)
--   2. o link da biblioteca para a banca do edital
--   3. o link da biblioteca "qualquer banca"
--
-- Segurança: o script compara o catálogo antes e depois. Se QUALQUER link que o aluno
-- vê mudar, ele dá erro e nada é gravado.
-- =====================================================================
begin;

-- Foto do catálogo antes de mexer (para a conferência final)
create temp table t_catalogo_antes as select public.catalogo_editais() as cat;

-- ---------------------------------------------------------------------
-- 1. Normalização de textos (maiúsculas, acentos, pontuação e numeração não contam)
-- ---------------------------------------------------------------------
create or replace function public.chave_texto(t text) returns text
language sql immutable set search_path = '' as $$
  select btrim(regexp_replace(regexp_replace(
           translate(lower(coalesce(t, '')), 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn'),
           '[^a-z0-9]+', ' ', 'g'), '\s+', ' ', 'g'))
$$;

-- "1.2 Licitações" e "Licitações" são o mesmo assunto; "Noções de Direito X" = "Direito X"
create or replace function public.chave_assunto(p_materia text, p_topico text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(public.chave_texto(p_materia), '^nocoes (basicas )?de ', '') || '|' ||
         regexp_replace(public.chave_texto(p_topico), '^([0-9]+ )+', '')
$$;

-- Apelidos de banca: "CESPE", "Cespe/Cebraspe" e "CEBRASPE (CESPE)" viram a mesma banca
create table if not exists public.bancas_apelidos (
  apelido text primary key,       -- já normalizado (chave_texto)
  banca   text not null           -- chave normalizada da banca oficial
);
insert into public.bancas_apelidos (apelido, banca) values
  ('cespe', 'cebraspe'), ('cespe cebraspe', 'cebraspe'), ('cebraspe cespe', 'cebraspe'),
  ('cespe unb', 'cebraspe'), ('fundacao getulio vargas', 'fgv'), ('fgv conhecimento', 'fgv'),
  ('fundacao carlos chagas', 'fcc'), ('fundacao vunesp', 'vunesp'), ('instituto aocp', 'aocp')
on conflict (apelido) do nothing;

create or replace function public.chave_banca(p_banca text) returns text
language sql stable set search_path = '' as $$
  select coalesce((select a.banca from public.bancas_apelidos a where a.apelido = public.chave_texto(p_banca)),
                  public.chave_texto(p_banca))
$$;

-- ---------------------------------------------------------------------
-- 2. Tabelas
-- ---------------------------------------------------------------------
create table if not exists public.assuntos (
  id        bigint generated always as identity primary key,
  chave     text not null unique,
  materia   text not null,
  assunto   text not null,
  criado_em timestamptz not null default now()
);

create table if not exists public.assuntos_links (
  id            bigint generated always as identity primary key,
  assunto_id    bigint not null references public.assuntos(id) on delete cascade,
  banca         text not null default '',   -- como você escreveu (ex.: "Cebraspe"); vazio = qualquer banca
  banca_chave   text not null default '',   -- preenchido sozinho
  link          text not null check (btrim(link) <> ''),
  atualizado_em timestamptz not null default now(),
  unique (assunto_id, banca_chave)
);

alter table public.editais_base add column if not exists assunto_id bigint references public.assuntos(id) on delete set null;
create index if not exists editais_base_assunto on public.editais_base (assunto_id);

alter table public.assuntos        enable row level security;
alter table public.assuntos_links  enable row level security;
alter table public.bancas_apelidos enable row level security;
revoke all on public.assuntos, public.assuntos_links, public.bancas_apelidos from anon, authenticated;
grant select, insert, update, delete on public.assuntos, public.assuntos_links, public.bancas_apelidos to service_role;
grant usage, select on all sequences in schema public to service_role;
-- (os alunos não leem essas tabelas direto: o catálogo entrega tudo pronto)

-- banca_chave e data de atualização sempre preenchidas sozinhas
create or replace function public.preparar_link_assunto() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.banca := btrim(coalesce(new.banca, ''));
  new.banca_chave := public.chave_banca(new.banca);
  new.link := btrim(new.link);
  new.atualizado_em := now();
  return new;
end $$;
drop trigger if exists preparar_link_assunto on public.assuntos_links;
create trigger preparar_link_assunto before insert or update on public.assuntos_links
  for each row execute function public.preparar_link_assunto();

-- ---------------------------------------------------------------------
-- 3. Toda linha de edital nova ou editada se liga sozinha à biblioteca
--    (você continua cadastrando editais do mesmo jeito)
-- ---------------------------------------------------------------------
create or replace function public.ligar_linha_edital() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  ch text;
  bk text;
  lib text;
begin
  new.link_master := btrim(coalesce(new.link_master, ''));
  if btrim(coalesce(new.topico, '')) = '' then new.assunto_id := null; return new; end if;

  ch := public.chave_assunto(new.materia, new.topico);
  select id into new.assunto_id from public.assuntos where chave = ch;
  if new.assunto_id is null then
    insert into public.assuntos (chave, materia, assunto) values (ch, btrim(new.materia), btrim(new.topico))
      returning id into new.assunto_id;
  end if;

  if new.link_master <> '' then
    bk := public.chave_banca(new.banca);
    select link into lib from public.assuntos_links where assunto_id = new.assunto_id and banca_chave = bk;
    if lib is null then
      -- primeiro link deste assunto para esta banca: vai para a biblioteca
      insert into public.assuntos_links (assunto_id, banca, link) values (new.assunto_id, btrim(new.banca), new.link_master);
      new.link_master := '';
    elsif lib = new.link_master then
      new.link_master := '';          -- igual ao da biblioteca: não precisa de exceção
    end if;                           -- diferente: fica como exceção só deste edital
  end if;
  return new;
end $$;
drop trigger if exists ligar_linha_edital on public.editais_base;
create trigger ligar_linha_edital before insert or update of materia, topico, banca, link_master
  on public.editais_base for each row execute function public.ligar_linha_edital();

-- ---------------------------------------------------------------------
-- 4. Carga inicial a partir dos editais que já existem
-- ---------------------------------------------------------------------
-- 4a. Um assunto por chave, com a escrita mais usada
insert into public.assuntos (chave, materia, assunto)
select ch, mode() within group (order by btrim(materia)), mode() within group (order by btrim(topico))
  from (select public.chave_assunto(materia, topico) ch, materia, topico
          from public.editais_base where btrim(topico) <> '') x
 group by ch
on conflict (chave) do nothing;

-- 4b. Para cada assunto + banca, o link mais usado vira o link da biblioteca
insert into public.assuntos_links (assunto_id, banca, link)
select a.id, mode() within group (order by btrim(e.banca)), mode() within group (order by btrim(e.link_master))
  from public.editais_base e
  join public.assuntos a on a.chave = public.chave_assunto(e.materia, e.topico)
 where btrim(e.topico) <> '' and btrim(e.link_master) <> ''
 group by a.id, public.chave_banca(e.banca)
on conflict (assunto_id, banca_chave) do nothing;

-- 4c. Liga as linhas (o gatilho limpa o link_master quando ele é igual ao da biblioteca)
update public.editais_base set link_master = link_master;

-- ---------------------------------------------------------------------
-- 5. Catálogo: mesmo formato de antes, agora lendo os links da biblioteca
-- ---------------------------------------------------------------------
create or replace function public.catalogo_editais() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(concurso, itens), '{}') from (
    select e.concurso, jsonb_agg(jsonb_build_object('banca', e.banca, 'bloco', e.bloco, 'mat', e.materia,
             'top', e.topico,
             'linkMaster', coalesce(nullif(e.link_master, ''), lb.link, lg.link, ''))
             order by e.id) as itens
      from public.editais_base e
      left join public.assuntos_links lb on lb.assunto_id = e.assunto_id and lb.banca_chave = public.chave_banca(e.banca)
                                         and lb.banca_chave <> ''
      left join public.assuntos_links lg on lg.assunto_id = e.assunto_id and lg.banca_chave = ''
     where btrim(e.concurso) <> '' group by e.concurso) c
$$;

-- ---------------------------------------------------------------------
-- 6. Conferência: nenhum aluno pode ver link diferente do que via antes
-- ---------------------------------------------------------------------
--    (linha que não tinha link e agora ganhou um da biblioteca é permitido: é ganho, não mudança)
create temp table t_comparacao as
select a.key as concurso, a.n, a.item as antes, d.item as depois
  from (select c.key, i.n, i.item from jsonb_each((select cat from t_catalogo_antes)) c,
               jsonb_array_elements(c.value) with ordinality i(item, n)) a
  full join (select c.key, i.n, i.item from jsonb_each(public.catalogo_editais()) c,
                    jsonb_array_elements(c.value) with ordinality i(item, n)) d
    on d.key = a.key and d.n = a.n;

do $$
declare mudou int;
begin
  select count(*) into mudou from t_comparacao
   where antes is null or depois is null
      or (antes - 'linkMaster') is distinct from (depois - 'linkMaster')
      or (btrim(antes ->> 'linkMaster') <> '' and btrim(antes ->> 'linkMaster') <> btrim(depois ->> 'linkMaster'));
  if mudou > 0 then
    raise exception 'ABORTADO: % linha(s) de edital mudariam de link. Nada foi gravado. Me mande esta mensagem.', mudou;
  end if;
end $$;

select (select count(*) from public.assuntos)                                    as assuntos_na_biblioteca,
       (select count(*) from public.assuntos_links)                              as links_na_biblioteca,
       (select count(*) from public.editais_base where assunto_id is not null)  as linhas_ligadas,
       (select count(*) from public.editais_base where link_master <> '')       as excecoes_por_edital,
       (select count(*) from t_comparacao where btrim(antes ->> 'linkMaster') = ''
                                            and btrim(depois ->> 'linkMaster') <> '') as linhas_que_ganharam_link,
       'BIBLIOTECA OK' as resultado;

drop table t_catalogo_antes, t_comparacao;
commit;
