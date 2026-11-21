// Login de transição (Edge Function "login-legado").
// Quando a senha do aluno ainda é a da planilha, confere o hash antigo ("h1$salt$sha256")
// e grava a mesma senha no Supabase Auth. Depois disso o login é 100% Supabase e o hash é apagado.
// Publicar com "Verify JWT" DESLIGADO (o aluno ainda não tem sessão quando chama).

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

async function api(caminho: string, init: RequestInit = {}) {
  const headers: Record<string, string> = { apikey: SB_KEY, "Content-Type": "application/json" };
  if (SB_KEY.startsWith("eyJ")) headers.Authorization = "Bearer " + SB_KEY;
  const r = await fetch(SB_URL + caminho, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> || {}) } });
  const t = await r.text();
  let j: any = null;
  try { j = t ? JSON.parse(t) : null; } catch { j = null; }
  return { ok: r.ok, status: r.status, j };
}

async function sha256hex(texto: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Mesma conta do Code.gs: sha256(salt + ":" + senha)
async function confere(hash: string, senha: string) {
  if (hash.startsWith("h1$")) {
    const p = hash.split("$");
    return p.length === 3 && (await sha256hex(p[1] + ":" + senha)) === p[2];
  }
  return false;
}

const negar = () => json({ ok: false });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false }, 405);

  const corpo = await req.json().catch(() => ({}));
  const email = String(corpo.email || "").trim().toLowerCase();
  const senha = String(corpo.senha || "");
  if (!email || !senha || email.length > 200 || senha.length > 200) return negar();

  const perfil = await api(`/rest/v1/perfis?select=id&email=eq.${encodeURIComponent(email)}`);
  const id = perfil.j?.[0]?.id;
  if (!id) return negar();

  const leg = (await api(`/rest/v1/legado_senhas?select=hash,tentativas,bloqueado_ate&user_id=eq.${id}`)).j?.[0];
  if (!leg) return negar();
  if (leg.bloqueado_ate && new Date(leg.bloqueado_ate) > new Date()) {
    return json({ ok: false, mensagem: "Muitas tentativas. Aguarde 15 minutos e tente novamente." });
  }

  // Quem já entrou pelo Supabase (inclusive trocando a senha) não volta para a senha antiga
  const usuario = await api(`/auth/v1/admin/users/${id}`);
  if (!usuario.ok || usuario.j?.last_sign_in_at) {
    await api(`/rest/v1/legado_senhas?user_id=eq.${id}`, { method: "DELETE" });
    return negar();
  }

  if (!(await confere(String(leg.hash), senha))) {
    const t = (leg.tentativas || 0) + 1;
    await api(`/rest/v1/legado_senhas?user_id=eq.${id}`, {
      method: "PATCH",
      body: JSON.stringify(t >= 5
        ? { tentativas: 0, bloqueado_ate: new Date(Date.now() + 15 * 60 * 1000).toISOString() }
        : { tentativas: t }),
    });
    return negar();
  }

  const troca = await api(`/auth/v1/admin/users/${id}`, { method: "PUT", body: JSON.stringify({ password: senha }) });
  if (!troca.ok) {
    return json({ ok: false, mensagem: 'Sua senha antiga precisa ser trocada. Use "Esqueci minha senha".' });
  }
  await api(`/rest/v1/legado_senhas?user_id=eq.${id}`, { method: "DELETE" });
  return json({ ok: true });
});
