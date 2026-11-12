// ===== AUTENTICAÇÃO / REGRAS DE ACESSO =====
var ADMIN_EMAIL = "valefvs92@gmail.com"; // troque pelo seu e-mail
var LIMITE_FUNDADORES = 100;
var ANOS_FUNDADOR = 5;
var SESSAO_DIAS = 30;
var COL = { EMAIL: 0, SENHA: 1, EXPIRA: 2, NICK: 3, CODIGO: 10, AVATAR: 11, TOKEN: 12, TOKEN_EXP: 13, CODIGO_EXP: 14, TENTATIVAS: 15, ORIGEM: 16, CADASTRO_EM: 23, ULTIMO_ACESSO: 24 };

function respJSON(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function hashSenha(senha, salt) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ":" + senha, Utilities.Charset.UTF_8);
  return bytes.map(function(b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? "0" + v : v;
  }).join("");
}

function gerarHashSenha(senha) {
  var salt = Utilities.getUuid().replace(/-/g, "").substring(0, 16);
  return "h1$" + salt + "$" + hashSenha(String(senha), salt);
}

function conferirSenha(armazenada, informada) {
  armazenada = String(armazenada || "");
  informada = String(informada || "");
  if (armazenada.indexOf("h1$") === 0) {
    var p = armazenada.split("$");
    return p.length === 3 && hashSenha(informada, p[1]) === p[2];
  }
  return armazenada !== "" && armazenada === informada; // senha antiga (texto puro): migra no login
}

function gerarToken() {
  return Utilities.getUuid() + Utilities.getUuid().replace(/-/g, "");
}

function emitirSessao(sheetU, linhaIdx) {
  var token = gerarToken();
  var exp = new Date();
  exp.setDate(exp.getDate() + SESSAO_DIAS);
  sheetU.getRange(linhaIdx + 1, COL.TOKEN + 1).setValue(token);
  sheetU.getRange(linhaIdx + 1, COL.TOKEN_EXP + 1).setValue(exp);
  return token;
}

// Retorna o índice da linha do usuário, -1 (sessão inválida) ou -2 (assinatura expirada)
function validarSessao(users, email, token) {
  if (!email || !token) return -1;
  var emailL = String(email).trim().toLowerCase();
  for (var i = 1; i < users.length; i++) {
    if (users[i][COL.EMAIL] && users[i][COL.EMAIL].toString().toLowerCase() === emailL) {
      var tk = users[i][COL.TOKEN] ? users[i][COL.TOKEN].toString() : "";
      if (tk === "" || tk !== String(token)) return -1;
      var tkExp = users[i][COL.TOKEN_EXP];
      if (!tkExp || isNaN(new Date(tkExp).getTime()) || new Date() > new Date(tkExp)) return -1;
      var dataExp = users[i][COL.EXPIRA];
      if (dataExp && dataExp !== "" && !isNaN(new Date(dataExp).getTime()) && new Date() > new Date(dataExp)) return -2;
      return i;
    }
  }
  return -1;
}
// ===== SANITIZAÇÃO E VALIDAÇÃO DE DADOS =====
var LIMITE_Q_POR_LANCAMENTO = 1000;
var LIMITE_MIN_POR_LANCAMENTO = 960; // 16h em minutos
var LIMITE_IMPORTACAO = 2000;
var ANO_MINIMO_LANCAMENTO = 2020;
var LIMITE_Q_POR_DIA = 1500;
var LIMITE_MIN_POR_DIA = 1080; // 18h
var LIMITE_LANC_POR_DIA = 50;
var PROG_CHUNK = 45000;      // caracteres por célula (limite do Sheets: 50.000)
var PROG_COLS_EXTRA = 6;     // colunas de overflow para o progresso do edital
var PROG_EXTRA_INI = 17;     // índice (base 0) da coluna R

function numeroSeguro(v) {
  var n = parseFloat(String(v === null || typeof v === "undefined" ? "" : v).replace(",", "."));
  return (isFinite(n) && n > 0) ? n : 0;
}

// Texto livre (matéria, tópico...): remove controle, < >, e caracteres que o Sheets leria como fórmula
function limparTexto(v, max) {
  var t = String(v === null || typeof v === "undefined" ? "" : v);
  t = t.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/[<>]/g, "").trim().replace(/^[=+\-@\s]+/, "").trim();
  return t.substring(0, max);
}

// Codinome: o único texto de um aluno que aparece para os outros, então o filtro é rígido
function limparNick(v) {
  var t = String(v === null || typeof v === "undefined" ? "" : v);
  t = t.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/[<>"'`&\\\/=]/g, "").replace(/\s+/g, " ").trim().replace(/^[+\-@]+/, "").trim();
  return t.substring(0, 20);
}

function avatarValido(v) {
  var s = String(v === null || typeof v === "undefined" ? "" : v);
  if (s === "") return true; // permite remover a foto
  return s.length <= 40000 && /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+\/=]+$/.test(s);
}

function chaveLancamento(data, mat, top, t, q, a) {
  return [data, mat, top, t, q, a].map(function(x) { return String(x).trim().toLowerCase(); }).join("|");
}

function validarLancamento(d) {
  var q = Math.floor(numeroSeguro(d.questoes));
  var a = Math.floor(numeroSeguro(d.acertos));
  var t = Math.round(numeroSeguro(d.tempo));
  if (q > LIMITE_Q_POR_LANCAMENTO) return { ok: false, mensagem: "Máximo de " + LIMITE_Q_POR_LANCAMENTO + " questões por lançamento." };
  if (a > q) return { ok: false, mensagem: "Os acertos não podem ser maiores que as questões." };
  if (t > LIMITE_MIN_POR_LANCAMENTO) return { ok: false, mensagem: "Tempo máximo de 16h por lançamento." };

  var partes = String(d.dataEstudo || "").trim().split("/");
  if (partes.length !== 3) return { ok: false, mensagem: "Data inválida." };
  var dia = parseInt(partes[0], 10), mes = parseInt(partes[1], 10), ano = parseInt(partes[2], 10);
  var dt = new Date(ano, mes - 1, dia);
  if (isNaN(dt.getTime()) || dt.getDate() !== dia || dt.getMonth() !== mes - 1 || dt.getFullYear() !== ano) return { ok: false, mensagem: "Data inválida." };
  var limiteFuturo = new Date();
  limiteFuturo.setDate(limiteFuturo.getDate() + 2); // folga de fuso
  if (dt > limiteFuturo || ano < ANO_MINIMO_LANCAMENTO) return { ok: false, mensagem: "Data fora do período permitido." };

  var mat = limparTexto(d.materia, 120);
  var top = limparTexto(d.topico, 200);
  if (!mat || !top) return { ok: false, mensagem: "Matéria e tópico são obrigatórios." };

  var faseNum = parseInt(d.fase, 10);
  if (!(faseNum >= 1 && faseNum <= 4)) faseNum = 1;

  return {
    ok: true,
    data: ("0" + dia).slice(-2) + "/" + ("0" + mes).slice(-2) + "/" + ano,
    mat: mat, top: top,
    tipoLink: limparTexto(d.tipoLink, 300),
    met: limparTexto(d.metodologia, 80),
    fase: String(faseNum), q: q, a: a, t: t
  };
}

// Colunas K e L: mesma regra do painel (fase 4 com aproveitamento >= 85% = consolidado)
var PCT_CONSOLIDACAO = 0.85;
function marcasConsolidacao(fase, q, a) {
  var consolidado = String(fase) === "4" && q > 0 && (a / q) >= PCT_CONSOLIDACAO;
  return consolidado ? ["OK", "CONSOLIDADO"] : ["", ""];
}

// Soma o que o aluno já registrou em cada data de estudo (lê só as colunas necessárias).
// linhaIgnorada: linha da planilha a desconsiderar (usado na retificação).
function somasDoUsuario(sheetB, email, linhaIgnorada) {
  var mapa = {};
  var ultima = sheetB.getLastRow();
  if (ultima < 2) return mapa;
  var n = ultima - 1;
  var datas = sheetB.getRange(2, 2, n, 1).getDisplayValues();
  var tempoEQuestoes = sheetB.getRange(2, 6, n, 2).getValues(); // F = tempo, G = questões
  var emails = sheetB.getRange(2, 13, n, 1).getValues();        // M = e-mail
  for (var i = 0; i < n; i++) {
    if (linhaIgnorada && (i + 2) === linhaIgnorada) continue;
    if (!emails[i][0] || emails[i][0].toString().toLowerCase() !== email) continue;
    var chave = String(datas[i][0]).trim();
    if (!mapa[chave]) mapa[chave] = { q: 0, t: 0, n: 0 };
    mapa[chave].t += parseFloat(tempoEQuestoes[i][0]) || 0;
    mapa[chave].q += parseFloat(tempoEQuestoes[i][1]) || 0;
    mapa[chave].n += 1;
  }
  return mapa;
}

// Retorna "" se o novo lançamento cabe no dia, ou a mensagem de recusa
function verificarTetoDia(somaAtual, q, t) {
  var s = somaAtual || { q: 0, t: 0, n: 0 };
  if (s.n + 1 > LIMITE_LANC_POR_DIA) return "Teto diário: máximo de " + LIMITE_LANC_POR_DIA + " lançamentos por dia de estudo.";
  if (s.q + q > LIMITE_Q_POR_DIA) return "Teto diário: máximo de " + LIMITE_Q_POR_DIA + " questões por dia de estudo (já registradas nesta data: " + s.q + ").";
  if (s.t + t > LIMITE_MIN_POR_DIA) return "Teto diário: máximo de " + (LIMITE_MIN_POR_DIA / 60) + "h por dia de estudo (já registrados nesta data: " + Math.round(s.t) + " min).";
  return "";
}
// Executa a gravação com trava para evitar perda de atualização em acessos simultâneos
// Junta o progresso do edital (coluna J + colunas de overflow R..W)
function montarProgresso(linha) {
  var s = linha[9] ? linha[9].toString() : "";
  if (s === "") return "{}";
  for (var k = 0; k < PROG_COLS_EXTRA; k++) {
    var c = linha[PROG_EXTRA_INI + k];
    if (!c) break;
    s += c.toString().substring(1); // remove o marcador "~" que protege contra fórmulas
  }
  return s;
}
// Recuperação de senha: a mesma lógica atende GET (transição) e POST
function acaoSolicitarCodigo(emailBruto) {
  var sheetU = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Usuarios");
  var emailReq = String(emailBruto || "").trim().toLowerCase();
  if (!emailReq) return respJSON({"status": "erro", "mensagem": "Informe o e-mail."});

  var cacheCod = CacheService.getScriptCache();
  if (cacheCod.get("cod_" + emailReq)) return respJSON({"status": "erro", "mensagem": "Aguarde 1 minuto para solicitar um novo código."});
  cacheCod.put("cod_" + emailReq, "1", 60);

  var users = sheetU.getDataRange().getValues();
  for (var i = 1; i < users.length; i++) {
    if (users[i][COL.EMAIL] && users[i][COL.EMAIL].toString().toLowerCase() === emailReq) {
      var code = (parseInt(Utilities.getUuid().replace(/-/g, "").substring(0, 8), 16) % 900000 + 100000).toString();
      var expCod = new Date(new Date().getTime() + 15 * 60 * 1000);
      sheetU.getRange(i + 1, COL.CODIGO + 1).setValue(code);
      sheetU.getRange(i + 1, COL.CODIGO_EXP + 1).setValue(expCod);
      sheetU.getRange(i + 1, COL.TENTATIVAS + 1).setValue(0);
      SpreadsheetApp.flush(); // TRAVA DE SEGURANÇA
      try {
        MailApp.sendEmail(emailReq, "Código de Segurança - Protocolo Controle", "Comandante,\n\nSeu código tático de autorização para redefinir a senha é: " + code + "\n\nEle vale por 15 minutos. Se não foi você que solicitou, ignore esta mensagem.");
      } catch (errMail) {
        return respJSON({"status": "erro", "mensagem": "Erro de permissão no Google. O Administrador precisa autorizar o script para enviar e-mails."});
      }
      break;
    }
  }
  // Resposta igual exista o e-mail ou não (evita descobrir quem é aluno)
  return respJSON({"status": "sucesso"});
}

function acaoTrocarSenha(emailBruto, codigoBruto, novaSenhaBruta) {
  var emailReq = String(emailBruto || "").trim().toLowerCase();
  var codeReq = String(codigoBruto || "").trim();
  var newPass = String(novaSenhaBruta || "");
  if (newPass.length < 6) return respJSON({"status": "erro", "mensagem": "A nova senha precisa ter ao menos 6 caracteres."});

  return comTrava(function() {
    var sheetU = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Usuarios");
    var users = sheetU.getDataRange().getValues();
    for (var i = 1; i < users.length; i++) {
      if (users[i][COL.EMAIL] && users[i][COL.EMAIL].toString().toLowerCase() === emailReq) {
        var savedCode = users[i][COL.CODIGO] ? users[i][COL.CODIGO].toString() : "";
        var expCodigo = users[i][COL.CODIGO_EXP];
        var tentativas = parseInt(users[i][COL.TENTATIVAS], 10) || 0;
        var codigoValido = savedCode !== "" && expCodigo && !isNaN(new Date(expCodigo).getTime()) && new Date() <= new Date(expCodigo) && tentativas < 5;

        if (!codigoValido) {
          sheetU.getRange(i + 1, COL.CODIGO + 1).setValue("");
          SpreadsheetApp.flush(); // TRAVA DE SEGURANÇA
          return respJSON({"status": "erro", "mensagem": "Código inválido ou expirado. Solicite um novo."});
        }
        if (savedCode !== codeReq) {
          sheetU.getRange(i + 1, COL.TENTATIVAS + 1).setValue(tentativas + 1);
          SpreadsheetApp.flush(); // TRAVA DE SEGURANÇA
          return respJSON({"status": "erro", "mensagem": "Código inválido ou expirado. Solicite um novo."});
        }

        sheetU.getRange(i + 1, COL.SENHA + 1).setValue(gerarHashSenha(newPass));
        sheetU.getRange(i + 1, COL.CODIGO + 1).setValue("");
        sheetU.getRange(i + 1, COL.CODIGO_EXP + 1).setValue("");
        sheetU.getRange(i + 1, COL.TENTATIVAS + 1).setValue(0);
        sheetU.getRange(i + 1, COL.TOKEN + 1).setValue("");     // derruba sessões abertas
        sheetU.getRange(i + 1, COL.TOKEN_EXP + 1).setValue("");
        SpreadsheetApp.flush(); // TRAVA DE SEGURANÇA
        return respJSON({"status": "sucesso"});
      }
    }
    return respJSON({"status": "erro", "mensagem": "Código inválido ou expirado. Solicite um novo."});
  });
}

// ===== VAGAS DE FUNDADOR E MÉTRICAS =====
function acaoVagas() {
  var cache = CacheService.getScriptCache();
  var emCache = cache.get("vagas_restantes");
  if (emCache !== null) {
    return respJSON({"status": "sucesso", "restantes": parseInt(emCache, 10), "limite": LIMITE_FUNDADORES, "anos": ANOS_FUNDADOR});
  }
  var sheetU = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Usuarios");
  var users = sheetU.getDataRange().getValues();
  var total = 0;
  for (var i = 1; i < users.length; i++) {
    if (users[i][COL.EMAIL]) total++;
  }
  var restantes = Math.max(0, LIMITE_FUNDADORES - total);
  cache.put("vagas_restantes", String(restantes), 300);
  return respJSON({"status": "sucesso", "restantes": restantes, "limite": LIMITE_FUNDADORES, "anos": ANOS_FUNDADOR});
}

function garantirColunasMetricas(sheetU) {
  var necessarias = COL.ULTIMO_ACESSO + 1;
  if (sheetU.getMaxColumns() < necessarias) {
    sheetU.insertColumnsAfter(sheetU.getMaxColumns(), necessarias - sheetU.getMaxColumns());
  }
  if (!sheetU.getRange(1, COL.CADASTRO_EM + 1).getValue()) sheetU.getRange(1, COL.CADASTRO_EM + 1).setValue("Cadastro_Em");
  if (!sheetU.getRange(1, COL.ULTIMO_ACESSO + 1).getValue()) sheetU.getRange(1, COL.ULTIMO_ACESSO + 1).setValue("Ultimo_Acesso");
}

// linha: número da linha na planilha (base 1)
function registrarCadastroEm(sheetU, linha) {
  try {
    garantirColunasMetricas(sheetU);
    sheetU.getRange(linha, COL.CADASTRO_EM + 1).setValue(new Date());
  } catch (err) {
    Logger.log("Falha ao registrar data de cadastro: " + err.message);
  }
}

// Grava o último acesso no máximo uma vez por dia por aluno (nunca derruba a sincronização)
function registrarAcessoDiario(sheetU, linhaIdx, linhaDados) {
  try {
    var tz = Session.getScriptTimeZone();
    var hoje = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
    var atual = linhaDados[COL.ULTIMO_ACESSO];
    var atualStr = (atual instanceof Date && !isNaN(atual.getTime())) ? Utilities.formatDate(atual, tz, "yyyy-MM-dd") : "";
    if (atualStr === hoje) return;
    garantirColunasMetricas(sheetU);
    sheetU.getRange(linhaIdx + 1, COL.ULTIMO_ACESSO + 1).setValue(new Date());
  } catch (err) {
    Logger.log("Falha ao registrar acesso diário: " + err.message);
  }
}

// Roda todo dia por gatilho: grava (ou atualiza) a linha de hoje na aba Metricas
function registrarMetricasDiarias() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tz = Session.getScriptTimeZone();
  var agora = new Date();
  var diaStr = Utilities.formatDate(agora, tz, "yyyy-MM-dd");
  var limite7 = Utilities.formatDate(new Date(agora.getTime() - 6 * 86400000), tz, "yyyy-MM-dd");

  function diaDe(v) {
    return (v instanceof Date && !isNaN(v.getTime())) ? Utilities.formatDate(v, tz, "yyyy-MM-dd") : "";
  }

  var users = ss.getSheetByName("Usuarios").getDataRange().getValues();
  var total = 0, novos = 0, acessaramHoje = 0, ativos7 = 0;
  for (var i = 1; i < users.length; i++) {
    if (!users[i][COL.EMAIL]) continue;
    total++;
    if (diaDe(users[i][COL.CADASTRO_EM]) === diaStr) novos++;
    var ac = diaDe(users[i][COL.ULTIMO_ACESSO]);
    if (ac === diaStr) acessaramHoje++;
    if (ac !== "" && ac >= limite7) ativos7++;
  }

  var estudaramHoje = {}, estudaram7 = {};
  var lancHoje = 0, questoesHoje = 0;
  var sheetB = ss.getSheetByName("Base_Dashboard");
  var ultimaB = sheetB ? sheetB.getLastRow() : 0;
  if (ultimaB >= 2) {
    var n = ultimaB - 1;
    var carimbos = sheetB.getRange(2, 1, n, 1).getValues();
    var questoes = sheetB.getRange(2, 7, n, 1).getValues();
    var emails = sheetB.getRange(2, 13, n, 1).getValues();
    for (var j = 0; j < n; j++) {
      var d = diaDe(carimbos[j][0]);
      if (d === "" || d < limite7) continue;
      var em = emails[j][0] ? emails[j][0].toString().toLowerCase() : "";
      if (!em) continue;
      estudaram7[em] = true;
      if (d === diaStr) {
        lancHoje++;
        questoesHoje += parseFloat(questoes[j][0]) || 0;
        estudaramHoje[em] = true;
      }
    }
  }

  var linha = [
    new Date(agora.getFullYear(), agora.getMonth(), agora.getDate()),
    total, novos, acessaramHoje, ativos7,
    Object.keys(estudaramHoje).length, Object.keys(estudaram7).length,
    lancHoje, questoesHoje, Math.max(0, LIMITE_FUNDADORES - total)
  ];

  var aba = ss.getSheetByName("Metricas");
  if (!aba) {
    aba = ss.insertSheet("Metricas");
    aba.appendRow(["Data", "Total_Usuarios", "Novos_Cadastros", "Acessaram_Hoje", "Ativos_7d", "Estudaram_Hoje", "Estudaram_7d", "Lancamentos_Hoje", "Questoes_Hoje", "Vagas_Fundador_Restantes"]);
  }
  var ultimaLinha = aba.getLastRow();
  var ultimaData = ultimaLinha >= 2 ? aba.getRange(ultimaLinha, 1).getValue() : "";
  var alvo = (diaDe(ultimaData) === diaStr) ? ultimaLinha : ultimaLinha + 1; // reexecução no mesmo dia atualiza a linha
  aba.getRange(alvo, 1, 1, linha.length).setValues([linha]);
  aba.getRange(alvo, 1).setNumberFormat("dd/MM/yyyy");
  SpreadsheetApp.flush();
  Logger.log("Métricas de " + diaStr + ": " + JSON.stringify(linha));
}

// Rode UMA vez pelo editor (▶) para agendar a coleta diária (~23h)
function instalarGatilhoMetricas() {
  var existentes = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existentes.length; i++) {
    if (existentes[i].getHandlerFunction() === "registrarMetricasDiarias") ScriptApp.deleteTrigger(existentes[i]);
  }
  ScriptApp.newTrigger("registrarMetricasDiarias").timeBased().everyDays(1).atHour(23).create();
  Logger.log("Gatilho diário criado: registrarMetricasDiarias (~23h, no fuso do projeto).");
}

function comTrava(fn) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (errLock) {
    return respJSON({"status": "erro", "mensagem": "Servidor ocupado. Tente novamente em instantes."});
  }
  try { return fn(); } finally { lock.releaseLock(); }
}
function doPost(e) {
  try {
    // Blindagem: Garante que a requisição tem um corpo de dados antes de tentar ler
    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput(JSON.stringify({"status": "erro", "mensagem": "Carga de dados vazia."})).setMimeType(ContentService.MimeType.JSON);
    }
    
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var dados = JSON.parse(e.postData.contents);
    var acao = dados.acao;
    var sheetU = ss.getSheetByName("Usuarios");

    // PORTÃO: toda ação exige sessão válida, exceto login e cadastro
    var acoesPublicas = ["login", "cadastro", "ping", "solicitar_codigo", "trocarSenhaSegura"];
    if (acoesPublicas.indexOf(acao) === -1) {
      var linhaAuth = validarSessao(sheetU.getDataRange().getValues(), dados.email, dados.token);
      if (linhaAuth === -1) return respJSON({"status": "erro", "sessao": false, "mensagem": "Sessão inválida. Faça login novamente."});
      if (linhaAuth === -2) return respJSON({"status": "erro", "mensagem": "Sua assinatura expirou."});
    }
    if (acao === "ping") return respJSON({"status": "sucesso"});
    if (acao === "solicitar_codigo") return acaoSolicitarCodigo(dados.email);
    if (acao === "trocarSenhaSegura") return acaoTrocarSenha(dados.email, dados.codigo, dados.novaSenha);

    if (acao === "login") {
      var emailLog = String(dados.email || "").trim().toLowerCase();
      var senhaLog = String(dados.senha || "");
      var cacheLog = CacheService.getScriptCache();
      var chaveTent = "tent_" + emailLog;
      var tentativasLog = parseInt(cacheLog.get(chaveTent) || "0", 10);
      if (tentativasLog >= 5) return respJSON({"status": "erro", "mensagem": "Muitas tentativas. Aguarde 15 minutos e tente novamente."});

      var usersLog = sheetU.getDataRange().getValues();
      for (var iL = 1; iL < usersLog.length; iL++) {
        if (usersLog[iL][COL.EMAIL] && usersLog[iL][COL.EMAIL].toString().toLowerCase() === emailLog) {
          if (!conferirSenha(usersLog[iL][COL.SENHA], senhaLog)) break;
          var dataExpLog = usersLog[iL][COL.EXPIRA];
          if (dataExpLog && dataExpLog !== "" && !isNaN(new Date(dataExpLog).getTime()) && new Date() > new Date(dataExpLog)) {
            return respJSON({"status": "erro", "mensagem": "Sua assinatura expirou."});
          }
          if (String(usersLog[iL][COL.SENHA]).indexOf("h1$") !== 0) {
            sheetU.getRange(iL + 1, COL.SENHA + 1).setValue(gerarHashSenha(senhaLog)); // migra senha antiga para hash
          }
          var tokenNovo = emitirSessao(sheetU, iL);
          cacheLog.remove(chaveTent);
          SpreadsheetApp.flush(); // TRAVA DE SEGURANÇA
          return respJSON({"status": "sucesso", "token": tokenNovo});
        }
      }
      cacheLog.put(chaveTent, String(tentativasLog + 1), 900);
      return respJSON({"status": "erro", "mensagem": "Credenciais inválidas."});
    }

    if (acao === "cadastro") {
      var emailCad = String(dados.email || "").trim().toLowerCase();
      var senhaCad = String(dados.senha || "");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailCad)) return respJSON({"status": "erro", "mensagem": "E-mail inválido."});
      if (senhaCad.length < 6) return respJSON({"status": "erro", "mensagem": "A senha precisa ter ao menos 6 caracteres."});

      var lockCad = LockService.getScriptLock();
      try { lockCad.waitLock(15000); } catch (errLock) {
        return respJSON({"status": "erro", "mensagem": "Servidor ocupado. Tente novamente em instantes."});
      }

      try {
        var usersCad = sheetU.getDataRange().getValues();
        var totalCadastros = 0;
        for (var iC = 1; iC < usersCad.length; iC++) {
          if (!usersCad[iC][COL.EMAIL]) continue;
          totalCadastros++;
          if (usersCad[iC][COL.EMAIL].toString().toLowerCase() === emailCad) {
            // E-mail pré-autorizado (compra / liberação manual): apenas ativa a conta
            var dataExpCad = usersCad[iC][COL.EXPIRA];
            if (dataExpCad && dataExpCad !== "" && !isNaN(new Date(dataExpCad).getTime()) && new Date() > new Date(dataExpCad)) {
              return respJSON({"status": "erro", "mensagem": "Assinatura expirada."});
            }
            if (usersCad[iC][COL.SENHA] && usersCad[iC][COL.SENHA].toString().trim() !== "") {
              return respJSON({"status": "erro", "mensagem": "Conta já ativada!"});
            }
            sheetU.getRange(iC + 1, COL.SENHA + 1).setValue(gerarHashSenha(senhaCad));
            sheetU.getRange(iC + 1, COL.NICK + 1).setValue("Recruta_" + Math.floor(Math.random() * 1000));
            registrarCadastroEm(sheetU, iC + 1);
            SpreadsheetApp.flush(); // TRAVA DE SEGURANÇA
            return respJSON({"status": "sucesso"});
          }
        }

        // E-mail desconhecido: só entra se ainda houver vaga de fundador
        if (totalCadastros >= LIMITE_FUNDADORES) {
          var sheetW = ss.getSheetByName("Lista_Espera");
          if (sheetW) sheetW.appendRow([new Date(), emailCad]);
          SpreadsheetApp.flush(); // TRAVA DE SEGURANÇA
          return respJSON({"status": "erro", "mensagem": "As vagas de fundador foram preenchidas. Você entrou na lista de espera e será avisado quando o acesso abrir."});
        }

        var expFund = new Date();
        expFund.setFullYear(expFund.getFullYear() + ANOS_FUNDADOR);
        var novoNickname = "Recruta_" + Math.floor(Math.random() * 1000);
        sheetU.appendRow([emailCad, gerarHashSenha(senhaCad), expFund, novoNickname, 0, 0, 0, "", "", "{}", "", "", "", "", "", "", "FUNDADOR"]);
        registrarCadastroEm(sheetU, sheetU.getLastRow());
        CacheService.getScriptCache().remove("vagas_restantes");
        SpreadsheetApp.flush(); // TRAVA DE SEGURANÇA
        return respJSON({"status": "sucesso"});
      } finally {
        lockCad.releaseLock();
      }
    }

    if (acao === "salvar_ciclo_nuvem") {
      var cicloStr = String(dados.cicloJson || "");
      if (cicloStr.length > PROG_CHUNK) return respJSON({"status": "erro", "mensagem": "Ciclo grande demais para ser salvo."});
      try {
        if (!Array.isArray(JSON.parse(cicloStr))) throw new Error("formato");
      } catch (errCiclo) {
        return respJSON({"status": "erro", "mensagem": "Ciclo inválido."});
      }

      return comTrava(function() {
        var emailC = String(dados.email).trim().toLowerCase();
        var dataUC = sheetU.getDataRange().getValues();
        for (var i = 1; i < dataUC.length; i++) {
          if (dataUC[i][0] && dataUC[i][0].toString().toLowerCase() === emailC) {
            sheetU.getRange(i + 1, 8).setValue(cicloStr);
            SpreadsheetApp.flush(); // TRAVA DE SEGURANÇA
            return respJSON({"status": "sucesso"});
          }
        }
        return respJSON({"status": "erro", "mensagem": "Usuário não encontrado."});
      });
    }

    if (acao === "salvar_progresso_edital") {
      var progStr = String(dados.progressoJson || "{}");
      var editalStr = String(dados.editalAtivo || "").replace(/[\u0000-\u001F\u007F]+/g, " ").substring(0, 300);
      if (progStr.length > PROG_CHUNK * (1 + PROG_COLS_EXTRA)) {
        return respJSON({"status": "erro", "mensagem": "Progresso grande demais para ser salvo."});
      }
      try {
        var objProg = JSON.parse(progStr);
        if (objProg === null || typeof objProg !== "object" || Array.isArray(objProg)) throw new Error("formato");
      } catch (errProg) {
        return respJSON({"status": "erro", "mensagem": "Progresso inválido."});
      }

      return comTrava(function() {
        var emailPG = String(dados.email).trim().toLowerCase();
        var dataUPG = sheetU.getDataRange().getValues();
        for (var i = 1; i < dataUPG.length; i++) {
          if (dataUPG[i][0] && dataUPG[i][0].toString().toLowerCase() === emailPG) {
            var partes = [];
            for (var p = 0; p < progStr.length; p += PROG_CHUNK) partes.push(progStr.substring(p, p + PROG_CHUNK));

            var extras = [];
            for (var k = 0; k < PROG_COLS_EXTRA; k++) extras.push(partes[k + 1] ? "~" + partes[k + 1] : "");

            var colunasNecessarias = PROG_EXTRA_INI + PROG_COLS_EXTRA;
            if (sheetU.getMaxColumns() < colunasNecessarias) {
              sheetU.insertColumnsAfter(sheetU.getMaxColumns(), colunasNecessarias - sheetU.getMaxColumns());
            }

            sheetU.getRange(i + 1, 9).setValue(editalStr);
            sheetU.getRange(i + 1, 10).setValue(partes[0] || "{}");
            sheetU.getRange(i + 1, PROG_EXTRA_INI + 1, 1, PROG_COLS_EXTRA).setValues([extras]);
            SpreadsheetApp.flush(); // TRAVA DE SEGURANÇA
            return respJSON({"status": "sucesso"});
          }
        }
        return respJSON({"status": "erro", "mensagem": "Usuário não encontrado."});
      });
    }

    if (acao === "solicitar_edital") {
      var sheetP = ss.getSheetByName("Pedidos_Editais");
      if(sheetP) {
        sheetP.appendRow([new Date(), dados.email, dados.concursoStr]);
        SpreadsheetApp.flush(); // TRAVA DE SEGURANÇA
        return ContentService.createTextOutput(JSON.stringify({"status": "sucesso"})).setMimeType(ContentService.MimeType.JSON);
      }
    }

    if (acao === "importar_historico") {
      var lancsImp = dados.lancamentos;
      if (!Array.isArray(lancsImp) || lancsImp.length === 0) return respJSON({"status": "erro", "mensagem": "Nenhum lançamento enviado."});
      if (lancsImp.length > LIMITE_IMPORTACAO) return respJSON({"status": "erro", "mensagem": "Limite de " + LIMITE_IMPORTACAO + " linhas por importação."});

      return comTrava(function() {
        var sheetB = ss.getSheetByName("Base_Dashboard");
        var emailImp = String(dados.email).trim().toLowerCase();

        var existentes = {};
        var dataBImp = sheetB.getDataRange().getDisplayValues();
        for (var x = 1; x < dataBImp.length; x++) {
          if (dataBImp[x][12] && dataBImp[x][12].toString().toLowerCase() === emailImp) {
            existentes[chaveLancamento(dataBImp[x][1], dataBImp[x][2], dataBImp[x][3], dataBImp[x][5], dataBImp[x][6], dataBImp[x][7])] = true;
          }
        }

        var somasImp = somasDoUsuario(sheetB, emailImp);
        var linhasNovas = [];
        var totalQ = 0, totalT = 0, totalA = 0, ignorados = 0, ignoradosTeto = 0;
        for (var n = 0; n < lancsImp.length; n++) {
          var l = lancsImp[n] || {};
          var v = validarLancamento({ dataEstudo: l.data, materia: l.mat, topico: l.top, tipoLink: "", tempo: l.t, questoes: l.q, acertos: l.a, fase: 4, metodologia: l.met });
          if (!v.ok) { ignorados++; continue; }
          var chave = chaveLancamento(v.data, v.mat, v.top, v.t, v.q, v.a);
          if (existentes[chave]) { ignorados++; continue; }

          var somaDia = somasImp[v.data] || { q: 0, t: 0, n: 0 };
          if (verificarTetoDia(somaDia, v.q, v.t) !== "") { ignorados++; ignoradosTeto++; continue; }

          existentes[chave] = true;
          somasImp[v.data] = { q: somaDia.q + v.q, t: somaDia.t + v.t, n: somaDia.n + 1 };
          linhasNovas.push([new Date(), v.data, v.mat, v.top, "", v.t, v.q, v.a, "4", v.met, "OK", "CONSOLIDADO", emailImp]);
          totalQ += v.q; totalT += v.t; totalA += v.a;
        }

        if (linhasNovas.length > 0) {
          sheetB.getRange(sheetB.getLastRow() + 1, 1, linhasNovas.length, 13).setValues(linhasNovas);
          var dataUImp = sheetU.getDataRange().getValues();
          for (var j = 1; j < dataUImp.length; j++) {
            if (dataUImp[j][0].toString().toLowerCase() === emailImp) {
              sheetU.getRange(j + 1, 5).setValue((parseFloat(dataUImp[j][4]) || 0) + totalQ);
              sheetU.getRange(j + 1, 6).setValue((parseFloat(dataUImp[j][5]) || 0) + totalT);
              sheetU.getRange(j + 1, 7).setValue((parseFloat(dataUImp[j][6]) || 0) + totalA);
              break;
            }
          }
        }
        SpreadsheetApp.flush(); // TRAVA DE SEGURANÇA
        return respJSON({"status": "sucesso", "importados": linhasNovas.length, "ignorados": ignorados, "ignoradosTeto": ignoradosTeto});
      });
    }

        if (acao === "updateProfile") {
      var nickLimpo = limparNick(dados.nickname);
      if (nickLimpo.length < 3) return respJSON({"status": "erro", "mensagem": "Codinome inválido (mínimo de 3 caracteres, sem símbolos especiais)."});
      if (typeof dados.avatar !== "undefined" && !avatarValido(dados.avatar)) {
        return respJSON({"status": "erro", "mensagem": "Foto inválida. Use PNG, JPG ou WEBP."});
      }

      return comTrava(function() {
        var emailP = String(dados.email).trim().toLowerCase();
        var dataUP = sheetU.getDataRange().getValues();
        var linhaP = -1;
        var nicksEmUso = {};
        for (var i = 1; i < dataUP.length; i++) {
          if (!dataUP[i][0]) continue;
          if (dataUP[i][0].toString().toLowerCase() === emailP) { linhaP = i; }
          else if (dataUP[i][3]) { nicksEmUso[dataUP[i][3].toString().toLowerCase()] = true; }
        }
        if (linhaP === -1) return respJSON({"status": "erro", "mensagem": "Usuário não encontrado."});

        // O ranking agrupa por codinome: dois alunos com o mesmo nome somariam os totais
        var nickFinal = nickLimpo;
        var sufixo = 2;
        while (nicksEmUso[nickFinal.toLowerCase()]) {
          nickFinal = nickLimpo.substring(0, 17) + "_" + sufixo;
          sufixo++;
        }

        sheetU.getRange(linhaP + 1, 4).setValue(nickFinal);
        if (typeof dados.avatar !== "undefined") {
          sheetU.getRange(linhaP + 1, 12).setValue(dados.avatar);
        }
        SpreadsheetApp.flush(); // TRAVA DE SEGURANÇA
        return respJSON({"status": "sucesso"});
      });
    }

    if (acao === "apagar_historico") {
      // Dentro da trava: nenhuma outra gravação mexe na planilha enquanto as linhas são localizadas e apagadas,
      // então os números de linha não mudam no meio do processo (antes, dois "apagar" simultâneos podiam apagar linhas de outro aluno)
      return comTrava(function() {
        var sheetB = ss.getSheetByName("Base_Dashboard");
        var emailH = String(dados.email || "").trim().toLowerCase();
        if (!emailH) return respJSON({"status": "erro", "mensagem": "E-mail ausente."});

        var apagados = 0;
        var ultimaH = sheetB.getLastRow();
        if (ultimaH >= 2) {
          var emailsH = sheetB.getRange(2, 13, ultimaH - 1, 1).getValues(); // M = e-mail (lê só a coluna necessária)

          // Agrupa linhas consecutivas do aluno em blocos [início, quantidade]
          var blocos = [];
          var inicio = -1;
          for (var r = 0; r < emailsH.length; r++) {
            var ehDoAluno = emailsH[r][0] && emailsH[r][0].toString().trim().toLowerCase() === emailH;
            if (ehDoAluno && inicio === -1) inicio = r;
            if (!ehDoAluno && inicio !== -1) { blocos.push([inicio + 2, r - inicio]); inicio = -1; }
          }
          if (inicio !== -1) blocos.push([inicio + 2, emailsH.length - inicio]);

          // O Sheets não deixa apagar todas as linhas não congeladas: garante uma linha vazia de sobra
          var totalApagar = 0;
          for (var t = 0; t < blocos.length; t++) totalApagar += blocos[t][1];
          if (totalApagar > 0 && sheetB.getMaxRows() - totalApagar <= sheetB.getFrozenRows()) {
            sheetB.insertRowsAfter(sheetB.getMaxRows(), 1);
          }

          // Apaga de baixo para cima: apagar um bloco não desloca os blocos que ainda faltam
          for (var b = blocos.length - 1; b >= 0; b--) {
            sheetB.deleteRows(blocos[b][0], blocos[b][1]);
            apagados += blocos[b][1];
          }
        }

        var dataU = sheetU.getDataRange().getValues();
        for (var j = 1; j < dataU.length; j++) {
          if (dataU[j][0] && dataU[j][0].toString().toLowerCase() === emailH) {
            sheetU.getRange(j + 1, 5, 1, 3).setValues([[0, 0, 0]]);
            break;
          }
        }
        SpreadsheetApp.flush(); // TRAVA DE SEGURANÇA
        return respJSON({"status": "sucesso", "apagados": apagados});
      });
    }

    if (acao === "retificar_ultimo") {
      var vR = validarLancamento(dados);
      if (!vR.ok) return respJSON({"status": "erro", "mensagem": vR.mensagem});

      return comTrava(function() {
        var sheetB = ss.getSheetByName("Base_Dashboard");
        var emailR = String(dados.email).trim().toLowerCase();
        var dataB = sheetB.getDataRange().getValues();
        var lastRowIndex = -1;
        var oldQ = 0, oldT = 0, oldA = 0;

        for (var i = dataB.length - 1; i > 0; i--) {
          if (dataB[i].length > 12 && dataB[i][12] && dataB[i][12].toString().toLowerCase() === emailR) {
            lastRowIndex = i + 1; oldT = parseFloat(dataB[i][5]) || 0; oldQ = parseFloat(dataB[i][6]) || 0; oldA = parseFloat(dataB[i][7]) || 0;
            break;
          }
        }
        if (lastRowIndex === -1) return respJSON({"status": "erro", "mensagem": "Nenhum lançamento encontrado."});

        // Teto do dia desconsiderando a própria linha que está sendo retificada
        var somaR = somasDoUsuario(sheetB, emailR, lastRowIndex)[vR.data];
        var erroTetoR = verificarTetoDia(somaR, vR.q, vR.t);
        if (erroTetoR !== "") return respJSON({"status": "erro", "mensagem": erroTetoR});

        var marcasR = marcasConsolidacao(vR.fase, vR.q, vR.a);
        // Colunas B..L numa única gravação (data, matéria, tópico, link, tempo, questões, acertos, fase, método, K, L)
        sheetB.getRange(lastRowIndex, 2, 1, 11).setValues([[vR.data, vR.mat, vR.top, vR.tipoLink, vR.t, vR.q, vR.a, vR.fase, vR.met, marcasR[0], marcasR[1]]]);

        var dataUR = sheetU.getDataRange().getValues();
        for (var j = 1; j < dataUR.length; j++) {
          if (dataUR[j][0].toString().toLowerCase() === emailR) {
            var currentQ = parseFloat(dataUR[j][4]) || 0; var currentT = parseFloat(dataUR[j][5]) || 0; var currentA = parseFloat(dataUR[j][6]) || 0;
            sheetU.getRange(j + 1, 5).setValue(Math.max(0, currentQ - oldQ + vR.q));
            sheetU.getRange(j + 1, 6).setValue(Math.max(0, currentT - oldT + vR.t));
            sheetU.getRange(j + 1, 7).setValue(Math.max(0, currentA - oldA + vR.a));
            break;
          }
        }
        SpreadsheetApp.flush(); // TRAVA DE SEGURANÇA
        return respJSON({"status": "sucesso"});
      });
    }

    if (acao === "lancamento") {
      var vL = validarLancamento(dados);
      if (!vL.ok) return respJSON({"status": "erro", "mensagem": vL.mensagem});

      return comTrava(function() {
        var sheetB = ss.getSheetByName("Base_Dashboard");
        var emailL = String(dados.email).trim().toLowerCase();

        var erroTetoL = verificarTetoDia(somasDoUsuario(sheetB, emailL)[vL.data], vL.q, vL.t);
        if (erroTetoL !== "") return respJSON({"status": "erro", "mensagem": erroTetoL});

        var marcasL = marcasConsolidacao(vL.fase, vL.q, vL.a);
        sheetB.appendRow([new Date(), vL.data, vL.mat, vL.top, vL.tipoLink, vL.t, vL.q, vL.a, vL.fase, vL.met, marcasL[0], marcasL[1], emailL]);

        var dataUL = sheetU.getDataRange().getValues();
        for (var i = 1; i < dataUL.length; i++) {
          if (dataUL[i][0].toString().toLowerCase() === emailL) {
            sheetU.getRange(i + 1, 5).setValue((parseFloat(dataUL[i][4]) || 0) + vL.q);
            sheetU.getRange(i + 1, 6).setValue((parseFloat(dataUL[i][5]) || 0) + vL.t);
            sheetU.getRange(i + 1, 7).setValue((parseFloat(dataUL[i][6]) || 0) + vL.a);
            break;
          }
        }
        SpreadsheetApp.flush(); // TRAVA DE SEGURANÇA
        return respJSON({"status": "sucesso"});
      });
    }
    return respJSON({"status": "erro", "mensagem": "Ação desconhecida ou usuário não encontrado."});
  } catch(err) {
    return ContentService.createTextOutput(JSON.stringify({"status": "erro", "mensagem": "Erro interno no servidor: " + err.message})).setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  try {
    var acao = e.parameter.acao;
    if (acao === "vagas") return acaoVagas();
    var acoesPublicasGet = ["solicitar_codigo", "trocarSenhaSegura", "login", "cadastro"];
    if (acoesPublicasGet.indexOf(acao) === -1) {
      var sheetUAuth = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Usuarios");
      if (!sheetUAuth) return respJSON({"status": "erro", "erro": true, "mensagem": "Aba 'Usuarios' não encontrada."});
      var linhaAuthGet = validarSessao(sheetUAuth.getDataRange().getValues(), e.parameter.email, e.parameter.token);
      if (linhaAuthGet === -1) return respJSON({"status": "erro", "erro": true, "sessao": false, "mensagem": "Sessão inválida. Faça login novamente."});
      if (linhaAuthGet === -2) return respJSON({"status": "erro", "erro": true, "mensagem": "Sua assinatura expirou."});
    }

    // Login e cadastro chegam por GET (legível pelo navegador) e reutilizam a lógica do doPost
    // Ações com senha não aceitam mais GET (a senha ficaria exposta na URL)
    if (acao === "login" || acao === "cadastro" || acao === "trocarSenhaSegura") {
      return respJSON({"status": "erro", "mensagem": "Versão desatualizada. Atualize a página (Ctrl + F5)."});
    }

    if (acao === "solicitar_codigo") {
      return acaoSolicitarCodigo(e.parameter.email);
    }

    if (acao === "trocarSenhaSegura") {
      return acaoTrocarSenha(e.parameter.email, e.parameter.codigo, e.parameter.novaSenha);
    }

    if (acao === "radar") {
      try {
        var url = 'https://www.pciconcursos.com.br/rss/';
        var opcoesAvancadas = { "muteHttpExceptions": true, "headers": { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" } };
        var response = UrlFetchApp.fetch(url, opcoesAvancadas);
        var xml = response.getContentText();
        
        if (!xml.includes('<rss') && !xml.includes('<feed')) {
           xml = ""; 
           for (var pagina = 1; pagina <= 5; pagina++) {
             var urlEst = 'https://www.estrategiaconcursos.com.br/blog/feed/?paged=' + pagina;
             var resEst = UrlFetchApp.fetch(urlEst, opcoesAvancadas);
             xml += resEst.getContentText(); 
           }
        }
        
        var newsList = [];
        var itemRegex = /<item>([\s\S]*?)<\/item>/gi;
        var match; var limit = 0;
        
        while ((match = itemRegex.exec(xml)) !== null && limit < 60) {
          var block = match[1];
          var titleRegex = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i;
          var tMatch = titleRegex.exec(block); var titulo = tMatch ? tMatch[1].trim() : "Aviso Oficial";
          var linkRegex = /<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i;
          var lMatch = linkRegex.exec(block); var link = lMatch ? lMatch[1].trim() : "#";
          var dateRegex = /<pubDate>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/pubDate>/i;
          var dMatch = dateRegex.exec(block); var pubDate = dMatch ? dMatch[1].trim() : "";
          
          newsList.push({ titulo: titulo, link: link, pubDate: pubDate }); limit++;
        }
        return ContentService.createTextOutput(JSON.stringify({ "status": "sucesso", "noticias": newsList })).setMimeType(ContentService.MimeType.JSON);
      } catch (errRadar) {
        return ContentService.createTextOutput(JSON.stringify({ "status": "erro", "mensagem": "Falha na varredura regex: " + errRadar.message })).setMimeType(ContentService.MimeType.JSON);
      }
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var email = e.parameter.email;
    var senha = e.parameter.senha;
    if (!email) return ContentService.createTextOutput(JSON.stringify({"erro": true, "mensagem": "Email ausente"})).setMimeType(ContentService.MimeType.JSON);

    var sheetU = ss.getSheetByName("Usuarios");
    if(!sheetU) return ContentService.createTextOutput(JSON.stringify({"erro": true, "mensagem": "Aba 'Usuarios' não encontrada."})).setMimeType(ContentService.MimeType.JSON);
    
    var users = sheetU.getDataRange().getValues();
    var userRow = -1;
    var expirationDate = ""; var nickname = ""; var cicloSalvoNuvem = ""; var nickMap = {};
    var editalAtivoUsuario = ""; var progressoEditalUsuario = "{}";

    var editalAtivoUsuario = ""; var progressoEditalUsuario = "{}";
    var avatarUsuario = ""; var avatarByNick = {};

    for (var i = 1; i < users.length; i++) {
      var uEmail = users[i][0] ? users[i][0].toString().toLowerCase() : "";
      var uNick = users[i][3] || "Anônimo";
      var uAvatar = users[i][11] ? users[i][11].toString() : "";
      if (uEmail) { 
        nickMap[uEmail] = uNick; 
        avatarByNick[uNick] = uAvatar;
      }

      if (uEmail === email.toLowerCase()) {
        if (acao === "login" && users[i][1].toString() !== senha) { } 
        else {
          var dataExpiracao = users[i][2];
          if (dataExpiracao && dataExpiracao !== "" && !isNaN(new Date(dataExpiracao).getTime())) {
            if (new Date() > new Date(dataExpiracao)) return ContentService.createTextOutput(JSON.stringify({"status": "erro", "erro": true, "mensagem": "Sua assinatura expirou."})).setMimeType(ContentService.MimeType.JSON);
            expirationDate = Utilities.formatDate(new Date(dataExpiracao), Session.getScriptTimeZone(), "dd/MM/yyyy");
          } else { expirationDate = "Vitalício"; }
          nickname = uNick;
          cicloSalvoNuvem = users[i][7] || ""; 
          editalAtivoUsuario = users[i][8] || ""; 
          progressoEditalUsuario = montarProgresso(users[i]);
          avatarUsuario = uAvatar;
          userRow = i;
        }
      }
    }

    if (userRow === -1) return ContentService.createTextOutput(JSON.stringify({"status": "erro", "erro": true, "mensagem": "Credenciais Inválidas ou Assinatura Inativa."})).setMimeType(ContentService.MimeType.JSON);
    registrarAcessoDiario(sheetU, userRow, users[userRow]);

    var baseEditaisDict = {};
    var sheetE = ss.getSheetByName("Base_Editais");
    if (sheetE) {
      var dataE = sheetE.getDataRange().getValues();
      for(var e_idx = 1; e_idx < dataE.length; e_idx++) {
         var conc = dataE[e_idx][0] ? dataE[e_idx][0].toString().trim() : "";
         if(!conc) continue;
         if(!baseEditaisDict[conc]) baseEditaisDict[conc] = [];
         baseEditaisDict[conc].push({
            banca: dataE[e_idx][1] ? dataE[e_idx][1].toString().trim() : "",
            bloco: dataE[e_idx][2] ? dataE[e_idx][2].toString().trim() : "",
            mat: dataE[e_idx][3] ? dataE[e_idx][3].toString().trim() : "",
            top: dataE[e_idx][4] ? dataE[e_idx][4].toString().trim() : "",
            linkMaster: dataE[e_idx][5] ? dataE[e_idx][5].toString().trim() : ""
         });
      }
    }

    var sheetB = ss.getSheetByName("Base_Dashboard");
    if(!sheetB) return ContentService.createTextOutput(JSON.stringify({"erro": true, "mensagem": "Aba 'Base_Dashboard' não encontrada."})).setMimeType(ContentService.MimeType.JSON);

    var dataB_Full = sheetB.getDataRange().getDisplayValues(); 
    var now = new Date();
    var tz = Session.getScriptTimeZone();
    
    var hojeStr = Utilities.formatDate(now, tz, "dd/MM/yyyy");
    var mesAnoStr = hojeStr.substring(3);
    
    var shiftedNow = new Date(now.getTime() - 86400000);
    var currentWeekStr = Utilities.formatDate(shiftedNow, tz, "w-yyyy");
    
    var rankDiario = {}; var rankSemanal = {}; var rankMensal = {}; var rankGeral = {}; 
    var compDisciplinas = {}; var compMensal = {};
    var dateCache = {}; 
    var filtered = [];
    
    if (dataB_Full.length > 0) {
        filtered.push(dataB_Full[0]); 
    }

    if (dataB_Full.length > 1) {
        for(var r = 1; r < dataB_Full.length; r++) {
            var row = dataB_Full[r];
            var dataEstudo = row[1] ? row[1].toString().trim() : ""; 
            var matEstudo = row[2] ? row[2].toString().trim() : "";
            var q = parseFloat(String(row[6]).replace(',', '.')) || 0; 
            var a = parseFloat(String(row[7]).replace(',', '.')) || 0; 
            var userEmail = row[12] ? row[12].toString().toLowerCase() : ""; 
            if(!userEmail) continue;
            
            if (userEmail === email.toLowerCase()) {
                filtered.push(row);
            }

            if (matEstudo && q > 0) {
                if (!compDisciplinas[matEstudo]) compDisciplinas[matEstudo] = { q: 0, a: 0 };
                compDisciplinas[matEstudo].q += q;
                compDisciplinas[matEstudo].a += a;
            }

            var mesChave = dataEstudo.length >= 10 ? dataEstudo.substring(3) : "";
            if (mesChave && q > 0) {
                if (!compMensal[mesChave]) compMensal[mesChave] = { q: 0, a: 0 };
                compMensal[mesChave].q += q;
                compMensal[mesChave].a += a;
            }

            var nick = nickMap[userEmail] || "Anônimo";

            if(!rankGeral[nick]) rankGeral[nick] = {q:0, a:0};
            rankGeral[nick].q += q; rankGeral[nick].a += a;

            if(dataEstudo === hojeStr) {
              if(!rankDiario[nick]) rankDiario[nick] = {q:0, a:0};
              rankDiario[nick].q += q; rankDiario[nick].a += a;
            }
            
            if(dataEstudo.substring(3) === mesAnoStr) {
              if(!rankMensal[nick]) rankMensal[nick] = {q:0, a:0};
              rankMensal[nick].q += q; rankMensal[nick].a += a;
            }
            
            var rowWeekStr;
            if (dateCache[dataEstudo]) {
                rowWeekStr = dateCache[dataEstudo]; 
            } else {
                var dParts = dataEstudo.split('/');
                if(dParts.length === 3) {
                   var dObj = new Date(dParts[2], dParts[1]-1, dParts[0]);
                   var shiftedRowDate = new Date(dObj.getTime() - 86400000);
                   rowWeekStr = Utilities.formatDate(shiftedRowDate, tz, "w-yyyy"); 
                   dateCache[dataEstudo] = rowWeekStr; 
                } else {
                   rowWeekStr = "invalido";
                   dateCache[dataEstudo] = "invalido";
                }
            }
            
            if (rowWeekStr === currentWeekStr) {
               if(!rankSemanal[nick]) rankSemanal[nick] = {q:0, a:0};
               rankSemanal[nick].q += q; rankSemanal[nick].a += a;
            }
        }
    }

    var formatRank = function(obj, limit) { 
      return Object.keys(obj).map(function(k){ 
        return {nick: k, q: obj[k].q, a: obj[k].a, avatar: avatarByNick[k] || ""}; 
      }).sort(function(a,b){return b.q - a.q}).slice(0, limit); 
    };

    var leaderboardsObj = { 
        "diario": formatRank(rankDiario, 20), 
        "semanal": formatRank(rankSemanal, 20), 
        "mensal": formatRank(rankMensal, 20), 
        "geral": formatRank(rankGeral, 50) 
    };

    var comparativoGeralObj = {
        "disciplinas": compDisciplinas,
        "mensal": compMensal
    };

    if (acao === "login") {
      return ContentService.createTextOutput(JSON.stringify({ 
        "status": "sucesso", "expiration": expirationDate, "nickname": nickname, "avatar": avatarUsuario,
        "cicloNuvem": cicloSalvoNuvem, "baseEditais": baseEditaisDict,
        "editalAtivo": editalAtivoUsuario, "progressoEdital": progressoEditalUsuario
      })).setMimeType(ContentService.MimeType.JSON);
    }
    
    return ContentService.createTextOutput(JSON.stringify({ 
      "status": "sucesso", "dados": filtered, "expiration": expirationDate, "nickname": nickname, "avatar": avatarUsuario,
      "leaderboards": leaderboardsObj, "comparativoGeral": comparativoGeralObj, "cicloNuvem": cicloSalvoNuvem, 
      "baseEditais": baseEditaisDict, "editalAtivo": editalAtivoUsuario, "progressoEdital": progressoEditalUsuario
    })).setMimeType(ContentService.MimeType.JSON);

  } catch(err) {
    return ContentService.createTextOutput(JSON.stringify({"status": "erro", "erro": true, "mensagem": "Erro no Google Sheets: " + err.message})).setMimeType(ContentService.MimeType.JSON);
  }
}
function migrarUsuariosExistentes() {
  var sheetU = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Usuarios");
  var users = sheetU.getDataRange().getValues();
  var expFund = new Date();
  expFund.setFullYear(expFund.getFullYear() + ANOS_FUNDADOR);
  var posicao = 0, marcados = 0, foraDasVagas = [];

  for (var i = 1; i < users.length; i++) {
    var em = users[i][COL.EMAIL] ? users[i][COL.EMAIL].toString().toLowerCase() : "";
    if (!em) continue;
    posicao++;
    if (em === ADMIN_EMAIL.toLowerCase()) continue;
    var exp = users[i][COL.EXPIRA];
    var semData = !exp || exp === "" || isNaN(new Date(exp).getTime());
    if (!semData) continue;
    if (posicao <= LIMITE_FUNDADORES) {
      sheetU.getRange(i + 1, COL.EXPIRA + 1).setValue(expFund);
      sheetU.getRange(i + 1, COL.ORIGEM + 1).setValue("FUNDADOR");
      marcados++;
    } else {
      foraDasVagas.push(em);
    }
  }
  SpreadsheetApp.flush();
  Logger.log("Fundadores marcados: " + marcados + " | Sem vigência após a vaga 100: " + foraDasVagas.join(", "));
}