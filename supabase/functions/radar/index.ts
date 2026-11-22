// Radar de Editais (Edge Function "radar"): mesma busca do acaoRadar() do Code.gs.
// Lê os feeds de notícias de concursos (vários ao mesmo tempo; se um falhar, os outros seguem), tira repetidas e
// devolve { status, noticias: [{ titulo, link, pubDate, fonte, descricao, trecho, categorias }] }.
// Guarda o resultado por 30 minutos. Publicar com "Verify JWT" LIGADO (só aluno logado).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const CACHE_MS = 30 * 60 * 1000;
const UA = "Mozilla/5.0 (compatible; ProtocoloControle-Radar/1.0)";
const MAX_NOTICIAS = 250;
const MAX_POR_FONTE = 150; // nenhuma fonte ocupa o radar inteiro
// Google Notícias: busca de concursos dos últimos 7 dias em vários jornais e portais.
// Cada notícia sai com o nome do veículo original como fonte.
const GOOGLE = (q: string) => "https://news.google.com/rss/search?q=" + encodeURIComponent(q) + "&hl=pt-BR&gl=BR&ceid=BR:pt-419";
// Fontes, em ordem de preferência. Cada uma pode falhar sozinha sem derrubar o radar.
// (PCI tirou o RSS do ar e o Estratégia bloqueia robôs desde nov/2026: ficam na lista caso voltem.)
const FONTES: { nome: string; urls: string[] }[] = [
  { nome: "Google Notícias", urls: [GOOGLE("concurso edital when:7d"), GOOGLE("concurso público inscrições when:7d"),
                                    GOOGLE("concurso autorizado vagas when:7d")] },
  { nome: "Blog Gran Cursos Online", urls: [1, 2, 3, 4, 5, 6, 7].map(p => "https://blog.grancursosonline.com.br/feed/" + (p > 1 ? "?paged=" + p : "")) },
  { nome: "PCI Concursos", urls: ["https://www.pciconcursos.com.br/rss/"] },
  { nome: "Blog Estratégia Concursos", urls: ["https://concursos.estrategia.com/portal/feed/"] },
];

let cache: { em: number; json: string } | null = null;
let diag: string[] = [];

function resposta(texto: string) {
  return new Response(texto, { headers: { ...CORS, "Content-Type": "application/json" } });
}

// HTML do feed vira texto curto (igual a textoLimpoRadar)
function textoLimpo(html: string, max = 600) {
  let t = String(html || "");
  t = t.replace(/<p>\s*(O post|The post)[\s\S]*?(apareceu primeiro em|appeared first on)[\s\S]*?<\/p>/gi, " ");
  t = t.replace(/<(script|style|figure)[\s\S]*?<\/\1>/gi, " ");
  t = t.replace(/<\/(td|th)>/gi, ": ");
  t = t.replace(/<br\s*\/?>|<\/(p|li|h\d|div|tr)>/gi, ". ");
  t = t.replace(/<[^>]+>/g, " ");
  t = t.replace(/\[(&#8230;|…|\.\.\.)\]/g, " ");
  t = t.replace(/\s+/g, " ").replace(/:\s*\./g, ".").replace(/([.!?])\s*\./g, "$1").replace(/(\.\s*){2,}/g, ". ").trim();
  return t.substring(0, max);
}

// Respeita o charset do feed (o Deno lê tudo como UTF-8 por padrão)
async function lerFeed(url: string) {
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12000) });
  diag.push(r.status + " " + url);
  if (!r.ok) return "";
  const bytes = new Uint8Array(await r.arrayBuffer());
  let charset = (/charset=([\w-]+)/i.exec(r.headers.get("content-type") || "") || [])[1];
  if (!charset) {
    const cabeca = new TextDecoder("latin1").decode(bytes.slice(0, 200));
    charset = (/encoding=["']([\w-]+)["']/i.exec(cabeca) || [])[1] || "utf-8";
  }
  try { return new TextDecoder(charset.toLowerCase()).decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}

async function buscar() {
  const noticias: any[] = [];
  const vistos: Record<string, boolean> = {};
  const porFonte: Record<string, number> = {};
  const extrair = (xml: string, fonte: string) => {
    let novos = 0;
    const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
    let m: RegExpExecArray | null;
    while ((m = itemRegex.exec(xml)) !== null && noticias.length < MAX_NOTICIAS && (porFonte[fonte] || 0) < MAX_POR_FONTE) {
      const bloco = m[1];
      const campo = (tag: string) => {
        const r = new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i").exec(bloco);
        return r ? r[1].trim() : "";
      };
      // Google Notícias: <source> traz o veículo original; o título termina com " - Veículo"
      const fonteOrig = (/<source[^>]*>([\s\S]*?)<\/source>/i.exec(bloco) || [])[1];
      const doGoogle = !!fonteOrig;
      const fonteItem = doGoogle ? textoLimpo(fonteOrig, 80) : fonte;
      let titulo = campo("title") || "Notícia de concurso";
      if (doGoogle && titulo.endsWith(" - " + fonteOrig.trim())) titulo = titulo.slice(0, -(fonteOrig.trim().length + 3));
      const link = campo("link") || "#";
      const chaveL = "l:" + link.toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
      const chaveT = "t:" + titulo.toLowerCase().replace(/\s+/g, " ");
      if (vistos[chaveL] || vistos[chaveT]) continue;
      vistos[chaveL] = vistos[chaveT] = true;
      const categorias: string[] = [];
      const catRegex = /<category>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/category>/gi;
      let c: RegExpExecArray | null;
      while ((c = catRegex.exec(bloco)) !== null && categorias.length < 8) categorias.push(textoLimpo(c[1], 60));
      const descricao = campo("description");
      const conteudo = campo("content:encoded");
      noticias.push({
        titulo, link, pubDate: campo("pubDate"), fonte: fonteItem,
        descricao: descricao && !doGoogle ? textoLimpo(descricao, 600) : "",
        trecho: conteudo ? textoLimpo(conteudo, 2000) : "",
        categorias,
      });
      novos++;
      porFonte[fonte] = (porFonte[fonte] || 0) + 1;
    }
    return novos;
  };

  // Baixa tudo em paralelo; feed que falhar vira texto vazio
  const textos = await Promise.all(FONTES.map(f =>
    Promise.all(f.urls.map(u => lerFeed(u).catch(e => { diag.push("falhou " + u + ": " + (e as Error).message); return ""; })))));
  FONTES.forEach((f, i) => textos[i].forEach(xml => {
    if (xml.includes("<rss") || xml.includes("<feed")) extrair(xml, f.nome);
  }));
  return noticias;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const diagnostico = new URL(req.url).searchParams.get("diag") === "1";
  if (!diagnostico && cache && Date.now() - cache.em < CACHE_MS) return resposta(cache.json);
  try {
    diag = [];
    const noticias = await buscar();
    if (diagnostico) return resposta(JSON.stringify({ status: "sucesso", total: noticias.length, fontes: diag }));
    const json = JSON.stringify({ status: "sucesso", noticias });
    if (noticias.length > 0) cache = { em: Date.now(), json };
    return resposta(json);
  } catch (err) {
    return resposta(JSON.stringify({ status: "erro", mensagem: "Falha na varredura: " + (err as Error).message }));
  }
});
