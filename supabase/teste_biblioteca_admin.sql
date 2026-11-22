-- =====================================================================
-- Testes da tela de administração da biblioteca — rodar DEPOIS do fase5_biblioteca_admin.sql
-- ("Run without RLS" se perguntar). Tudo é desfeito no fim (ROLLBACK).
-- Resultado esperado: "BIBLIOTECA ADMIN TESTES OK".
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
create or replace function public.t_link(p_concurso text, p_topico text) returns text language sql as $$
  select i ->> 'linkMaster' from jsonb_array_elements(public.catalogo_editais() -> p_concurso) i
   where i ->> 'top' = p_topico limit 1
$$;
grant execute on function public.t_erro(text, text), public.t_ok(boolean, text), public.t_link(text, text) to authenticated;

insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000b0001', 'bibadm@ex.com', '{"nickname":"BibAdmin"}');
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000b0002', 'bibalu@ex.com', '{"nickname":"BibAluno"}');
update public.perfis set is_admin = true where id = '00000000-0000-0000-0000-0000000b0001';

insert into public.editais_base (concurso, banca, materia, topico, link_master) values
  ('ZZ BIB A - Cargo', 'CESPE', 'ZZ Dir Teste', 'Poderes administrativos', ''),
  ('ZZ BIB A - Cargo', 'CESPE', 'ZZ Dir Teste', 'Serviços públicos', 'https://tec/servicos-cespe'),
  ('ZZ BIB B - Cargo', 'FGV',   'ZZ Direito Teste', 'Poderes administrativos', '');
create temp table t_ids as
  select topico, materia, assunto_id from public.editais_base where concurso like 'ZZ BIB %';
grant all on t_ids to authenticated;

-- Aluno comum não usa a tela
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000b0002';
select t_erro($$select biblioteca_painel('zz dir', 'todos', 1)$$, 'Ação restrita ao administrador.');
select t_erro($$select biblioteca_salvar_link(1, '', 'https://x')$$, 'Ação restrita ao administrador.');
select t_erro($$select biblioteca_juntar(1, array[2]::bigint[])$$, 'Ação restrita ao administrador.');

-- Administrador
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000b0001';
select t_ok((biblioteca_painel('zz dir', 'todos', 1) ->> 'total')::int = 3, 'lista os 3 assuntos de teste');
select t_ok((biblioteca_painel('zz dir', 'sem_link', 1) ->> 'total')::int = 2, 'filtro sem link: 2 assuntos');
select t_ok((biblioteca_painel('zz dir', 'com_link', 1) ->> 'total')::int = 1, 'filtro com link: 1 assunto');

-- Salvar link para a banca Cebraspe (escrita "Cebraspe")
select t_ok(biblioteca_salvar_link((select assunto_id from t_ids where topico = 'Poderes administrativos' and materia = 'ZZ Dir Teste'),
            'Cebraspe', 'https://tec/poderes-cespe') ->> 'status' = 'sucesso', 'salva link');
select t_ok(t_link('ZZ BIB A - Cargo', 'Poderes administrativos') = 'https://tec/poderes-cespe', 'edital CESPE recebe o link');
select t_erro($$select biblioteca_salvar_link((select assunto_id from t_ids limit 1), '', 'tec.com sem https')$$, 'Link inválido%');
-- Atualizar o mesmo link (não duplica)
select biblioteca_salvar_link((select assunto_id from t_ids where topico = 'Poderes administrativos' and materia = 'ZZ Dir Teste'),
       'CESPE', 'https://tec/poderes-cespe-v2');
select t_ok(t_link('ZZ BIB A - Cargo', 'Poderes administrativos') = 'https://tec/poderes-cespe-v2', 'atualiza o link');

-- Duplicados: "ZZ Dir Teste" e "ZZ Direito Teste" têm o mesmo assunto "Poderes administrativos"
select t_ok(exists (select 1 from jsonb_array_elements(biblioteca_duplicados() -> 'grupos') g
                     where g ->> 'assunto' = 'Poderes administrativos'), 'duplicado sugerido');

-- Juntar: fica o de "ZZ Dir Teste"
select t_ok((biblioteca_juntar(
               (select assunto_id from t_ids where topico = 'Poderes administrativos' and materia = 'ZZ Dir Teste'),
               array[(select assunto_id from t_ids where topico = 'Poderes administrativos' and materia = 'ZZ Direito Teste')])
             ->> 'linhasMovidas')::int = 1, 'juntar move a linha do edital B');
-- Link geral passa a valer para o edital FGV (B), que agora é o mesmo assunto
select biblioteca_salvar_link((select assunto_id from t_ids where topico = 'Poderes administrativos' and materia = 'ZZ Dir Teste'),
       '', 'https://tec/poderes-geral');
select t_ok(t_link('ZZ BIB B - Cargo', 'Poderes administrativos') = 'https://tec/poderes-geral', 'edital FGV usa o link geral do assunto juntado');
select t_ok(t_link('ZZ BIB A - Cargo', 'Poderes administrativos') = 'https://tec/poderes-cespe-v2', 'CESPE mantém o específico');
reset role;

-- Edital novo escrito do jeito antigo cai no assunto que ficou (apelido)
insert into public.editais_base (concurso, banca, materia, topico) values ('ZZ BIB C - Cargo', 'FGV', 'ZZ Direito Teste', 'Poderes administrativos');
select t_ok((select assunto_id from public.editais_base where concurso = 'ZZ BIB C - Cargo') =
            (select assunto_id from t_ids where topico = 'Poderes administrativos' and materia = 'ZZ Dir Teste'), 'apelido funciona');
-- Texto do edital B não mudou (progresso do aluno preservado)
select t_ok(exists (select 1 from jsonb_array_elements(public.catalogo_editais() -> 'ZZ BIB B - Cargo') i
                     where i ->> 'mat' = 'ZZ Direito Teste'), 'texto do edital preservado');

-- Apagar link (link vazio)
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000b0001';
select biblioteca_salvar_link((select assunto_id from t_ids where topico = 'Poderes administrativos' and materia = 'ZZ Dir Teste'), '', '');
select t_ok(t_link('ZZ BIB B - Cargo', 'Poderes administrativos') = '', 'link geral apagado');
reset role;

select 'BIBLIOTECA ADMIN TESTES OK' as resultado;
rollback;
