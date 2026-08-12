# Cloudflare Webhook

ไฟล์ `worker.ts` เป็นตัวอย่าง Cloudflare Worker สำหรับรับ Event จาก LiveFlow โดยใช้ URL รูปแบบ:

```text
https://ชื่อโปรเจกต์.ชื่อผู้ใช้.workers.dev
```

นำ URL ที่ Deploy แล้วไปวางในเมนู **ส่ง Webhook** จากนั้นสามารถผูกกับ Gift, Comment, Like หรือ Event อื่นได้

