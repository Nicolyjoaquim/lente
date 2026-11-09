# Lente

Plataforma web que analisa empresas da B3 a partir dos balanços entregues à CVM e do preço da ação ao vivo.

**Site:** [lentefinance.vercel.app](https://lentefinance.vercel.app)

Comecei a Lente como trabalho da disciplina de Finanças Corporativas (nota 9,5) e depois a transformei numa ferramenta que funciona para qualquer empresa não financeira listada. Construí o projeto com vibe coding, usando o Claude para escrever o código.

## O que ela faz

1. **Você escolhe uma empresa da B3.** Os balanços dos últimos 5 anos chegam sozinhos dos dados abertos da CVM, e o preço vem ao vivo da API da brapi.
2. **A IA escolhe os concorrentes.** O Gemini indica 2 ou 3 empresas comparáveis e explica o motivo de cada uma (ex.: Sabesp → Copasa e Sanepar).
3. **A Lente faz as contas.** Alavancagem, DuPont, custos, valuation por múltiplos e ROIC contra o custo de capital, cada número com a fórmula ao lado.
4. **Você testa cenários.** Vendas, custos, Selic, dívida e múltiplo mudam e o efeito aparece no lucro, no preço e em todas as telas.
5. **Sai uma conclusão.** Tipo de empresa, riscos, pontos de monitoramento e uma indicação do modelo (compra, neutro ou venda) com os motivos.

## Como funciona

```
CVM (dados abertos)  ──►  robô semanal (GitHub Actions + Python)  ──►  data/cvm/*.json
                                                                           │
brapi (cotações)  ──►  /api/cotacao  ─┐                                    ▼
                                      ├──────────────────────────►  index.html (o site)
Gemini + GNews  ──►  /api/mercado  ───┘
```

- **`scripts/cvm_coleta.py`**: baixa as demonstrações financeiras da CVM, monta a série de cada empresa e gera um arquivo por ticker. Roda toda segunda-feira pelo GitHub Actions (`.github/workflows/cvm.yml`).
- **`api/cotacao.mjs`**: busca preços e valor de mercado na brapi. Guarda as respostas em cache para economizar a cota da API.
- **`api/mercado.mjs`**: chama o Gemini para escolher os concorrentes e para escrever o capítulo "Mercado e estratégia" a partir de notícias recentes. Se um modelo falhar, tenta o próximo.
- **`index.html`**: o site inteiro, com os cálculos feitos no navegador.

As chaves das APIs ficam em variáveis de ambiente na Vercel e nunca aparecem no código do site.

## Como conferi os números

- Comparei os dados do robô com uma base montada à mão (`conferir.py`). A WEG bateu praticamente igual.
- Tratei casos que distorciam os resultados: empresas que só entregam balanço individual (Sanepar), lucro dos controladores preenchido como zero (Sabesp), desdobramento de ações depois do último balanço e units como SAPR11.
- Ajustei os prompts até as escolhas de concorrentes ficarem coerentes, e a Lente usa uma regra de reserva quando a IA não responde.

## Limites

- Bancos e seguradoras ficam de fora: o balanço deles não tem EBITDA nem dívida líquida comparáveis.
- A indicação de compra, neutro ou venda vem de regras simples. É um projeto acadêmico, não recomendação de investimento.

## Ferramentas

Claude (vibe coding), Gemini, APIs da brapi e da GNews, dados abertos da CVM, Python, GitHub Actions e Vercel.

---

Feito por **Nicoly Pacheco Joaquim** · [LinkedIn](https://www.linkedin.com/in/nicoly-pacheco-joaquim)
