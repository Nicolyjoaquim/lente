// Netlify Function: gera o capítulo "Mercado e estratégia" de uma empresa com IA.
// 1) busca notícias recentes da empresa na GNews; 2) envia notícias + números da CVM + concorrentes ao Gemini;
// 3) devolve um JSON com título, leitura para a tese, descrição dos concorrentes, linha do tempo,
//    tendências, oportunidades, ameaças e vantagens competitivas.
// As chaves ficam nas variáveis de ambiente GEMINI_API_KEY e GNEWS_API_KEY (painel do Netlify).

const TICKER = /^[A-Z]{4}\d{1,2}$/;
const MODELOS = (process.env.GEMINI_MODEL || "gemini-flash-latest,gemini-flash-lite-latest,gemini-2.5-flash")
  .split(",").map((s) => s.trim()).filter(Boolean);

export default async (req) => {
  const url = new URL(req.url);
  const tk = (url.searchParams.get("ticker") || "").toUpperCase();
  const pares = (url.searchParams.get("pares") || "").toUpperCase().split(",").filter((t) => TICKER.test(t)).slice(0, 8);
  if (!TICKER.test(tk)) return json({ error: "ticker inválido" }, 400);
  const gkey = process.env.GEMINI_API_KEY, nkey = process.env.GNEWS_API_KEY;
  if (!gkey || !nkey) return json({ error: "Configure GEMINI_API_KEY e GNEWS_API_KEY no Netlify" }, 500);

  // dados da própria empresa e dos pares (arquivos gerados pelo robô da CVM, publicados no mesmo site)
  const ler = async (t) => {
    try { const r = await fetch(`${url.origin}/data/cvm/${t}.json`); return r.ok ? await r.json() : null; } catch { return null; }
  };
  const d = await ler(tk);
  if (!d) return json({ error: "empresa sem dados da CVM" }, 404);
  const dp = (await Promise.all(pares.map(ler))).map((x, i) => x && { ticker: pares[i], nome: x.nome, setor: x.setor }).filter(Boolean);

  // nome curto de mercado enviado pela Lente (ex.: "Petrobras"), que acha mais notícias que a razão social
  const nomeQ = (url.searchParams.get("nome") || "").replace(/[^\p{L}\p{N} .&'-]/gu, "").trim().slice(0, 60);
  const nome = nomeQ || limparNome(d.nome);
  const noticias = await buscarNoticias(nome, nkey);

  const L = d.anos.length - 1;
  const fin = {
    anos: d.anos,
    receita_mi: d.receita,
    ebit_mi: d.ebit,
    lucro_liquido_mi: d.lucro_liquido,
    divida_liquida_mi: d.divida_liquida,
    margem_ebitda_ultimo_ano: d.receita[L] ? +(((d.ebit[L] + (d.da[L] || 0)) / d.receita[L]) * 100).toFixed(1) : null,
  };

  const prompt = `Você é analista de research de ações no Brasil. Escreva o capítulo "Mercado e estratégia" sobre ${nome} (${tk}), setor "${d.setor}".

DADOS QUE VOCÊ PODE USAR (e somente estes para números e fatos recentes):
Números da CVM, em R$ milhões: ${JSON.stringify(fin)}
Concorrentes escolhidos pela ferramenta: ${JSON.stringify(dp)}
Notícias recentes (id, data, título, resumo, veículo): ${JSON.stringify(noticias.map((n, i) => ({ id: i, data: n.data, titulo: n.titulo, resumo: n.resumo, veiculo: n.fonte })))}

REGRAS:
- Português do Brasil, frases curtas e diretas, tom de relatório de análise.
- Não invente números, datas, percentuais nem fatos recentes: use só os dados acima. Conhecimento geral e estável sobre o negócio da empresa e dos concorrentes (o que fazem, onde atuam) é permitido, sem números.
- Não faça recomendação de compra ou venda.
- "noticias": escolha até 5 notícias da lista que sejam relevantes para a tese, pelo id, e resuma cada uma em até 25 palavras. Se nenhuma for relevante, devolva lista vazia.
- "concorrentes": para cada ticker de concorrente informado, uma descrição de até 12 palavras do que a empresa faz e de como compete com ${nome}.
- "tendencias", "oportunidades", "ameacas": 3 itens cada, até 20 palavras por item.
- "vantagens": 3 a 4 itens curtos (até 6 palavras cada).
- "titulo": a principal conclusão estratégica em até 12 palavras.
- "e_dai": 1 ou 2 frases ligando o contexto de mercado aos números da empresa.

Responda apenas com JSON neste formato:
{"titulo":"","e_dai":"","concorrentes":[{"ticker":"","descricao":""}],"noticias":[{"id":0,"resumo":""}],"tendencias":[""],"oportunidades":[""],"ameacas":[""],"vantagens":[""]}`;

  let ia = null, modeloUsado = null, ultimoErro = "";
  for (const m of MODELOS) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": gkey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.3 },
        }),
      });
      if (!r.ok) { ultimoErro = `${m}: ${r.status}`; continue; }
      const out = await r.json();
      const txt = out?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
      ia = JSON.parse(txt.replace(/^```(json)?|```$/g, "").trim());
      modeloUsado = m;
      break;
    } catch (e) { ultimoErro = `${m}: ${e.message}`; }
  }
  if (!ia) return json({ error: "Não consegui gerar o capítulo agora", detalhe: ultimoErro }, 502);

  const arr = (x, n) => (Array.isArray(x) ? x.filter((v) => typeof v === "string" && v.trim()).slice(0, n) : []);
  const linha = (ia.noticias || [])
    .filter((n) => Number.isInteger(n.id) && noticias[n.id] && typeof n.resumo === "string")
    .slice(0, 5)
    .map((n) => ({ ...noticias[n.id], resumo: n.resumo }))
    .sort((a, b) => (a.iso < b.iso ? 1 : -1));
  const conc = {};
  (ia.concorrentes || []).forEach((c) => { if (c && pares.includes(String(c.ticker).toUpperCase())) conc[String(c.ticker).toUpperCase()] = String(c.descricao || ""); });

  return json({
    ticker: tk,
    modelo: modeloUsado,
    gerado_em: new Date().toISOString(),
    titulo: String(ia.titulo || "Contexto de mercado"),
    e_dai: String(ia.e_dai || ""),
    concorrentes: conc,
    noticias: linha,
    tendencias: arr(ia.tendencias, 3),
    oportunidades: arr(ia.oportunidades, 3),
    ameacas: arr(ia.ameacas, 3),
    vantagens: arr(ia.vantagens, 4),
    n_noticias: noticias.length,
  }, 200, true);
};

function limparNome(n) {
  return String(n || "")
    .replace(/\s+-\s+em recupera.*$/i, "")
    .replace(/\b(S\.?A\.?|S\/A|CIA\.?|COMPANHIA|PARTICIPA[ÇC](Õ|O)ES)\b/gi, "")
    .replace(/\s+/g, " ").trim()
    .toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

async function buscarNoticias(nome, key) {
  try {
    const q = encodeURIComponent(`"${nome}"`);
    const r = await fetch(`https://gnews.io/api/v4/search?q=${q}&lang=pt&country=br&max=10&sortby=publishedAt&apikey=${key}`);
    if (!r.ok) return [];
    const d = await r.json();
    return (d.articles || []).map((a) => ({
      iso: a.publishedAt || "",
      data: a.publishedAt ? a.publishedAt.slice(0, 10).split("-").reverse().join("/") : "",
      titulo: a.title || "",
      resumo: a.description || "",
      fonte: a.source?.name || "",
      url: a.url || "",
    }));
  } catch { return []; }
}

function json(body, status = 200, cache = false) {
  const headers = { "Content-Type": "application/json; charset=utf-8" };
  if (cache) {
    // Guarda o capítulo por 7 dias no CDN do Netlify: economiza cota do Gemini e da GNews.
    headers["Netlify-CDN-Cache-Control"] = "public, durable, s-maxage=604800, stale-while-revalidate=86400";
    headers["Netlify-Vary"] = "query=ticker|pares|nome";
  } else {
    headers["Cache-Control"] = "no-store";
    headers["Netlify-CDN-Cache-Control"] = "no-store";
  }
  return new Response(JSON.stringify(body), { status, headers });
}
