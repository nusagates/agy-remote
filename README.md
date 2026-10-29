# NusaGates AGY (nusagates-agy)

> Remote Coding Task Dispatcher & Worker for **Google Antigravity** (IDE & CLI).  
> Hubungkan dashboard web ToolBox dengan Antigravity di PC Lokal atau VPS Linux.

---

## Fitur Utama

- **Otomatisasi Coding Remote:** Menerima tugas dari web dashboard NusaGates/ToolBox dan mengeksekusinya langsung via Antigravity.
- **Dukungan Multi-Platform:**
  - **Windows:** Terintegrasi langsung dengan Antigravity IDE desktop (Language Server & live session).
  - **Linux / VPS:** Terintegrasi langsung dengan Antigravity CLI (`agy`) headless mode (`--dangerously-skip-permissions`).
- **Real-Time Live Logs:** Mengirimkan tahapan berpikir (*thinking logs*) dan aksi AI (*tool calls*) kembali ke web secara instan.
- **Git Delta Tracker:** Mendeteksi otomatis file-file yang dimodifikasi oleh AI dan melaporkannya ke web.

---

## Cara Penggunaan Cepat

### 1. Menjalankan Langsung via NPX (Tanpa Install)

```bash
npx github:nusagates/nusagates-agy listen --server=https://tools.nusagates.com --token=YOUR_AGENT_TOKEN
```

### 2. Atau Install Global di Sistem

```bash
npm install -g github:nusagates/nusagates-agy
nusagates-agy listen --server=https://tools.nusagates.com --token=YOUR_AGENT_TOKEN
```

---

## Penggunaan di VPS Linux (Headless)

1. Pastikan Antigravity CLI (`agy`) terpasang:
   ```bash
   curl -fsSL https://antigravity.google/cli/install.sh | bash
   export PATH="$HOME/.local/bin:$PATH"
   agy
   ```
2. Jalankan worker di background via PM2:
   ```bash
   pm2 start npx --name "nusagates-worker" -- github:nusagates/nusagates-agy listen --server=https://tools.nusagates.com --token=YOUR_AGENT_TOKEN
   ```

---

## License

MIT © NusaGates
