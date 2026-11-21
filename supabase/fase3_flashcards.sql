-- =====================================================================
-- Fase 3 — Flashcards (v29-94). Rodar UMA vez no SQL Editor.
-- Cards de pergunta/resposta e de Certo/Errado (estilo Cebraspe), com revisão espaçada:
--   Errei  → volta amanhã
--   Difícil → volta em 3 dias (ou na metade do intervalo atual, se for maior)
--   Fácil  → sobe a escada 7 → 15 → 30 → 60 → 120 dias
-- Dia com revisão de flashcards conta para a ofensiva.
-- =====================================================================

-- Texto de card: aceita quebra de linha; tira os demais caracteres de controle
create or replace function public.limpar_card(t text, maximo int) returns text
language sql immutable set search_path = '' as $$
  select left(btrim(regexp_replace(regexp_replace(coalesce(t, ''), E'\r\n?', E'\n', 'g'),
                                   E'[\\x01-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]+', ' ', 'g'), E' \t\n'), maximo)
$$;

create table if not exists public.flashcards (
  id              bigint generated always as identity primary key,
  user_id         uuid not null default auth.uid() references public.perfis(id) on delete cascade,
  tipo            text not null default 'pergunta' check (tipo in ('pergunta', 'certo_errado')),
  frente          text not null check (char_length(frente) between 1 and 1000),
  verso           text not null default '' check (char_length(verso) <= 2000),
  gabarito        boolean,                  -- só no Certo/Errado: true = CERTO
  materia         text not null default '' check (char_length(materia) <= 120),
  topico          text not null default '' check (char_length(topico) <= 200),
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now(),
  proxima_revisao date not null default public.hoje_br(),
  intervalo_dias  int not null default 0,
  revisoes        int not null default 0,
  acertos         int not null default 0,
  ultima_revisao  timestamptz,
  check (tipo <> 'certo_errado' or gabarito is not null),
  check (tipo <> 'pergunta' or char_length(verso) >= 1)
);
create index if not exists flashcards_usuario on public.flashcards (user_id, proxima_revisao);

create table if not exists public.revisoes_flashcards (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.perfis(id) on delete cascade,
  card_id     bigint references public.flashcards(id) on delete set null,
  dia         date not null default public.hoje_br(),
  resposta    text not null check (resposta in ('errei', 'dificil', 'facil')),
  revisado_em timestamptz not null default now()
);
create index if not exists revisoes_usuario_dia on public.revisoes_flashcards (user_id, dia);

alter table public.flashcards enable row level security;
alter table public.revisoes_flashcards enable row level security;
revoke all on public.flashcards, public.revisoes_flashcards from anon, authenticated;
grant select on public.flashcards, public.revisoes_flashcards to authenticated;
grant select, insert, update, delete on public.flashcards, public.revisoes_flashcards to service_role;
grant usage, select on all sequences in schema public to service_role;
create policy flashcards_leitura on public.flashcards for select to authenticated using (user_id = auth.uid());
create policy revisoes_leitura on public.revisoes_flashcards for select to authenticated using (user_id = auth.uid());

-- Card no formato do aplicativo
create or replace function public.card_json(c public.flashcards) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', c.id, 'tipo', c.tipo, 'frente', c.frente, 'verso', c.verso, 'gabarito', c.gabarito,
    'materia', c.materia, 'topico', c.topico,
    'proxima', to_char(c.proxima_revisao, 'YYYY-MM-DD'), 'intervalo', c.intervalo_dias,
    'revisoes', c.revisoes, 'acertos', c.acertos,
    'criado', to_char(c.criado_em at time zone 'America/Sao_Paulo', 'YYYY-MM-DD'))
$$;

-- Resumo para o painel: total, cards para hoje, revisados hoje e dias com revisão (ofensiva)
create or replace function public.resumo_flashcards() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := public.exigir_acesso();
begin
  return jsonb_build_object(
    'status', 'sucesso',
    'total', (select count(*) from public.flashcards where user_id = uid),
    'hoje', (select count(*) from public.flashcards where user_id = uid and proxima_revisao <= public.hoje_br()),
    'revisadosHoje', (select count(*) from public.revisoes_flashcards where user_id = uid and dia = public.hoje_br()),
    'diasRevisao', coalesce((select jsonb_agg(d order by d) from (
                      select distinct to_char(dia, 'YYYY-MM-DD') as d
                        from public.revisoes_flashcards where user_id = uid) x), '[]'));
end $$;

create or replace function public.meus_flashcards() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := public.exigir_acesso();
begin
  return jsonb_build_object('status', 'sucesso', 'cards',
    coalesce((select jsonb_agg(public.card_json(c) order by c.proxima_revisao, c.id)
                from public.flashcards c where c.user_id = uid), '[]'));
end $$;

-- Cria (sem id) ou edita (com id) um card do próprio aluno
create or replace function public.salvar_flashcard(d jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.exigir_acesso();
  v_id bigint := nullif(d ->> 'id', '')::bigint;
  v_tipo text := case when d ->> 'tipo' = 'certo_errado' then 'certo_errado' else 'pergunta' end;
  v_frente text := public.limpar_card(d ->> 'frente', 1000);
  v_verso text := public.limpar_card(d ->> 'verso', 2000);
  v_gab boolean := case when v_tipo = 'certo_errado' then (d ->> 'gabarito')::boolean end;
  v_mat text := public.limpar_texto(d ->> 'materia', 120);
  v_top text := public.limpar_texto(d ->> 'topico', 200);
  c public.flashcards%rowtype;
begin
  if v_frente = '' then raise exception 'Escreva a frente do card.'; end if;
  if v_tipo = 'pergunta' and v_verso = '' then raise exception 'Escreva a resposta (verso) do card.'; end if;
  if v_tipo = 'certo_errado' and v_gab is null then raise exception 'Marque se a afirmação está CERTA ou ERRADA.'; end if;

  if v_id is null then
    perform pg_advisory_xact_lock(hashtext(uid::text));
    if (select count(*) from public.flashcards where user_id = uid) >= 5000 then
      raise exception 'Limite de 5.000 flashcards atingido. Exclua cards que você já domina.';
    end if;
    insert into public.flashcards (user_id, tipo, frente, verso, gabarito, materia, topico)
    values (uid, v_tipo, v_frente, v_verso, v_gab, v_mat, v_top)
    returning * into c;
  else
    update public.flashcards
       set tipo = v_tipo, frente = v_frente, verso = v_verso, gabarito = v_gab,
           materia = v_mat, topico = v_top, atualizado_em = now()
     where id = v_id and user_id = uid
    returning * into c;
    if not found then raise exception 'Card não encontrado.'; end if;
  end if;
  return jsonb_build_object('status', 'sucesso', 'card', public.card_json(c));
end $$;

create or replace function public.excluir_flashcard(p_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.exigir_acesso();
begin
  delete from public.flashcards where id = p_id and user_id = uid;
  if not found then raise exception 'Card não encontrado.'; end if;
  return jsonb_build_object('status', 'sucesso');
end $$;

-- Registra a revisão e agenda a próxima
create or replace function public.revisar_flashcard(p_id bigint, p_resposta text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.exigir_acesso();
  c public.flashcards%rowtype;
  novo int;
begin
  if p_resposta not in ('errei', 'dificil', 'facil') then raise exception 'Resposta inválida.'; end if;
  select * into c from public.flashcards where id = p_id and user_id = uid for update;
  if not found then raise exception 'Card não encontrado.'; end if;

  novo := case p_resposta
    when 'errei'   then 1
    when 'dificil' then greatest(3, c.intervalo_dias / 2)
    else (select coalesce(min(x), 120) from unnest(array[7, 15, 30, 60, 120]) x where x > c.intervalo_dias)
  end;

  update public.flashcards
     set intervalo_dias = novo, proxima_revisao = public.hoje_br() + novo,
         revisoes = revisoes + 1, acertos = acertos + (p_resposta <> 'errei')::int, ultima_revisao = now()
   where id = p_id
  returning * into c;
  insert into public.revisoes_flashcards (user_id, card_id, resposta) values (uid, p_id, p_resposta);

  return jsonb_build_object('status', 'sucesso', 'card', public.card_json(c));
end $$;

revoke all on function public.limpar_card(text, int), public.card_json(public.flashcards),
  public.resumo_flashcards(), public.meus_flashcards(), public.salvar_flashcard(jsonb),
  public.excluir_flashcard(bigint), public.revisar_flashcard(bigint, text) from public, anon, authenticated;
grant execute on function public.limpar_card(text, int) to public;
grant execute on function public.resumo_flashcards(), public.meus_flashcards(), public.salvar_flashcard(jsonb),
  public.excluir_flashcard(bigint), public.revisar_flashcard(bigint, text) to authenticated;

-- Escudo: dia com revisão de flashcards já conta como dia estudado
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
    if exists (select 1 from public.revisoes_flashcards where user_id = uid and dia = d) then
      raise exception 'Você revisou flashcards em %: não precisa de escudo.', to_char(d, 'DD/MM/YYYY');
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

select 'Flashcards instalados' as resultado;
