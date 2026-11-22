-- =====================================================================
-- Consultas de revisão da biblioteca de assuntos (só leitura, pode rodar quando quiser).
-- Rode UMA consulta por vez: selecione o bloco desejado e clique em Run.
-- =====================================================================

-- 1. ONDE VALE MAIS A PENA ADICIONAR LINK: assuntos sem link, dos mais usados para os menos.
--    "falta_para" mostra as bancas dos editais que ainda estão sem link nesse assunto.
select a.id as assunto_id, a.materia, a.assunto,
       count(*) as linhas_sem_link, count(distinct e.concurso) as editais,
       string_agg(distinct nullif(btrim(e.banca), ''), ', ') as falta_para
  from public.editais_base e
  join public.assuntos a on a.id = e.assunto_id
 where e.link_master = ''
   and not exists (select 1 from public.assuntos_links l where l.assunto_id = a.id
                    and l.banca_chave in ('', public.chave_banca(e.banca)))
 group by a.id
 order by linhas_sem_link desc, a.materia, a.assunto
 limit 200;

-- 2. EXCEÇÕES: linhas de edital com link próprio, diferente do link da biblioteca.
--    Se o link da biblioteca for o melhor, apague o link_master dessa linha (Table Editor → editais_base).
select e.id, e.concurso, e.banca, e.materia, e.topico,
       e.link_master as link_do_edital, l.link as link_da_biblioteca
  from public.editais_base e
  left join public.assuntos_links l on l.assunto_id = e.assunto_id and l.banca_chave = public.chave_banca(e.banca)
 where e.link_master <> ''
 order by e.materia, e.topico, e.concurso;

-- 3. POSSÍVEIS DUPLICADOS: o mesmo assunto aparecendo com nomes de matéria diferentes
--    (ex.: "Dir. Administrativo" e "Direito Administrativo"). Para juntar, me mande a lista.
select split_part(a.chave, '|', 2) as assunto_normalizado,
       string_agg(a.materia || ' (#' || a.id || ')', '  |  ' order by a.materia) as aparece_como,
       count(*) as variantes
  from public.assuntos a
 group by split_part(a.chave, '|', 2)
having count(*) > 1
 order by variantes desc, assunto_normalizado
 limit 200;

-- 4. BANCAS: como cada banca escrita nos editais foi entendida.
--    Se duas linhas deveriam ser a mesma banca e não são, me avise (ou cadastre em bancas_apelidos).
select btrim(banca) as banca_no_edital, public.chave_banca(banca) as banca_reconhecida,
       count(*) as linhas, count(distinct concurso) as editais
  from public.editais_base
 group by 1, 2
 order by banca_reconhecida, linhas desc;

-- 5. RESUMO GERAL
select (select count(*) from public.assuntos) as assuntos,
       (select count(*) from public.assuntos_links) as links,
       (select count(*) from public.editais_base where btrim(topico) <> '') as linhas_de_edital,
       (select count(*) from public.editais_base e where e.link_master <> '' or exists (
          select 1 from public.assuntos_links l where l.assunto_id = e.assunto_id
             and l.banca_chave in ('', public.chave_banca(e.banca)))) as linhas_com_link;
