// ===== CÓPIA DA PLANILHA PARA O SUPABASE (transição) =====
// Arquivo separado no mesmo projeto do Apps Script (usa COL, limparNick, gerarHashSenha... do Code.gs).
//
// 1. Configurações do projeto → Propriedades do script:
//      SUPABASE_URL    = https://nydspkbnbahclgkjfotc.supabase.co
//      SUPABASE_SECRET = chave secreta (Supabase → Project Settings → API Keys → secret / service_role)
// 2. Selecione migrarParaSupabase e clique em ▶ Executar. O resumo aparece no Registro de execução.
//
// Pode rodar quantas vezes quiser até a virada: alunos são atualizados (não duplicam) e
// lançamentos, escudos, editais e pedidos são apagados no Supabase e copiados de novo.
// ATENÇÃO: o que for lançado no modo de teste (?backend=supabase) some a cada nova cópia.

function migrarParaSupabase() {
  var cfg = sbConfig_();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var inicio = new Date();
  var r = { alunos: 0, novasContas: 0, senhasAntigas: 0, liberados: 0, escudos: 0, lancamentos: 0,
            lancIgnorados: 0, motivos: {}, editais: 0, pedidos: 0, espera: 0, metricas: 0 };
  function ignorar(motivo) { r.lancIgnorados++; r.motivos[motivo] = (r.motivos[motivo] || 0) + 1; }

  // 1. Contas que já existem no Supabase Auth (rodar de novo não duplica)
  var contas = {};
  for (var pg = 1; pg <= 40; pg++) {
    var lista = (sbReq_(cfg, "get", "/auth/v1/admin/users?page=" + pg + "&per_page=500") || {}).users || [];
    lista.forEach(function(u) { contas[String(u.email || "").toLowerCase()] = u; });
    if (lista.length < 500) break;
  }

  // 2. Alunos (aba Usuarios)
  var users = ss.getSheetByName("Usuarios").getDataRange().getValues();
  var adm = emailAdmin();
  var idPorEmail = {}, nicks = {}, perfis = [], legados = [], liberados = [], escudos = [];
  for (var i = 1; i < users.length; i++) {
    var u = users[i];
    var email = String(u[COL.EMAIL] || "").trim().toLowerCase();
    if (!email || idPorEmail[email] || liberados.some(function(l) { return l.email === email; })) continue;
    var senha = String(u[COL.SENHA] || "");
    var expira = sbIso_(u[COL.EXPIRA]);
    var origem = String(u[COL.ORIGEM] || "");

    if (!senha) { // liberado pelo admin, ainda sem conta
      liberados.push({ email: email, expira_em: expira, origem: origem });
      continue;
    }

    var conta = contas[email];
    if (!conta) {
      conta = sbReq_(cfg, "post", "/auth/v1/admin/users", {
        email: email, password: Utilities.getUuid() + "Aa1!", email_confirm: true,
        app_metadata: { importado: "true" }
      });
      r.novasContas++;
    }
    idPorEmail[email] = conta.id;

    var nick = limparNick(u[COL.NICK]);
    if (nick.length < 3) nick = "Aluno_" + Math.floor(1000 + Math.random() * 9000);
    var base = nick, suf = 2;
    while (nicks[nick.toLowerCase()]) { nick = base.substring(0, 17) + "_" + suf; suf++; }
    nicks[nick.toLowerCase()] = true;

    var ciclo = [];
    try { var c = JSON.parse(String(u[7] || "[]")); if (Array.isArray(c)) ciclo = c; } catch (e1) {}
    var progresso = {};
    try { var p = JSON.parse(montarProgresso(u)); if (p && typeof p === "object" && !Array.isArray(p)) progresso = p; } catch (e2) {}
    var avatar = String(u[COL.AVATAR] || "");
    if (!avatar || !avatarValido(avatar)) avatar = null;

    perfis.push({
      id: conta.id, email: email, nickname: nick, avatar: avatar, expira_em: expira, origem: origem,
      ciclo: ciclo, edital_ativo: String(u[8] || "").replace(/[\u0000-\u001F\u007F]+/g, " ").substring(0, 300),
      progresso_edital: progresso, is_admin: email === adm,
      cadastro_em: sbIso_(u[COL.CADASTRO_EM]) || new Date().toISOString(),
      ultimo_acesso: sbDia_(u[COL.ULTIMO_ACESSO])
    });

    // Senha antiga: só para quem ainda não entrou pelo Supabase
    if (!conta.last_sign_in_at) {
      legados.push({ user_id: conta.id, hash: senha.indexOf("h1$") === 0 ? senha : gerarHashSenha(senha), tentativas: 0, bloqueado_ate: null });
    }

    // Escudos: cada compra vira uma linha; os usados ocupam as compras mais antigas, em ordem
    var esc = lerEscudos(u[COL.ESCUDOS]);
    var compras = esc.compras.slice().sort();
    var usados = esc.usados.map(isoDeBR).filter(String).sort();
    for (var k = 0; k < compras.length; k++) {
      escudos.push({ user_id: conta.id, comprado_em: compras[k], usado_em: usados[k] || null });
    }
  }
  r.alunos = perfis.length;
  r.liberados = liberados.length;
  r.senhasAntigas = legados.length;

  sbLotes_(cfg, "/rest/v1/perfis?on_conflict=id", perfis, 100, "merge");
  sbLotes_(cfg, "/rest/v1/legado_senhas?on_conflict=user_id", legados, 500, "merge");
  sbLotes_(cfg, "/rest/v1/acessos_liberados?on_conflict=email", liberados, 500, "merge");
  sbReq_(cfg, "delete", "/rest/v1/escudos?id=gt.0");
  sbLotes_(cfg, "/rest/v1/escudos", escudos, 500);
  r.escudos = escudos.length;

  // 3. Lançamentos (aba Base_Dashboard)
  sbReq_(cfg, "delete", "/rest/v1/lancamentos?id=gt.0");
  var sheetB = ss.getSheetByName("Base_Dashboard");
  var ultB = sheetB.getLastRow();
  var lancs = [];
  if (ultB >= 2) {
    var vals = sheetB.getRange(2, 1, ultB - 1, 13).getValues();
    var datas = sheetB.getRange(2, 2, ultB - 1, 1).getDisplayValues();
    for (var j = 0; j < vals.length; j++) {
      var v = vals[j];
      var em = String(v[12] || "").trim().toLowerCase();
      if (!em) continue;
      var uid = idPorEmail[em];
      if (!uid) { ignorar("aluno sem conta"); continue; }
      var dia = isoDeBR(String(datas[j][0]).trim());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dia) || dia < "2020-01-01") { ignorar("data inválida"); continue; }
      var q = Math.floor(numeroSeguro(v[6])), a = Math.floor(numeroSeguro(v[7])), t = Math.round(numeroSeguro(v[5]));
      if (q > 1000) { ignorar("mais de 1000 questões"); continue; }
      if (t > 960) { ignorar("mais de 16h"); continue; }
      if (a > q) a = q;
      var mat = limparTexto(v[2], 120), top = limparTexto(v[3], 200);
      if (!mat || !top) { ignorar("sem matéria/tópico"); continue; }
      var fase = parseInt(v[8], 10);
      lancs.push({
        user_id: uid, criado_em: sbIso_(v[0]) || new Date().toISOString(), data_estudo: dia,
        materia: mat, topico: top, link: limparTexto(v[4], 300), tempo_min: t, questoes: q, acertos: a,
        fase: (fase >= 1 && fase <= 4) ? fase : 1, metodologia: limparTexto(v[9], 80)
      });
    }
  }
  sbLotes_(cfg, "/rest/v1/lancamentos", lancs, 1000);
  r.lancamentos = lancs.length;

  // 4. Catálogo de editais (aba Base_Editais)
  sbReq_(cfg, "delete", "/rest/v1/editais_base?id=gt.0");
  var editais = [];
  var sheetE = ss.getSheetByName("Base_Editais");
  if (sheetE && sheetE.getLastRow() >= 2) {
    sheetE.getRange(2, 1, sheetE.getLastRow() - 1, 6).getValues().forEach(function(e) {
      var conc = String(e[0] || "").trim();
      if (!conc) return;
      editais.push({ concurso: conc, banca: String(e[1] || "").trim(), bloco: String(e[2] || "").trim(),
                     materia: String(e[3] || "").trim(), topico: String(e[4] || "").trim(), link_master: String(e[5] || "").trim() });
    });
  }
  sbLotes_(cfg, "/rest/v1/editais_base", editais, 1000);
  r.editais = editais.length;

  // 5. Pedidos de edital
  sbReq_(cfg, "delete", "/rest/v1/pedidos_editais?id=gt.0");
  var pedidos = [];
  var sheetP = ss.getSheetByName("Pedidos_Editais");
  if (sheetP && sheetP.getLastRow() >= 2) {
    sheetP.getRange(2, 1, sheetP.getLastRow() - 1, 5).getValues().forEach(function(pd) {
      var uidP = idPorEmail[String(pd[1] || "").trim().toLowerCase()];
      var conc = limparTexto(pd[2], 200);
      if (!uidP || conc.length < 3) return;
      var st = String(pd[3] || "").trim();
      if (STATUS_PEDIDO.indexOf(st) === -1) st = "Pendente";
      pedidos.push({ user_id: uidP, concurso: conc, status: st,
                     criado_em: sbIso_(pd[0]) || new Date().toISOString(),
                     respondido_em: st === "Pendente" ? null : sbIso_(pd[4]) });
    });
  }
  sbLotes_(cfg, "/rest/v1/pedidos_editais", pedidos, 500);
  r.pedidos = pedidos.length;

  // 6. Lista de espera e histórico de métricas
  var espera = [];
  var sheetW = ss.getSheetByName("Lista_Espera");
  if (sheetW && sheetW.getLastRow() >= 1) {
    sheetW.getRange(1, 1, sheetW.getLastRow(), 2).getValues().forEach(function(w) {
      var ew = String(w[1] || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ew) || espera.some(function(x) { return x.email === ew; })) return;
      espera.push({ email: ew, criado_em: sbIso_(w[0]) || new Date().toISOString() });
    });
  }
  sbLotes_(cfg, "/rest/v1/lista_espera?on_conflict=email", espera, 500, "merge");
  r.espera = espera.length;

  var metricas = [];
  var sheetM = ss.getSheetByName("Metricas");
  if (sheetM && sheetM.getLastRow() >= 2) {
    sheetM.getRange(2, 1, sheetM.getLastRow() - 1, 10).getValues().forEach(function(m) {
      var d = sbDia_(m[0]);
      if (!d) return;
      metricas.push({ data: d, total_usuarios: +m[1] || 0, novos_cadastros: +m[2] || 0, acessaram_hoje: +m[3] || 0,
                      ativos_7d: +m[4] || 0, estudaram_hoje: +m[5] || 0, estudaram_7d: +m[6] || 0,
                      lancamentos_hoje: +m[7] || 0, questoes_hoje: +m[8] || 0, vagas_fundador: +m[9] || 0 });
    });
  }
  sbLotes_(cfg, "/rest/v1/metricas_diarias?on_conflict=data", metricas, 500, "merge");
  r.metricas = metricas.length;

  r.segundos = Math.round((new Date() - inicio) / 1000);
  Logger.log("Cópia para o Supabase concluída:\n" + JSON.stringify(r, null, 2));
  return r;
}

function sbConfig_() {
  var p = PropertiesService.getScriptProperties();
  var url = String(p.getProperty("SUPABASE_URL") || "").trim().replace(/\/+$/, "");
  var key = String(p.getProperty("SUPABASE_SECRET") || "").trim();
  if (!url || !key) throw new Error("Preencha SUPABASE_URL e SUPABASE_SECRET nas Propriedades do script.");
  return { url: url, key: key };
}

function sbReq_(cfg, metodo, caminho, corpo, prefer) {
  var headers = { apikey: cfg.key };
  if (cfg.key.indexOf("eyJ") === 0) headers.Authorization = "Bearer " + cfg.key; // chave service_role antiga (JWT)
  if (prefer) headers.Prefer = prefer;
  var op = { method: metodo, headers: headers, muteHttpExceptions: true };
  if (typeof corpo !== "undefined") { op.contentType = "application/json"; op.payload = JSON.stringify(corpo); }
  var resp = UrlFetchApp.fetch(cfg.url + caminho, op);
  var cod = resp.getResponseCode(), txt = resp.getContentText();
  if (cod >= 300) throw new Error(metodo.toUpperCase() + " " + caminho.split("?")[0] + " → " + cod + ": " + txt.substring(0, 500));
  try { return txt ? JSON.parse(txt) : null; } catch (e) { return null; }
}

// Envia em lotes; modo "merge" = atualiza quem já existe (upsert)
function sbLotes_(cfg, caminho, linhas, tamanho, modo) {
  var prefer = "return=minimal" + (modo === "merge" ? ",resolution=merge-duplicates" : "");
  for (var i = 0; i < linhas.length; i += tamanho) {
    sbReq_(cfg, "post", caminho, linhas.slice(i, i + tamanho), prefer);
  }
}

function sbIso_(v) {
  return (v instanceof Date && !isNaN(v.getTime())) ? v.toISOString() : null;
}

function sbDia_(v) {
  return (v instanceof Date && !isNaN(v.getTime())) ? Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd") : null;
}
