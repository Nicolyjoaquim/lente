"""Robô de coleta da Lente: baixa os balanços anuais (DFP) do Portal de Dados Abertos da CVM
e gera um arquivo por empresa no formato que a Lente importa.

Uso:
  python scripts/cvm_coleta.py                    # baixa da CVM (usado pelo GitHub Actions)
  python scripts/cvm_coleta.py --local PASTA      # usa zips já baixados em PASTA (para testes)

Saída: data/cvm/index.json (lista de empresas) e data/cvm/<TICKER>.json (uma por ticker).
Só usa a biblioteca padrão do Python.
"""
import argparse
import csv
import datetime as dt
import io
import json
import os
import re
import sys
import unicodedata
import urllib.request
import zipfile

BASE = "https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC"
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "cvm")
N_ANOS = 5  # anos de histórico entregues à Lente

csv.field_size_limit(10**8)


def norm(s):
    s = unicodedata.normalize("NFD", s or "")
    return "".join(c for c in s if unicodedata.category(c) != "Mn").lower().strip()


# ---------------------------------------------------------------- download / leitura
def baixar(url, destino):
    req = urllib.request.Request(url, headers={"User-Agent": "lente-coleta/1.0"})
    with urllib.request.urlopen(req, timeout=180) as r, open(destino, "wb") as f:
        f.write(r.read())


def obter_zip(nome, pasta_local, subdir):
    caminho = os.path.join(pasta_local, nome)
    if os.path.exists(caminho):
        return caminho
    if ARGS.local:
        return None
    try:
        baixar(f"{BASE}/{subdir}/DADOS/{nome}", caminho)
        return caminho
    except Exception as e:  # ano ainda não publicado, etc.
        print(f"  aviso: não consegui baixar {nome}: {e}")
        return None


def ler_csv(zf, nome):
    alvo = [n for n in zf.namelist() if n.lower() == nome.lower()]
    if not alvo:
        return []
    with zf.open(alvo[0]) as f:
        return list(csv.DictReader(io.TextIOWrapper(f, encoding="latin-1"), delimiter=";"))


def ultima_versao(linhas):
    """Mantém só a versão mais recente de cada documento (reapresentações)."""
    maior = {}
    for l in linhas:
        k = (l["CD_CVM"], l["DT_REFER"])
        maior[k] = max(maior.get(k, 0), int(l.get("VERSAO") or 0))
    return [l for l in linhas if int(l.get("VERSAO") or 0) == maior[(l["CD_CVM"], l["DT_REFER"])]]


# ---------------------------------------------------------------- demonstrativos
def valor(l):
    v = float(l["VL_CONTA"] or 0)
    esc = (l.get("ESCALA_MOEDA") or "").upper()
    if esc == "MIL":
        v *= 1e3
    return v / 1e6  # R$ milhões


def indexar(linhas):
    """{(cd_cvm, ano): {cd_conta: (descricao, valor)}} usando a data de fim do exercício."""
    out = {}
    for l in ultima_versao(linhas):
        ano = l["DT_FIM_EXERC"][:4]
        out.setdefault((l["CD_CVM"], ano), {})[l["CD_CONTA"]] = (l["DS_CONTA"], valor(l))
    return out


def conta(d, codigo):
    v = d.get(codigo)
    return v[1] if v else None


def por_nome(d, prefixo, *palavras, excluir=()):
    """Soma as contas abaixo de `prefixo` cuja descrição contém todas as `palavras`."""
    tot, achou = 0.0, False
    for cod, (ds, v) in d.items():
        if not cod.startswith(prefixo + "."):
            continue
        n = norm(ds)
        if all(p in n for p in palavras) and not any(x in n for x in excluir):
            tot += v
            achou = True
    return tot if achou else None


def depreciacao(dfc):
    """D&A vem da DFC (método indireto): soma ajustes de depreciação, amortização e exaustão."""
    if not dfc:
        return None
    tot, achou = 0.0, False
    for cod, (ds, v) in dfc.items():
        if not cod.startswith("6.01.01."):
            continue
        n = norm(ds)
        if ("deprecia" in n or "amortiza" in n or "exaust" in n) and "agio" not in n and "custo de transac" not in n:
            tot += abs(v)
            achou = True
    return tot if achou else None


def nao_controladores(bpp):
    for cod, (ds, v) in bpp.items():
        if cod.startswith("2.03.") and "nao controlador" in norm(ds):
            return v
    return 0.0


def lucro_controladores(dre):
    for cod, (ds, v) in dre.items():
        if cod.startswith("3.11.") and "controladora" in norm(ds):
            return v
    return conta(dre, "3.11") if conta(dre, "3.11") is not None else conta(dre, "3.09")


def eh_financeira(dre):
    ds = norm((dre.get("3.01") or ("", 0))[0])
    return any(p in ds for p in ("intermediacao", "premios", "receitas de seguros", "prestacao de servicos de previdencia"))


def montar_ano(dre, bpa, bpp, dfc):
    rec = conta(dre, "3.01")
    ebit = conta(dre, "3.05")
    if rec is None or ebit is None or conta(bpa, "1") is None:
        return None
    emp = (conta(bpp, "2.01.04") or 0) + (conta(bpp, "2.02.01") or 0)
    # caixa, aplicações de curto prazo e aplicações financeiras de longo prazo
    caixa = (conta(bpa, "1.01.01") or 0) + (conta(bpa, "1.01.02") or 0) + (por_nome(bpa, "1.02.01", "aplicac") or 0)
    vend, adm = conta(dre, "3.04.01"), conta(dre, "3.04.02")
    desp = None if vend is None and adm is None else -((vend or 0) + (adm or 0))
    nci = nao_controladores(bpp)
    plt = conta(bpp, "2.03")
    return {
        "receita": rec,
        "cpv": conta(dre, "3.02"),
        # despesas fixas = vendas + gerais e administrativas, como número positivo (a DRE traz negativo)
        "despesas_operacionais": desp,
        "ebit": ebit,
        "resultado_financeiro": conta(dre, "3.06"),
        "lair": conta(dre, "3.07"),
        "lucro_liquido": lucro_controladores(dre),
        "da": depreciacao(dfc),
        "ativo_total": conta(bpa, "1"),
        "intangivel": conta(bpa, "1.02.04"),
        "pl_total": plt,
        "pl": None if plt is None else plt - nci,
        "minoritarios": nci,
        "divida_bruta": emp,
        "caixa": caixa,
        "divida_liquida": emp - caixa,
    }


# ---------------------------------------------------------------- cadastro e tickers
def carregar_fca(pasta):
    ano = dt.date.today().year
    for a in (ano, ano - 1):
        z = obter_zip(f"fca_cia_aberta_{a}.zip", pasta, "FCA")
        if z:
            with zipfile.ZipFile(z) as zf:
                vm = ler_csv(zf, f"fca_cia_aberta_valor_mobiliario_{a}.csv")
                geral = ler_csv(zf, f"fca_cia_aberta_geral_{a}.csv")
            if vm:
                return vm, geral
    return [], []


def tickers_por_cnpj(vm):
    """Códigos de negociação ativos na bolsa, mais recentes por empresa."""
    maior = {}
    for l in vm:
        k = l["CNPJ_Companhia"]
        maior[k] = max(maior.get(k, 0), int(l.get("Versao") or 0))
    out = {}
    for l in vm:
        if int(l.get("Versao") or 0) != maior[l["CNPJ_Companhia"]]:
            continue
        cod = (l.get("Codigo_Negociacao") or "").strip().upper()
        if not re.fullmatch(r"[A-Z]{4}\d{1,2}", cod):
            continue
        if (l.get("Data_Fim_Negociacao") or "").strip():
            continue
        if "bolsa" not in norm(l.get("Mercado", "")):
            continue
        out.setdefault(l["CNPJ_Companhia"], [])
        if cod not in out[l["CNPJ_Companhia"]]:
            out[l["CNPJ_Companhia"]].append(cod)
    return out


def setores(geral):
    out = {}
    for l in geral:
        s = (l.get("Setor_Atividade") or "").strip()
        if s:
            out[l["CNPJ_Companhia"]] = s
    return out


# ---------------------------------------------------------------- principal
def main():
    pasta = ARGS.local or os.path.join(os.path.dirname(__file__), "..", ".cache_cvm")
    os.makedirs(pasta, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)

    # Um zip DFP traz o último e o penúltimo exercício: 3 arquivos cobrem 5 anos.
    ultimo = dt.date.today().year - 1
    zips = []
    for a in range(ultimo, ultimo - N_ANOS, -2):
        z = obter_zip(f"dfp_cia_aberta_{a}.zip", pasta, "DFP")
        if z:
            zips.append((a, z))
    if not zips:
        sys.exit("Nenhum arquivo DFP disponível.")
    ano_ref = zips[0][0]
    print("DFPs:", [a for a, _ in zips])

    dados, nomes, cnpjs, acoes = {}, {}, {}, {}
    for a, z in zips:  # do mais novo para o mais antigo
        with zipfile.ZipFile(z) as zf:
            dre = indexar(ler_csv(zf, f"dfp_cia_aberta_DRE_con_{a}.csv"))
            bpa = indexar(ler_csv(zf, f"dfp_cia_aberta_BPA_con_{a}.csv"))
            bpp = indexar(ler_csv(zf, f"dfp_cia_aberta_BPP_con_{a}.csv"))
            dfc = indexar(ler_csv(zf, f"dfp_cia_aberta_DFC_MI_con_{a}.csv"))
            cad = ler_csv(zf, f"dfp_cia_aberta_{a}.csv")
            cap = ler_csv(zf, f"dfp_cia_aberta_composicao_capital_{a}.csv")
        for l in cad:
            nomes.setdefault(l["CD_CVM"], l["DENOM_CIA"])
            cnpjs.setdefault(l["CD_CVM"], l["CNPJ_CIA"])
        cnpj_cd = {v: k for k, v in cnpjs.items()}
        for l in cap:
            cd = cnpj_cd.get(l.get("CNPJ_CIA"))
            if cd and cd not in acoes:
                try:
                    tot = float(l.get("QT_ACAO_TOTAL_CAP_INTEGR") or 0) - float(l.get("QT_ACAO_TOTAL_TESOURO") or 0)
                    if tot > 0:
                        acoes[cd] = tot
                except ValueError:
                    pass
        for (cd, ano), d in dre.items():
            if (cd, ano) in dados or ("fin", cd) in dados:
                continue
            if eh_financeira(d):
                dados[("fin", cd)] = True
                continue
            linha = montar_ano(d, bpa.get((cd, ano), {}), bpp.get((cd, ano), {}), dfc.get((cd, ano)))
            if linha:
                dados[(cd, ano)] = linha

    vm, geral = carregar_fca(pasta)
    tk = tickers_por_cnpj(vm)
    st = setores(geral)
    hoje = dt.date.today().isoformat()

    indice, gerados = [], 0
    por_cd = {}
    for (cd, ano), v in dados.items():
        if cd == "fin":
            continue
        por_cd.setdefault(cd, {})[ano] = v
    for cd, anos in por_cd.items():
        if ("fin", cd) in dados:
            continue
        lista = sorted(anos)[-N_ANOS:]
        if len(lista) < 2 or lista[-1] < str(ano_ref - 1):
            continue  # pouco histórico ou empresa sem balanço recente
        cnpj = cnpjs.get(cd)
        setor = st.get(cnpj, "Setor não informado")
        if any(p in norm(setor) for p in ("banco", "segurad", "intermediacao financeira", "credito imobiliario", "arrendamento", "securitiz")):
            continue  # instituições financeiras usam outro plano de contas
        codigos = tk.get(cnpj, [])
        if not codigos:
            continue  # sem ação negociada em bolsa
        serie = lambda k: [None if anos[a][k] is None else round(anos[a][k], 3) for a in lista]
        avisos = []
        if any(x is None for x in serie("da")):
            avisos.append("D&A não encontrada em algum ano (DFC pelo método direto ou conta com outro nome).")
        # Algumas empresas informam a quantidade de ações em milhares: se o patrimônio por ação
        # passa de R$ 1.000, a contagem está em milhares e é corrigida.
        acoes_mi = acoes[cd] / 1e6 if cd in acoes else None
        pl_ult = anos[lista[-1]]["pl"]
        if acoes_mi and pl_ult and abs(pl_ult / acoes_mi) > 1000:
            acoes_mi *= 1000
            avisos.append("Quantidade de ações informada em milhares na CVM; convertida.")
            if abs(pl_ult / acoes_mi) > 1000:
                avisos.append("Quantidade de ações incomum: confira antes de analisar.")
        base = {
            "_fonte": "CVM – Dados Abertos, DFP consolidada (R$ milhões)",
            "_atualizado": hoje,
            "_avisos": avisos,
            "nome": nomes.get(cd, ""),
            "setor": setor,
            "cd_cvm": cd,
            "anos": lista,
            "receita": serie("receita"),
            "ebit": serie("ebit"),
            "da": [0 if x is None else x for x in serie("da")],
            "resultado_financeiro": serie("resultado_financeiro"),
            "lucro_liquido": serie("lucro_liquido"),
            "despesas_operacionais": serie("despesas_operacionais"),
            "ativo_total": serie("ativo_total"),
            "intangivel": serie("intangivel"),
            "pl": serie("pl"),
            "divida_liquida": serie("divida_liquida"),
            "minoritarios": round(anos[lista[-1]]["minoritarios"] or 0, 3),
            "acoes_mi": None if acoes_mi is None else round(acoes_mi, 3),
        }
        for t in codigos:
            arq = dict(base, ticker=t, outros_tickers=[x for x in codigos if x != t])
            with open(os.path.join(OUT, f"{t}.json"), "w", encoding="utf-8") as f:
                json.dump(arq, f, ensure_ascii=False, separators=(",", ":"))
            # g = grupo de setor (sem o prefixo de holding), c = empresa, r = receita do último ano:
            # usados pela Lente para sugerir concorrentes do mesmo setor e porte parecido
            grupo = re.sub(r"^Emp\. Adm\. Part\. - ", "", setor)
            indice.append({"t": t, "n": base["nome"], "s": setor, "g": grupo, "c": cd, "r": round(base["receita"][-1] or 0)})
            gerados += 1

    indice.sort(key=lambda x: x["t"])
    with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as f:
        json.dump({"atualizado": hoje, "empresas": indice}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{gerados} tickers gerados em {os.path.normpath(OUT)}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--local", help="pasta com os zips da CVM já baixados (não baixa nada)")
    ARGS = p.parse_args()
    main()
