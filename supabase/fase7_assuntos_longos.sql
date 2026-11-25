-- =====================================================================
-- Fase 7 — Assuntos de até 500 caracteres (v29-99).
-- Rodar UMA vez no SQL Editor ("Run without RLS" se perguntar). Pode rodar de novo sem problema.
--
-- Antes o limite era 200: lançar estudo em um assunto maior gravava o texto cortado, e ele
-- deixava de bater com o edital (selo "Fase X", GPS e Cronograma não reconheciam).
--   1. sobe o limite nas tabelas e nas funções
--   2. completa o texto dos lançamentos, flashcards e metas que já foram cortados
--      (só quando existe UM único assunto de edital que começa com aquele texto)
-- Nada além do texto do assunto muda: tempo, questões, acertos, fase e datas ficam como estão.
-- =====================================================================
begin;

-- 1a. Limites das tabelas (a regra tem nome automático: procura pela definição)
do $$
declare r record;
begin
  for r in select c.conname, c.conrelid::regclass as tabela
             from pg_constraint c
            where c.contype = 'c'
              and c.conrelid in ('public.lancamentos'::regclass, 'public.flashcards'::regclass, 'public.metas_cronograma'::regclass)
              and pg_get_constraintdef(c.oid) ~ 'char_length\(topico\)' loop
    execute format('alter table %s drop constraint %I', r.tabela, r.conname);
  end loop;
end $$;
alter table public.lancamentos      add constraint lancamentos_topico_check      check (char_length(topico) between 1 and 500);
alter table public.flashcards       add constraint flashcards_topico_check       check (char_length(topico) <= 500);
alter table public.metas_cronograma add constraint metas_cronograma_topico_check check (char_length(topico) <= 500);

-- 1b. Funções: troca só o limite do assunto, mantendo o resto exatamente como está no banco
do $$
declare
  alvo record;
  def text;
begin
  for alvo in select * from (values
      ('public.validar_lancamento()', 'limpar_texto(new.topico, 200)', 'limpar_texto(new.topico, 500)'),
      ('public.importar_historico(jsonb)', 'limpar_texto(it ->> ''top'', 200)', 'limpar_texto(it ->> ''top'', 500)'),
      ('public.salvar_flashcard(jsonb)', 'limpar_texto(d ->> ''topico'', 200)', 'limpar_texto(d ->> ''topico'', 500)'),
      ('public.salvar_meta(jsonb)', 'limpar_texto(d ->> ''topico'', 200)', 'limpar_texto(d ->> ''topico'', 500)')
    ) v(funcao, de, para) loop
    def := pg_get_functiondef(alvo.funcao::regprocedure);
    if position(alvo.para in def) > 0 then continue; end if;   -- já estava trocado
    if position(alvo.de in def) = 0 then
      raise exception 'ABORTADO: não achei o limite em %. Nada foi gravado. Me mande esta mensagem.', alvo.funcao;
    end if;
    execute replace(def, alvo.de, alvo.para);
  end loop;
end $$;

-- 2. Completa os textos cortados
create temp table t_cortados on commit drop as
select rtrim(left(completo, 200)) as cortado, min(completo) as completo
  from (select distinct public.limpar_texto(topico, 500) as completo from public.editais_base) e
 where char_length(completo) > 200
 group by 1
having count(*) = 1;
-- se algum edital tem um assunto que é exatamente o texto cortado, não dá para saber qual é: não mexe
delete from t_cortados t where exists (select 1 from public.editais_base e where rtrim(public.limpar_texto(e.topico, 500)) = t.cortado);

create temp table t_foto on commit drop as
select count(*) as n, sum(tempo_min) as t, sum(questoes) as q, sum(acertos) as a, count(*) filter (where consolidado) as c
  from public.lancamentos;

create temp table t_ajustes (tabela text, n int) on commit drop;
alter table public.lancamentos disable trigger lancamentos_validar;  -- só o texto muda; não reconta o teto diário
with u as (update public.lancamentos l set topico = t.completo from t_cortados t
            where char_length(l.topico) between 190 and 200 and rtrim(l.topico) = t.cortado returning 1)
insert into t_ajustes select 'lancamentos', count(*) from u;
alter table public.lancamentos enable trigger lancamentos_validar;
with u as (update public.flashcards l set topico = t.completo from t_cortados t
            where char_length(l.topico) between 190 and 200 and rtrim(l.topico) = t.cortado returning 1)
insert into t_ajustes select 'flashcards', count(*) from u;
with u as (update public.metas_cronograma l set topico = t.completo from t_cortados t
            where char_length(l.topico) between 190 and 200 and rtrim(l.topico) = t.cortado returning 1)
insert into t_ajustes select 'metas', count(*) from u;

-- Conferência: os números dos alunos não podem mudar
do $$
declare mudou boolean;
begin
  select (f.n, f.t, f.q, f.a, f.c) is distinct from (x.n, x.t, x.q, x.a, x.c) into mudou
    from t_foto f, (select count(*) as n, sum(tempo_min) as t, sum(questoes) as q, sum(acertos) as a,
                           count(*) filter (where consolidado) as c from public.lancamentos) x;
  if mudou then raise exception 'ABORTADO: os totais dos lançamentos mudariam. Nada foi gravado.'; end if;
end $$;

select (select n from t_ajustes where tabela = 'lancamentos') as lancamentos_completados,
       (select n from t_ajustes where tabela = 'flashcards')  as flashcards_completados,
       (select n from t_ajustes where tabela = 'metas')       as metas_completadas,
       (select count(*) from public.editais_base where char_length(topico) > 200) as assuntos_longos,
       (select max(char_length(topico)) from public.editais_base) as maior_assunto,
       'ASSUNTOS LONGOS OK' as resultado;
commit;
