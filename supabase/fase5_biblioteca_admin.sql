-- =====================================================================
-- Fase 5 — Tela de administração da biblioteca de assuntos
-- Rodar UMA vez no SQL Editor DEPOIS do fase4_biblioteca.sql ("Run without RLS" se perguntar).
-- Só o administrador consegue usar estas funções.
-- =====================================================================
begin;

-- Quando dois assuntos são juntados, o nome antigo vira apelido do que ficou:
-- um edital novo escrito do jeito antigo cai direto no assunto certo.
create table if not exists public.assuntos_apelidos (
  chave      text primary key,
  assunto_id bigint not null references public.assuntos(id) on delete cascade
);
alter table public.assuntos_apelidos enable row level security;
revoke all on public.assuntos_apelidos from anon, authenticated;
grant select, insert, update, delete on public.assuntos_apelidos to service_role;

-- Gatilho das linhas de edital, agora olhando também os apelidos
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
    select assunto_id into new.assunto_id from public.assuntos_apelidos where chave = ch;
  end if;
  if new.assunto_id is null then
    insert into public.assuntos (chave, materia, assunto) values (ch, btrim(new.materia), btrim(new.topico))
      returning id into new.assunto_id;
  end if;

  if new.link_master <> '' then
    bk := public.chave_banca(new.banca);
    select link into lib from public.assuntos_links where assunto_id = new.assunto_id and banca_chave = bk;
    if lib is null then
      insert into public.assuntos_links (assunto_id, banca, link) values (new.assunto_id, btrim(new.banca), new.link_master);
      new.link_master := '';
    elsif lib = new.link_master then
      new.link_master := '';
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- Lista da tela: assuntos com bancas, links e editais que usam cada um
--   p_filtro: 'sem_link' (falta link para alguma banca), 'com_link' ou 'todos'
-- ---------------------------------------------------------------------
create or replace function public.biblioteca_painel(p_busca text default '', p_filtro text default 'sem_link',
                                                    p_pagina int default 1) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  busca text := public.chave_texto(p_busca);
  pag int := greatest(coalesce(p_pagina, 1), 1);
  por_pagina constant int := 30;
  res jsonb;
begin
  if not public.eh_admin() then raise exception 'Ação restrita ao administrador.'; end if;

  with linhas as (
    select e.assunto_id, e.concurso, btrim(e.banca) as banca, public.chave_banca(e.banca) as bk, e.link_master
      from public.editais_base e where e.assunto_id is not null
  ), por_assunto as (
    select a.id, a.materia, a.assunto,
           count(l.assunto_id) as qtd_linhas,
           count(distinct l.concurso) as qtd_editais,
           (select coalesce(jsonb_agg(c order by c), '[]') from (select distinct l2.concurso as c from linhas l2
               where l2.assunto_id = a.id order by 1 limit 6) z) as editais,
           (select coalesce(jsonb_agg(jsonb_build_object('banca', b.banca, 'chave', b.bk,
                       'temLink', exists (select 1 from public.assuntos_links k where k.assunto_id = a.id and k.banca_chave in ('', b.bk)))
                     order by b.banca), '[]')
              from (select l3.bk, min(l3.banca) as banca from linhas l3 where l3.assunto_id = a.id and l3.bk <> '' group by l3.bk) b) as bancas,
           (select coalesce(jsonb_agg(jsonb_build_object('banca', k.banca, 'chave', k.banca_chave, 'link', k.link)
                     order by k.banca_chave), '[]')
              from public.assuntos_links k where k.assunto_id = a.id) as links,
           count(l.assunto_id) filter (where l.link_master = '' and not exists (
              select 1 from public.assuntos_links k where k.assunto_id = a.id and k.banca_chave in ('', l.bk))) as linhas_sem_link
      from public.assuntos a
      left join linhas l on l.assunto_id = a.id
     where busca = '' or public.chave_texto(a.materia || ' ' || a.assunto) like '%' || busca || '%'
     group by a.id
  ), filtrado as (
    select * from por_assunto
     where case coalesce(p_filtro, 'sem_link')
             when 'sem_link' then linhas_sem_link > 0
             when 'com_link' then jsonb_array_length(links) > 0
             else true end
  )
  select jsonb_build_object(
    'status', 'sucesso',
    'total', (select count(*) from filtrado),
    'pagina', pag,
    'porPagina', por_pagina,
    'itens', coalesce((select jsonb_agg(jsonb_build_object(
                'id', f.id, 'materia', f.materia, 'assunto', f.assunto, 'linhas', f.qtd_linhas,
                'qtdEditais', f.qtd_editais, 'editais', f.editais, 'bancas', f.bancas, 'links', f.links,
                'linhasSemLink', f.linhas_sem_link) order by f.linhas_sem_link desc, f.qtd_linhas desc, f.materia, f.assunto)
              from (select * from filtrado order by linhas_sem_link desc, qtd_linhas desc, materia, assunto
                     offset (pag - 1) * por_pagina limit por_pagina) f), '[]'),
    'resumo', jsonb_build_object(
       'assuntos', (select count(*) from por_assunto),
       'assuntosComLink', (select count(*) from por_assunto where jsonb_array_length(links) > 0),
       'linhas', (select coalesce(sum(qtd_linhas), 0) from por_assunto),
       'linhasSemLink', (select coalesce(sum(linhas_sem_link), 0) from por_assunto))
  ) into res;
  return res;
end $$;

-- ---------------------------------------------------------------------
-- Salvar (ou apagar, se o link vier vazio) o link de um assunto para uma banca.
-- Banca vazia = link que vale para qualquer banca.
-- ---------------------------------------------------------------------
create or replace function public.biblioteca_salvar_link(p_assunto_id bigint, p_banca text, p_link text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  lk text := btrim(coalesce(p_link, ''));
  bc text := btrim(coalesce(p_banca, ''));
begin
  if not public.eh_admin() then raise exception 'Ação restrita ao administrador.'; end if;
  if not exists (select 1 from public.assuntos where id = p_assunto_id) then raise exception 'Assunto não encontrado.'; end if;
  if char_length(bc) > 100 then raise exception 'Nome de banca grande demais.'; end if;
  if lk = '' then
    delete from public.assuntos_links where assunto_id = p_assunto_id and banca_chave = public.chave_banca(bc);
    return jsonb_build_object('status', 'sucesso', 'removido', true);
  end if;
  if lk !~* '^https?://[^\s]+$' or char_length(lk) > 2000 then
    raise exception 'Link inválido. Cole o endereço completo, começando com https://';
  end if;
  insert into public.assuntos_links (assunto_id, banca, link) values (p_assunto_id, bc, lk)
  on conflict (assunto_id, banca_chave) do update set link = excluded.link, banca = excluded.banca;
  return jsonb_build_object('status', 'sucesso');
end $$;

-- ---------------------------------------------------------------------
-- Sugestões de duplicados: mesmo assunto com nomes de matéria diferentes
-- ---------------------------------------------------------------------
create or replace function public.biblioteca_duplicados() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare res jsonb;
begin
  if not public.eh_admin() then raise exception 'Ação restrita ao administrador.'; end if;
  select coalesce(jsonb_agg(g order by g ->> 'assunto'), '[]') into res from (
    select jsonb_build_object('assunto', min(a.assunto), 'opcoes', jsonb_agg(jsonb_build_object(
             'id', a.id, 'materia', a.materia, 'assunto', a.assunto,
             'linhas', (select count(*) from public.editais_base e where e.assunto_id = a.id),
             'links', (select count(*) from public.assuntos_links k where k.assunto_id = a.id))
             order by a.materia)) as g
      from public.assuntos a
     group by split_part(a.chave, '|', 2)
    having count(*) > 1
    ) x;
  return jsonb_build_object('status', 'sucesso', 'grupos', res);
end $$;

-- ---------------------------------------------------------------------
-- Juntar assuntos: os editais e links dos removidos passam para o que fica.
-- Se os dois tinham link para a mesma banca, vale o do assunto que fica.
-- O texto dos editais não muda (o progresso dos alunos fica intacto).
-- ---------------------------------------------------------------------
create or replace function public.biblioteca_juntar(p_manter bigint, p_remover bigint[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  rem bigint[];
  n int;
begin
  if not public.eh_admin() then raise exception 'Ação restrita ao administrador.'; end if;
  if not exists (select 1 from public.assuntos where id = p_manter) then raise exception 'Assunto não encontrado.'; end if;
  select array_agg(distinct r) into rem from unnest(p_remover) r
   where r is not null and r <> p_manter and exists (select 1 from public.assuntos where id = r);
  if rem is null then raise exception 'Escolha ao menos um assunto para juntar.'; end if;

  update public.editais_base set assunto_id = p_manter where assunto_id = any(rem);
  get diagnostics n = row_count;
  insert into public.assuntos_links (assunto_id, banca, link)
    select p_manter, k.banca, k.link from public.assuntos_links k where k.assunto_id = any(rem)
    order by k.atualizado_em desc
  on conflict (assunto_id, banca_chave) do nothing;
  update public.assuntos_apelidos set assunto_id = p_manter where assunto_id = any(rem);
  insert into public.assuntos_apelidos (chave, assunto_id)
    select a.chave, p_manter from public.assuntos a where a.id = any(rem)
  on conflict (chave) do update set assunto_id = excluded.assunto_id;
  delete from public.assuntos where id = any(rem);
  return jsonb_build_object('status', 'sucesso', 'linhasMovidas', n, 'assuntosJuntados', array_length(rem, 1));
end $$;

revoke execute on function public.biblioteca_painel(text, text, int), public.biblioteca_salvar_link(bigint, text, text),
  public.biblioteca_duplicados(), public.biblioteca_juntar(bigint, bigint[]) from public, anon;
grant execute on function public.biblioteca_painel(text, text, int), public.biblioteca_salvar_link(bigint, text, text),
  public.biblioteca_duplicados(), public.biblioteca_juntar(bigint, bigint[]) to authenticated;

select 'BIBLIOTECA ADMIN OK' as resultado;
commit;
