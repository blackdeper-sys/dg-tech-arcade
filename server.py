#!/usr/bin/env python3
"""
DG TECH ARCADE — SERVIDOR CENTRAL DE CONTROLE REMOTO 4G/WI-FI & TELEMETRIA PIX NUVEM
Foco: Monitoramento Remoto de Vendas da Barbearia (Mercado Pago Nuvem) + Disparo de Coin (ESP-01S)
Compatível com: Terminal ESP32 na Barbearia & Módulo Relé Coin
Segurança: Proteção por PIN de Acesso para Acesso via Rede Móvel (4G/5G)
"""

from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import urllib.request
import urllib.parse
import urllib.error
import json
import os
import re
import sys
import time
import threading
from datetime import datetime, timezone, timedelta

# Fuso Horário Oficial de Brasília (UTC-3)
BRAZIL_TZ = timezone(timedelta(hours=-3))

if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass
if hasattr(sys.stderr, 'reconfigure'):
    try:
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

PORT = int(os.environ.get("PORT", 8088))
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(BASE_DIR, "dados_vendas.json")
LINK_FILE = os.path.join(BASE_DIR, "LINK_ACESSO_4G.txt")

# Token de Produção do Mercado Pago vinculado ao Fliperama
DEFAULT_MP_TOKEN = "APP_USR-5529824471056733-082916-765dca4d1caf210308a55984c4d48abe-1291350873"

DEFAULT_MACHINES = [
    {
        "id": "distribuidora",
        "nome": "Distribuidora",
        "estabelecimento": "Distribuidora",
        "proprietario": "DG Tech Arcade",
        "controlador": "ESP-01S",
        "ip": "192.168.18.99",
        "status": "OFFLINE",
        "percentual_dg_tech": 100,
        "percentual_proprietario": 100,
        "percentual_parceiro": 0,
        "preco_ficha": 2.50,
        "ultimo_contato": None,
        "ultimo_pulso": None,
        "ultimo_comando": None,
        "last_heartbeat_ts": 0.0
    },
    {
        "id": "barbearia",
        "nome": "Barbearia",
        "estabelecimento": "Barbearia",
        "proprietario": "DG Tech Arcade",
        "controlador": "ESP32-CYD + ESP-01S",
        "ip": "192.168.1.63",
        "status": "OFFLINE",
        "percentual_dg_tech": 70,
        "percentual_proprietario": 70,
        "percentual_parceiro": 30,
        "preco_ficha": 2.50,
        "ultimo_contato": None,
        "ultimo_pulso": None,
        "ultimo_comando": None,
        "last_heartbeat_ts": 0.0
    }
]

# Estado persistente do sistema
data_lock = threading.RLock()
sales_data = {
    "session_cash": 0.0,
    "session_tokens": 0,
    "paid_tokens": 0,
    "courtesy_tokens": 0,
    "maintenance_tokens": 0,
    "general_tokens": 0,
    "general_cash": 0.0,
    "price_per_token": 2.50,
    "active_machine_id": "distribuidora",
    "barber_split_percent": 0,
    "owner_split_percent": 100,
    "machines": [dict(m) for m in DEFAULT_MACHINES],
    "technical_logs": [],
    "executed_commands": {},
    "pending_commands": [],
    "last_confirmed_cmd": None,
    "security_pin": "1234",
    "require_pin": False,
    "mp_access_token": DEFAULT_MP_TOKEN,
    "processed_mp_ids": [],
    "last_mp_sync": None,
    "last_mp_status": "Iniciando...",
    "events": [],
    "closed_registers": [],
    "closed_quinzenas": [],
    "daily_sales": []
}

def get_active_machine_unlocked():
    global sales_data
    active_id = sales_data.get("active_machine_id", "distribuidora")
    machines = sales_data.get("machines", [])
    found = None
    for m in machines:
        if m.get("id") == active_id:
            found = m
            break
    if not found:
        if machines:
            found = machines[0]
        else:
            default_m = dict(DEFAULT_MACHINES[0])
            sales_data["machines"] = [default_m]
            sales_data["active_machine_id"] = "distribuidora"
            found = default_m

    p_dg = found.get("percentual_dg_tech", found.get("percentual_proprietario", 100))
    p_pt = found.get("percentual_parceiro", 0)
    found["percentual_dg_tech"] = p_dg
    found["percentual_proprietario"] = p_dg
    found["percentual_parceiro"] = p_pt
    return found

def get_active_machine():
    with data_lock:
        return get_active_machine_unlocked()

def get_machine_by_id(machine_id):
    with data_lock:
        for m in sales_data.get("machines", []):
            if m.get("id") == machine_id:
                return m
        return None

def add_technical_log(cmd_id, maquina, fichas, modo, resultado, contabilizado, resposta_controlador="", detalhes=""):
    with data_lock:
        if "technical_logs" not in sales_data:
            sales_data["technical_logs"] = []
        now_br = datetime.now(BRAZIL_TZ)
        log_entry = {
            "id": len(sales_data["technical_logs"]) + 1,
            "cmd_id": str(cmd_id),
            "timestamp": now_br.timestamp(),
            "data": now_br.strftime("%d/%m/%Y"),
            "hora": now_br.strftime("%H:%M:%S"),
            "maquina": str(maquina),
            "fichas": int(fichas),
            "modo": str(modo),
            "resultado": str(resultado),
            "contabilizado": bool(contabilizado),
            "resposta_controlador": str(resposta_controlador)[:150],
            "detalhes": str(detalhes)[:200]
        }
        sales_data["technical_logs"].append(log_entry)
        if len(sales_data["technical_logs"]) > 500:
            sales_data["technical_logs"] = sales_data["technical_logs"][-500:]
        save_data()
        return log_entry

def recalculate_totals_unlocked():
    """Recalcula de forma blindada todos os totais da sessão, fechamentos e faturamento diário."""
    global sales_data
    events = sales_data.get("events", [])
    
    last_sangria_ts = 0.0
    last_sangria_id = 0
    last_sangria_info = None

    for evt in events:
        if evt.get("tipo") == "sangria":
            ts = float(evt.get("timestamp", 0.0))
            if ts >= last_sangria_ts:
                last_sangria_ts = ts
                last_sangria_id = int(evt.get("id", 0))
                last_sangria_info = {
                    "data": evt.get("data", ""),
                    "hora": evt.get("hora", ""),
                    "valor": float(evt.get("valor", 0.0)),
                    "fichas": int(evt.get("fichas", 0)),
                    "responsavel": evt.get("responsavel", "Operador")
                }

    now_br = datetime.now(BRAZIL_TZ)
    today_str = now_br.strftime("%d/%m/%Y")
    yesterday_str = (now_br - timedelta(days=1)).strftime("%d/%m/%Y")

    s_cash = 0.0
    s_tokens = 0
    s_paid = 0
    s_courtesy = 0
    s_maint = 0

    today_cash = 0.0
    today_tokens = 0
    yesterday_cash = 0.0
    yesterday_tokens = 0

    gen_tokens = 0
    gen_cash = 0.0

    daily_map = {}

    for evt in events:
        evt_ts = float(evt.get("timestamp", 0.0))
        evt_id = int(evt.get("id", 0))
        tipo = evt.get("tipo", "")
        valor = float(evt.get("valor", 0.0))
        fichas = int(evt.get("fichas", 0))
        data_str = str(evt.get("data", ""))

        if tipo == "venda":
            gen_tokens += fichas
            gen_cash += valor
            if data_str == today_str:
                today_cash += valor
                today_tokens += fichas
            elif data_str == yesterday_str:
                yesterday_cash += valor
                yesterday_tokens += fichas

            # Agrupamento diário
            if data_str:
                if data_str not in daily_map:
                    daily_map[data_str] = {"data": data_str, "valor": 0.0, "fichas": 0, "count": 0}
                daily_map[data_str]["valor"] = round(daily_map[data_str]["valor"] + valor, 2)
                daily_map[data_str]["fichas"] += fichas
                daily_map[data_str]["count"] += 1

        elif tipo in ["cortesia", "manutencao"]:
            gen_tokens += fichas

        # Eventos da sessão: ocorridos ESTRITAMENTE após a última sangria
        if evt_ts > last_sangria_ts or (evt_ts == last_sangria_ts and evt_id > last_sangria_id):
            if tipo == "venda":
                s_cash += valor
                s_tokens += fichas
                s_paid += fichas
            elif tipo == "cortesia":
                s_tokens += fichas
                s_courtesy += fichas
            elif tipo == "manutencao":
                s_maint += fichas

    sales_data["session_cash"] = round(s_cash, 2)
    sales_data["session_tokens"] = s_tokens
    sales_data["paid_tokens"] = s_paid
    sales_data["courtesy_tokens"] = s_courtesy
    sales_data["maintenance_tokens"] = s_maint
    sales_data["today_cash"] = round(today_cash, 2)
    sales_data["today_tokens"] = today_tokens
    sales_data["yesterday_cash"] = round(yesterday_cash, 2)
    sales_data["yesterday_tokens"] = yesterday_tokens
    sales_data["last_sangria"] = last_sangria_info
    if gen_tokens > sales_data.get("general_tokens", 0):
        sales_data["general_tokens"] = gen_tokens
    if gen_cash > sales_data.get("general_cash", 0.0):
        sales_data["general_cash"] = round(gen_cash, 2)

    # Ordenação dos dias de venda do mais recente para o mais antigo
    def parse_d(d_str):
        try:
            return datetime.strptime(d_str, "%d/%m/%Y")
        except Exception:
            return datetime.min

    sorted_days = sorted(daily_map.values(), key=lambda x: parse_d(x["data"]), reverse=True)
    sales_data["daily_sales"] = sorted_days

    # Sincronização permanente dos caixas fechados (closed_registers)
    if "closed_registers" not in sales_data:
        sales_data["closed_registers"] = []
    if "closed_quinzenas" not in sales_data:
        sales_data["closed_quinzenas"] = []

    existing_signatures = {(float(r.get("timestamp", 0)), float(r.get("valor", 0))) for r in sales_data["closed_registers"]}
    existing_event_ids = {r.get("event_id") for r in sales_data["closed_registers"] if r.get("event_id")}
    
    active_m = get_active_machine_unlocked()
    partner_pct = float(active_m.get("percentual_parceiro", 0))
    owner_pct = float(active_m.get("percentual_proprietario", 100))
    sales_data["barber_split_percent"] = int(partner_pct)
    sales_data["owner_split_percent"] = int(owner_pct)
    split_pct = partner_pct

    for evt in events:
        if evt.get("tipo") == "sangria":
            sig = (float(evt.get("timestamp", 0)), float(evt.get("valor", 0)))
            eid = evt.get("id")
            if eid not in existing_event_ids and sig not in existing_signatures:
                v = float(evt.get("valor", 0.0))
                if "repasse_estabelecimento" in evt or "repasse_barbearia" in evt:
                    b_val = float(evt.get("repasse_estabelecimento", evt.get("repasse_barbearia", 0.0)))
                    o_val = float(evt.get("lucro_proprietario", v - b_val))
                    s_pct = int(evt.get("split_percent", partner_pct))
                else:
                    b_val = round((v * partner_pct) / 100.0, 2)
                    o_val = round(v - b_val, 2)
                    s_pct = int(partner_pct)
                reg = {
                    "id": len(sales_data["closed_registers"]) + 1,
                    "event_id": eid,
                    "data": evt.get("data", ""),
                    "hora": evt.get("hora", ""),
                    "timestamp": float(evt.get("timestamp", 0.0)),
                    "valor": v,
                    "fichas": int(evt.get("fichas", 0)),
                    "responsavel": evt.get("responsavel", "Operador"),
                    "observacao": evt.get("observacao", ""),
                    "repasse_barbearia": b_val,
                    "repasse_estabelecimento": b_val,
                    "lucro_proprietario": o_val,
                    "split_percent": s_pct
                }
                sales_data["closed_registers"].append(reg)
                existing_signatures.add(sig)
                existing_event_ids.add(eid)

    sales_data["closed_registers"].sort(key=lambda x: (float(x.get("timestamp", 0)), int(x.get("id", 0))))
    for idx, reg in enumerate(sales_data["closed_registers"], 1):
        reg["id"] = idx

def load_data():
    global sales_data
    if os.path.exists(DATA_FILE):
        try:
            with open(DATA_FILE, "r", encoding="utf-8") as f:
                saved = json.load(f)
                sales_data.update(saved)
                # Garante chaves essenciais
                if "processed_mp_ids" not in sales_data:
                    sales_data["processed_mp_ids"] = []
                if "machines" not in sales_data or not sales_data["machines"]:
                    sales_data["machines"] = [dict(m) for m in DEFAULT_MACHINES]
                if "active_machine_id" not in sales_data:
                    sales_data["active_machine_id"] = "distribuidora"
                
                # Regra: Distribuidora 100% DG Tech Arcade, 0% Estabelecimento
                for m in sales_data.get("machines", []):
                    if m.get("id") == "distribuidora":
                        m["nome"] = "Distribuidora"
                        m["estabelecimento"] = "Distribuidora"
                        m["proprietario"] = "DG Tech Arcade"
                        m["percentual_proprietario"] = 100
                        m["percentual_dg_tech"] = 100
                        m["percentual_parceiro"] = 0
                        if not m.get("ip") or m.get("ip") in ("192.168.10.99", "192.168.1.62"):
                            m["ip"] = "192.168.18.99"
                        if not m.get("controlador"):
                            m["controlador"] = "ESP-01S"
                    elif m.get("ip") in ("192.168.10.99", "192.168.1.62"):
                        m["ip"] = "192.168.18.99"
                
                if sales_data.get("active_machine_id") == "distribuidora":
                    sales_data["barber_split_percent"] = 0
                    sales_data["owner_split_percent"] = 100
                elif "barber_split_percent" not in sales_data:
                    sales_data["barber_split_percent"] = 0

                if "technical_logs" not in sales_data:
                    sales_data["technical_logs"] = []
                if "executed_commands" not in sales_data:
                    sales_data["executed_commands"] = {}
                if "pending_commands" not in sales_data:
                    sales_data["pending_commands"] = []
                if "closed_quinzenas" not in sales_data:
                    sales_data["closed_quinzenas"] = []
                if "mp_access_token" not in sales_data or not sales_data["mp_access_token"]:
                    sales_data["mp_access_token"] = DEFAULT_MP_TOKEN
                if "events" in sales_data and sales_data["events"]:
                    sales_data["events"].sort(key=lambda x: (float(x.get("timestamp", 0)), int(x.get("id", 0))))
                recalculate_totals_unlocked()
        except Exception as e:
            print(f"[STORAGE AVISO] Falha ao carregar {DATA_FILE}: {e}")

def save_data():
    try:
        tmp_file = DATA_FILE + ".tmp"
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(sales_data, f, ensure_ascii=False, indent=2)
        os.replace(tmp_file, DATA_FILE)
    except Exception as e:
        print(f"[STORAGE ERRO] Falha ao salvar {DATA_FILE}: {e}")

def add_event(tipo, fichas, valor, descricao, origem="Painel", mp_id=None, extra=None):
    with data_lock:
        event_id = len(sales_data["events"]) + 1
        now_br = datetime.now(BRAZIL_TZ)
        evt = {
            "id": event_id,
            "tipo": tipo,  # 'manutencao', 'venda', 'cortesia', 'sangria'
            "fichas": fichas,
            "valor": valor,
            "descricao": descricao,
            "origem": origem,
            "timestamp": now_br.timestamp(),
            "hora": now_br.strftime("%H:%M:%S"),
            "data": now_br.strftime("%d/%m/%Y")
        }
        if mp_id:
            evt["mp_id"] = str(mp_id)
        if extra and isinstance(extra, dict):
            evt.update(extra)
        sales_data["events"].append(evt)
        # Mantém histórico rigorosamente ordenado por data e hora cronológica
        sales_data["events"].sort(key=lambda x: (float(x.get("timestamp", 0)), int(x.get("id", 0))))
        # Limita histórico recente a 350 eventos
        if len(sales_data["events"]) > 350:
            sales_data["events"] = sales_data["events"][-350:]
        recalculate_totals_unlocked()
        save_data()
        return evt

def safe_print(text):
    try:
        print(text)
        sys.stdout.flush()
    except UnicodeEncodeError:
        try:
            print(text.encode("ascii", "replace").decode("ascii"))
            sys.stdout.flush()
        except Exception:
            pass

def sync_mercadopago(limit=50):
    """Sincroniza pagamentos Pix da máquina na barbearia via API oficial do Mercado Pago."""
    token = sales_data.get("mp_access_token") or DEFAULT_MP_TOKEN
    if not token:
        return {"success": False, "error": "Token do Mercado Pago não configurado."}

    url = f"https://api.mercadopago.com/v1/payments/search?sort=date_created&criteria=desc&limit={limit}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "User-Agent": "DG-Tech-Arcade-Server/2.0"
    })

    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            raw = resp.read().decode("utf-8")
            data = json.loads(raw)
            results = data.get("results", [])

            new_sales = 0
            total_val_new = 0.0

            with data_lock:
                processed = set(str(pid) for pid in sales_data.get("processed_mp_ids", []))
                price = float(sales_data.get("price_per_token", 2.50))

                # Processa em ordem cronológica (antigo -> novo) para sequência natural
                for p in reversed(results):
                    pid = str(p.get("id"))
                    if pid in processed:
                        continue

                    status = p.get("status")
                    if status != "approved":
                        continue

                    desc = (p.get("description") or "").strip()
                    ext_ref = str(p.get("external_reference") or "").strip()
                    
                    # Identifica tipo de pagamento e origem Pix
                    poi = p.get("point_of_interaction") or {}
                    poi_type = str(poi.get("type") or "").upper()
                    poi_sub = str(poi.get("sub_type") or "").upper()
                    is_pix = any(k in poi_type for k in ["PSP", "PIX", "QR"]) or any(k in poi_sub for k in ["PSP", "PIX", "QR"]) or (p.get("payment_method_id") == "pix")
                    is_arcade = any(kw in desc.lower() for kw in ["fliperama", "arcade", "ficha", "credito"]) or ext_ref.startswith("arcade")
                    
                    # Esta conta/token de produção do Mercado Pago é vinculada ao fliperama da barbearia.
                    # Aceita se tiver palavras-chave do arcade OU se for qualquer Pix/transferência aprovada recebida.
                    if not (is_arcade or is_pix or not desc):
                        continue

                    valor = float(p.get("transaction_amount", 0.0))
                    if valor <= 0.0:
                        continue

                    # Extrai quantidade de fichas da descrição (ex: 'Fliperama - 2 credito(s)') ou calcula pelo preço unitário
                    m = re.search(r'(\d+)\s*(?:credito|ficha)', desc, re.I)
                    if m:
                        fichas = int(m.group(1))
                    else:
                        fichas = max(1, round(valor / price))
                        if not desc:
                            desc = f"Fliperama - {fichas} credito(s)"

                    # Data e hora original do pagamento no Mercado Pago convertida para o Fuso do Brasil (UTC-3)
                    dt_str = str(p.get("date_approved") or p.get("date_created") or "")
                    try:
                        dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
                        if dt.tzinfo is not None:
                            dt_br = dt.astimezone(BRAZIL_TZ)
                        else:
                            dt_br = dt.replace(tzinfo=BRAZIL_TZ)
                        hora_str = dt_br.strftime("%H:%M:%S")
                        data_str = dt_br.strftime("%d/%m/%Y")
                        ts = dt_br.timestamp()
                    except Exception:
                        now_br = datetime.now(BRAZIL_TZ)
                        hora_str = now_br.strftime("%H:%M:%S")
                        data_str = now_br.strftime("%d/%m/%Y")
                        ts = now_br.timestamp()

                    # Identificação do cliente e banco pagador
                    payer = p.get("payer") or {}
                    fname = (payer.get("first_name") or "").strip()
                    lname = (payer.get("last_name") or "").strip()
                    nome_cliente = f"{fname} {lname}".strip()

                    bank_info = p.get("point_of_interaction", {}).get("transaction_data", {}).get("bank_info", {}).get("payer", {})
                    b_raw = bank_info.get("long_name") or ""
                    banco = "Pix"
                    if "NU PAGAMENTOS" in b_raw.upper():
                        banco = "Nubank"
                    elif "PICPAY" in b_raw.upper():
                        banco = "PicPay"
                    elif "CAIXA" in b_raw.upper():
                        banco = "Caixa Econômica"
                    elif "ITAU" in b_raw.upper():
                        banco = "Itaú"
                    elif "BRADESCO" in b_raw.upper():
                        banco = "Bradesco"
                    elif "INTER" in b_raw.upper():
                        banco = "Banco Inter"
                    elif "SANTANDER" in b_raw.upper():
                        banco = "Santander"
                    elif "PAGSEGURO" in b_raw.upper() or "PAGBANK" in b_raw.upper():
                        banco = "PagBank"
                    elif "C6" in b_raw.upper():
                        banco = "C6 Bank"
                    elif b_raw:
                        banco = b_raw.split("-")[0].strip()

                    if nome_cliente:
                        cliente_display = f"{nome_cliente} ({banco})"
                    elif banco != "Pix":
                        cliente_display = f"Cliente {banco}"
                    else:
                        cliente_display = "Cliente Pix"

                    event_id = len(sales_data["events"]) + 1
                    clean_desc = f"Pix Barbearia: {desc} • {cliente_display} (MP #{pid})"
                    evt = {
                        "id": event_id,
                        "tipo": "venda",
                        "fichas": fichas,
                        "valor": valor,
                        "cliente": cliente_display,
                        "banco": banco,
                        "descricao": clean_desc,
                        "origem": f"Mercado Pago ({banco})",
                        "timestamp": ts,
                        "hora": hora_str,
                        "data": data_str,
                        "mp_id": pid
                    }
                    sales_data["events"].append(evt)
                    # Mantém eventos rigorosamente ordenados por data e hora cronológica
                    sales_data["events"].sort(key=lambda x: (float(x.get("timestamp", 0)), int(x.get("id", 0))))
                    if len(sales_data["events"]) > 350:
                        sales_data["events"] = sales_data["events"][-350:]

                    if "processed_mp_ids" not in sales_data:
                        sales_data["processed_mp_ids"] = []
                    sales_data["processed_mp_ids"].append(pid)
                    if len(sales_data["processed_mp_ids"]) > 600:
                        sales_data["processed_mp_ids"] = sales_data["processed_mp_ids"][-600:]

                    new_sales += 1
                    total_val_new += valor

                recalculate_totals_unlocked()
                sales_data["last_mp_sync"] = datetime.now(BRAZIL_TZ).strftime("%H:%M:%S")
                sales_data["last_mp_status"] = f"Online ({len(sales_data.get('processed_mp_ids', []))} processados)"

                if new_sales > 0:
                    save_data()
                    safe_print(f"[MERCADO PAGO NUVEM] [PIX BARBEARIA] +{new_sales} nova(s) venda(s) Pix sincronizada(s)! (+R$ {total_val_new:.2f})")

            return {
                "success": True,
                "new_sales": new_sales,
                "total_added": total_val_new,
                "session_cash": sales_data.get("session_cash", 0.0),
                "session_tokens": sales_data.get("session_tokens", 0),
                "today_cash": sales_data.get("today_cash", 0.0),
                "today_tokens": sales_data.get("today_tokens", 0),
                "yesterday_cash": sales_data.get("yesterday_cash", 0.0),
                "yesterday_tokens": sales_data.get("yesterday_tokens", 0),
                "last_sync": sales_data.get("last_mp_sync")
            }

    except Exception as e:
        with data_lock:
            sales_data["last_mp_status"] = f"Erro de conexão: {str(e)[:40]}"
        return {"success": False, "error": str(e)}

def mp_sync_background_worker():
    """Monitor em segundo plano: consulta Mercado Pago a cada 10 segundos."""
    time.sleep(1.5)
    # Sincronização inicial imediata ao ligar
    try:
        sync_mercadopago(limit=50)
    except Exception as e:
        print(f"[MP SYNC INICIAL ERRO] {e}")

    while True:
        try:
            sync_mercadopago(limit=30)
        except Exception as e:
            pass
        time.sleep(10)

class ArcadeHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def log_message(self, format, *args):
        try:
            sys.stdout.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format % args))
            sys.stdout.flush()
        except Exception:
            pass

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Pin')
        self.end_headers()

    def send_json(self, status_code, data):
        try:
            body = json.dumps(data, ensure_ascii=False).encode('utf-8')
            self.send_response(status_code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Pin')
            self.end_headers()
            self.wfile.write(body)
        except Exception:
            pass

    def check_auth_pin(self, provided_pin):
        with data_lock:
            if not sales_data.get("require_pin", False):
                return True
            expected = str(sales_data.get("security_pin", "1234")).strip()
            return str(provided_pin or "").strip() == expected

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        # 1. API: Obter Status Financeiro, Distribuidora/Máquinas & Contadores de Vendas
        if path == '/api/vendas/status':
            with data_lock:
                recalculate_totals_unlocked()
                active_m = get_active_machine_unlocked()
                safe_copy = dict(sales_data)
                safe_copy["active_machine"] = dict(active_m)
                safe_copy["active_machine_id"] = active_m.get("id", "distribuidora")
                safe_copy["machines"] = sales_data.get("machines", [])
                safe_copy["pin_configured"] = bool(sales_data.get("security_pin"))
                safe_copy["require_pin"] = sales_data.get("require_pin", False)
                safe_copy["barber_split_percent"] = active_m.get("percentual_parceiro", 0)
                safe_copy["owner_split_percent"] = active_m.get("percentual_proprietario", 100)
                safe_copy["config_updated_at"] = sales_data.get("config_updated_at", 0)
                safe_copy["last_mp_sync"] = sales_data.get("last_mp_sync", "Nunca")
                safe_copy["last_mp_status"] = sales_data.get("last_mp_status", "Online")
                safe_copy["technical_logs"] = sales_data.get("technical_logs", [])[-50:]
                safe_copy["last_confirmed_cmd"] = sales_data.get("last_confirmed_cmd")
                # Não expor senhas e tokens reais
                if "security_pin" in safe_copy:
                    del safe_copy["security_pin"]
                if "mp_access_token" in safe_copy:
                    safe_copy["mp_configured"] = bool(safe_copy["mp_access_token"])
                    del safe_copy["mp_access_token"]
            self.send_json(200, {"success": True, "data": safe_copy})
            return

        # 2. API: Forçar Sincronização Imediata com Mercado Pago
        elif path == '/api/mercadopago/sincronizar':
            res = sync_mercadopago(limit=40)
            self.send_json(200, res)
            return

        # 3. API: Obter Link do Túnel 4G Ativo
        elif path == '/api/tunnel/url':
            tunnel_url = ""
            if os.path.exists(LINK_FILE):
                try:
                    with open(LINK_FILE, "r", encoding="utf-8") as f:
                        content = f.read()
                        m = re.search(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com", content)
                        if m:
                            tunnel_url = m.group(0)
                except Exception:
                    pass
            self.send_json(200, {"success": bool(tunnel_url), "url": tunnel_url})
            return

        # 4. API: Bridge Wi-Fi ESP-01S (Relé de Fichas) - Ping
        elif path == '/api/esp01/ping':
            active_m = get_active_machine()
            esp01_ip = query.get('ip', [active_m.get('ip', '192.168.18.99')])[0]
            self.get_esp01_ping(esp01_ip)
            return

        # 5. API: Bridge Wi-Fi ESP-01S - Disparo Remoto de Coin com Confirmação Real
        elif path == '/api/esp01/credito':
            active_m = get_active_machine()
            esp01_ip = query.get('ip', [active_m.get('ip', '192.168.18.99')])[0]
            qtd = max(1, min(20, int(query.get('qtd', ['1'])[0])))
            modo = query.get('modo', ['manutencao'])[0]
            pin = query.get('pin', [''])[0] or self.headers.get('X-Pin', '')
            motivo = query.get('motivo', ['Disparo Remoto'])[0]
            cmd_id = query.get('cmd_id', [''])[0]
            async_mode = query.get('async', ['0'])[0] in ('1', 'true', 'yes')

            if not self.check_auth_pin(pin):
                self.send_json(403, {"success": False, "error": "PIN de segurança incorreto. Acesso negado."})
                return

            self.get_esp01_credito(esp01_ip, qtd, modo, motivo, cmd_id, async_mode)
            return

        # 5b. API: Status de Comando Específico para o Painel Web
        elif path == '/api/esp01/status_comando':
            cmd_id = query.get('cmd_id', [''])[0]
            self.get_esp01_status_comando(cmd_id)
            return

        # 6. API: Bridge Wi-Fi ESP32 CYD - Ping / Status
        elif path == '/api/esp32/ping':
            esp32_ip = query.get('ip', ['192.168.1.63'])[0]
            self.get_esp32_ping(esp32_ip)
            return

        # 7. API: Bridge Wi-Fi ESP32 CYD - Resetar Tela
        elif path == '/api/esp32/reset':
            esp32_ip = query.get('ip', ['192.168.1.63'])[0]
            self.get_esp32_reset(esp32_ip)
            return

        # 8. API: Obter Eventos de Telemetria Recentes (Polling)
        elif path == '/api/telemetria/eventos_recentes':
            since_id = int(query.get('since', [0])[0])
            with data_lock:
                recalculate_totals_unlocked()
                active_m = get_active_machine_unlocked()
                now_ts = time.time()
                hb_ts = float(active_m.get("last_heartbeat_ts", 0))
                diff_sec = int(now_ts - hb_ts) if hb_ts > 0 else 9999
                active_m["status"] = "ONLINE" if (diff_sec <= 25 and hb_ts > 0) else "OFFLINE"
                events = [e for e in sales_data["events"] if e["id"] > since_id]
                last_id = sales_data["events"][-1]["id"] if sales_data["events"] else 0
            self.send_json(200, {
                "events": events,
                "last_id": last_id,
                "active_machine": active_m,
                "session_cash": sales_data.get("session_cash", 0.0),
                "session_tokens": sales_data.get("session_tokens", 0),
                "today_cash": sales_data.get("today_cash", 0.0),
                "today_tokens": sales_data.get("today_tokens", 0),
                "yesterday_cash": sales_data.get("yesterday_cash", 0.0),
                "yesterday_tokens": sales_data.get("yesterday_tokens", 0),
                "last_sangria": sales_data.get("last_sangria"),
                "closed_registers": sales_data.get("closed_registers", []),
                "closed_quinzenas": sales_data.get("closed_quinzenas", []),
                "daily_sales": sales_data.get("daily_sales", []),
                "last_sync": sales_data.get("last_mp_sync"),
                "last_confirmed_cmd": sales_data.get("last_confirmed_cmd")
            })
            return

        # 9. API: Obter Histórico de Quinzenas Fechadas
        elif path == '/api/quinzenal/historico':
            with data_lock:
                quinzenas = sales_data.get("closed_quinzenas", [])
            self.send_json(200, {"success": True, "closed_quinzenas": quinzenas})
            return

        # 10. API: Obter Histórico Técnico & Auditoria
        elif path == '/api/technical_logs':
            limit = int(query.get('limit', [100])[0])
            with data_lock:
                logs = list(sales_data.get("technical_logs", []))
            logs = logs[-limit:]
            logs.reverse()
            self.send_json(200, {"success": True, "logs": logs})
            return

        # 11. API: Obter Lista de Máquinas
        elif path == '/api/machines':
            with data_lock:
                machines = sales_data.get("machines", [])
                active_id = sales_data.get("active_machine_id", "distribuidora")
                active_m = get_active_machine_unlocked()
                now_ts = time.time()
                hb_ts = float(active_m.get("last_heartbeat_ts", 0))
                active_m["status"] = "ONLINE" if (now_ts - hb_ts <= 25 and hb_ts > 0) else "OFFLINE"
            self.send_json(200, {
                "success": True,
                "active_machine_id": active_id,
                "active_machine": active_m,
                "machines": machines
            })
            return

        # 12. API: Polling de Comandos pelo ESP-01S (Nuvem / Polling)
        elif path == '/api/esp01/poll':
            now_ts = time.time()
            now_br = datetime.now(BRAZIL_TZ)
            time_str = now_br.strftime("%H:%M:%S")

            with data_lock:
                active_m = get_active_machine_unlocked()
                active_m["last_heartbeat_ts"] = now_ts
                active_m["status"] = "ONLINE"
                active_m["ultimo_contato"] = time_str

                pending_cmd = None
                p_list = sales_data.get("pending_commands", [])
                for cmd in p_list:
                    c_status = cmd.get("status", "PENDENTE")
                    if c_status == "PENDENTE":
                        pending_cmd = cmd
                        cmd["status"] = "ENVIADO"
                        cmd["fetched_at"] = now_ts
                        save_data()
                        break
                    elif c_status == "ENVIADO" and (now_ts - cmd.get("fetched_at", now_ts) > 20):
                        cmd["status"] = "EXPIRADO"

            if pending_cmd:
                safe_print(f"[POLL ESP-01S] Entregando comando {pending_cmd['cmd_id']} ({pending_cmd['quantidade']} ficha(s)) ao ESP-01S.")
                self.send_json(200, {
                    "has_command": True,
                    "cmd_id": pending_cmd["cmd_id"],
                    "quantidade": pending_cmd["quantidade"]
                })
            else:
                self.send_json(200, {
                    "has_command": False
                })
            return

        # Arquivos estáticos normais (HTML, JS, CSS, PNG)
        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        # 1. API: Fechar Caixa / Sangria
        if path == '/api/vendas/sangria':
            self.post_sangria()
            return

        # 2. API: Registrar Venda Manual / Moeda / Cédula
        elif path == '/api/vendas/registrar':
            self.post_registrar_venda()
            return

        # 3. API: Configurar PIN de Segurança
        elif path == '/api/config/pin':
            self.post_config_pin()
            return

        # 4. API: Salvar Configurações Gerais (Divisão Barbearia/Distribuidora, Preço, PIN, MP Token)
        elif path == '/api/config/settings':
            self.post_config_settings()
            return

        # 5. API: Atualizar Nome do Cliente da Venda
        elif path == '/api/vendas/cliente':
            self.post_update_cliente()
            return

        # 6. API: Fechamento de Caixa Quinzenal
        elif path == '/api/quinzenal/fechar':
            self.post_fechar_quinzena()
            return

        # 7. API: Selecionar Máquina Ativa
        elif path == '/api/machines/select':
            self.post_select_machine()
            return

        # 8. API: Configurações de Máquina Específica
        elif path == '/api/machines/settings':
            self.post_machine_settings()
            return

        # 9. API: Confirmação de Pulso enviada pelo ESP-01S (Nuvem / Polling)
        elif path == '/api/esp01/confirm':
            self.post_esp01_confirm()
            return

        # 10. API: Heartbeat enviado pelo ESP-01S
        elif path == '/api/esp01/heartbeat':
            self.post_esp01_heartbeat()
            return

        self.send_json(404, {"error": "Rota não encontrada"})

    # --- BRIDGE ESP-01S (RELÉ COIN) ---
    def get_esp01_ping(self, ip=None):
        now_ts = time.time()
        with data_lock:
            active_m = get_active_machine_unlocked()
            last_hb_ts = float(active_m.get("last_heartbeat_ts", 0))
            diff_sec = int(now_ts - last_hb_ts) if last_hb_ts > 0 else None

            # ONLINE se recebeu heartbeat nos últimos 25 segundos
            online = (diff_sec is not None) and (diff_sec <= 25)
            active_m["status"] = "ONLINE" if online else "OFFLINE"

            # Sanitização rigorosa do IP para 192.168.18.99
            cur_ip = active_m.get("ip", "192.168.18.99")
            if cur_ip in ("192.168.10.99", "192.168.1.62") or not cur_ip:
                cur_ip = "192.168.18.99"
                active_m["ip"] = cur_ip

            reported_device = active_m.get("device", "ESP-01S")
            maquina_nome = active_m.get("nome", "Distribuidora")
            proprietario = active_m.get("proprietario", "DG Tech Arcade")
            ultimo_contato = active_m.get("ultimo_contato", "Nenhum registro")
            ultimo_pulso = active_m.get("ultimo_pulso", "Nenhum")
            ultimo_comando = active_m.get("ultimo_comando", "Nenhum")

        self.send_json(200, {
            "online": online,
            "status": "ONLINE" if online else "OFFLINE",
            "device": reported_device,
            "role": "relay",
            "ip": cur_ip,
            "maquina": maquina_nome,
            "proprietario": proprietario,
            "ultimo_contato": ultimo_contato,
            "segundos_atras": diff_sec if diff_sec is not None else 9999,
            "ultimo_pulso": ultimo_pulso,
            "ultimo_comando": ultimo_comando,
            "last_heartbeat_ts": last_hb_ts
        })

    def get_esp01_status_comando(self, cmd_id):
        cmd_id = str(cmd_id).strip()
        if not cmd_id:
            self.send_json(400, {"success": False, "error": "cmd_id não informado"})
            return

        with data_lock:
            now_ts = time.time()
            # 1. Já confirmado no executed_commands?
            if cmd_id in sales_data.get("executed_commands", {}):
                last_c = sales_data.get("last_confirmed_cmd", {})
                self.send_json(200, {
                    "success": True,
                    "cmd_id": cmd_id,
                    "status": "CONFIRMADO",
                    "confirmed": True,
                    "executed": True,
                    "hora": last_c.get("hora", "")
                })
                return

            # 2. Na fila de comandos pendentes?
            for c in sales_data.get("pending_commands", []):
                if c.get("cmd_id") == cmd_id:
                    c_status = c.get("status", "PENDENTE")
                    created_at = c.get("created_at", c.get("ts", now_ts))
                    # Timeout de 20s
                    if now_ts - created_at > 20 and c_status != "CONFIRMADO":
                        c["status"] = "EXPIRADO"
                        c_status = "EXPIRADO"

                    self.send_json(200, {
                        "success": True,
                        "cmd_id": cmd_id,
                        "status": c_status,
                        "confirmed": (c_status == "CONFIRMADO"),
                        "quantidade": c.get("quantidade", 1),
                        "modo": c.get("modo", "manutencao"),
                        "created_at": created_at,
                        "fetched_at": c.get("fetched_at")
                    })
                    return

            # 3. Não encontrado na fila nem no histórico
            self.send_json(200, {
                "success": False,
                "cmd_id": cmd_id,
                "status": "NAO_ENCONTRADO",
                "confirmed": False
            })

    def get_esp01_credito(self, ip, qtd=1, modo="manutencao", motivo="Disparo Remoto", cmd_id=None, async_mode=False):
        now_br = datetime.now(BRAZIL_TZ)
        time_str = now_br.strftime("%H:%M:%S")

        # 1. Garante identificador exclusivo por comando
        if not cmd_id or not str(cmd_id).strip():
            cmd_id = f"CMD-{now_br.strftime('%Y%m%d%H%M%S')}-{int(time.time()*1000)%10000:04d}"
        cmd_id = str(cmd_id).strip()

        # 2. Proteção contra pulso duplicado no backend
        with data_lock:
            active_m = get_active_machine_unlocked()
            if "executed_commands" not in sales_data:
                sales_data["executed_commands"] = {}

            if cmd_id in sales_data["executed_commands"]:
                safe_print(f"[REPETIÇÃO BLOQUEADA] Comando {cmd_id} já executado anteriormente.")
                add_technical_log(cmd_id, active_m.get("nome", "Distribuidora"), qtd, modo, "DUPLICADO_IGNORADO", False, "Comando já executado anteriormente", "Bloqueado para proteção contra créditos duplicados")
                self.send_json(200, {
                    "success": True,
                    "confirmed": True,
                    "already_executed": True,
                    "status": "CONFIRMADO",
                    "cmd_id": cmd_id,
                    "credits": qtd,
                    "modo": modo,
                    "ip": ip,
                    "message": "Comando já executado anteriormente. Nenhum crédito duplicado gerado."
                })
                return

            # 3. Enfileira o comando para polling pelo ESP-01S
            if "pending_commands" not in sales_data:
                sales_data["pending_commands"] = []

            # Limpa comandos antigos (> 60s) que já expiraram
            now_ts = time.time()
            sales_data["pending_commands"] = [
                c for c in sales_data["pending_commands"]
                if (now_ts - c.get("created_at", c.get("ts", now_ts)) < 60) and (c.get("status") not in ("CONFIRMADO", "EXPIRADO", "FALHA"))
            ]

            # Adiciona o novo comando na fila com estado PENDENTE
            pending_cmd = {
                "cmd_id": cmd_id,
                "ip": ip,
                "quantidade": qtd,
                "modo": modo,
                "motivo": motivo,
                "created_at": now_ts,
                "ts": now_ts,
                "fetched_at": None,
                "status": "PENDENTE",
                "confirmed": False
            }
            sales_data["pending_commands"].append(pending_cmd)
            save_data()

        safe_print(f"[FILA COMANDOS] Comando {cmd_id} enfileirado: {qtd} ficha(s), modo {modo}.")

        # Se solicitado modo assíncrono (painel web moderno), responde imediatamente
        if async_mode:
            self.send_json(200, {
                "success": True,
                "status": "PENDENTE",
                "cmd_id": cmd_id,
                "quantidade": qtd,
                "modo": modo,
                "message": "Comando enfileirado com sucesso. Aguardando ESP-01S."
            })
            return

        # Modo síncrono (aguarda até 12 segundos pela confirmação do ESP-01S via nuvem)
        confirmed = False
        t_start = time.time()
        while time.time() - t_start < 12.0:
            time.sleep(0.25)
            with data_lock:
                if cmd_id in sales_data.get("executed_commands", {}):
                    confirmed = True
                    break
                for c in sales_data.get("pending_commands", []):
                    if c.get("cmd_id") == cmd_id and c.get("status") in ("EXPIRADO", "FALHA"):
                        break

        if confirmed:
            with data_lock:
                active_m = get_active_machine_unlocked()
                last_evt = sales_data.get("events", [{}])[-1] if sales_data.get("events") else {}
            self.send_json(200, {
                "success": True,
                "confirmed": True,
                "status": "CONFIRMADO",
                "cmd_id": cmd_id,
                "credits": qtd,
                "modo": modo,
                "ip": ip,
                "event": last_evt,
                "message": "Ficha liberada com sucesso."
            })
        else:
            with data_lock:
                active_m = get_active_machine_unlocked()
                # Atualiza status do comando para EXPIRADO
                for c in sales_data.get("pending_commands", []):
                    if c.get("cmd_id") == cmd_id:
                        c["status"] = "EXPIRADO"
                save_data()

            add_technical_log(
                cmd_id=cmd_id,
                maquina=active_m.get("nome", "Distribuidora"),
                fichas=qtd,
                modo=modo,
                resultado="FALHOU",
                contabilizado=False,
                resposta_controlador="TIMEOUT / SEM RESPOSTA",
                detalhes="Controlador não confirmou a execução a tempo. NÃO CONTABILIZADO."
            )
            safe_print(f"[DISPARO NÃO CONFIRMADO] {cmd_id} expirou sem confirmação do ESP-01S.")
            self.send_json(200, {
                "success": False,
                "confirmed": False,
                "status": "EXPIRADO",
                "cmd_id": cmd_id,
                "error": "Controlador não confirmou a execução.",
                "contabilizado": False
            })

    # --- BRIDGE ESP32 CYD ---
    def get_esp32_ping(self, ip):
        for route in ['/ping', '/status', '/']:
            try:
                req = urllib.request.Request(f'http://{ip}{route}')
                with urllib.request.urlopen(req, timeout=2.5) as resp:
                    raw = resp.read().decode('utf-8', errors='ignore')
                    try:
                        data = json.loads(raw)
                    except Exception:
                        data = {"response": raw.strip()}
                    self.send_json(200, {"online": True, "device": "ESP32-CYD", "role": "display", "ip": ip, "data": data})
                    return
            except urllib.error.HTTPError as he:
                if he.code == 404:
                    continue
            except Exception:
                pass
        self.send_json(200, {"online": False, "error": "Display ESP32 não respondeu no IP informado", "ip": ip})

    def get_esp32_reset(self, ip):
        try:
            req = urllib.request.Request(f'http://{ip}/reset')
            with urllib.request.urlopen(req, timeout=4) as resp:
                data = json.loads(resp.read().decode('utf-8'))
                self.send_json(200, {"success": True, "ip": ip, "data": data})
        except Exception as e:
            self.send_json(500, {"success": False, "error": str(e), "ip": ip})

    # --- CONTROLE FINANCEIRO: SANGRIA E REGISTRO ---
    def post_sangria(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            raw_bytes = self.rfile.read(length)
            try:
                raw_body = raw_bytes.decode('utf-8')
            except UnicodeDecodeError:
                raw_body = raw_bytes.decode('latin-1', errors='replace')
            req_data = json.loads(raw_body) if raw_body else {}

            responsavel = req_data.get("responsavel", "Operador")
            obs = req_data.get("observacao", "Fechamento de Caixa")

            active_m = get_active_machine()
            partner_pct = float(active_m.get("percentual_parceiro", 0))
            owner_pct = float(active_m.get("percentual_proprietario", 100))

            with data_lock:
                recalculate_totals_unlocked()
                valor_sangria = sales_data.get("session_cash", 0.0)
                fichas_sangria = sales_data.get("session_tokens", 0)
                barber_share = round((valor_sangria * partner_pct) / 100.0, 2)
                owner_share = round(valor_sangria - barber_share, 2)

                desc_sangria = f"Sangria por {responsavel} no ponto {active_m.get('nome', 'Distribuidora')}. Total: R$ {valor_sangria:.2f} (DG Tech: R$ {owner_share:.2f} | Estabelecimento: R$ {barber_share:.2f}). Obs: {obs}"
                extra_sangria = {
                    "responsavel": responsavel,
                    "observacao": obs,
                    "maquina": active_m.get("nome", "Distribuidora"),
                    "repasse_barbearia": barber_share,
                    "repasse_estabelecimento": barber_share,
                    "lucro_proprietario": owner_share,
                    "split_percent": int(partner_pct)
                }

                evt = add_event("sangria", fichas_sangria, valor_sangria, desc_sangria, "Painel Gerencial", extra=extra_sangria)
                print(f"[FECHAMENTO CAIXA] R$ {valor_sangria:.2f} recolhido por {responsavel} (Ponto: {active_m.get('nome')} | DG Tech: R$ {owner_share:.2f} | Parceiro: R$ {barber_share:.2f})")

            self.send_json(200, {
                "success": True,
                "valor_recolhido": valor_sangria,
                "fichas_fechadas": fichas_sangria,
                "barber_share": barber_share,
                "owner_share": owner_share,
                "event": evt,
                "closed_registers": sales_data.get("closed_registers", []),
                "last_sangria": sales_data.get("last_sangria")
            })
        except Exception as e:
            self.send_json(500, {"success": False, "error": str(e)})

    def post_fechar_quinzena(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            raw_bytes = self.rfile.read(length)
            try:
                raw_body = raw_bytes.decode('utf-8')
            except UnicodeDecodeError:
                raw_body = raw_bytes.decode('latin-1', errors='replace')
            req_data = json.loads(raw_body) if raw_body else {}

            responsavel = req_data.get("responsavel", "Daniel")
            observacao = req_data.get("observacao", "Fechamento Quinzenal")
            periodo_label = req_data.get("periodo_label", "1ª Quinzena")
            data_inicio = req_data.get("data_inicio", "")
            data_fim = req_data.get("data_fim", "")
            valor_total = float(req_data.get("valor_total", 0.0))
            fichas = int(req_data.get("fichas", 0))

            active_m = get_active_machine()
            default_split = float(active_m.get("percentual_parceiro", 0))
            split_pct = float(req_data.get("split_percent", default_split))
            barber_share = float(req_data.get("barber_share", (valor_total * split_pct) / 100.0))
            owner_share = float(req_data.get("owner_share", valor_total - barber_share))
            efetuar_sangria = bool(req_data.get("efetuar_sangria", False))

            now_br = datetime.now(BRAZIL_TZ)
            data_fechamento = now_br.strftime("%d/%m/%Y")
            hora_fechamento = now_br.strftime("%H:%M:%S")
            ts_fechamento = now_br.timestamp()

            with data_lock:
                if "closed_quinzenas" not in sales_data:
                    sales_data["closed_quinzenas"] = []

                reg_quinzena = {
                    "id": len(sales_data["closed_quinzenas"]) + 1,
                    "periodo_label": periodo_label,
                    "data_inicio": data_inicio,
                    "data_fim": data_fim,
                    "data_fechamento": data_fechamento,
                    "hora_fechamento": hora_fechamento,
                    "timestamp": ts_fechamento,
                    "valor_total": round(valor_total, 2),
                    "fichas": fichas,
                    "split_percent": int(split_pct),
                    "barber_share": round(barber_share, 2),
                    "owner_share": round(owner_share, 2),
                    "responsavel": responsavel,
                    "observacao": observacao,
                    "status": "Fechada / Auditada"
                }
                sales_data["closed_quinzenas"].append(reg_quinzena)

                sangria_evt = None
                if efetuar_sangria and sales_data.get("session_cash", 0.0) > 0:
                    v_sangria = sales_data.get("session_cash", 0.0)
                    f_sangria = sales_data.get("session_tokens", 0)
                    b_share = round((v_sangria * split_pct) / 100.0, 2)
                    o_share = round(v_sangria - b_share, 2)
                    desc_sangria = f"Fechamento Quinzenal ({periodo_label}) por {responsavel}. Total: R$ {v_sangria:.2f} (Barbearia: R$ {b_share:.2f} | Seu: R$ {o_share:.2f}). Obs: {observacao}"
                    extra_sangria = {
                        "responsavel": responsavel,
                        "observacao": f"Fechamento Quinzenal ({periodo_label})",
                        "repasse_barbearia": b_share,
                        "lucro_proprietario": o_share
                    }
                    sangria_evt = add_event("sangria", f_sangria, v_sangria, desc_sangria, "Painel Quinzenal", extra=extra_sangria)

                recalculate_totals_unlocked()
                save_data()

                print(f"[FECHAMENTO QUINZENAL] {periodo_label} encerrada por {responsavel}. Total: R$ {valor_total:.2f} (Barbearia: R$ {barber_share:.2f} | Daniel: R$ {owner_share:.2f})")

            self.send_json(200, {
                "success": True,
                "quinzena": reg_quinzena,
                "closed_quinzenas": sales_data.get("closed_quinzenas", []),
                "sangria_realizada": bool(sangria_evt),
                "session_cash": sales_data.get("session_cash", 0.0),
                "session_tokens": sales_data.get("session_tokens", 0)
            })
        except Exception as e:
            self.send_json(500, {"success": False, "error": str(e)})

    def post_registrar_venda(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            raw_body = self.rfile.read(length).decode('utf-8')
            req_data = json.loads(raw_body) if raw_body else {}

            fichas = int(req_data.get("fichas", 1))
            valor = float(req_data.get("valor", fichas * 2.50))
            origem = req_data.get("origem", "Moedeiro Físico")

            with data_lock:
                sales_data["session_cash"] += valor
                sales_data["session_tokens"] += fichas
                sales_data["paid_tokens"] += fichas
                sales_data["general_tokens"] += fichas
                sales_data["general_cash"] += valor
                save_data()

            evt = add_event("venda", fichas, valor, f"Entrada registrada: {fichas} fichas (R$ {valor:.2f}) de {origem}", origem)
            self.send_json(200, {"success": True, "event": evt})
        except Exception as e:
            self.send_json(500, {"success": False, "error": str(e)})

    def post_config_pin(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            raw_body = self.rfile.read(length).decode('utf-8')
            req_data = json.loads(raw_body) if raw_body else {}

            novo_pin = str(req_data.get("pin", "")).strip()
            require_pin = bool(req_data.get("require_pin", True))

            with data_lock:
                if novo_pin:
                    sales_data["security_pin"] = novo_pin
                sales_data["require_pin"] = require_pin
                save_data()

            self.send_json(200, {"success": True, "message": "Configurações de segurança atualizadas com sucesso"})
        except Exception as e:
            self.send_json(500, {"success": False, "error": str(e)})

    def post_config_settings(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            raw_body = self.rfile.read(length).decode('utf-8')
            req_data = json.loads(raw_body) if raw_body else {}

            with data_lock:
                active_m = get_active_machine_unlocked()
                if "machine_name" in req_data and str(req_data["machine_name"]).strip():
                    active_m["nome"] = str(req_data["machine_name"]).strip()
                    active_m["estabelecimento"] = str(req_data["machine_name"]).strip()
                if "owner_name" in req_data and str(req_data["owner_name"]).strip():
                    active_m["proprietario"] = str(req_data["owner_name"]).strip()
                if "esp01_ip" in req_data and str(req_data["esp01_ip"]).strip():
                    active_m["ip"] = str(req_data["esp01_ip"]).strip()

                if "owner_split_percent" in req_data:
                    active_m["percentual_proprietario"] = max(0, min(100, int(req_data["owner_split_percent"])))
                    active_m["percentual_parceiro"] = 100 - active_m["percentual_proprietario"]
                    sales_data["barber_split_percent"] = active_m["percentual_parceiro"]
                    sales_data["owner_split_percent"] = active_m["percentual_proprietario"]
                elif "barber_split_percent" in req_data:
                    active_m["percentual_parceiro"] = max(0, min(100, int(req_data["barber_split_percent"])))
                    active_m["percentual_proprietario"] = 100 - active_m["percentual_parceiro"]
                    sales_data["barber_split_percent"] = active_m["percentual_parceiro"]
                    sales_data["owner_split_percent"] = active_m["percentual_proprietario"]

                if "price_per_token" in req_data:
                    p = max(0.50, float(req_data["price_per_token"]))
                    sales_data["price_per_token"] = p
                    active_m["preco_ficha"] = p

                if "security_pin" in req_data and str(req_data["security_pin"]).strip():
                    sales_data["security_pin"] = str(req_data["security_pin"]).strip()
                elif "pin" in req_data and str(req_data["pin"]).strip():
                    sales_data["security_pin"] = str(req_data["pin"]).strip()
                if "require_pin" in req_data:
                    sales_data["require_pin"] = bool(req_data["require_pin"])
                if "mp_access_token" in req_data and str(req_data["mp_access_token"]).strip():
                    sales_data["mp_access_token"] = str(req_data["mp_access_token"]).strip()

                sales_data["config_updated_at"] = time.time()
                recalculate_totals_unlocked()
                save_data()

            self.send_json(200, {
                "success": True, 
                "message": "Configurações salvas com sucesso",
                "active_machine": active_m,
                "barber_split_percent": active_m.get("percentual_parceiro", 0),
                "owner_split_percent": active_m.get("percentual_proprietario", 100),
                "price_per_token": sales_data.get("price_per_token", 2.50),
                "config_updated_at": sales_data.get("config_updated_at", 0)
            })
        except Exception as e:
            self.send_json(500, {"success": False, "error": str(e)})

    def post_select_machine(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            raw_body = self.rfile.read(length).decode('utf-8')
            req_data = json.loads(raw_body) if raw_body else {}
            machine_id = str(req_data.get("machine_id", "")).strip()

            with data_lock:
                found = False
                for m in sales_data.get("machines", []):
                    if m.get("id") == machine_id:
                        sales_data["active_machine_id"] = machine_id
                        found = True
                        break
                if not found:
                    self.send_json(404, {"success": False, "error": "Máquina não encontrada"})
                    return
                recalculate_totals_unlocked()
                save_data()
                active_m = get_active_machine_unlocked()

            self.send_json(200, {"success": True, "active_machine": active_m, "active_machine_id": machine_id})
        except Exception as e:
            self.send_json(500, {"success": False, "error": str(e)})

    def post_machine_settings(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            raw_body = self.rfile.read(length).decode('utf-8')
            req_data = json.loads(raw_body) if raw_body else {}
            machine_id = str(req_data.get("machine_id", "")).strip()

            with data_lock:
                target_m = None
                for m in sales_data.get("machines", []):
                    if m.get("id") == machine_id or (not machine_id and m.get("id") == sales_data.get("active_machine_id")):
                        target_m = m
                        break
                if not target_m:
                    self.send_json(404, {"success": False, "error": "Máquina não encontrada"})
                    return

                if "nome" in req_data and str(req_data["nome"]).strip():
                    target_m["nome"] = str(req_data["nome"]).strip()
                if "proprietario" in req_data and str(req_data["proprietario"]).strip():
                    target_m["proprietario"] = str(req_data["proprietario"]).strip()
                if "estabelecimento" in req_data and str(req_data["estabelecimento"]).strip():
                    target_m["estabelecimento"] = str(req_data["estabelecimento"]).strip()
                if "percentual_proprietario" in req_data:
                    target_m["percentual_proprietario"] = max(0, min(100, int(req_data["percentual_proprietario"])))
                    target_m["percentual_parceiro"] = 100 - target_m["percentual_proprietario"]
                elif "percentual_parceiro" in req_data:
                    target_m["percentual_parceiro"] = max(0, min(100, int(req_data["percentual_parceiro"])))
                    target_m["percentual_proprietario"] = 100 - target_m["percentual_parceiro"]
                if "ip" in req_data and str(req_data["ip"]).strip():
                    target_m["ip"] = str(req_data["ip"]).strip()
                if "preco_ficha" in req_data:
                    target_m["preco_ficha"] = max(0.50, float(req_data["preco_ficha"]))

                recalculate_totals_unlocked()
                save_data()

            self.send_json(200, {"success": True, "machine": target_m})
        except Exception as e:
            self.send_json(500, {"success": False, "error": str(e)})

    def post_esp01_confirm(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            raw_body = self.rfile.read(length).decode('utf-8')
            req_data = json.loads(raw_body) if raw_body else {}
            cmd_id = str(req_data.get("cmd_id", "")).strip()

            if not cmd_id:
                self.send_json(400, {"success": False, "error": "cmd_id não informado"})
                return

            now_ts = time.time()
            now_br = datetime.now(BRAZIL_TZ)
            time_str = now_br.strftime("%H:%M:%S")

            with data_lock:
                active_m = get_active_machine_unlocked()
                active_m["last_heartbeat_ts"] = now_ts
                active_m["status"] = "ONLINE"
                active_m["ultimo_contato"] = time_str
                active_m["ultimo_pulso"] = time_str
                active_m["ultimo_comando"] = cmd_id
                if "ip" in req_data and req_data["ip"]:
                    active_m["ip"] = str(req_data["ip"])
                if active_m.get("ip") in ("192.168.10.99", "192.168.1.62"):
                    active_m["ip"] = "192.168.18.99"

                if "executed_commands" not in sales_data:
                    sales_data["executed_commands"] = {}

                already_executed = cmd_id in sales_data["executed_commands"]
                sales_data["executed_commands"][cmd_id] = now_ts

                matched_cmd = None
                for cmd in sales_data.get("pending_commands", []):
                    if cmd.get("cmd_id") == cmd_id:
                        matched_cmd = cmd
                        cmd["status"] = "CONFIRMADO"
                        cmd["confirmed"] = True
                        cmd["confirmed_at"] = now_ts
                        break

                if already_executed:
                    safe_print(f"[RECONFIRMAÇÃO IGNORADA] Comando {cmd_id} já executado anteriormente.")
                    save_data()
                    self.send_json(200, {
                        "success": True,
                        "already_executed": True,
                        "cmd_id": cmd_id,
                        "message": "Comando já confirmado anteriormente. Crédito não duplicado."
                    })
                    return

                # Primeira confirmação do comando pelo ESP-01S!
                qtd = int(matched_cmd.get("quantidade", req_data.get("quantidade", 1))) if matched_cmd else int(req_data.get("quantidade", 1))
                modo = matched_cmd.get("modo", "manutencao") if matched_cmd else "manutencao"
                motivo = matched_cmd.get("motivo", "Disparo Remoto") if matched_cmd else "Disparo Remoto"

                sales_data["last_confirmed_cmd"] = {
                    "cmd_id": cmd_id,
                    "quantidade": qtd,
                    "modo": modo,
                    "hora": time_str,
                    "maquina": active_m.get("nome", "Distribuidora")
                }

                price = float(active_m.get("preco_ficha", sales_data.get("price_per_token", 2.50)))
                valor = qtd * price if modo == "venda" else 0.0

                if modo == "venda":
                    tipo_evento = "venda"
                    desc = f"Venda Manual: {qtd} ficha(s) (R$ {valor:.2f}) [{cmd_id}]"
                elif modo == "cortesia":
                    tipo_evento = "cortesia"
                    desc = f"Cortesia / Bônus: {qtd} ficha(s) [{cmd_id}]"
                else:
                    tipo_evento = "manutencao"
                    desc = f"Manutenção Técnica / Teste: {qtd} pulso(s) [{cmd_id}]"

                evt = add_event(tipo_evento, qtd, valor, desc, f"Painel -> ESP-01S ({active_m.get('ip', '192.168.18.99')})", extra={
                    "cmd_id": cmd_id,
                    "maquina": active_m.get("nome", "Distribuidora"),
                    "controlador": "ESP-01S",
                    "confirmado": True
                })

                add_technical_log(
                    cmd_id=cmd_id,
                    maquina=active_m.get("nome", "Distribuidora"),
                    fichas=qtd,
                    modo=modo,
                    resultado="CONFIRMADO",
                    contabilizado=(modo == "venda"),
                    resposta_controlador="200 OK (ESP Cloud)",
                    detalhes="Pulso físico executado e confirmado pelo ESP-01S"
                )

                safe_print(f"[PULSO CONFIRMADO COM SUCESSO] {cmd_id}: {qtd} ficha(s) executadas pelo ESP-01S.")
                save_data()

            self.send_json(200, {"success": True, "confirmed": True, "cmd_id": cmd_id, "event": evt})
        except Exception as e:
            self.send_json(500, {"success": False, "error": str(e)})

    def post_esp01_heartbeat(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            raw_body = self.rfile.read(length).decode('utf-8')
            req_data = json.loads(raw_body) if raw_body else {}

            now_ts = time.time()
            now_br = datetime.now(BRAZIL_TZ)
            time_str = now_br.strftime("%H:%M:%S")

            with data_lock:
                active_m = get_active_machine_unlocked()
                active_m["last_heartbeat_ts"] = now_ts
                active_m["status"] = "ONLINE"
                active_m["ultimo_contato"] = time_str
                active_m["device"] = req_data.get("device", "ESP-01S")
                if "ip" in req_data and req_data["ip"]:
                    active_m["ip"] = str(req_data["ip"])
                if active_m.get("ip") in ("192.168.10.99", "192.168.1.62"):
                    active_m["ip"] = "192.168.18.99"
                save_data()

            self.send_json(200, {"success": True, "status": "online", "time": time_str, "ip": active_m.get("ip")})
        except Exception as e:
            self.send_json(500, {"success": False, "error": str(e)})

    def post_update_cliente(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            raw_body = self.rfile.read(length).decode('utf-8')
            req_data = json.loads(raw_body) if raw_body else {}

            event_id = int(req_data.get("event_id", 0))
            novo_cliente = str(req_data.get("cliente", "")).strip()

            if not event_id:
                self.send_json(400, {"success": False, "error": "ID do evento não informado"})
                return

            with data_lock:
                for evt in sales_data.get("events", []):
                    if str(evt.get("id")) == str(event_id) or str(evt.get("mp_id")) == str(event_id):
                        evt["cliente"] = novo_cliente
                        desc_parts = evt.get("descricao", "").split(" • ")
                        mp_id = evt.get("mp_id", "")
                        mp_tag = f" (MP #{mp_id})" if mp_id else ""
                        evt["descricao"] = f"{desc_parts[0]} • {novo_cliente}{mp_tag}"
                        save_data()
                        self.send_json(200, {"success": True, "event": evt})
                        return

            self.send_json(404, {"success": False, "error": "Evento não encontrado"})
        except Exception as e:
            self.send_json(500, {"success": False, "error": str(e)})

def get_local_network_ips():
    ips = []
    try:
        import socket
        hostname = socket.gethostname()
        for ip in socket.gethostbyname_ex(hostname)[2]:
            if not ip.startswith("127."):
                ips.append(ip)
    except Exception:
        pass
    return ips

def run():
    load_data()
    
    # Inicia o sincronizador contínuo do Mercado Pago em segundo plano
    sync_thread = threading.Thread(target=mp_sync_background_worker, daemon=True)
    sync_thread.start()

    server_address = ('', PORT)
    httpd = ThreadingHTTPServer(server_address, ArcadeHandler)
    local_ips = get_local_network_ips()
    safe_print("=================================================================")
    safe_print("  DG TECH ARCADE -- SERVIDOR DE CONTROLE LOCAL & REDE WI-FI")
    safe_print(f"  No Computador Local: http://localhost:{PORT}")
    if local_ips:
        safe_print("  No Celular (conectado ao mesmo Wi-Fi):")
        for ip in local_ips:
            safe_print(f"    --> http://{ip}:{PORT}")
    safe_print("  Modulo Rele (ESP-01S): http://192.168.18.99")
    safe_print(f"  Armazenamento: {DATA_FILE}")
    safe_print("=================================================================")
    sys.stdout.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass

if __name__ == '__main__':
    run()
