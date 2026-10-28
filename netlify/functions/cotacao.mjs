// Netlify Function: intermediário entre a Lente e a API da brapi.dev.
// O token fica guardado na variável de ambiente BRAPI_TOKEN (configurada no painel do Netlify),
// nunca no código que roda no navegador.

const TICKER = /^[A-Z]{4}\d{1,2}$/;
const MAX_TICKERS = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async (req) => {
  const url = new URL(req.url);
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
