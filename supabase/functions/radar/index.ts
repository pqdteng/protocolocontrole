// Radar de Editais (Edge Function "radar"): mesma busca do acaoRadar() do Code.gs.
// Lê o RSS do PCI Concursos (ou, se falhar, o blog do Estratégia), tira repetidas e
// devolve { status, noticias: [{ titulo, link, pubDate, fonte, descricao, trecho, categorias }] }.
// Guarda o resultado por 30 minutos. Publicar com "Verify JWT" LIGADO (só aluno logado).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const CACHE_MS = 30 * 60 * 1000;
const UA = "Mozilla/5.0 (compatible; ProtocoloControle-Radar/1.0)";

let cache: { em: number; json: string } | null = null;

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
  const r = await fetch(url, { headers: { "User-Agent": UA } });
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
  const extrair = (xml: string, fonte: string) => {
    let novos = 0;
    const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
    let m: RegExpExecArray | null;
    while ((m = itemRegex.exec(xml)) !== null && noticias.length < 60) {
      const bloco = m[1];
      const campo = (tag: string) => {
        const r = new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i").exec(bloco);
        return r ? r[1].trim() : "";
      };
      const titulo = campo("title") || "Notícia de concurso";
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
        titulo, link, pubDate: campo("pubDate"), fonte,
        descricao: descricao ? textoLimpo(descricao, 600) : "",
        trecho: conteudo ? textoLimpo(conteudo, 2000) : "",
        categorias,
      });
      novos++;
    }
    return novos;
  };

  let xml = "";
  try { xml = await lerFeed("https://www.pciconcursos.com.br/rss/"); } catch { xml = ""; }
  if (xml.includes("<rss") || xml.includes("<feed")) {
    extrair(xml, "PCI Concursos");
  } else {
    for (let pagina = 1; pagina <= 5 && noticias.length < 60; pagina++) {
      const est = await lerFeed("https://www.estrategiaconcursos.com.br/blog/feed/?paged=" + pagina);
      if (extrair(est, "Blog Estratégia Concursos") === 0) break;
    }
  }
  return noticias;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (cache && Date.now() - cache.em < CACHE_MS) return resposta(cache.json);
  try {
    const noticias = await buscar();
    const json = JSON.stringify({ status: "sucesso", noticias });
    if (noticias.length > 0) cache = { em: Date.now(), json };
    return resposta(json);
  } catch (err) {
    return resposta(JSON.stringify({ status: "erro", mensagem: "Falha na varredura: " + (err as Error).message }));
  }
});
