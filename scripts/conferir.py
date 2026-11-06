"""Confere os números gerados pelo robô contra a base manual da Lente (WEG e Localiza).
Uso: python scripts/conferir.py
"""
import json
import os
import re

RAIZ = os.path.join(os.path.dirname(__file__), "..")
html = open(os.path.join(RAIZ, "index.html"), encoding="utf-8").read()
linha = next(l for l in html.splitlines() if l.startswith("const DATA = "))
DATA = json.loads(linha[linha.index("{"):linha.rindex("}") + 1])
YB = ["2021", "2022", "2023", "2024", "2025", "LTM"]

CAMPOS = [("receita", "rev", 1), ("ebit", "ebit", 1), ("da", "da", 1), ("resultado_financeiro", "fin", 1),
          ("lucro_liquido", "ll", 1), ("despesas_operacionais", "desp", -1), ("ativo_total", "at", 1),
          ("pl", "pl", 1), ("divida_liquida", "nd", 1)]

for code, tk in (("WEG", "WEGE3"), ("RENT3", "RENT3"), ("HAPV3", "HAPV3")):
    arq = os.path.join(RAIZ, "data", "cvm", f"{tk}.json")
    if not os.path.exists(arq):
        print(f"{tk}: sem arquivo gerado")
        continue
    r = json.load(open(arq, encoding="utf-8"))
    m = DATA[code]
    print(f"\n{tk} – robô x base manual (R$ milhões, diferença %)")
    for k_robo, k_man, sinal in CAMPOS:
        partes = []
        for i, ano in enumerate(r["anos"]):
            if ano not in YB:
                continue
            vm = m.get(k_man, [None] * 6)[YB.index(ano)]
            vr = r[k_robo][i]
            if vm is None or vr is None:
                partes.append(f"{ano}: –")
                continue
            vm *= sinal
            dif = (vr - vm) / abs(vm) * 100 if vm else 0
            partes.append(f"{ano}: {vr:,.0f} x {vm:,.0f} ({dif:+.1f}%)")
        print(f"  {k_robo:22s} " + " | ".join(partes))
