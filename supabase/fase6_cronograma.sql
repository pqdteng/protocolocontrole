-- =====================================================================
-- Fase 6 — Cronograma Semanal (v29-98). Rodar UMA vez no SQL Editor ("Run without RLS" se perguntar).
-- Cada linha é uma meta de um dia. Assunto vazio = "GPS decide".
-- A conclusão automática é calculada na tela, pelos lançamentos; aqui só fica o "feita" marcado à mão.
-- =====================================================================
begin;

create table if not exists public.metas_cronograma (
  id            bigint generated always as identity primary key,
  user_id       uuid not null default auth.uid() references public.perfis(id) on delete cascade,
  data          date not null,
  ordem         int not null default 0,
  tipo          text not null default 'questoes' check (tipo in ('questoes', 'teoria', 'revisao', 'flashcards')),
  materia       text not null default '' check (char_length(materia) <= 120),
  topico        text not null default '' check (char_length(topico) <= 200),
  minutos       int not null default 60 check (minutos between 5 and 720),
  feita         boolean not null default false,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  check (tipo = 'flashcards' or materia <> '')
);
create index if not exists metas_usuario_data on public.metas_cronograma (user_id, data);

alter table public.metas_cronograma enable row level security;
revoke all on public.metas_cronograma from anon, authenticated;
grant select on public.metas_cronograma to authenticated;
grant select, insert, update, delete on public.metas_cronograma to service_role;
grant usage, select on all sequences in schema public to service_role;
drop policy if exists metas_leitura on public.metas_cronograma;
create policy metas_leitura on public.metas_cronograma for select to authenticated using (user_id = auth.uid());

create or replace function public.meta_json(m public.metas_cronograma) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', m.id, 'data', to_char(m.data, 'YYYY-MM-DD'), 'ordem', m.ordem, 'tipo', m.tipo,
    'materia', m.materia, 'topico', m.topico, 'minutos', m.minutos, 'feita', m.feita)
$$;

-- Confere a data e o limite do dia; devolve a próxima posição na fila do dia
create or replace function public.vaga_meta(p_uid uuid, p_data date) returns int
language plpgsql security definer set search_path = '' as $$
declare n int; prox int;
begin
  if p_data is null or p_data < public.hoje_br() - 60 or p_data > public.hoje_br() + 370 then
    raise exception 'Data fora do período permitido.';
  end if;
  select count(*), coalesce(max(ordem), 0) + 1 into n, prox
    from public.metas_cronograma where user_id = p_uid and data = p_data;
  if n >= 20 then raise exception 'Máximo de 20 metas por dia (%).', to_char(p_data, 'DD/MM'); end if;
  return prox;
end $$;

-- Metas do aluno em um período (até 70 dias)
create or replace function public.minhas_metas(p_de date, p_ate date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := public.exigir_acesso();
begin
  if p_de is null or p_ate is null or p_ate < p_de or p_ate - p_de > 70 then raise exception 'Período inválido.'; end if;
  return jsonb_build_object('status', 'sucesso', 'de', to_char(p_de, 'YYYY-MM-DD'), 'ate', to_char(p_ate, 'YYYY-MM-DD'),
    'metas', coalesce((select jsonb_agg(public.meta_json(m) order by m.data, m.ordem, m.id)
                         from public.metas_cronograma m where m.user_id = uid and m.data between p_de and p_ate), '[]'));
end $$;

-- Cria (sem id, em um ou mais dias: "datas") ou edita (com id, "data") metas do próprio aluno
create or replace function public.salvar_meta(d jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.exigir_acesso();
  v_id bigint := nullif(d ->> 'id', '')::bigint;
  v_tipo text := coalesce(nullif(d ->> 'tipo', ''), 'questoes');
  v_mat text := public.limpar_texto(d ->> 'materia', 120);
  v_top text := public.limpar_texto(d ->> 'topico', 200);
  v_min int := round(public.numero_seguro(d ->> 'minutos'))::int;
  v_data date;
  m public.metas_cronograma%rowtype;
  saida jsonb := '[]';
begin
  if v_tipo not in ('questoes', 'teoria', 'revisao', 'flashcards') then raise exception 'Tipo de meta inválido.'; end if;
  if v_tipo = 'flashcards' then v_mat := ''; v_top := ''; end if;
  if v_tipo <> 'flashcards' and v_mat = '' then raise exception 'Escolha a matéria.'; end if;
  if v_min < 5 or v_min > 720 then raise exception 'O tempo da meta vai de 5 minutos a 12 horas.'; end if;
  perform pg_advisory_xact_lock(hashtext(uid::text));

  if v_id is null then
    if jsonb_typeof(d -> 'datas') is distinct from 'array' then raise exception 'Escolha de 1 a 7 dias.'; end if;
    if jsonb_array_length(d -> 'datas') not between 1 and 7 then raise exception 'Escolha de 1 a 7 dias.'; end if;
    for v_data in select distinct x::date from jsonb_array_elements_text(d -> 'datas') x order by 1 loop
      insert into public.metas_cronograma (user_id, data, ordem, tipo, materia, topico, minutos)
      values (uid, v_data, public.vaga_meta(uid, v_data), v_tipo, v_mat, v_top, v_min)
      returning * into m;
      saida := saida || jsonb_build_array(public.meta_json(m));
    end loop;
  else
    select * into m from public.metas_cronograma where id = v_id and user_id = uid for update;
    if not found then raise exception 'Meta não encontrada.'; end if;
    v_data := coalesce(nullif(d ->> 'data', '')::date, m.data);
    update public.metas_cronograma t
       set tipo = v_tipo, materia = v_mat, topico = v_top, minutos = v_min,
           data = v_data,
           ordem = case when v_data = m.data then m.ordem else public.vaga_meta(uid, v_data) end,
           atualizado_em = now()
     where t.id = v_id returning * into m;
    saida := saida || jsonb_build_array(public.meta_json(m));
  end if;
  return jsonb_build_object('status', 'sucesso', 'metas', saida);
end $$;

-- Move uma ou mais metas para outro dia (vão para o fim da fila daquele dia)
create or replace function public.mover_metas(p_ids bigint[], p_data date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.exigir_acesso();
  v_id bigint;
  m public.metas_cronograma%rowtype;
  saida jsonb := '[]';
begin
  if coalesce(array_length(p_ids, 1), 0) not between 1 and 100 then raise exception 'Escolha as metas para mover.'; end if;
  perform pg_advisory_xact_lock(hashtext(uid::text));
  for v_id in select t.id from public.metas_cronograma t
               where t.user_id = uid and t.id = any(p_ids) and t.data is distinct from p_data
               order by t.data, t.ordem, t.id loop
    update public.metas_cronograma t set data = p_data, ordem = public.vaga_meta(uid, p_data), atualizado_em = now()
     where t.id = v_id returning * into m;
    saida := saida || jsonb_build_array(public.meta_json(m));
  end loop;
  return jsonb_build_object('status', 'sucesso', 'metas', saida);
end $$;

create or replace function public.marcar_meta(p_id bigint, p_feita boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.exigir_acesso(); m public.metas_cronograma%rowtype;
begin
  update public.metas_cronograma set feita = coalesce(p_feita, false), atualizado_em = now()
   where id = p_id and user_id = uid returning * into m;
  if not found then raise exception 'Meta não encontrada.'; end if;
  return jsonb_build_object('status', 'sucesso', 'metas', jsonb_build_array(public.meta_json(m)));
end $$;

create or replace function public.excluir_metas(p_ids bigint[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.exigir_acesso(); n int;
begin
  delete from public.metas_cronograma where user_id = uid and id = any(p_ids);
  get diagnostics n = row_count;
  if n = 0 then raise exception 'Meta não encontrada.'; end if;
  return jsonb_build_object('status', 'sucesso', 'excluidas', n);
end $$;

revoke execute on function public.vaga_meta(uuid, date), public.meta_json(public.metas_cronograma) from public, anon, authenticated;
revoke execute on function public.minhas_metas(date, date), public.salvar_meta(jsonb), public.mover_metas(bigint[], date),
  public.marcar_meta(bigint, boolean), public.excluir_metas(bigint[]) from public, anon;
grant execute on function public.minhas_metas(date, date), public.salvar_meta(jsonb), public.mover_metas(bigint[], date),
  public.marcar_meta(bigint, boolean), public.excluir_metas(bigint[]) to authenticated;

select 'CRONOGRAMA OK' as resultado;
commit;
