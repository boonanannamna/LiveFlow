import { useEffect, useState, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { check, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { RefreshCw } from "lucide-react";

type UpdateStatus = "checking" | "current" | "downloading" | "installing" | "error";

const UPDATE_CHECK_RETRIES = 2;

export function UpdateGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<UpdateStatus>(isTauri() ? "checking" : "current");
  const [version, setVersion] = useState("");
  const [message, setMessage] = useState("กำลังตรวจสอบเวอร์ชันล่าสุดจาก GitHub...");
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let downloaded = 0;
    let total = 0;

    const handleProgress = (event: DownloadEvent) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? 0;
        downloaded = 0;
        setStatus("downloading");
        setMessage("กำลังดาวน์โหลดอัปเดตที่มีลายเซ็น...");
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        if (total > 0) setProgress(Math.min(100, Math.round((downloaded / total) * 100)));
      } else if (event.event === "Finished") {
        setProgress(100);
        setStatus("installing");
        setMessage("กำลังติดตั้งอัปเดต กรุณาอย่าปิดโปรแกรม...");
      }
    };

    const checkForUpdate = async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt <= UPDATE_CHECK_RETRIES; attempt += 1) {
        try {
          return await check({ timeout: 20_000 });
        } catch (error) {
          lastError = error;
          if (attempt < UPDATE_CHECK_RETRIES) {
            setMessage(`เชื่อมต่อ GitHub ไม่สำเร็จ กำลังลองใหม่ (${attempt + 1}/${UPDATE_CHECK_RETRIES})...`);
            await new Promise((resolve) => window.setTimeout(resolve, 1_500));
          }
        }
      }
      throw lastError;
    };

    void checkForUpdate()
      .then(async (update) => {
        if (cancelled) { await update?.close(); return; }
        if (!update) { setStatus("current"); return; }
        setVersion(update.version);
        await update.downloadAndInstall(handleProgress);
        if (!cancelled) await relaunch();
      })
      .catch((error) => {
        if (cancelled) return;
        const details = String(error);
        // The very first installer must remain usable before the repository has
        // its initial GitHub Release. Once latest.json exists, newer versions
        // are still downloaded and installed before the application opens.
        if (/404|not found/i.test(details)) {
          setStatus("current");
          return;
        }
        setStatus("error");
        setMessage(`ตรวจสอบอัปเดตไม่สำเร็จ: ${details}`);
      });

    return () => { cancelled = true; };
  }, []);

  if (status === "current") return <>{children}</>;

  return (
    <main className="forced-update-screen">
      <section>
        <RefreshCw size={42} className={status !== "error" ? "update-spinner" : ""} />
        <p className="eyebrow">SECURE AUTO UPDATE</p>
        <h1>{status === "error" ? "ไม่สามารถตรวจสอบอัปเดตได้" : version ? `กำลังอัปเดตเป็น ${version}` : "กำลังตรวจสอบอัปเดต"}</h1>
        <p>{message}</p>
        {(status === "downloading" || status === "installing") && <div className="update-progress"><span style={{ width: `${progress}%` }} /></div>}
        {status === "error" && <div className="update-error-actions"><button onClick={() => window.location.reload()}>ลองตรวจสอบอีกครั้ง</button><button className="ghost-btn" onClick={() => setStatus("current")}>เข้าใช้งานชั่วคราว</button></div>}
        <small>LiveFlow จะตรวจสอบลายเซ็นดิจิทัลก่อนติดตั้งทุกครั้ง</small>
      </section>
    </main>
  );
}
