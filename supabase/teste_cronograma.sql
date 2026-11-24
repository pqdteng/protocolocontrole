-- =====================================================================
-- Testes do Cronograma Semanal — rodar DEPOIS do fase6_cronograma.sql ("Run without RLS" se perguntar).
-- Tudo é desfeito no fim (ROLLBACK). Resultado esperado: "CRONOGRAMA TESTES OK".
-- =====================================================================
begin;
create or replace function public.t_erro(cmd text, esperado text) returns text language plpgsql as $$
begin
  execute cmd;
  raise exception 'FALHOU (sem erro): %', cmd;
exception when others then
  if sqlerrm like 'FALHOU%' then raise; end if;
  if sqlerrm not like esperado then raise exception 'FALHOU: % -> "%" (esperado "%")', cmd, sqlerrm, esperado; end if;
  return 'ok';
end $$;
create or replace function public.t_ok(cond boolean, nome text) returns text language plpgsql as $$
begin
  if not coalesce(cond, false) then raise exception 'FALHOU: %', nome; end if;
  return 'ok';
end $$;
grant execute on function public.t_erro(text, text), public.t_ok(boolean, text) to authenticated;

insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000c0001', 'cro1@ex.com', '{"nickname":"CronoTeste1"}');
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000c0002', 'cro2@ex.com', '{"nickname":"CronoTeste2"}');
create temp table t_ids (nome text, id bigint);
grant all on t_ids to authenticated;
-- hoje_br() pode não estar liberada para o aluno: guarda a data de hoje antes de trocar de papel
create temp table t_hoje as select public.hoje_br() as d;
grant select on t_hoje to authenticated;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000c0001';

-- Criar em vários dias de uma vez
select t_ok(jsonb_array_length(salvar_meta(jsonb_build_object('tipo', 'questoes', 'materia', 'POR', 'minutos', 60,
   'datas', jsonb_build_array(d, d + 1, d + 2))) -> 'metas') = 3, 'cria em 3 dias') from t_hoje;
insert into t_ids select 'fixa', (salvar_meta(jsonb_build_object('tipo', 'teoria', 'materia', 'DAD', 'topico', 'Licitações <b>', 'minutos', '90',
   'datas', jsonb_build_array(d))) -> 'metas' -> 0 ->> 'id')::bigint from t_hoje;
insert into t_ids select 'fc', (salvar_meta(jsonb_build_object('tipo', 'flashcards', 'materia', 'DAD', 'minutos', 15,
   'datas', jsonb_build_array(d))) -> 'metas' -> 0 ->> 'id')::bigint from t_hoje;
select t_ok((select topico from metas_cronograma where id = (select id from t_ids where nome = 'fixa')) = 'Licitações b', 'texto limpo');
select t_ok((select materia from metas_cronograma where id = (select id from t_ids where nome = 'fc')) = '', 'flashcards sem matéria');
select t_ok((select ordem from metas_cronograma where id = (select id from t_ids where nome = 'fc')) = 3, 'entra no fim do dia');
select t_ok(jsonb_array_length(minhas_metas(d, d) -> 'metas') = 3, 'lista só o dia pedido') from t_hoje;
select t_ok(jsonb_array_length(minhas_metas(d, d + 6) -> 'metas') = 5, 'lista a semana') from t_hoje;

-- Validações
select t_erro($$select salvar_meta('{"tipo":"questoes","minutos":60,"datas":["2099-01-01"]}')$$, 'Escolha a matéria.');
select t_erro($$select salvar_meta('{"tipo":"questoes","materia":"POR","minutos":60,"datas":["2099-01-01"]}')$$, 'Data fora do período%');
select t_erro($$select salvar_meta('{"tipo":"questoes","materia":"POR","minutos":2,"datas":["2026-12-01"]}')$$, 'O tempo da meta%');
select t_erro($$select salvar_meta('{"tipo":"outro","materia":"POR","minutos":60,"datas":["2026-12-01"]}')$$, 'Tipo de meta inválido.');
select t_erro($$select salvar_meta('{"tipo":"questoes","materia":"POR","minutos":60}')$$, 'Escolha de 1 a 7 dias.');
select t_erro($$select salvar_meta('{"tipo":"questoes","materia":"POR","minutos":60,"datas":[]}')$$, 'Escolha de 1 a 7 dias.');
select t_erro($$select minhas_metas(d, d + 200) from t_hoje$$, 'Período inválido.');
select t_erro($$insert into metas_cronograma (data, materia) values (current_date, 'x')$$, '%permission denied%');

-- Editar, marcar, mover
select t_ok((salvar_meta(jsonb_build_object('id', (select id from t_ids where nome = 'fixa'), 'tipo', 'revisao', 'materia', 'DAD',
   'topico', 'Contratos', 'minutos', 30, 'data', d + 1)) -> 'metas' -> 0 ->> 'data')::date = d + 1, 'edita e troca o dia') from t_hoje;
select t_ok((marcar_meta((select id from t_ids where nome = 'fixa'), true) -> 'metas' -> 0 ->> 'feita')::boolean, 'marca feita');
select t_ok(jsonb_array_length(mover_metas(array[(select id from t_ids where nome = 'fixa'), (select id from t_ids where nome = 'fc')],
   d + 5) -> 'metas') = 2, 'move duas') from t_hoje;
select t_ok(jsonb_array_length(minhas_metas(d + 5, d + 5) -> 'metas') = 2, 'chegaram no dia novo') from t_hoje;
select t_erro('select mover_metas(array[' || (select id from t_ids where nome = 'fc') || ']::bigint[], null)', 'Data fora do período%');

-- Limite de 20 por dia
do $$
declare dia date := (select d + 10 from t_hoje);
begin
  for i in 1..20 loop
    perform salvar_meta(jsonb_build_object('tipo', 'questoes', 'materia', 'POR', 'minutos', 30, 'datas', jsonb_build_array(dia)));
  end loop;
end $$;
select t_erro($$select salvar_meta(jsonb_build_object('tipo', 'questoes', 'materia', 'POR', 'minutos', 30, 'datas', jsonb_build_array(d + 10))) from t_hoje$$,
   'Máximo de 20 metas%');

-- Outro aluno não vê nem mexe
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000c0002';
select t_ok(jsonb_array_length(minhas_metas(d, d + 30) -> 'metas') = 0, 'não vê metas alheias') from t_hoje;
select t_ok((select count(*) from metas_cronograma) = 0, 'tabela filtrada para o aluno');
select t_erro('select marcar_meta(' || (select id from t_ids where nome = 'fc') || ', true)', 'Meta não encontrada.');
select t_erro('select excluir_metas(array[' || (select id from t_ids where nome = 'fc') || ']::bigint[])', 'Meta não encontrada.');
select t_ok(jsonb_array_length(mover_metas(array[(select id from t_ids where nome = 'fc')], d) -> 'metas') = 0, 'não move meta alheia') from t_hoje;

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000c0001';
select t_ok((excluir_metas(array[(select id from t_ids where nome = 'fc'), (select id from t_ids where nome = 'fixa')]) ->> 'excluidas')::int = 2, 'exclui');
reset role;

-- Permissões
select t_ok(not has_function_privilege('anon', 'public.salvar_meta(jsonb)', 'execute'), 'visitante sem acesso');
select t_ok(not has_function_privilege('authenticated', 'public.vaga_meta(uuid, date)', 'execute'), 'função interna fechada');

select 'CRONOGRAMA TESTES OK' as resultado;
rollback;
