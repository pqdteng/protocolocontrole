// ===== BACKUP SEMANAL: SUPABASE → GOOGLE DRIVE =====
// Arquivo separado no mesmo projeto do Apps Script. Usa sbConfig_ e sbReq_ do MigrarSupabase.gs
// (mesmas Propriedades do script: SUPABASE_URL e SUPABASE_SECRET).
//
// Cada execução cria, na pasta "Backups Protocolo Controle" do seu Drive:
//   • backup_AAAA-MM-DD.json  → cópia completa e exata (é o arquivo que serve para restaurar)
//   • planilha "Backup Protocolo Controle AAAA-MM-DD" → uma aba por tabela, para consultar
// Backups com mais de 8 semanas vão para a lixeira do Drive.
// As senhas antigas (legado_senhas) ficam de fora de propósito.
//
// Para usar: rode backupSupabase uma vez (▶) para autorizar e conferir;
// depois rode instalarBackupSemanal uma vez para agendar (toda segunda-feira, ~3h).

var BACKUP_TABELAS = ["perfis", "lancamentos", "escudos", "editais_base", "pedidos_editais",
                      "acessos_liberados", "lista_espera", "metricas_diarias",
                      "flashcards", "revisoes_flashcards", "assuntos", "assuntos_links", "bancas_apelidos"];
var BACKUP_ORDEM = { acessos_liberados: "email", lista_espera: "email", metricas_diarias: "data", bancas_apelidos: "apelido" };
var BACKUP_SEMANAS = 8;
var BACKUP_PASTA = "Backups Protocolo Controle";

function backupSupabase() {
  var cfg = sbConfig_();
  var hoje = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  var pasta = pastaBackup_();

  // Lê todas as tabelas (de 1000 em 1000 linhas)
  var dados = {}, resumo = {};
  BACKUP_TABELAS.forEach(function(t) {
    var linhas = [];
    for (var off = 0; ; off += 1000) {
      var lote = sbReq_(cfg, "get", "/rest/v1/" + t + "?select=*&order=" + (BACKUP_ORDEM[t] || "id") +
                        "&limit=1000&offset=" + off) || [];
      linhas = linhas.concat(lote);
      if (lote.length < 1000) break;
    }
    dados[t] = linhas;
    resumo[t] = linhas.length;
  });

  // 1. Arquivo JSON completo
  pasta.createFile("backup_" + hoje + ".json",
    JSON.stringify({ criado_em: new Date().toISOString(), tabelas: dados }), "application/json");

  // 2. Planilha para consulta
  var ss = SpreadsheetApp.create("Backup Protocolo Controle " + hoje);
  DriveApp.getFileById(ss.getId()).moveTo(pasta);
  var primeira = ss.getSheets()[0];
  BACKUP_TABELAS.forEach(function(t, i) {
    var aba = i === 0 ? primeira.setName(t) : ss.insertSheet(t);
    var linhas = dados[t];
    if (!linhas.length) { aba.getRange(1, 1).setValue("(tabela vazia)"); return; }
    var cols = Object.keys(linhas[0]);
    var matriz = [cols].concat(linhas.map(function(l) {
      return cols.map(function(c) { return celulaBackup_(l[c]); });
    }));
    aba.getRange(1, 1, matriz.length, cols.length).setValues(matriz);
    aba.setFrozenRows(1);
  });

  // 3. Limpa backups antigos (vão para a lixeira, de onde ainda dá para recuperar por 30 dias)
  var limite = new Date(Date.now() - BACKUP_SEMANAS * 7 * 86400000);
  var arquivos = pasta.getFiles();
  var apagados = 0;
  while (arquivos.hasNext()) {
    var f = arquivos.next();
    if (f.getDateCreated() < limite) { f.setTrashed(true); apagados++; }
  }

  Logger.log("Backup " + hoje + " salvo na pasta \"" + BACKUP_PASTA + "\".\nLinhas por tabela: " +
             JSON.stringify(resumo, null, 2) + "\nBackups antigos removidos: " + apagados);
  return resumo;
}

// Rode UMA vez para agendar o backup semanal (segunda-feira, por volta das 3h)
function instalarBackupSemanal() {
  ScriptApp.getProjectTriggers().forEach(function(g) {
    if (g.getHandlerFunction() === "backupSupabase") ScriptApp.deleteTrigger(g);
  });
  ScriptApp.newTrigger("backupSupabase").timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(3).create();
  Logger.log("Backup semanal agendado: toda segunda-feira, por volta das 3h.");
}

function pastaBackup_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty("BACKUP_PASTA_ID");
  if (id) {
    try { var p = DriveApp.getFolderById(id); if (!p.isTrashed()) return p; } catch (e) {}
  }
  var achadas = DriveApp.getFoldersByName(BACKUP_PASTA);
  var pasta = achadas.hasNext() ? achadas.next() : DriveApp.createFolder(BACKUP_PASTA);
  props.setProperty("BACKUP_PASTA_ID", pasta.getId());
  return pasta;
}

// Valor de célula seguro: JSON vira texto, nada vira fórmula, e textos enormes são cortados
// (o limite do Sheets é 50 mil caracteres por célula; o valor completo está no .json)
function celulaBackup_(v) {
  if (v === null || typeof v === "undefined") return "";
  var s = (typeof v === "object") ? JSON.stringify(v) : v;
  if (typeof s === "string") {
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    if (s.length > 49000) s = s.substring(0, 49000) + " …[cortado: valor completo no arquivo .json]";
  }
  return s;
}
