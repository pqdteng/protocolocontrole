-- =====================================================================
-- Testes do schema.sql — rodar no SQL Editor DEPOIS do schema.sql.
-- Tudo acontece dentro de uma transação desfeita no fim (ROLLBACK):
-- nenhum dado de teste fica no banco.
-- Resultado esperado na última linha: "TODOS OS CENÁRIOS PASSARAM".
-- Se algo falhar, aparece um erro "FALHOU: ..." dizendo qual regra.
-- =====================================================================
begin;
-- Ferramentas de teste
create or replace function public.t_erro(cmd text, esperado text) returns text language plpgsql as $$
begin
  execute cmd;
  raise exception 'FALHOU (sem erro): %', cmd;
exception when others then
  if sqlerrm like 'FALHOU%' then raise; end if;
  if sqlerrm not like esperado then raise exception 'FALHOU: % -> "%" (esperado "%")', cmd, sqlerrm, esperado; end if;
  return 'ok: ' || sqlerrm;
end $$;
grant execute on function public.t_erro(text, text) to anon, authenticated;
create or replace function public.t_ok(cond boolean, nome text) returns text language plpgsql as $$
begin
  if not coalesce(cond, false) then raise exception 'FALHOU: %', nome; end if;
  return 'ok: ' || nome;
end $$;
grant execute on function public.t_ok(boolean, text) to anon, authenticated;

-- Cadastro pelo Auth
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-00000000000a', 'Ana@Ex.com', '{"nickname":"Tigre"}');
select t_ok((select origem = 'FUNDADOR' and email = 'ana@ex.com' and expira_em > now() + interval '4 years' from perfis), 'cadastro cria perfil fundador');
select t_erro($$insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-000000000101', 'b@ex.com', '{"nickname":"tigre"}')$$, '%já está em uso%');
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-00000000000b', 'b@ex.com', '{"nickname":"Le<a>o"}');
select t_ok((select nickname from perfis where email = 'b@ex.com') = 'Leao', 'codinome limpo');
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-000000000102', 'semnick@ex.com', '{}');
select t_ok((select nickname like 'Aluno\_%' from perfis where email = 'semnick@ex.com'), 'sem codinome vira Aluno_NNNN');
insert into auth.users (id, email, raw_app_meta_data) values ('00000000-0000-0000-0000-000000000103', 'importado@ex.com', '{"importado":"true"}');
select t_ok(not exists (select 1 from perfis where email = 'importado@ex.com'), 'importado não cria perfil automático');
insert into acessos_liberados (email, expira_em, origem) values ('pago@ex.com', null, 'COMPRA');
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-000000000104', 'pago@ex.com', '{"nickname":"Pago"}');
select t_ok((select expira_em is null and origem = 'COMPRA' from perfis where email = 'pago@ex.com'), 'acesso liberado vira vitalício');

-- Antes do login (anon)
set role anon;
select t_ok((vagas_fundador() ->> 'restantes')::int = 96, 'vagas restantes');
select t_ok(preparar_cadastro('x@ex.com', 'TIGRE') ->> 'mensagem' like '%já está em uso%', 'pré-cadastro recusa codinome');
select t_ok(preparar_cadastro('ANA@ex.com', 'Novo') ->> 'mensagem' = 'Conta já ativada!', 'pré-cadastro conta existente');
select t_ok(preparar_cadastro('novo@ex.com', 'Novo') ->> 'status' = 'sucesso', 'pré-cadastro ok');
select t_erro('select carregar_painel()', '%permission denied%');
select t_erro('select * from perfis', '%permission denied%');
reset role;

-- Aluna Ana logada
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
select lancar('{"dataEstudo":"01/11/2026","materia":"=Direito Adm","topico":"Atos","tempo":"130","questoes":"120","acertos":"110","fase":"4","metodologia":"Método Protocolo Controle"}');
select t_ok((select materia = 'Direito Adm' and consolidado from lancamentos), 'lançamento limpo e consolidado');
select t_erro($$select lancar('{"dataEstudo":"31/02/2026","materia":"A","topico":"B","questoes":"1"}')$$, 'Data inválida.');
select t_erro($$select lancar('{"dataEstudo":"01/11/2026","materia":"A","topico":"B","questoes":"5","acertos":"6"}')$$, 'Os acertos não podem%');
select t_erro($$select lancar('{"dataEstudo":"01/11/2019","materia":"A","topico":"B","questoes":"5"}')$$, 'Data fora do período%');
select t_erro($$select lancar('{"dataEstudo":"01/11/2026","materia":"","topico":"B","questoes":"5"}')$$, 'Matéria e tópico%');
select lancar('{"dataEstudo":"01/11/2026","materia":"Port","topico":"Crase","tempo":"10","questoes":"1000","acertos":"500","fase":"2"}');
select t_erro($$select lancar('{"dataEstudo":"01/11/2026","materia":"A","topico":"B","questoes":"400"}')$$, 'Teto diário: máximo de 1500 questões%1120%');
select t_erro($$insert into lancamentos (data_estudo, materia, topico) values ('2026-11-02','A','B')$$, '%permission denied%');
select t_erro($$update perfis set expira_em = null$$, '%permission denied%');
select t_ok((select count(*) from perfis) = 1, 'aluno só vê o próprio perfil');
select retificar_ultimo('{"dataEstudo":"01/11/2026","materia":"Port","topico":"Crase","tempo":"10","questoes":"900","acertos":"500","fase":"2"}');
select t_ok((select sum(questoes) from lancamentos) = 1020, 'retificação substitui o último');
select t_erro('select comprar_escudo()', 'Moedas insuficientes: o escudo custa 300 e você tem 100.');
select t_ok((importar_historico('[
  {"data":"02/11/2026","mat":"Port","top":"Crase","t":"130","q":"150","a":"100","met":"x"},
  {"data":"03/11/2026","mat":"Port","top":"Crase","t":"130","q":"150","a":"100"},
  {"data":"03/11/2026","mat":"Port","top":"Crase","t":"130","q":"150","a":"100"},
  {"data":"04/11/2026","mat":"Port","top":"Crase","t":"1000","q":"1","a":"1"},
  {"data":"lixo","mat":"Port","top":"Crase","t":"1","q":"1","a":"1"}]') = '{"status":"sucesso","importados":2,"ignorados":3,"ignoradosTeto":0}'), 'importação ignora repetidas e inválidas');
-- 100 + 100 + 100 = 300 moedas
select t_ok((comprar_escudo() -> 'moedas' ->> 'saldo')::int = 0, 'compra de escudo');
select t_erro($$select usar_escudos(array['01/11/2026'])$$, 'Você estudou em 01/11/2026%');
reset role;
update escudos set comprado_em = '2026-11-01';
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
select t_ok((usar_escudos(array['05/11/2026']) -> 'escudos' -> 'usados' ->> 0) = '05/11/2026', 'escudo cobre dia sem estudo');
select t_erro($$select usar_escudos(array['06/11/2026'])$$, 'Escudos insuficientes.');
select salvar_ciclo('[{"mat":"Port"}]');
select t_erro($$select salvar_ciclo('{}')$$, 'Ciclo inválido.');
select salvar_progresso_edital('TCE-MS', '{"a":1}');
select t_ok(solicitar_edital('TCE-SP Auditor') ->> 'status' = 'sucesso', 'pedido de edital');
select t_erro($$select solicitar_edital('tce-sp auditor')$$, 'Você já pediu este edital%');
select t_erro($$select atualizar_pedido(1, 'Mapeado')$$, 'Ação restrita ao administrador.');

-- Leo tenta usar o codinome da Ana e não vê os dados dela
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
select t_ok(atualizar_perfil('Tigre') ->> 'nickname' = 'Tigre_2', 'codinome repetido ganha sufixo');
select t_ok((select count(*) from lancamentos) = 0, 'não vê lançamentos alheios');
select t_ok((select count(*) from pedidos_editais) = 0, 'não vê pedidos alheios');
select lancar('{"dataEstudo":"01/11/2026","materia":"Port","topico":"Crase","tempo":"10","questoes":"30","acertos":"20","fase":"1"}');
select t_ok(position('ana@ex.com' in carregar_painel()::text) = 0, 'painel do Leo não expõe e-mail da Ana');

-- Admin
reset role;
update perfis set is_admin = true where email = 'ana@ex.com';
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
select t_ok((atualizar_pedido((select max(id) from pedidos_editais), 'Mapeado') -> 'pedidosAdmin' ->> 'pendentes')::int = 0, 'admin responde pedido');
select t_ok((meus_pedidos() -> 0 ->> 'status') = 'Mapeado', 'aluno vê resposta');
select t_ok(jsonb_array_length(carregar_painel() -> 'dados') = 5, 'painel traz cabeçalho + 4 lançamentos');
select t_ok((carregar_painel() -> 'leaderboards' -> 'geral' -> 0 ->> 'nick') = 'Tigre', 'ranking geral');
select t_ok(apagar_historico() ->> 'apagados' = '4', 'apagar histórico');
select t_ok(not exists (select 1 from escudos), 'escudos zerados');
reset role;

-- Assinatura vencida
update perfis set expira_em = now() - interval '1 day' where email = 'b@ex.com';
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
select t_erro('select carregar_painel()', 'Sua assinatura expirou.');
select t_ok(apagar_historico() ->> 'status' = 'sucesso', 'vencido ainda pode apagar os dados');
reset role;

select registrar_metricas();
select * from metricas_diarias;
select 'TODOS OS CENÁRIOS PASSARAM' as resultado;
rollback;
