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
from datetime import datetime

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

# Estado persistente do sistema
data_lock = threading.Lock()
sales_data = {
    "session_cash": 0.0,
    "session_tokens": 0,
    "paid_tokens": 0,
    "courtesy_tokens": 0,
    "maintenance_tokens": 0,
    "general_tokens": 0,
    "general_cash": 0.0,
    "price_per_token": 2.50,
    "barber_split_percent": 50,
    "security_pin": "1234",
    "require_pin": False,
    "mp_access_token": DEFAULT_MP_TOKEN,
    "processed_mp_ids": [],
    "last_mp_sync": None,
    "last_mp_status": "Iniciando...",
    "events": []
}

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
                if "barber_split_percent" not in sales_data:
                    sales_data["barber_split_percent"] = 50
                if "mp_access_token" not in sales_data or not sales_data["mp_access_token"]:
                    sales_data["mp_access_token"] = DEFAULT_MP_TOKEN
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

def add_event(tipo, fichas, valor, descricao, origem="Painel", mp_id=None):
    with data_lock:
        event_id = len(sales_data["events"]) + 1
        evt = {
            "id": event_id,
            "tipo": tipo,  # 'manutencao', 'venda', 'cortesia', 'sangria'
            "fichas": fichas,
            "valor": valor,
            "descricao": descricao,
            "origem": origem,
            "timestamp": time.time(),
            "hora": time.strftime("%H:%M:%S"),
            "data": time.strftime("%d/%m/%Y")
        }
        if mp_id:
            evt["mp_id"] = str(mp_id)
        sales_data["events"].append(evt)
        # Limita histórico recente a 350 eventos
        if len(sales_data["events"]) > 350:
            sales_data["events"].pop(0)
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

                    desc = p.get("description") or ""
                    ext_ref = str(p.get("external_reference") or "")
                    
                    # Filtra transações do Fliperama / Arcade
                    is_arcade = any(kw in desc.lower() for kw in ["fliperama", "arcade", "ficha", "credito"]) or ext_ref.startswith("arcade")
                    if not is_arcade:
                        continue

                    valor = float(p.get("transaction_amount", 0.0))

                    # Extrai quantidade de fichas da descrição (ex: 'Fliperama - 2 credito(s)') ou calcula
                    m = re.search(r'(\d+)\s*(?:credito|ficha)', desc, re.I)
                    if m:
                        fichas = int(m.group(1))
                    else:
                        fichas = max(1, round(valor / price))

                    # Data e hora original do pagamento no Mercado Pago
                    dt_str = p.get("date_approved") or p.get("date_created")
                    try:
                        dt = datetime.fromisoformat(dt_str)
                        hora_str = dt.strftime("%H:%M:%S")
                        data_str = dt.strftime("%d/%m/%Y")
                        ts = dt.timestamp()
                    except Exception:
                        hora_str = time.strftime("%H:%M:%S")
                        data_str = time.strftime("%d/%m/%Y")
                        ts = time.time()

                    # Atualiza acumuladores da sessão e histórico vitalício
                    sales_data["session_cash"] += valor
                    sales_data["session_tokens"] += fichas
                    sales_data["paid_tokens"] += fichas
                    sales_data["general_tokens"] += fichas
                    sales_data["general_cash"] += valor

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
                    if len(sales_data["events"]) > 350:
                        sales_data["events"].pop(0)

                    if "processed_mp_ids" not in sales_data:
                        sales_data["processed_mp_ids"] = []
                    sales_data["processed_mp_ids"].append(pid)
                    if len(sales_data["processed_mp_ids"]) > 600:
                        sales_data["processed_mp_ids"] = sales_data["processed_mp_ids"][-600:]

                    new_sales += 1
                    total_val_new += valor

                sales_data["last_mp_sync"] = time.strftime("%H:%M:%S")
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

        # 1. API: Obter Status Financeiro, Barbearia & Contadores de Vendas
        if path == '/api/vendas/status':
            with data_lock:
                safe_copy = dict(sales_data)
                safe_copy["pin_configured"] = bool(sales_data.get("security_pin"))
                safe_copy["require_pin"] = sales_data.get("require_pin", False)
                safe_copy["barber_split_percent"] = sales_data.get("barber_split_percent", 50)
                safe_copy["last_mp_sync"] = sales_data.get("last_mp_sync", "Nunca")
                safe_copy["last_mp_status"] = sales_data.get("last_mp_status", "Online")
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
            esp01_ip = query.get('ip', ['192.168.18.99'])[0]
            self.get_esp01_ping(esp01_ip)
            return

        # 5. API: Bridge Wi-Fi ESP-01S - Disparo Remoto de Coin (Manutenção / Teste / Venda)
        elif path == '/api/esp01/credito':
            esp01_ip = query.get('ip', ['192.168.18.99'])[0]
            qtd = max(1, min(20, int(query.get('qtd', ['1'])[0])))
            modo = query.get('modo', ['manutencao'])[0]
            pin = query.get('pin', [''])[0] or self.headers.get('X-Pin', '')
            motivo = query.get('motivo', ['Disparo Remoto'])[0]

            if not self.check_auth_pin(pin):
                self.send_json(403, {"success": False, "error": "PIN de segurança incorreto. Acesso negado."})
                return

            self.get_esp01_credito(esp01_ip, qtd, modo, motivo)
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
                events = [e for e in sales_data["events"] if e["id"] > since_id]
                last_id = sales_data["events"][-1]["id"] if sales_data["events"] else 0
            self.send_json(200, {
                "events": events,
                "last_id": last_id,
                "session_cash": sales_data.get("session_cash", 0.0),
                "session_tokens": sales_data.get("session_tokens", 0),
                "last_sync": sales_data.get("last_mp_sync")
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

        # 4. API: Salvar Configurações Gerais (Divisão Barbearia, Preço, PIN, MP Token)
        elif path == '/api/config/settings':
            self.post_config_settings()
            return

        # 5. API: Atualizar Nome do Cliente da Venda
        elif path == '/api/vendas/cliente':
            self.post_update_cliente()
            return

        self.send_json(404, {"error": "Rota não encontrada"})

    # --- BRIDGE ESP-01S (RELÉ COIN) ---
    def get_esp01_ping(self, ip):
        for route in ['/', '/ping', '/status']:
            try:
                req = urllib.request.Request(f'http://{ip}{route}')
                with urllib.request.urlopen(req, timeout=2.5) as resp:
                    raw = resp.read().decode('utf-8', errors='ignore')
                    try:
                        data = json.loads(raw)
                    except Exception:
                        data = {"response": raw.strip()}
                    self.send_json(200, {"online": True, "device": "ESP-01S", "role": "relay", "ip": ip, "data": data})
                    return
            except urllib.error.HTTPError as he:
                if he.code == 404:
                    continue
            except Exception:
                pass
        self.send_json(200, {"online": False, "error": "ESP-01S não respondeu no IP informado", "ip": ip})

    def get_esp01_credito(self, ip, qtd=1, modo="manutencao", motivo="Disparo Remoto"):
        try:
            url = f'http://{ip}/credito?quantidade={qtd}'
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=10) as resp:
                raw = resp.read().decode('utf-8', errors='ignore')
                try:
                    data = json.loads(raw)
                except Exception:
                    data = {"response": raw.strip()}

                with data_lock:
                    price = sales_data.get("price_per_token", 2.50)
                    valor_estimado = qtd * price

                    if modo == "venda":
                        sales_data["session_cash"] += valor_estimado
                        sales_data["session_tokens"] += qtd
                        sales_data["paid_tokens"] += qtd
                        sales_data["general_tokens"] += qtd
                        sales_data["general_cash"] += valor_estimado
                        tipo_evento = "venda"
                        desc = f"Venda Manual ({qtd} fichas - R$ {valor_estimado:.2f})"
                    elif modo == "cortesia":
                        sales_data["courtesy_tokens"] += qtd
                        sales_data["general_tokens"] += qtd
                        tipo_evento = "cortesia"
                        desc = f"Cortesia / Bônus ({qtd} fichas)"
                        valor_estimado = 0.0
                    else:
                        sales_data["maintenance_tokens"] += qtd
                        tipo_evento = "manutencao"
                        desc = f"Manutenção Técnica / Teste ({qtd} fichas)"
                        valor_estimado = 0.0

                    save_data()

                evt = add_event(tipo_evento, qtd, valor_estimado, desc, f"Celular 4G -> ESP-01S ({ip})")
                print(f"[DISPARO RELÉ] {qtd} ficha(s) enviada(s) ao ESP-01S ({ip}) - Modo: {modo.upper()}")

                self.send_json(200, {
                    "success": True,
                    "credits": qtd,
                    "modo": modo,
                    "ip": ip,
                    "details": data,
                    "event": evt
                })
        except Exception as e:
            print(f"[DISPARO ERRO] Falha ao comunicar com ESP-01S ({ip}): {e}")
            self.send_json(500, {"success": False, "error": str(e), "ip": ip})

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
            raw_body = self.rfile.read(length).decode('utf-8')
            req_data = json.loads(raw_body) if raw_body else {}

            responsavel = req_data.get("responsavel", "Operador")
            obs = req_data.get("observacao", "Fechamento de Caixa")

            with data_lock:
                valor_sangria = sales_data["session_cash"]
                fichas_sangria = sales_data["session_tokens"]
                split = float(sales_data.get("barber_split_percent", 50)) / 100.0
                barber_share = valor_sangria * split
                owner_share = valor_sangria - barber_share

                # Zera os contadores da sessão atual, mantendo o totalizador geral vitalício intacto
                sales_data["session_cash"] = 0.0
                sales_data["session_tokens"] = 0
                sales_data["paid_tokens"] = 0
                sales_data["courtesy_tokens"] = 0
                save_data()

            desc_sangria = f"Sangria por {responsavel}. Total: R$ {valor_sangria:.2f} (Barbearia: R$ {barber_share:.2f} | Seu: R$ {owner_share:.2f}). Obs: {obs}"
            evt = add_event("sangria", fichas_sangria, valor_sangria, desc_sangria)
            print(f"[FECHAMENTO CAIXA] R$ {valor_sangria:.2f} recolhido por {responsavel} (Repasse Barbearia: R$ {barber_share:.2f})")

            self.send_json(200, {
                "success": True,
                "valor_recolhido": valor_sangria,
                "fichas_fechadas": fichas_sangria,
                "barber_share": barber_share,
                "owner_share": owner_share,
                "event": evt
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
                if "barber_split_percent" in req_data:
                    sales_data["barber_split_percent"] = max(0, min(100, int(req_data["barber_split_percent"])))
                if "price_per_token" in req_data:
                    sales_data["price_per_token"] = max(0.50, float(req_data["price_per_token"]))
                if "security_pin" in req_data and str(req_data["security_pin"]).strip():
                    sales_data["security_pin"] = str(req_data["security_pin"]).strip()
                if "require_pin" in req_data:
                    sales_data["require_pin"] = bool(req_data["require_pin"])
                if "mp_access_token" in req_data and str(req_data["mp_access_token"]).strip():
                    sales_data["mp_access_token"] = str(req_data["mp_access_token"]).strip()
                save_data()

            self.send_json(200, {"success": True, "message": "Configurações salvas com sucesso"})
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
