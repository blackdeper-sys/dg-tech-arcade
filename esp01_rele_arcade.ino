#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>

// =====================================================================================
// DG TECH ARCADE — MÓDULO RELÉ DE CRÉDITOS 100% WI-FI (ESP-01S / ESP8266)
// REDE: Gigabyte@marialaura | IP FIXO: 192.168.18.99
// =====================================================================================

// =====================================================
// CONFIGURAÇÃO WI-FI
// =====================================================
const char* ssid = "Gigabyte@marialaura";
const char* password = "manu1730";

// IP Estático fixado em 192.168.18.99 na rede do roteador
IPAddress local_IP(192, 168, 18, 99);
IPAddress gateway(192, 168, 18, 1);
IPAddress subnet(255, 255, 255, 0);
IPAddress primaryDNS(8, 8, 8, 8);

// =====================================================
// CONFIGURAÇÃO DO RELÉ
// =====================================================
const int RELE = 0;  // GPIO0 (Nível LOW liga o relé no módulo ESP-01S)

// Variáveis de controle e estatísticas
unsigned long totalPulsosLiberados = 0;
unsigned long ultimoPulsoMillis = 0;

// =====================================================
// PROTEÇÃO CONTRA PULSO DUPLICADO (RING BUFFER EM RAM)
// Compatível com as limitações de memória do ESP-01S (ESP8266)
// =====================================================
const int CMD_CACHE_SIZE = 16;
String ultimosComandos[CMD_CACHE_SIZE];
int cmdCacheIndex = 0;
String ultimoCmdExecutado = "Nenhum";

bool comandoJaExecutado(const String& cmdId) {
  if (cmdId.length() == 0) return false;
  for (int i = 0; i < CMD_CACHE_SIZE; i++) {
    if (ultimosComandos[i] == cmdId) {
      return true;
    }
  }
  return false;
}

void registrarComando(const String& cmdId) {
  if (cmdId.length() == 0) return;
  ultimosComandos[cmdCacheIndex] = cmdId;
  cmdCacheIndex = (cmdCacheIndex + 1) % CMD_CACHE_SIZE;
  ultimoCmdExecutado = cmdId;
}

// =====================================================
// SERVIDOR WEB (Porta 80)
// =====================================================
ESP8266WebServer servidor(80);

// Helper para cabeçalhos CORS (permite chamadas de qualquer origem no navegador/painel)
void aplicarCORS() {
  servidor.sendHeader("Access-Control-Allow-Origin", "*");
  servidor.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  servidor.sendHeader("Access-Control-Allow-Headers", "Content-Type");
}

// =====================================================
// DISPARAR UM PULSO DE CRÉDITO NO COIN
// =====================================================
void darCredito() {
  // Liga o relé (nível LOW no módulo ESP-01S Relay)
  digitalWrite(RELE, LOW);
  delay(85);

  // Desliga o relé
  digitalWrite(RELE, HIGH);

  // Intervalo seguro entre créditos para a placa arcade registrar
  delay(280);
  yield(); // Alimenta o Watchdog do ESP8266
}

// =====================================================
// PÁGINA WEB DIRETA NO CELULAR OU COMPUTADOR (PORTA 80)
// Permite acionar fichas digitando direto http://192.168.18.99
// =====================================================
void paginaInicial() {
  aplicarCORS();

  String html = "<!DOCTYPE html><html lang='pt-BR'><head>";
  html += "<meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no'>";
  html += "<title>DG TECH ARCADE — Relé Wi-Fi</title>";
  html += "<style>";
  html += "*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;}";
  html += "body{background:#0a0d14;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:20px;text-align:center;}";
  html += ".card{background:#131826;border:2px solid #00e5ff;border-radius:16px;padding:24px;max-width:380px;width:100%;box-shadow:0 0 25px rgba(0,229,255,0.2);}";
  html += "h1{font-size:1.6rem;color:#ff0055;margin-bottom:6px;letter-spacing:1px;text-shadow:0 0 10px rgba(255,0,85,0.5);}";
  html += "p.sub{font-size:0.85rem;color:#8ba3c7;margin-bottom:20px;}";
  html += ".badge{display:inline-block;background:#003344;border:1px solid #00e5ff;color:#00e5ff;padding:4px 12px;border-radius:20px;font-size:0.8rem;margin-bottom:18px;}";
  html += ".btn{display:block;width:100%;padding:16px;margin-bottom:12px;font-size:1.15rem;font-weight:bold;color:#fff;border:none;border-radius:12px;cursor:pointer;transition:transform 0.1s,background 0.2s;text-decoration:none;}";
  html += ".btn:active{transform:scale(0.96);}";
  html += ".btn-coin1{background:linear-gradient(135deg,#00c853,#64dd17);box-shadow:0 0 15px rgba(0,200,83,0.4);}";
  html += ".btn-coin2{background:linear-gradient(135deg,#00b0ff,#0091ea);box-shadow:0 0 15px rgba(0,176,255,0.4);}";
  html += ".btn-coin5{background:linear-gradient(135deg,#ff9100,#ff6d00);box-shadow:0 0 15px rgba(255,145,0,0.4);}";
  html += ".stat-box{background:#0d111d;border:1px solid #202b42;border-radius:10px;padding:12px;margin-top:14px;font-size:0.85rem;color:#a0b0cb;}";
  html += "#log{color:#00e5ff;font-weight:bold;margin-top:6px;min-height:20px;}";
  html += "</style></head><body>";
  html += "<div class='card'>";
  html += "<h1>DG TECH ARCADE</h1>";
  html += "<p class='sub'>DISPARO DE COIN WI-FI (ESP-01S)</p>";
  html += "<div class='badge'>IP: " + WiFi.localIP().toString() + " | ONLINE</div>";
  html += "<button class='btn btn-coin1' onclick='dar(1)'>🪙 1 FICHA (R$ 2,50)</button>";
  html += "<button class='btn btn-coin2' onclick='dar(2)'>🪙 2 FICHAS (R$ 5,00)</button>";
  html += "<button class='btn btn-coin5' onclick='dar(5)'>🪙 5 FICHAS (R$ 12,50)</button>";
  html += "<div class='stat-box'>";
  html += "<div>Total liberado desde o boot: <strong id='total'>" + String(totalPulsosLiberados) + "</strong></div>";
  html += "<div id='log'>Pronto para disparar</div>";
  html += "</div></div>";
  html += "<script>";
  html += "function dar(q){";
  html += "document.getElementById('log').innerText='Disparando '+q+' ficha(s)...';";
  html += "var cmd='CMD-DIR-'+Date.now();";
  html += "fetch('/credito?quantidade='+q+'&cmd_id='+cmd)";
  html += ".then(r=>r.json())";
  html += ".then(d=>{";
  html += "document.getElementById('log').innerText='✅ '+q+' ficha(s) liberada(s)!';";
  html += "if(d.total_acumulado) document.getElementById('total').innerText=d.total_acumulado;";
  html += "})";
  html += ".catch(e=>{document.getElementById('log').innerText='❌ Erro de comunicacao';});";
  html += "}";
  html += "</script></body></html>";

  servidor.send(200, "text/html", html);
}

// =====================================================
// ROTA: PING RÁPIDO
// =====================================================
void ping() {
  aplicarCORS();
  servidor.send(200, "application/json", "{\"status\":\"pong\",\"device\":\"ESP-01S\",\"role\":\"relay\",\"ip\":\"" + WiFi.localIP().toString() + "\"}");
}

// =====================================================
// ROTA: STATUS JSON COMPLETO
// =====================================================
void statusJson() {
  aplicarCORS();
  String json = "{";
  json += "\"device\":\"ESP-01S\",";
  json += "\"role\":\"relay\",";
  json += "\"status\":\"online\",";
  json += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  json += "\"rssi\":" + String(WiFi.RSSI()) + ",";
  json += "\"total_creditos\":" + String(totalPulsosLiberados) + ",";
  json += "\"uptime_segundos\":" + String(millis() / 1000) + ",";
  json += "\"ultimo_cmd_id\":\"" + ultimoCmdExecutado + "\",";
  json += "\"ultimo_pulso_ms\":" + String(ultimoPulsoMillis);
  json += "}";

  servidor.send(200, "application/json", json);
}

// =====================================================
// ROTA: LIBERAR CRÉDITOS COM PROTEÇÃO CONTRA DUPLICIDADE
// (/credito?quantidade=X&cmd_id=CMD-YYYYMMDD-XXXXX)
// =====================================================
void liberarCredito() {
  aplicarCORS();
  int quantidade = 1;
  String cmdId = "";

  if (servidor.hasArg("quantidade")) {
    quantidade = servidor.arg("quantidade").toInt();
  }
  if (servidor.hasArg("cmd_id")) {
    cmdId = servidor.arg("cmd_id");
  } else if (servidor.hasArg("id")) {
    cmdId = servidor.arg("id");
  }

  // Proteção contra quantidade inválida
  if (quantidade < 1 || quantidade > 20) {
    servidor.send(400, "application/json", "{\"error\":\"Quantidade invalida (min 1, max 20)\"}");
    return;
  }

  // PROTEÇÃO CONTRA PULSO DUPLICADO (Deduplicação por ID de Comando)
  if (cmdId.length() > 0 && comandoJaExecutado(cmdId)) {
    Serial.println();
    Serial.print("[PROTECAO DUPLICIDADE] Comando ja executado anteriormente: ");
    Serial.println(cmdId);
    String resp = "{";
    resp += "\"success\":true,";
    resp += "\"already_executed\":true,";
    resp += "\"executed\":false,";
    resp += "\"cmd_id\":\"" + cmdId + "\",";
    resp += "\"creditos_liberados\":" + String(quantidade) + ",";
    resp += "\"total_acumulado\":" + String(totalPulsosLiberados) + ",";
    resp += "\"device\":\"ESP-01S\",";
    resp += "\"message\":\"Comando ja executado anteriormente (protecao contra duplicidade)\"";
    resp += "}";
    servidor.send(200, "application/json", resp);
    return;
  }

  // Proteção contra múltiplos cliques rápidos ou disparos duplicados sem ID em menos de 500ms
  unsigned long agora = millis();
  if (cmdId.length() == 0 && ultimoPulsoMillis > 0 && (agora - ultimoPulsoMillis < 500)) {
    Serial.println("[AVISO] Disparo duplicado bloqueado por cooldown (< 500ms).");
    String resp = "{\"success\":true,\"ignored\":true,\"motivo\":\"cooldown\",\"total_acumulado\":" + String(totalPulsosLiberados) + "}";
    servidor.send(200, "application/json", resp);
    return;
  }

  Serial.println();
  Serial.println("=========================================");
  Serial.print(">>> DISPARANDO CREDITOS NO RELE: ");
  Serial.println(quantidade);
  if (cmdId.length() > 0) {
    Serial.print(">>> ID DO COMANDO: ");
    Serial.println(cmdId);
  }
  Serial.println("=========================================");

  // Executa os pulsos físicos no relé
  for (int i = 0; i < quantidade; i++) {
    darCredito();
    totalPulsosLiberados++;
  }
  ultimoPulsoMillis = millis();
  if (cmdId.length() > 0) {
    registrarComando(cmdId);
  }

  String resp = "{";
  resp += "\"success\":true,";
  resp += "\"executed\":true,";
  if (cmdId.length() > 0) {
    resp += "\"cmd_id\":\"" + cmdId + "\",";
  }
  resp += "\"creditos_liberados\":" + String(quantidade) + ",";
  resp += "\"total_acumulado\":" + String(totalPulsosLiberados) + ",";
  resp += "\"device\":\"ESP-01S\"";
  resp += "}";

  servidor.send(200, "application/json", resp);
}

// =====================================================
// SETUP
// =====================================================
void setup() {
  Serial.begin(115200);
  delay(300);

  // CONFIGURAÇÃO DO RELÉ
  // IMPORTANTE: Escrever HIGH antes de pinMode evita o falso clique na inicialização
  digitalWrite(RELE, HIGH);
  pinMode(RELE, OUTPUT);
  digitalWrite(RELE, HIGH);

  // WI-FI
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(true);

  // Fixa o IP Estático 192.168.18.99
  WiFi.config(local_IP, gateway, subnet, primaryDNS);

  WiFi.begin(ssid, password);

  Serial.println();
  Serial.print("Conectando ao Wi-Fi: ");
  Serial.println(ssid);

  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }

  Serial.println();
  Serial.println("=========================================");
  Serial.println("Wi-Fi CONECTADO COM SUCESSO!");
  Serial.print("IP FIXO ESP-01S: ");
  Serial.println(WiFi.localIP());
  Serial.println("=========================================");

  // ROTAS DO SERVIDOR HTTP
  servidor.on("/", paginaInicial);
  servidor.on("/ping", ping);
  servidor.on("/status", statusJson);
  servidor.on("/credito", liberarCredito);

  servidor.begin();
  Serial.println("Servidor HTTP do Relé Ativo na Porta 80!");
}

// =====================================================
// LOOP PRINCIPAL
// =====================================================
void loop() {
  servidor.handleClient();
}
