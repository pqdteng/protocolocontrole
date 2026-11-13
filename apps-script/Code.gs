// ===== AUTENTICAÇÃO / REGRAS DE ACESSO =====
var ADMIN_EMAIL = "valefvs92@gmail.com"; // troque pelo seu e-mail
var LIMITE_FUNDADORES = 100;
var ANOS_FUNDADOR = 5;
var SESSAO_DIAS = 30;
var COL = { EMAIL: 0, SENHA: 1, EXPIRA: 2, NICK: 3, CODIGO: 10, AVATAR: 11, TOKEN: 12, TOKEN_EXP: 13, CODIGO_EXP: 14, TENTATIVAS: 15, ORIGEM: 16, CADASTRO_EM: 23, ULTIMO_ACESSO: 24, ESCUDOS: 25 };

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

  var users = lerUsuariosLeve(sheetU); // só precisa do e-mail
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
  var users = lerUsuariosLeve(sheetU); // só precisa do e-mail
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
      var linhaAuth = validarSessao(lerUsuariosLeve(sheetU), dados.email, dados.token);
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

      var usersLog = lerUsuariosLeve(sheetU); // e-mail, senha, validade (sem fotos nem progresso)
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
        var usersCad = lerUsuariosLeve(sheetU);
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
        var iC = indiceDoUsuario(sheetU, dados.email);
        if (iC === -1) return respJSON({"status": "erro", "mensagem": "Usuário não encontrado."});
        sheetU.getRange(iC + 1, 8).setValue(cicloStr);
        SpreadsheetApp.flush(); // TRAVA DE SEGURANÇA
        return respJSON({"status": "sucesso"});
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
        var i = indiceDoUsuario(sheetU, dados.email);
        if (i === -1) return respJSON({"status": "erro", "mensagem": "Usuário não encontrado."});

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
      });
    }

    if (acao === "comprar_escudo") {
      return comTrava(function() { return acaoComprarEscudo(ss, sheetU, dados.email); });
    }

    if (acao === "usar_escudos") {
      return comTrava(function() { return acaoUsarEscudos(ss, sheetU, dados.email, dados.datas); });
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
          somarTotaisUsuario(sheetU, indiceDoUsuario(sheetU, emailImp), totalQ, totalT, totalA);
          invalidarLinhasAluno(emailImp);
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
        var dataUP = sheetU.getRange(1, 1, Math.max(1, sheetU.getLastRow()), 4).getValues(); // A:D (e-mail e codinome)
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

        var nickAntigo = dataUP[linhaP][3] ? dataUP[linhaP][3].toString() : "";
        sheetU.getRange(linhaP + 1, 4).setValue(nickFinal);
        var fotoAtual;
        if (typeof dados.avatar !== "undefined") {
          sheetU.getRange(linhaP + 1, 12).setValue(dados.avatar);
          fotoAtual = String(dados.avatar || "");
        } else {
          fotoAtual = String(sheetU.getRange(linhaP + 1, 12).getValue() || "");
        }
        SpreadsheetApp.flush(); // TRAVA DE SEGURANÇA

        // Cache: foto ligada ao novo codinome, e o ranking passa a mostrar o novo nome
        try {
          var cacheP = CacheService.getScriptCache();
          if (nickAntigo && nickAntigo.toLowerCase() !== nickFinal.toLowerCase()) cacheP.remove(chaveAvatar(nickAntigo));
          cacheP.put(chaveAvatar(nickFinal), fotoAtual || "-", CACHE_AVATAR_SEG);
        } catch (errCacheP) {}
        invalidarAgregados();
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

        var iH = indiceDoUsuario(sheetU, emailH);
        if (iH !== -1) {
          sheetU.getRange(iH + 1, 5, 1, 3).setValues([[0, 0, 0]]);
          // Sem histórico não há moedas: zera também os escudos
          if (sheetU.getMaxColumns() > COL.ESCUDOS) sheetU.getRange(iH + 1, COL.ESCUDOS + 1).setValue("");
        }
        SpreadsheetApp.flush(); // TRAVA DE SEGURANÇA
        invalidarLinhasAluno(emailH);
        return respJSON({"status": "sucesso", "apagados": apagados});
      });
    }

    if (acao === "retificar_ultimo") {
      var vR = validarLancamento(dados);
      if (!vR.ok) return respJSON({"status": "erro", "mensagem": vR.mensagem});

      return comTrava(function() {
        var sheetB = ss.getSheetByName("Base_Dashboard");
        var emailR = String(dados.email).trim().toLowerCase();
        var lastRowIndex = -1;
        var oldQ = 0, oldT = 0, oldA = 0;

        // Lê só a coluna de e-mail (M) para achar o último lançamento do aluno
        var ultimaR = sheetB.getLastRow();
        if (ultimaR >= 2) {
          var emailsR = sheetB.getRange(2, 13, ultimaR - 1, 1).getValues();
          for (var i = emailsR.length - 1; i >= 0; i--) {
            if (emailsR[i][0] && emailsR[i][0].toString().toLowerCase() === emailR) { lastRowIndex = i + 2; break; }
          }
        }
        if (lastRowIndex === -1) return respJSON({"status": "erro", "mensagem": "Nenhum lançamento encontrado."});
        var antigos = sheetB.getRange(lastRowIndex, 6, 1, 3).getValues()[0]; // F = tempo, G = questões, H = acertos
        oldT = parseFloat(antigos[0]) || 0; oldQ = parseFloat(antigos[1]) || 0; oldA = parseFloat(antigos[2]) || 0;

        // Teto do dia desconsiderando a própria linha que está sendo retificada
        var somaR = somasDoUsuario(sheetB, emailR, lastRowIndex)[vR.data];
        var erroTetoR = verificarTetoDia(somaR, vR.q, vR.t);
        if (erroTetoR !== "") return respJSON({"status": "erro", "mensagem": erroTetoR});

        var marcasR = marcasConsolidacao(vR.fase, vR.q, vR.a);
        // Colunas B..L numa única gravação (data, matéria, tópico, link, tempo, questões, acertos, fase, método, K, L)
        sheetB.getRange(lastRowIndex, 2, 1, 11).setValues([[vR.data, vR.mat, vR.top, vR.tipoLink, vR.t, vR.q, vR.a, vR.fase, vR.met, marcasR[0], marcasR[1]]]);

        somarTotaisUsuario(sheetU, indiceDoUsuario(sheetU, emailR), vR.q - oldQ, vR.t - oldT, vR.a - oldA);
        SpreadsheetApp.flush(); // TRAVA DE SEGURANÇA
        invalidarLinhasAluno(emailR);
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

        somarTotaisUsuario(sheetU, indiceDoUsuario(sheetU, emailL), vL.q, vL.t, vL.a);
        SpreadsheetApp.flush(); // TRAVA DE SEGURANÇA
        invalidarLinhasAluno(emailL);
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
    var usersLeve = null, linhaAuthGet = -1;
    if (acoesPublicasGet.indexOf(acao) === -1) {
      var sheetUAuth = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Usuarios");
      if (!sheetUAuth) return respJSON({"status": "erro", "erro": true, "mensagem": "Aba 'Usuarios' não encontrada."});
      usersLeve = lerUsuariosLeve(sheetUAuth); // só e-mail, codinome, validade e token (sem fotos nem progresso)
      linhaAuthGet = validarSessao(usersLeve, e.parameter.email, e.parameter.token);
      if (linhaAuthGet === -1) return respJSON({"status": "erro", "erro": true, "sessao": false, "mensagem": "Sessão inválida. Faça login novamente."});
      if (linhaAuthGet === -2) return respJSON({"status": "erro", "erro": true, "mensagem": "Sua assinatura expirou."});
    }

    // Ações com senha não aceitam GET (a senha ficaria exposta na URL)
    if (acao === "login" || acao === "cadastro" || acao === "trocarSenhaSegura") {
      return respJSON({"status": "erro", "mensagem": "Versão desatualizada. Atualize a página (Ctrl + F5)."});
    }

    if (acao === "solicitar_codigo") {
      return acaoSolicitarCodigo(e.parameter.email);
    }

    if (acao === "radar") return acaoRadar();

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var email = String(e.parameter.email || "").trim().toLowerCase();
    var sheetU = ss.getSheetByName("Usuarios");

    // Linha completa só do próprio aluno (antes: a aba inteira, com a foto e o progresso de todos)
    var userRow = linhaAuthGet;
    var linhaUsuario = sheetU.getRange(userRow + 1, 1, 1, sheetU.getLastColumn()).getValues()[0];
    var tz = Session.getScriptTimeZone();

    var expirationDate = "Vitalício";
    var dataExpiracao = linhaUsuario[COL.EXPIRA];
    if (dataExpiracao && dataExpiracao !== "" && !isNaN(new Date(dataExpiracao).getTime())) {
      expirationDate = Utilities.formatDate(new Date(dataExpiracao), tz, "dd/MM/yyyy");
    }
    var nickname = linhaUsuario[COL.NICK] || "Anônimo";
    var cicloSalvoNuvem = linhaUsuario[7] || "";
    var editalAtivoUsuario = linhaUsuario[8] || "";
    var progressoEditalUsuario = montarProgresso(linhaUsuario);
    var avatarUsuario = linhaUsuario[COL.AVATAR] ? linhaUsuario[COL.AVATAR].toString() : "";
    registrarAcessoDiario(sheetU, userRow, linhaUsuario);

    var baseEditaisDict = obterBaseEditais(ss);

    // Lançamentos do aluno + ranking/comparativo: vêm do cache; a Base_Dashboard só é lida quando o cache expira
    var datas = datasReferencia(tz);
    var cache = CacheService.getScriptCache();
    var chaveLin = "lin_" + versaoCache() + "_" + email;
    var chaveAgg = chaveAgregados(datas);
    var genAtual = cache.get(chaveGeracao(email)) || "0";

    var filtered = null, agregados = null;
    var linCache = cacheGetGrande(chaveLin);
    if (linCache !== null) {
      try { var objLin = JSON.parse(linCache); if (objLin && objLin.g === genAtual) filtered = objLin.r; } catch (errLin) {}
    }
    var aggCache = cacheGetGrande(chaveAgg);
    if (aggCache !== null) {
      try { agregados = JSON.parse(aggCache); } catch (errAgg) {}
    }

    if (filtered === null || agregados === null) {
      var sheetB = ss.getSheetByName("Base_Dashboard");
      if (!sheetB) return respJSON({"erro": true, "mensagem": "Aba 'Base_Dashboard' não encontrada."});
      var dataB_Full = sheetB.getDataRange().getDisplayValues();

      var nickMap = {};
      for (var i = 1; i < usersLeve.length; i++) {
        var uEmail = usersLeve[i][COL.EMAIL] ? usersLeve[i][COL.EMAIL].toString().toLowerCase() : "";
        if (uEmail) nickMap[uEmail] = usersLeve[i][COL.NICK] || "Anônimo";
      }

      var calc = calcularAgregados(dataB_Full, email, nickMap, tz, datas);
      filtered = calc.filtered;
      agregados = calc.agregados;
      cachePutGrande(chaveLin, JSON.stringify({ g: genAtual, r: filtered }), CACHE_LINHAS_SEG);
      cachePutGrande(chaveAgg, JSON.stringify(agregados), CACHE_RANKING_SEG);
    }

    // Fotos do ranking: uma vez por codinome (antes vinham repetidas em cada entrada dos 4 rankings)
    var nicksRanking = {};
    ["diario", "semanal", "mensal", "geral"].forEach(function(tipo) {
      (agregados.leaderboards[tipo] || []).forEach(function(item) { nicksRanking[item.nick] = true; });
    });
    var avatares = obterAvatares(sheetU, Object.keys(nicksRanking));

    return respJSON({
      "status": "sucesso", "dados": filtered, "expiration": expirationDate, "nickname": nickname, "avatar": avatarUsuario,
      "leaderboards": agregados.leaderboards, "avatares": avatares, "comparativoGeral": agregados.comparativo,
      "cicloNuvem": cicloSalvoNuvem, "baseEditais": baseEditaisDict,
      "editalAtivo": editalAtivoUsuario, "progressoEdital": progressoEditalUsuario,
      "escudos": lerEscudos(linhaUsuario[COL.ESCUDOS])
    });

  } catch(err) {
    return ContentService.createTextOutput(JSON.stringify({"status": "erro", "erro": true, "mensagem": "Erro no Google Sheets: " + err.message})).setMimeType(ContentService.MimeType.JSON);
  }
}

// Varre a Base_Dashboard uma vez: separa as linhas do aluno e monta ranking + comparativo geral
function calcularAgregados(dataB_Full, email, nickMap, tz, datas) {
  var hojeStr = datas.hoje, mesAnoStr = datas.mesAno, currentWeekStr = datas.semana;
  var rankDiario = {}, rankSemanal = {}, rankMensal = {}, rankGeral = {};
  var compDisciplinas = {}, compMensal = {};
  var dateCache = {};
  var filtered = [];
  if (dataB_Full.length > 0) filtered.push(dataB_Full[0]);

  function somar(obj, nick, q, a) {
    if (!obj[nick]) obj[nick] = { q: 0, a: 0 };
    obj[nick].q += q; obj[nick].a += a;
  }

  for (var r = 1; r < dataB_Full.length; r++) {
    var row = dataB_Full[r];
    var dataEstudo = row[1] ? row[1].toString().trim() : "";
    var matEstudo = row[2] ? row[2].toString().trim() : "";
    var q = parseFloat(String(row[6]).replace(',', '.')) || 0;
    var a = parseFloat(String(row[7]).replace(',', '.')) || 0;
    var userEmail = row[12] ? row[12].toString().toLowerCase() : "";
    if (!userEmail) continue;

    if (userEmail === email) filtered.push(row);

    if (matEstudo && q > 0) {
      if (!compDisciplinas[matEstudo]) compDisciplinas[matEstudo] = { q: 0, a: 0 };
      compDisciplinas[matEstudo].q += q; compDisciplinas[matEstudo].a += a;
    }

    var mesChave = dataEstudo.length >= 10 ? dataEstudo.substring(3) : "";
    if (mesChave && q > 0) {
      if (!compMensal[mesChave]) compMensal[mesChave] = { q: 0, a: 0 };
      compMensal[mesChave].q += q; compMensal[mesChave].a += a;
    }

    var nick = nickMap[userEmail] || "Anônimo";
    somar(rankGeral, nick, q, a);
    if (dataEstudo === hojeStr) somar(rankDiario, nick, q, a);
    if (dataEstudo.substring(3) === mesAnoStr) somar(rankMensal, nick, q, a);

    var rowWeekStr = dateCache[dataEstudo];
    if (!rowWeekStr) {
      var dParts = dataEstudo.split('/');
      if (dParts.length === 3) {
        var dObj = new Date(dParts[2], dParts[1] - 1, dParts[0]);
        rowWeekStr = Utilities.formatDate(new Date(dObj.getTime() - 86400000), tz, "w-yyyy");
      } else {
        rowWeekStr = "invalido";
      }
      dateCache[dataEstudo] = rowWeekStr;
    }
    if (rowWeekStr === currentWeekStr) somar(rankSemanal, nick, q, a);
  }

  var formatRank = function(obj, limit) {
    return Object.keys(obj).map(function(k) {
      return { nick: k, q: obj[k].q, a: obj[k].a };
    }).sort(function(x, y) { return y.q - x.q; }).slice(0, limit);
  };

  return {
    filtered: filtered,
    agregados: {
      leaderboards: {
        "diario": formatRank(rankDiario, 20),
        "semanal": formatRank(rankSemanal, 20),
        "mensal": formatRank(rankMensal, 20),
        "geral": formatRank(rankGeral, 50)
      },
      comparativo: { "disciplinas": compDisciplinas, "mensal": compMensal }
    }
  };
}

function acaoRadar() {
  var chaveRadar = "radar_" + versaoCache();
  var emCache = cacheGetGrande(chaveRadar);
  if (emCache !== null) return ContentService.createTextOutput(emCache).setMimeType(ContentService.MimeType.JSON);
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
      var tMatch = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(block); var titulo = tMatch ? tMatch[1].trim() : "Aviso Oficial";
      var lMatch = /<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i.exec(block); var link = lMatch ? lMatch[1].trim() : "#";
      var dMatch = /<pubDate>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/pubDate>/i.exec(block); var pubDate = dMatch ? dMatch[1].trim() : "";
      newsList.push({ titulo: titulo, link: link, pubDate: pubDate }); limit++;
    }
    var json = JSON.stringify({ "status": "sucesso", "noticias": newsList });
    if (newsList.length > 0) cachePutGrande(chaveRadar, json, CACHE_RADAR_SEG); // só guarda quando a busca deu certo
    return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
  } catch (errRadar) {
    return respJSON({ "status": "erro", "mensagem": "Falha na varredura regex: " + errRadar.message });
  }
}

// ===== DESEMPENHO: LEITURAS LEVES E CACHE =====
// Ranking e comparativo: recalculados no máximo a cada 5 min (ou na hora, quando o próprio aluno grava algo).
// Lançamentos do aluno: guardados por 1h e descartados a cada gravação dele.
// Mexeu na planilha à mão? Rode limparCaches() pelo editor (▶) para tudo ser relido na hora.
var CACHE_RANKING_SEG = 300;
var CACHE_LINHAS_SEG = 3600;
var CACHE_GERACAO_SEG = 21600;
var CACHE_AVATAR_SEG = 21600;
var CACHE_EDITAIS_SEG = 600;
var CACHE_RADAR_SEG = 1800;
var CACHE_PEDACO = 45000;   // o CacheService aceita até 100 KB por chave (acentos ocupam 2 bytes)
var CACHE_MAX_PEDACOS = 100;

var _versaoCache = null;
function versaoCache() {
  if (_versaoCache === null) {
    _versaoCache = PropertiesService.getScriptProperties().getProperty("CACHE_VERSAO") || "1";
  }
  return _versaoCache;
}

// Rode pelo editor depois de editar a planilha à mão: invalida todos os caches de uma vez
function limparCaches() {
  var nova = String(new Date().getTime());
  PropertiesService.getScriptProperties().setProperty("CACHE_VERSAO", nova);
  _versaoCache = nova;
  Logger.log("Caches invalidados (versão " + nova + ").");
}

// Guarda textos maiores que 100 KB dividindo em pedaços
function cachePutGrande(chave, texto, seg) {
  try {
    var obj = {};
    var n = 0;
    for (var p = 0; p < texto.length; p += CACHE_PEDACO) {
      obj[chave + "_" + n] = texto.substring(p, p + CACHE_PEDACO);
      n++;
      if (n > CACHE_MAX_PEDACOS) return; // grande demais: segue sem cache
    }
    obj[chave + "_n"] = String(n);
    CacheService.getScriptCache().putAll(obj, seg);
  } catch (err) {
    Logger.log("cachePutGrande(" + chave + "): " + err.message);
  }
}

// Devolve o texto guardado, ou null se faltar qualquer pedaço
function cacheGetGrande(chave) {
  try {
    var cache = CacheService.getScriptCache();
    var cab = cache.get(chave + "_n");
    if (cab === null) return null;
    var n = parseInt(cab, 10);
    if (!(n >= 0)) return null;
    var chaves = [];
    for (var i = 0; i < n; i++) chaves.push(chave + "_" + i);
    var partes = n > 0 ? cache.getAll(chaves) : {};
    var s = "";
    for (var j = 0; j < n; j++) {
      var parte = partes[chave + "_" + j];
      if (parte === undefined || parte === null) return null;
      s += parte;
    }
    return s;
  } catch (err) {
    return null;
  }
}

function datasReferencia(tz) {
  var agora = new Date();
  var hoje = Utilities.formatDate(agora, tz, "dd/MM/yyyy");
  return {
    hoje: hoje,
    mesAno: hoje.substring(3),
    semana: Utilities.formatDate(new Date(agora.getTime() - 86400000), tz, "w-yyyy")
  };
}

// A chave muda com o dia e a semana: o ranking "diário" nunca atravessa a meia-noite
function chaveAgregados(datas) {
  return "agg_" + versaoCache() + "_" + datas.hoje.replace(/\//g, "") + "_" + datas.semana;
}

function chaveGeracao(email) {
  return "gen_" + versaoCache() + "_" + email;
}

// Chamada a cada gravação do aluno: descarta o cache dos lançamentos dele.
// A "geração" protege contra uma sincronização lenta que leu a planilha antes da gravação e tenta guardar dados velhos.
function invalidarLinhasAluno(email) {
  try {
    CacheService.getScriptCache().put(chaveGeracao(String(email).trim().toLowerCase()), String(new Date().getTime()) + "_" + Math.floor(Math.random() * 1e6), CACHE_GERACAO_SEG);
  } catch (err) {
    Logger.log("invalidarLinhasAluno: " + err.message);
  }
}

function invalidarAgregados() {
  try {
    CacheService.getScriptCache().remove(chaveAgregados(datasReferencia(Session.getScriptTimeZone())) + "_n");
  } catch (err) {}
}

// Só as colunas usadas para autenticar (A:D e M:N), nos mesmos índices da linha completa.
// Evita ler fotos (até 40 KB por aluno) e progresso do edital (até ~315 KB por aluno) a cada requisição.
function lerUsuariosLeve(sheetU) {
  var ultima = sheetU.getLastRow();
  if (ultima < 1) return [];
  var ad = sheetU.getRange(1, 1, ultima, 4).getValues();
  var mn = sheetU.getRange(1, COL.TOKEN + 1, ultima, 2).getValues();
  var out = new Array(ultima);
  for (var i = 0; i < ultima; i++) {
    var r = [ad[i][0], ad[i][1], ad[i][2], ad[i][3]];
    r[COL.TOKEN] = mn[i][0];
    r[COL.TOKEN_EXP] = mn[i][1];
    out[i] = r;
  }
  return out;
}

// Índice (base 0, como em getValues) da linha do aluno, lendo só a coluna de e-mail
function indiceDoUsuario(sheetU, email) {
  var alvo = String(email || "").trim().toLowerCase();
  var ultima = sheetU.getLastRow();
  if (!alvo || ultima < 2) return -1;
  var col = sheetU.getRange(1, 1, ultima, 1).getValues();
  for (var i = 1; i < col.length; i++) {
    if (col[i][0] && col[i][0].toString().trim().toLowerCase() === alvo) return i;
  }
  return -1;
}

// Soma (ou subtrai) nos totais do aluno: colunas E (questões), F (tempo), G (acertos)
function somarTotaisUsuario(sheetU, idx, dq, dt, da) {
  if (idx < 0) return;
  var rg = sheetU.getRange(idx + 1, 5, 1, 3);
  var v = rg.getValues()[0];
  rg.setValues([[
    Math.max(0, (parseFloat(v[0]) || 0) + dq),
    Math.max(0, (parseFloat(v[1]) || 0) + dt),
    Math.max(0, (parseFloat(v[2]) || 0) + da)
  ]]);
}

function chaveAvatar(nick) {
  return "av_" + versaoCache() + "_" + String(nick).toLowerCase();
}

// Fotos dos codinomes do ranking. Vêm do cache; a coluna de fotos só é lida para quem ainda não está nele.
function obterAvatares(sheetU, nicks) {
  var mapa = {};
  if (!nicks || nicks.length === 0) return mapa;
  var cache = CacheService.getScriptCache();
  var chaves = nicks.map(chaveAvatar);
  var achados = {};
  try { achados = cache.getAll(chaves); } catch (errC) {}
  var faltando = [];
  for (var i = 0; i < nicks.length; i++) {
    var v = achados[chaves[i]];
    if (v === undefined || v === null) faltando.push(nicks[i]);
    else if (v !== "-") mapa[nicks[i]] = v;
  }
  if (faltando.length === 0) return mapa;

  var ultima = sheetU.getLastRow();
  if (ultima < 2) return mapa;
  var nk = sheetU.getRange(2, COL.NICK + 1, ultima - 1, 1).getValues();
  var av = sheetU.getRange(2, COL.AVATAR + 1, ultima - 1, 1).getValues();
  var porNick = {};
  for (var j = 0; j < nk.length; j++) {
    if (nk[j][0]) porNick[String(nk[j][0]).toLowerCase()] = av[j][0] ? String(av[j][0]) : "";
  }
  var novos = {};
  faltando.forEach(function(n) {
    var foto = porNick[String(n).toLowerCase()] || "";
    if (foto) mapa[n] = foto;
    novos[chaveAvatar(n)] = foto || "-"; // "-" = sem foto (evita reler a coluna)
  });
  try { cache.putAll(novos, CACHE_AVATAR_SEG); } catch (errP) {}
  return mapa;
}

// Catálogo de editais (muda pouco): guardado por 10 min
function obterBaseEditais(ss) {
  var chave = "edt_" + versaoCache();
  var emCache = cacheGetGrande(chave);
  if (emCache !== null) {
    try { return JSON.parse(emCache); } catch (errE) {}
  }
  var baseEditaisDict = {};
  var sheetE = ss.getSheetByName("Base_Editais");
  if (sheetE) {
    var dataE = sheetE.getDataRange().getValues();
    for (var i = 1; i < dataE.length; i++) {
      var conc = dataE[i][0] ? dataE[i][0].toString().trim() : "";
      if (!conc) continue;
      if (!baseEditaisDict[conc]) baseEditaisDict[conc] = [];
      baseEditaisDict[conc].push({
        banca: dataE[i][1] ? dataE[i][1].toString().trim() : "",
        bloco: dataE[i][2] ? dataE[i][2].toString().trim() : "",
        mat: dataE[i][3] ? dataE[i][3].toString().trim() : "",
        top: dataE[i][4] ? dataE[i][4].toString().trim() : "",
        linkMaster: dataE[i][5] ? dataE[i][5].toString().trim() : ""
      });
    }
  }
  cachePutGrande(chave, JSON.stringify(baseEditaisDict), CACHE_EDITAIS_SEG);
  return baseEditaisDict;
}

// ===== MOEDAS E ESCUDO DE OFENSIVA =====
// Moedas: 50 por dia com 100+ questões e mais 50 por dia com 2h+ de estudo (mesma regra do painel).
// Escudo: custa PRECO_ESCUDO moedas, no máximo MAX_ESCUDOS guardados; cobre um dia sem estudo a partir da data da compra.
// Guardado na coluna Z da aba Usuarios como {"compras":["yyyy-MM-dd",...],"usados":["dd/MM/yyyy",...]}.
var PRECO_ESCUDO = 300;
var MAX_ESCUDOS = 2;
var MOEDAS_META_Q = 100, MOEDAS_META_MIN = 120, MOEDAS_POR_META = 50;

function lerEscudos(valor) {
  try {
    var o = JSON.parse(String(valor || "") || "{}");
    var ehData = function(s) { return typeof s === "string" && s.length <= 10; };
    return {
      compras: Array.isArray(o.compras) ? o.compras.filter(ehData) : [],
      usados: Array.isArray(o.usados) ? o.usados.filter(ehData) : []
    };
  } catch (err) {
    return { compras: [], usados: [] };
  }
}

function moedasGanhas(somasPorDia) {
  var total = 0;
  for (var dia in somasPorDia) {
    if (somasPorDia[dia].q >= MOEDAS_META_Q) total += MOEDAS_POR_META;
    if (somasPorDia[dia].t >= MOEDAS_META_MIN) total += MOEDAS_POR_META;
  }
  return total;
}

function isoDeBR(br) { // "dd/MM/yyyy" -> "yyyy-MM-dd" (permite comparar como texto)
  var p = String(br).split("/");
  return p.length === 3 ? p[2] + "-" + ("0" + p[1]).slice(-2) + "-" + ("0" + p[0]).slice(-2) : "";
}

function gravarEscudos(sheetU, idx, esc) {
  if (sheetU.getMaxColumns() < COL.ESCUDOS + 1) {
    sheetU.insertColumnsAfter(sheetU.getMaxColumns(), COL.ESCUDOS + 1 - sheetU.getMaxColumns());
  }
  if (!sheetU.getRange(1, COL.ESCUDOS + 1).getValue()) sheetU.getRange(1, COL.ESCUDOS + 1).setValue("Escudos");
  sheetU.getRange(idx + 1, COL.ESCUDOS + 1).setValue(JSON.stringify(esc));
}

function resumoMoedas(ganhas, esc) {
  return { ganhas: ganhas, gastas: esc.compras.length * PRECO_ESCUDO, saldo: Math.max(0, ganhas - esc.compras.length * PRECO_ESCUDO) };
}

function acaoComprarEscudo(ss, sheetU, email) {
  var emailN = String(email || "").trim().toLowerCase();
  var idx = indiceDoUsuario(sheetU, emailN);
  if (idx === -1) return respJSON({"status": "erro", "mensagem": "Usuário não encontrado."});
  var esc = lerEscudos(sheetU.getRange(idx + 1, COL.ESCUDOS + 1).getValue());

  if (esc.compras.length - esc.usados.length >= MAX_ESCUDOS) {
    return respJSON({"status": "erro", "mensagem": "Você já tem " + MAX_ESCUDOS + " escudos guardados (o máximo)."});
  }
  var ganhas = moedasGanhas(somasDoUsuario(ss.getSheetByName("Base_Dashboard"), emailN));
  var saldo = ganhas - esc.compras.length * PRECO_ESCUDO;
  if (saldo < PRECO_ESCUDO) {
    return respJSON({"status": "erro", "mensagem": "Moedas insuficientes: o escudo custa " + PRECO_ESCUDO + " e você tem " + Math.max(0, saldo) + "."});
  }

  esc.compras.push(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd"));
  gravarEscudos(sheetU, idx, esc);
  SpreadsheetApp.flush(); // TRAVA DE SEGURANÇA
  return respJSON({"status": "sucesso", "escudos": esc, "moedas": resumoMoedas(ganhas, esc)});
}

// datas: dias sem estudo ("dd/MM/yyyy") que o aluno quer cobrir. Cada um precisa de um escudo comprado até aquele dia.
function acaoUsarEscudos(ss, sheetU, email, datas) {
  var emailN = String(email || "").trim().toLowerCase();
  if (!Array.isArray(datas) || datas.length === 0 || datas.length > MAX_ESCUDOS) {
    return respJSON({"status": "erro", "mensagem": "Datas inválidas."});
  }
  var idx = indiceDoUsuario(sheetU, emailN);
  if (idx === -1) return respJSON({"status": "erro", "mensagem": "Usuário não encontrado."});
  var esc = lerEscudos(sheetU.getRange(idx + 1, COL.ESCUDOS + 1).getValue());

  var tz = Session.getScriptTimeZone();
  var hojeIso = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
  var somas = somasDoUsuario(ss.getSheetByName("Base_Dashboard"), emailN);

  var novas = [];
  for (var i = 0; i < datas.length; i++) {
    var br = String(datas[i] || "").trim();
    var iso = isoDeBR(br);
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(br) || !iso) return respJSON({"status": "erro", "mensagem": "Data inválida: " + br});
    if (iso >= hojeIso) return respJSON({"status": "erro", "mensagem": "Só dias que já passaram podem ser protegidos."});
    if (esc.usados.indexOf(br) !== -1 || novas.indexOf(br) !== -1) return respJSON({"status": "erro", "mensagem": "Dia já protegido: " + br});
    if (somas[br]) return respJSON({"status": "erro", "mensagem": "Você estudou em " + br + ": não precisa de escudo."});
    novas.push(br);
  }
  novas.sort(function(a, b) { return isoDeBR(a) < isoDeBR(b) ? -1 : 1; });

  // Escudos disponíveis: compras ainda não usadas (a ordem de uso é a ordem de compra)
  var disponiveis = esc.compras.slice().sort().slice(esc.usados.length);
  if (novas.length > disponiveis.length) return respJSON({"status": "erro", "mensagem": "Escudos insuficientes."});
  for (var j = 0; j < novas.length; j++) {
    if (disponiveis[j] > isoDeBR(novas[j])) {
      return respJSON({"status": "erro", "mensagem": "O escudo foi comprado depois de " + novas[j] + " e não cobre esse dia."});
    }
  }

  esc.usados = esc.usados.concat(novas);
  gravarEscudos(sheetU, idx, esc);
  SpreadsheetApp.flush(); // TRAVA DE SEGURANÇA
  return respJSON({"status": "sucesso", "escudos": esc, "moedas": resumoMoedas(moedasGanhas(somas), esc)});
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