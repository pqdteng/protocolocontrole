-- =====================================================================
-- Fase 2 — ajustes no banco já criado (rodar UMA vez no SQL Editor).
-- (Quem criar um projeto do zero com o schema.sql atual não precisa deste arquivo.)
-- =====================================================================

-- Login de transição: trava de 15 min após 5 senhas erradas
alter table public.legado_senhas
  add column if not exists tentativas int not null default 0,
  add column if not exists bloqueado_ate timestamptz;

-- O login confere se a assinatura está em dia
grant execute on function public.exigir_acesso() to authenticated;

-- Lançamentos: a cópia da planilha (chave de serviço) entra sem passar pelo teto diário
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


select 'Fase 2 aplicada' as resultado;
