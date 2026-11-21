-- =====================================================================
-- Testes dos flashcards — rodar no SQL Editor DEPOIS do fase3_flashcards.sql.
-- Tudo é desfeito no fim (ROLLBACK). Resultado esperado: "FLASHCARDS OK".
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

insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000f0001', 'fc1@ex.com', '{"nickname":"CardTeste1"}');
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000f0002', 'fc2@ex.com', '{"nickname":"CardTeste2"}');
create temp table t_ids (nome text, id bigint);
grant all on t_ids to authenticated;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000f0001';
insert into t_ids select 'pergunta', (salvar_flashcard('{"tipo":"pergunta","frente":"Prazo do recurso?\nLinha 2","verso":"5 dias úteis","materia":"Dir. Adm","topico":"Licitações"}') -> 'card' ->> 'id')::bigint;
insert into t_ids select 'ce', (salvar_flashcard('{"tipo":"certo_errado","frente":"O pregão admite técnica e preço.","gabarito":false,"verso":"Só menor preço ou maior desconto."}') -> 'card' ->> 'id')::bigint;
select t_erro($$select salvar_flashcard('{"tipo":"pergunta","frente":"Sem verso"}')$$, 'Escreva a resposta%');
select t_erro($$select salvar_flashcard('{"tipo":"certo_errado","frente":"Sem gabarito"}')$$, 'Marque se a afirmação%');
select t_ok((select frente from flashcards where id = (select id from t_ids where nome = 'pergunta')) like E'%\nLinha 2', 'quebra de linha preservada');
select t_ok((resumo_flashcards() ->> 'hoje')::int = 2, 'cards novos entram para hoje');
select t_ok((revisar_flashcard((select id from t_ids where nome = 'pergunta'), 'facil') -> 'card' ->> 'intervalo')::int = 7, 'fácil: 7 dias');
select t_ok((revisar_flashcard((select id from t_ids where nome = 'pergunta'), 'facil') -> 'card' ->> 'intervalo')::int = 15, 'fácil de novo: 15 dias');
select t_ok((revisar_flashcard((select id from t_ids where nome = 'pergunta'), 'dificil') -> 'card' ->> 'intervalo')::int = 7, 'difícil: metade de 15 = 7');
select t_ok((revisar_flashcard((select id from t_ids where nome = 'ce'), 'errei') -> 'card' ->> 'intervalo')::int = 1, 'errei: amanhã');
select t_ok((resumo_flashcards() ->> 'hoje')::int = 0, 'nada mais para hoje');
select t_ok((resumo_flashcards() ->> 'revisadosHoje')::int = 4, 'revisões contadas');
select t_ok(jsonb_array_length(resumo_flashcards() -> 'diasRevisao') = 1, 'dia de revisão registrado');
select t_ok(jsonb_array_length(meus_flashcards() -> 'cards') = 2, 'lista os próprios cards');
select t_ok((salvar_flashcard(jsonb_build_object('id', (select id from t_ids where nome = 'ce'), 'tipo', 'certo_errado',
             'frente', 'Editado', 'gabarito', true)) -> 'card' ->> 'frente') = 'Editado', 'edição');
select t_erro($$insert into flashcards (frente, verso) values ('x', 'y')$$, '%permission denied%');

-- Outro aluno não vê nem mexe nos cards da primeira
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000f0002';
select t_ok(jsonb_array_length(meus_flashcards() -> 'cards') = 0, 'não vê cards alheios');
select t_ok((select count(*) from flashcards) = 0, 'tabela filtrada para o aluno');
select t_erro('select excluir_flashcard(' || (select id from t_ids where nome = 'ce') || ')', 'Card não encontrado.');
select t_erro('select revisar_flashcard(' || (select id from t_ids where nome = 'ce') || ', ''facil'')', 'Card não encontrado.');

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000f0001';
select t_ok(excluir_flashcard((select id from t_ids where nome = 'ce')) ->> 'status' = 'sucesso', 'exclusão');
reset role;

select 'FLASHCARDS OK' as resultado;
rollback;
