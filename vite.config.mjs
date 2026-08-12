import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const liveflowStateFile = path.join(os.tmpdir(), "liveflow-state.json");

function liveflowStateApiPlugin() {
  return {
    name: "liveflow-state-api",
    configureServer(server) {
      server.middlewares.use("/api/liveflow-state", (req, res, next) => {
        if (req.method === "POST") {
          const chunks = [];
          req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          req.on("end", () => {
            try {
              const raw = Buffer.concat(chunks).toString("utf8") || "{}";
              const contents = JSON.stringify(JSON.parse(raw));
              fs.writeFile(liveflowStateFile, contents, "utf8", (error) => {
                if (error) {
                  res.statusCode = 500;
                  res.setHeader("Content-Type", "application/json; charset=utf-8");
                  res.end(JSON.stringify({ ok: false, error: String(error) }));
                  return;
                }

                res.statusCode = 200;
                res.setHeader("Content-Type", "application/json; charset=utf-8");
                res.setHeader("Cache-Control", "no-store");
                res.end(JSON.stringify({ ok: true }));
              });
            } catch (error) {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(JSON.stringify({ ok: false, error: String(error) }));
            }
          });
          return;
        }

        if (req.method !== "GET" && req.method !== "HEAD") {
          next();
          return;
        }

        fs.readFile(liveflowStateFile, "utf8", (error, contents) => {
          if (error) {
            const body = "{}";
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader("Cache-Control", "no-store");
            res.end(body);
            return;
          }

          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.end(contents || "{}");
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), liveflowStateApiPlugin()],
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    allowedHosts: [".trycloudflare.com"],
    watch: {
      ignored: ["**/src-tauri/target/**", "**/src-tauri/target/**/*"],
    },
  },
});
