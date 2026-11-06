// Netlify Function: intermediário entre a Lente e a API da brapi.dev.
// O token fica guardado na variável de ambiente BRAPI_TOKEN (configurada no painel do Netlify),
// nunca no código que roda no navegador.

const TICKER = /^[A-Z]{4}\d{1,2}$/;
const MAX_TICKERS = 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("lista")) return lista();
  const tickers = (url.searchParams.get("tickers") || "")
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter((t) => TICKER.test(t))
    .slice(0, MAX_TICKERS);

  if (!tickers.length) {
    return json({ error: "Informe ao menos um ticker válido, ex.: ?tickers=WEGE3" }, 400);
  }

  const token = process.env.BRAPI_TOKEN;
  if (!token) {
    return json({ error: "BRAPI_TOKEN não configurado no Netlify" }, 500);
  }

  // O plano gratuito da brapi aceita 1 ticker por chamada e pode recusar pedidos simultâneos,
  // então buscamos uma empresa por vez e tentamos de novo uma vez se falhar.
  const quotes = {};
  for (const t of tickers) {
    let q = await getQuote(t, token);
    if (q.error) {
      await sleep(400);
      q = await getQuote(t, token);
    }
    quotes[t] = q;
  }

  const complete = Object.values(quotes).every((q) => !q.error);
  return json({ source: "brapi.dev", fetchedAt: new Date().toISOString(), complete, quotes }, 200, complete);
};

// Lista de ações da bolsa com setor de mercado e valor de mercado, usada para escolher concorrentes.
async function lista() {
  const token = process.env.BRAPI_TOKEN;
  if (!token) return json({ error: "BRAPI_TOKEN não configurado no Netlify" }, 500);
  try {
    const r = await fetch("https://brapi.dev/api/quote/list?type=stock&limit=2000", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return json({ error: `brapi respondeu ${r.status}` }, 502);
    const d = await r.json();
    const out = (d.stocks || [])
      .map((s) => ({
        t: String(s.stock || s.ticker || "").toUpperCase(),
        s: s.sector || null,
        mc: Number(s.market_cap ?? s.marketCap) || null,
      }))
      .filter((x) => TICKER.test(x.t) && x.s && x.mc > 0);
    if (!out.length) return json({ error: "lista vazia" }, 502);
    const res = json({ source: "brapi.dev", lista: out }, 200, true);
    res.headers.set("Netlify-CDN-Cache-Control", "public, durable, s-maxage=86400, stale-while-revalidate=3600");
    res.headers.set("Netlify-Vary", "query=lista");
    return res;
  } catch (e) {
    return json({ error: "falha de conexão com a brapi" }, 502);
  }
}

async function getQuote(t, token) {
  try {
    const r = await fetch(`https://brapi.dev/api/quote/${t}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return { error: `brapi respondeu ${r.status}` };
    const d = await r.json();
    const q = d && d.results && d.results[0];
    if (!q || typeof q.regularMarketPrice !== "number") return { error: "sem cotação" };
    return {
      price: q.regularMarketPrice,
      changePct: typeof q.regularMarketChangePercent === "number" ? q.regularMarketChangePercent : null,
      marketCap: typeof q.marketCap === "number" ? q.marketCap : null,
      time: q.regularMarketTime || null,
    };
  } catch (e) {
    return { error: "falha de conexão com a brapi" };
  }
}

function json(body, status = 200, cache = false) {
  const headers = { "Content-Type": "application/json; charset=utf-8" };
  if (cache) {
    // Resposta completa: guarda no CDN do Netlify por 30 min para economizar a cota da brapi.
    headers["Netlify-CDN-Cache-Control"] = "public, durable, s-maxage=1800, stale-while-revalidate=600";
    headers["Netlify-Vary"] = "query=tickers";
  } else {
    // Resposta incompleta ou erro: nunca guardar, para a próxima visita tentar de novo.
    headers["Cache-Control"] = "no-store";
    headers["Netlify-CDN-Cache-Control"] = "no-store";
  }
  return new Response(JSON.stringify(body), { status, headers });
}
