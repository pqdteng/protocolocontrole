-- =====================================================================
-- Testes da fase 7 — rodar DEPOIS do fase7_assuntos_longos.sql ("Run without RLS" se perguntar).
-- Tudo é desfeito no fim (ROLLBACK). Resultado esperado: "ASSUNTOS LONGOS TESTES OK".
-- =====================================================================
begin;
create or replace function public.t_ok(cond boolean, nome text) returns text language plpgsql as $$
begin
  if not coalesce(cond, false) then raise exception 'FALHOU: %', nome; end if;
  return 'ok';
end $$;
grant execute on function public.t_ok(boolean, text) to authenticated;
create temp table t_h as select public.hoje_br() as d, repeat('Assunto bem longo, ', 20) || 'fim' as longo;
grant select on t_h to authenticated;
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000a0001', 'longo1@ex.com', '{"nickname":"LongoTeste1"}');

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000a0001';
select t_ok(lancar(jsonb_build_object('dataEstudo', to_char(d, 'DD/MM/YYYY'), 'materia', 'POR', 'topico', longo, 'tempo', 30,
   'questoes', 10, 'acertos', 8, 'fase', '2')) ->> 'status' = 'sucesso', 'lança assunto longo') from t_h;
select t_ok((select topico from lancamentos where user_id = auth.uid()) = longo, 'lançamento guarda o texto inteiro') from t_h;
select t_ok(retificar_ultimo(jsonb_build_object('dataEstudo', to_char(d, 'DD/MM/YYYY'), 'materia', 'POR', 'topico', longo, 'tempo', 40,
   'questoes', 10, 'acertos', 9, 'fase', '2')) ->> 'status' = 'sucesso', 'retifica') from t_h;
select t_ok((select topico from lancamentos where user_id = auth.uid()) = longo, 'retificação guarda o texto inteiro') from t_h;
select t_ok(salvar_flashcard(jsonb_build_object('tipo', 'pergunta', 'frente', 'a', 'verso', 'b', 'materia', 'POR', 'topico', longo)) ->> 'status' = 'sucesso', 'flashcard') from t_h;
select t_ok((select topico from flashcards where user_id = auth.uid()) = longo, 'flashcard guarda o texto inteiro') from t_h;
select t_ok(salvar_meta(jsonb_build_object('tipo', 'questoes', 'materia', 'POR', 'topico', longo, 'minutos', 60,
   'datas', jsonb_build_array(d))) -> 'metas' -> 0 ->> 'topico' = longo, 'meta guarda o texto inteiro') from t_h;
select t_ok((importar_historico(jsonb_build_array(jsonb_build_object('data', to_char(d - 1, 'DD/MM/YYYY'), 'mat', 'POR', 'top', longo, 't', 30, 'q', 10, 'a', 5)))
   ->> 'importados')::int = 1, 'importa') from t_h;
select t_ok((select bool_and(topico = longo) from lancamentos where user_id = auth.uid()), 'importação guarda o texto inteiro') from t_h;
select t_ok(lancar(jsonb_build_object('dataEstudo', to_char(d, 'DD/MM/YYYY'), 'materia', 'POR', 'topico', repeat('x', 900), 'tempo', 5,
   'questoes', 0, 'acertos', 0, 'fase', '1')) ->> 'status' = 'sucesso', 'acima de 500 não dá erro') from t_h;
select t_ok((select max(char_length(topico)) from lancamentos where user_id = auth.uid()) = 500, 'acima de 500 é cortado');
reset role;
select 'ASSUNTOS LONGOS TESTES OK' as resultado;
rollback;
