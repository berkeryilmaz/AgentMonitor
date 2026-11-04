# 🚀 Antigravity Multi-Agent Monitor (`:8090`)

Google Antigravity (AGY) üzerinde çalışan **Ana Orkestratör** ve **Alt Ajanları (Subagents)**, dinamik seçilen modelleri (`flash_lite`, `flash`, `pro`, `inherit`), proje/klasör bazlı oturumları ve **ajanlar arası gönderilen tüm mesajları (`invoke_subagent` & `send_message`)** canlı olarak görselleştiren sıfır-ayarlı Docker izleme paneli.

## Kurulum ve Çalıştırma (Host Makinede)

Host makinenizde bu klasöre girip tek komutla ayağa kaldırabilirsiniz:

```bash
cd agent-monitor
docker compose up -d --build
```

Ardından tarayıcınızdan şu adrese gidin:
👉 **http://localhost:8090**

## Nasıl Çalışır?
1. **Otomatik Senkronizasyon (`/var/run/docker.sock` + Ortak Klasör):**
   - `agent-monitor` konteyneri çalıştığında `/var/run/docker.sock` üzerinden çalışan `antigravity` konteynerini otomatik bulur ve `/root/.gemini/antigravity-cli/brain` ile `/root/.gemini/config/agents` içerisindeki konuşma/ajan kayıtlarını `./data/mirror` klasörüne anlık senkronize eder.
   - Hiçbir `.env` veya host dosya yolu (`ANTIGRAVITY_HOME` vb.) ayarlamanıza gerek yoktur.
2. **Proje / Klasör Filtresi:**
   - Sol menüden `/workspace` altındaki projelerinizi (`SignalML`, `FaturaBol`, `HEPML` vb.) seçerek sadece o projede çalışan ajanları filtreleyebilirsiniz.
3. **Ajan Ağı & Mesaj Akışı:**
   - Üst panelde ana orkestratör ve alt ajanların kartlarını, hangi modelle (`flash_lite`, `flash`, `pro`) ve hangi branch/worktree üzerinde çalıştıklarını görürsünüz.
   - Alt panelde ajanların birbirine atadığı görevleri (`invoke_subagent`) ve tamamlama raporlarını (`send_message`) canlı sohbet akışı olarak takip edebilirsiniz.
   - Herhangi bir ajanın üzerindeki **"İncele →"** butonuna tıklayarak o ajanın içsel düşüncelerini (`thinking`) ve araç çağrılarını adım adım inceleyebilirsiniz.
