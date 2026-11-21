-- =====================================================================
-- Fase 2b — libera as tabelas para a chave de serviço (service_role).
-- Usada só pelo script de cópia (Apps Script) e pela função login-legado;
-- alunos e visitantes continuam com as mesmas restrições.
-- Rodar UMA vez no SQL Editor.
-- =====================================================================

grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

select 'Permissões da chave de serviço aplicadas' as resultado;
