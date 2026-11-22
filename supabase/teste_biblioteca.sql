-- =====================================================================
-- Testes da biblioteca de assuntos — rodar no SQL Editor DEPOIS do fase4_biblioteca.sql
-- ("Run without RLS" se perguntar). Usa editais de mentira e desfaz tudo no fim (ROLLBACK).
-- Resultado esperado: "BIBLIOTECA TESTES OK".
-- =====================================================================
begin;
create or replace function public.t_ok(cond boolean, nome text) returns text language plpgsql as $$
begin
  if not coalesce(cond, false) then raise exception 'FALHOU: %', nome; end if;
  return 'ok';
end $$;
create or replace function public.t_link(p_concurso text, p_topico text) returns text language sql as $$
  select i ->> 'linkMaster' from jsonb_array_elements(public.catalogo_editais() -> p_concurso) i
   where i ->> 'top' = p_topico limit 1
$$;

-- Banca escrita de jeitos diferentes = mesma banca
select t_ok(public.chave_banca('CESPE') = public.chave_banca('Cebraspe (CESPE)'), 'CESPE = Cebraspe (CESPE)');
select t_ok(public.chave_banca('CESPE/CEBRASPE') = 'cebraspe', 'CESPE/CEBRASPE = cebraspe');
select t_ok(public.chave_banca('FGV') <> public.chave_banca('Cebraspe'), 'FGV diferente de Cebraspe');
-- Assunto escrito de jeitos diferentes = mesmo assunto
select t_ok(public.chave_assunto('Direito Administrativo', '1.2 Licitações') =
            public.chave_assunto('Noções de Direito Administrativo', 'licitacoes'), 'numeração, acento e "Noções de" ignorados');

-- Edital A (Cebraspe) cadastrado com link: o link vai para a biblioteca
insert into public.editais_base (concurso, banca, materia, topico, link_master) values
  ('ZZ TESTE A - Cargo', 'CESPE', 'ZZ Direito Teste', 'Licitações', 'https://tec/cebraspe-licit'),
  ('ZZ TESTE A - Cargo', 'CESPE', 'ZZ Direito Teste', 'Atos administrativos', '');
select t_ok((select link_master from public.editais_base where concurso = 'ZZ TESTE A - Cargo' and topico = 'Licitações') = '',
            'link igual ao da biblioteca não vira exceção');
select t_ok(exists (select 1 from public.assuntos_links where link = 'https://tec/cebraspe-licit' and banca_chave = 'cebraspe'),
            'link guardado na biblioteca para a banca Cebraspe');

-- Edital B (Cebraspe escrito diferente, assunto numerado) SEM link: herda o da biblioteca
insert into public.editais_base (concurso, banca, materia, topico) values
  ('ZZ TESTE B - Cargo', 'Cebraspe (CESPE)', 'Noções de ZZ Direito Teste', '3.1 Licitações');
select t_ok(t_link('ZZ TESTE B - Cargo', '3.1 Licitações') = 'https://tec/cebraspe-licit', 'edital novo herda o link da mesma banca');

-- Edital C (FGV) SEM link: não pega o link da Cebraspe
insert into public.editais_base (concurso, banca, materia, topico) values
  ('ZZ TESTE C - Cargo', 'FGV', 'ZZ Direito Teste', 'Licitações');
select t_ok(t_link('ZZ TESTE C - Cargo', 'Licitações') = '', 'FGV não recebe link da Cebraspe');

-- Link "qualquer banca" cobre a FGV enquanto não existir um específico
insert into public.assuntos_links (assunto_id, banca, link)
  select assunto_id, '', 'https://tec/geral-licit' from public.editais_base where concurso = 'ZZ TESTE C - Cargo';
select t_ok(t_link('ZZ TESTE C - Cargo', 'Licitações') = 'https://tec/geral-licit', 'FGV usa o link geral');
select t_ok(t_link('ZZ TESTE A - Cargo', 'Licitações') = 'https://tec/cebraspe-licit', 'Cebraspe continua com o específico');

-- Outro edital FGV cadastrado com link: vira o link FGV da biblioteca e vale para o edital C também
insert into public.editais_base (concurso, banca, materia, topico, link_master) values
  ('ZZ TESTE D - Cargo', 'FGV', 'ZZ Direito Teste', 'Licitações', 'https://tec/fgv-licit');
select t_ok(t_link('ZZ TESTE C - Cargo', 'Licitações') = 'https://tec/fgv-licit', 'link FGV chega ao edital C');

-- Exceção: um edital com link próprio diferente mantém o dele
insert into public.editais_base (concurso, banca, materia, topico, link_master) values
  ('ZZ TESTE E - Cargo', 'CESPE', 'ZZ Direito Teste', 'Licitações', 'https://tec/caderno-especial');
select t_ok(t_link('ZZ TESTE E - Cargo', 'Licitações') = 'https://tec/caderno-especial', 'exceção do edital respeitada');

-- Corrigir na biblioteca corrige em todos os editais da banca (menos na exceção)
update public.assuntos_links set link = 'https://tec/cebraspe-licit-v2' where link = 'https://tec/cebraspe-licit';
select t_ok(t_link('ZZ TESTE A - Cargo', 'Licitações') = 'https://tec/cebraspe-licit-v2', 'correção chega ao edital A');
select t_ok(t_link('ZZ TESTE B - Cargo', '3.1 Licitações') = 'https://tec/cebraspe-licit-v2', 'correção chega ao edital B');
select t_ok(t_link('ZZ TESTE E - Cargo', 'Licitações') = 'https://tec/caderno-especial', 'exceção não é sobrescrita');

-- Assunto sem link nenhum continua vazio; nome do assunto no edital não muda (progresso do aluno preservado)
select t_ok(t_link('ZZ TESTE A - Cargo', 'Atos administrativos') = '', 'assunto sem link fica vazio');
select t_ok(exists (select 1 from jsonb_array_elements(public.catalogo_editais() -> 'ZZ TESTE B - Cargo') i
                     where i ->> 'top' = '3.1 Licitações' and i ->> 'mat' = 'Noções de ZZ Direito Teste'),
            'texto do edital preservado');

-- Aluno não lê a biblioteca direto
set role authenticated;
do $$ begin
  perform 1 from public.assuntos_links limit 1;
  raise exception 'FALHOU: aluno conseguiu ler assuntos_links';
exception when insufficient_privilege then null;
end $$;
reset role;

select 'BIBLIOTECA TESTES OK' as resultado;
rollback;
