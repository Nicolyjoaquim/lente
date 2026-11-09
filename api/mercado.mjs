// Função da Vercel: gera o capítulo "Mercado e estratégia" de uma empresa com IA.
// 1) busca notícias recentes da empresa na GNews; 2) envia notícias + números da CVM + concorrentes ao Gemini;
// 3) devolve um JSON com título, leitura para a tese, descrição dos concorrentes, linha do tempo,
//    tendências, oportunidades, ameaças e vantagens competitivas.
// Com ?modo=pares, escolhe com IA os 2 ou 3 concorrentes diretos da empresa entre as empresas da bolsa.
// As chaves ficam nas variáveis de ambiente GEMINI_API_KEY e GNEWS_API_KEY (painel da Vercel).

const TICKER = /^[A-Z]{4}\d{1,2}$/;
// modelos mais rápidos primeiro: respostas mais rápidas para quem está usando
const MODELOS = (process.env.GEMINI_MODEL || "gemini-flash-lite-latest,gemini-2.5-flash-lite,gemini-flash-latest")
  .split(",").map((s) => s.trim()).filter(Boolean);

const ORCAMENTO_MS = 45000;
// para escolher concorrentes vale mais a qualidade do que a velocidade (a resposta é curta e fica guardada 30 dias)
const MODELOS_PARES = ["gemini-2.5-flash", "gemini-flash-latest", "gemini-flash-lite-latest"];

export const maxDuration = 60;

export async function GET(req) {
  const t0 = Date.now();
  const url = new URL(req.url);
  const tk = (url.searchParams.get("ticker") || "").toUpperCase();
  const pares = (url.searchParams.get("pares") || "").toUpperCase().split(",").filter((t) => TICKER.test(t)).slice(0, 8);
  if (!TICKER.test(tk)) return json({ error: "ticker inválido" }, 400);
  const gkey = process.env.GEMINI_API_KEY, nkey = process.env.GNEWS_API_KEY;
  if (!gkey || !nkey) return json({ error: "Configure GEMINI_API_KEY e GNEWS_API_KEY na Vercel" }, 500);
  if (url.searchParams.get("modo") === "pares") return escolherPares(url, tk, gkey, t0);

  // dados da própria empresa e dos pares (arquivos gerados pelo robô da CVM, publicados no mesmo site)
  const ler = async (t) => {
    try { const r = await fetch(`${url.origin}/data/cvm/${t}.json`, { signal: AbortSignal.timeout(5000) }); return r.ok ? await r.json() : null; } catch { return null; }
  };
  // nome curto de mercado enviado pela Lente (ex.: "Petrobras"), que acha mais notícias que a razão social
  const nomeQ = (url.searchParams.get("nome") || "").replace(/[^\p{L}\p{N} .&'-]/gu, "").trim().slice(0, 60);
  // dados da empresa, dos pares e notícias, tudo em paralelo
  const [d, brutos, noticiasQ] = await Promise.all([
    ler(tk),
    Promise.all(pares.map(ler)),
    nomeQ ? buscarNoticias(nomeQ, nkey) : Promise.resolve(null),
  ]);
  if (!d) return json({ error: "empresa sem dados da CVM" }, 404);
  const dp = brutos.map((x, i) => x && { ticker: pares[i], nome: x.nome, setor: x.setor }).filter(Boolean);
  const nome = nomeQ || limparNome(d.nome);
  const noticias = noticiasQ || (await buscarNoticias(nome, nkey));
  const tDados = Date.now() - t0;

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

  const { ia, modeloUsado, ultimoErro } = await gemini(prompt, gkey, t0);
  if (!ia) return json({ error: "Não consegui gerar o capítulo agora", detalhe: ultimoErro, ms_dados: tDados, ms_total: Date.now() - t0 }, 502);

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
    ms: Date.now() - t0,
  }, 200, true);
}

// Chama o Gemini tentando os modelos em ordem, dentro do orçamento de tempo.
async function gemini(prompt, gkey, t0, maxTokens = 2000, aceitar = () => true, modelos = MODELOS) {
  let ia = null, modeloUsado = null, ultimoErro = "", bruto = "";
  for (const m of modelos) {
    const resta = ORCAMENTO_MS - (Date.now() - t0);
    if (resta < 3000) { ultimoErro += " | sem tempo para outro modelo"; break; }
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        signal: AbortSignal.timeout(resta),
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": gkey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: maxTokens },
        }),
      });
      if (!r.ok) { ultimoErro += ` | ${m}: ${r.status} ${(await r.text()).slice(0, 120)}`; continue; }
      const out = await r.json();
      const txt = out?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
      bruto = txt.slice(0, 300);
      const x = JSON.parse(txt.replace(/^```(json)?|```$/g, "").trim());
      if (!aceitar(x)) { ultimoErro += ` | ${m}: resposta sem concorrentes válidos`; continue; }
      ia = x;
      modeloUsado = m;
      break;
    } catch (e) { ultimoErro += ` | ${m}: ${e.name === "TimeoutError" ? "demorou demais" : e.message}`; }
  }
  return { ia, modeloUsado, ultimoErro, bruto };
}

// Escolhe de 1 a 3 concorrentes DIRETOS (mesmo negócio principal), como faria um analista do setor.
// A IA só pode escolher entre as empresas listadas na bolsa que têm dados da CVM na Lente.
async function escolherPares(url, tk, gkey, t0) {
  let idx;
  try { idx = await (await fetch(`${url.origin}/data/cvm/index.json`, { signal: AbortSignal.timeout(5000) })).json(); }
  catch { return json({ error: "índice da CVM indisponível" }, 502); }
  const emp = idx.empresas || [];
  const me = emp.find((e) => e.t === tk);
  if (!me) return json({ error: "empresa sem dados da CVM" }, 404);
  const nomeQ = (url.searchParams.get("nome") || "").replace(/[^\p{L}\p{N} .&'-]/gu, "").trim().slice(0, 60);
  const nome = nomeQ || limparNome(me.n);
  const chave = (e) => e.c || e.n;
  const vistos = new Set([chave(me)]), lista = [];
  for (const e of emp) {
    if (vistos.has(chave(e))) continue;
    vistos.add(chave(e));
    lista.push(e);
  }
  const prompt = `Você é analista de research de ações no Brasil. Escolha os concorrentes diretos de ${nome} (${tk}, ${me.n}, setor CVM "${me.s}") para uma comparação de múltiplos, como faria um analista que cobre o setor.

Critérios: mesmo negócio principal, mesmos clientes ou produtos, e comparáveis usados pelo mercado. Exemplos: Sabesp → Copasa e Sanepar; Magazine Luiza → Casas Bahia; Renner → C&A e Guararapes; Petrobras → PRIO e Brava; Localiza → Movida.
Não escolha empresas de outro negócio só porque estão no mesmo setor amplo (ex.: elétricas não são concorrentes de saneamento). Não escolha holdings ou controladas do mesmo grupo.
Escolha no máximo 3, de preferência 2, ordenados do mais comparável para o menos. Se não houver nenhum concorrente direto listado (ex.: Ambev, única grande cervejaria da bolsa), escolha as 2 empresas com modelo de negócio mais parecido (ex.: bens de consumo de marca, mesma cadeia) e marque "sem_concorrente_direto": true.

Empresas disponíveis (ticker: nome | setor):
${lista.map((e) => `${e.t}: ${e.n} | ${e.s}`).join("\n")}

Responda apenas com JSON: {"sem_concorrente_direto":false,"pares":[{"ticker":"","motivo":"até 12 palavras: por que é comparável"}]}`;
  const validos = new Map(lista.map((e) => [e.t, e]));
  const extrair = (ia) => {
    const arr = Array.isArray(ia) ? ia : (ia && (ia.pares || ia.concorrentes || ia.peers)) || [];
    return arr
      .map((p) => (typeof p === "string" ? { ticker: p } : p || {}))
      .map((p) => ({ t: String(p.ticker || p.t || p.codigo || "").toUpperCase().replace(/\.SA$/, "").trim(), motivo: String(p.motivo || p.razao || "").slice(0, 140) }))
      .filter((p) => validos.has(p.t) && p.t !== tk)
      .slice(0, 3);
  };
  // se um modelo devolver lista vazia ou tickers que não existem, tenta o próximo
  const { ia, modeloUsado, ultimoErro, bruto } = await gemini(prompt, gkey, t0, 4000, (x) => extrair(x).length > 0, MODELOS_PARES);
  if (!ia) return json({ error: "Não consegui escolher os concorrentes agora", detalhe: ultimoErro, bruto }, 502);
  const pares = extrair(ia);
  const semDireto = !Array.isArray(ia) && ia && ia.sem_concorrente_direto === true;
  return json({ ticker: tk, modelo: modeloUsado, pares, sem_direto: semDireto, ms: Date.now() - t0 }, 200, true, 2592000);
}

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
    const r = await fetch(`https://gnews.io/api/v4/search?q=${q}&lang=pt&country=br&max=10&sortby=publishedAt&apikey=${key}`, { signal: AbortSignal.timeout(6000) });
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

function json(body, status = 200, cache = false, segundos = 604800) {
  const headers = { "Content-Type": "application/json; charset=utf-8" };
  if (cache) {
    // Guarda no CDN da Vercel (capítulo: 7 dias; concorrentes: 30 dias) para economizar cota do Gemini e da GNews.
    headers["Vercel-CDN-Cache-Control"] = `public, s-maxage=${segundos}, stale-while-revalidate=86400`;
  } else {
    headers["Cache-Control"] = "no-store";
    headers["Vercel-CDN-Cache-Control"] = "no-store";
  }
  return new Response(JSON.stringify(body), { status, headers });
}
