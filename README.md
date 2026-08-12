# LiveFlow MVP

Desktop MVP สำหรับเชื่อม TikTok LIVE เข้ากับระบบ Event และกฎการทำงาน

## Stack

- React + TypeScript
- Vite
- Tauri 2 + Rust
- Neon PostgreSQL ผ่าน Rust backend
- Gift assets จาก `C:\Users\master\Documents\Codex\TikLIVE\TikLIVE\wwwroot\images\gifts`

## เปิดแบบเว็บสำหรับดู UI

```powershell
npm install
npm run dev
```

## เปิดแบบ Desktop

```powershell
npm install
npm run tauri:dev
```

ตั้งค่า Neon โดยคัดลอก `.env.example` เป็น `.env` ในโฟลเดอร์นี้ แล้วใส่ `DATABASE_URL` ของ Neon ค่าเชื่อมต่อนี้ต้องอยู่ฝั่ง Rust เท่านั้น

## สถานะ MVP

- หน้าภาพรวม LIVE
- ช่องกรอก TikTok username
- Event log แบบจำลอง
- Gift selector พร้อมรูป Gift จริง 106 รายการ
- ตัวแก้กฎ Gift → Action
- Rust command สำหรับทดสอบการเชื่อมต่อ Neon
- TikTok LIVE connector sidecar ที่ใช้ `isaackogan/TikTokLive` จาก GitHub
- ส่ง Event จาก Python → Rust → React ด้วย JSON lines และ Tauri event
- workflow ตรวจ GitHub ทุกสัปดาห์และเปิด Pull Request เมื่อมีการอัปเดต
- Python backend เก็บไว้ที่ `connector\\Python`

## TikTokLive connector

ติดตั้ง connector ล่าสุด:

```powershell
py -m pip install -r connector\requirements.txt
```

หรืออัปเดตด้วย:

```powershell
powershell -ExecutionPolicy Bypass -File connector\update_tiktoklive.ps1
```

จากนั้นเปิดแอป Tauri แล้วกรอก username ในหน้า Dashboard ระบบจะเริ่ม `connector/tiktok_connector.py` และรับ Comment, Gift, Follow และ Like เข้ามาใน Event Log

หมายเหตุ: upstream ระบุว่า `TikTokLive` เป็นไลบรารี third-party แบบ reverse-engineering และไม่ใช่ production-ready API ดังนั้น workflow จะเปิด Pull Request ให้ตรวจสอบก่อนนำเวอร์ชันใหม่เข้าโปรเจกต์จริง
