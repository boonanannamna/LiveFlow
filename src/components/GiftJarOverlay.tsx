import { useEffect, useMemo, useRef } from "react";
import { clamp, createJarGeometry, resolvePairCollision, resolveWallCollision } from "./giftJarPhysics";

type JarStyle = "classic" | "tall" | "hex" | "cute";

type GiftBody = {
  assetPath: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  angularVelocity: number;
  radius: number;
  mass: number;
  restitution: number;
  friction: number;
  wallFriction: number;
  sleeping: boolean;
  sleepFrames: number;
  settled: boolean;
  wobblePhase: number;
  driftSeed: number;
  airDriftStrength: number;
  airTorqueStrength: number;
  spinDirection: 1 | -1;
  image: HTMLImageElement | null;
};

const giftAssets = import.meta.glob("../assets/gifts/*", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
const giftAssetUrls = Object.entries(giftAssets).map(([path, url]) => ({
  name: path.replace("../assets/gifts/", "").replace(/\.png$/, ""),
  path,
  url,
}));

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function safeFileName(filePath: string) {
  return String(filePath || "").split(/[\\/]/).pop() || "gift";
}

function drawGiftBall(ctx: CanvasRenderingContext2D, image: HTMLImageElement | null, size: number) {
  const radius = size * 0.5;

  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.42)";
  ctx.shadowBlur = Math.max(6, radius * 0.45);
  ctx.shadowOffsetY = Math.max(3, radius * 0.22);

  const shell = ctx.createRadialGradient(
    -radius * 0.34,
    -radius * 0.38,
    radius * 0.05,
    radius * 0.14,
    radius * 0.2,
    radius * 1.08
  );
  shell.addColorStop(0, "rgba(255,255,255,1)");
  shell.addColorStop(0.16, "rgba(255,228,244,0.98)");
  shell.addColorStop(0.42, "rgba(255,78,156,0.97)");
  shell.addColorStop(0.74, "rgba(218,24,98,0.98)");
  shell.addColorStop(1, "rgba(87,8,42,1)");

  ctx.fillStyle = shell;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.shadowColor = "transparent";

  const lowerShade = ctx.createRadialGradient(
    radius * 0.2,
    radius * 0.38,
    radius * 0.08,
    radius * 0.2,
    radius * 0.42,
    radius * 0.92
  );
  lowerShade.addColorStop(0, "rgba(0,0,0,0)");
  lowerShade.addColorStop(0.55, "rgba(0,0,0,0.10)");
  lowerShade.addColorStop(1, "rgba(0,0,0,0.34)");
  ctx.fillStyle = lowerShade;
  ctx.beginPath();
  ctx.arc(0, 0, radius * 0.98, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, radius * 0.74, 0, Math.PI * 2);
  ctx.clip();

  const badge = ctx.createRadialGradient(
    -radius * 0.18,
    -radius * 0.22,
    radius * 0.05,
    0,
    0,
    radius * 0.78
  );
  badge.addColorStop(0, "rgba(255,255,255,0.98)");
  badge.addColorStop(0.72, "rgba(255,255,255,0.84)");
  badge.addColorStop(1, "rgba(255,210,235,0.72)");
  ctx.fillStyle = badge;
  ctx.fillRect(-radius, -radius, radius * 2, radius * 2);

  if (image) {
    const drawSize = radius * 1.26;
    ctx.globalAlpha = 0.96;
    ctx.drawImage(image, -drawSize * 0.5, -drawSize * 0.5, drawSize, drawSize);
  } else {
    ctx.fillStyle = "rgba(220, 25, 100, 0.92)";
    ctx.fillRect(-radius * 0.38, -radius * 0.26, radius * 0.76, radius * 0.58);
    ctx.fillStyle = "rgba(255, 255, 255, 0.90)";
    ctx.fillRect(-radius * 0.08, -radius * 0.26, radius * 0.16, radius * 0.58);
    ctx.fillRect(-radius * 0.38, -radius * 0.02, radius * 0.76, radius * 0.14);
  }

  ctx.restore();

  ctx.strokeStyle = "rgba(255,255,255,0.90)";
  ctx.lineWidth = Math.max(1.3, radius * 0.095);
  ctx.beginPath();
  ctx.arc(0, 0, radius * 0.76, 0, Math.PI * 2);
  ctx.stroke();

  const highlight = ctx.createRadialGradient(
    -radius * 0.34,
    -radius * 0.38,
    0,
    -radius * 0.34,
    -radius * 0.38,
    radius * 0.52
  );
  highlight.addColorStop(0, "rgba(255,255,255,0.92)");
  highlight.addColorStop(0.42, "rgba(255,255,255,0.34)");
  highlight.addColorStop(1, "rgba(255,255,255,0)");

  ctx.fillStyle = highlight;
  ctx.beginPath();
  ctx.ellipse(-radius * 0.34, -radius * 0.38, radius * 0.28, radius * 0.18, -0.55, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "rgba(255,255,255,0.72)";
  ctx.lineWidth = Math.max(1.2, radius * 0.075);
  ctx.beginPath();
  ctx.arc(0, 0, radius * 0.97, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = "rgba(54, 0, 32, 0.54)";
  ctx.lineWidth = Math.max(1, radius * 0.045);
  ctx.beginPath();
  ctx.arc(0, 0, radius * 1.01, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

type Props = {
  count: number;
  dropTrigger?: number;
  jarStyle: JarStyle;
  userName: string;
  coins: number;
  totalCoins: number;
  giftName?: string;
  giftScale?: number;
  capacity?: number;
  showOverflow?: boolean;
  showUser?: boolean;
  showCoins?: boolean;
  showCounter?: boolean;
};

export function GiftJarOverlay({
  count,
  dropTrigger = 0,
  jarStyle,
  userName,
  coins,
  totalCoins,
  giftName,
  giftScale = 1,
  capacity = 18,
  showOverflow = true,
  showUser = true,
  showCoins = true,
  showCounter = true,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const geometryRef = useRef(createJarGeometry(240, 320));
  const itemsRef = useRef<GiftBody[]>([]);
  const lastFrameRef = useRef<number>(0);
  const dprRef = useRef<number>(Math.max(1, Math.floor(window.devicePixelRatio || 1)));
  const prevVisibleCountRef = useRef<number>(Math.max(0, Math.min(count, capacity)));
  const prevDropTriggerRef = useRef<number>(dropTrigger);
  const pendingTimersRef = useRef<number[]>([]);
  const assetIndexRef = useRef<number>(0);

  const assetPool = useMemo(() => {
    if (giftName) {
      const selectedAsset = giftAssetUrls.find((item) => item.name === giftName || item.path === `${giftName}.png`);
      return selectedAsset ? [selectedAsset] : [];
    }
    return giftAssetUrls;
  }, [giftName]);
  const visibleCount = Math.max(0, Math.min(count, capacity));
  const overflowCount = showOverflow ? Math.max(0, count - capacity) : 0;
  const floorOverflowCount = showOverflow && count >= capacity ? Math.max(4, Math.ceil(capacity * 0.12)) : 0;

  const clearPendingTimers = () => {
    for (const timer of pendingTimersRef.current) {
      window.clearTimeout(timer);
    }
    pendingTimersRef.current = [];
  };

  const loadImage = (assetPath: string) => {
    const entry = assetPool.find((item) => item.path === assetPath || item.name === assetPath);
    if (!entry?.url) return Promise.resolve(null);
    return new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = entry.url;
    });
  };

  useEffect(() => {
    itemsRef.current = [];
    prevVisibleCountRef.current = 0;
    clearPendingTimers();
  }, [assetPool, giftScale]);

  useEffect(() => {
    if (!dropTrigger || dropTrigger === prevDropTriggerRef.current) return;
    prevDropTriggerRef.current = dropTrigger;
    if (assetPool.length === 0) return;
    const asset = assetPool[0];
    const timer = window.setTimeout(() => {
      void spawnGiftItem(asset.path);
    }, 0);
    pendingTimersRef.current.push(timer);
    return () => window.clearTimeout(timer);
  }, [assetPool, dropTrigger]);

  const createBody = async (assetPath: string) => {
    const glass = hostRef.current?.querySelector(".jar-body") as HTMLElement | null;
    const geometry = geometryRef.current;
    const width = glass?.clientWidth || geometry.width;
    const x = width * 0.5 + randomBetween(-18, 18);
    const startY = Math.max(geometry.mouthY * 0.15, 24);
    const radius = clamp(randomBetween(14, 20) * giftScale, 9, 28);
    const image = await loadImage(assetPath);
    return {
      assetPath,
      x,
      y: startY,
      vx: randomBetween(-7, 7),
      vy: randomBetween(-2, 4),
      angle: randomBetween(-0.35, 0.35),
      angularVelocity: randomBetween(-0.45, 0.45),
      radius,
      mass: clamp(radius / 12, 1, 2.2),
      restitution: randomBetween(0.015, 0.03),
      friction: randomBetween(0.96, 0.995),
      wallFriction: randomBetween(0.975, 0.995),
      sleeping: false,
      sleepFrames: 0,
      settled: false,
      wobblePhase: Math.random() * Math.PI * 2,
      driftSeed: Math.random() * Math.PI * 2,
      airDriftStrength: randomBetween(0.08, 0.35),
      airTorqueStrength: randomBetween(0.0006, 0.002),
      spinDirection: Math.random() > 0.5 ? (1 as const) : (-1 as const),
      image,
    } satisfies GiftBody;
  };

  const spawnGiftItem = async (assetPath: string) => {
    if (itemsRef.current.length >= Math.max(40, visibleCount + 10)) return;
    if (!assetPath) return;
    const body = await createBody(assetPath);
    itemsRef.current.push(body);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;

    const resize = () => {
      const body = host.querySelector(".jar-body") as HTMLElement | null;
      if (!body) return;
      const rect = body.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      dprRef.current = Math.max(1, Math.floor(window.devicePixelRatio || 1));
      canvas.width = Math.max(1, Math.round(width * dprRef.current));
      canvas.height = Math.max(1, Math.round(height * dprRef.current));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      geometryRef.current = createJarGeometry(width, height);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const body = host.querySelector(".jar-body");
    if (body) observer.observe(body);

    let running = true;
    const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
    if (!ctx) return () => observer.disconnect();

    const drawBackground = (width: number, height: number) => {
      ctx.clearRect(0, 0, width, height);
      ctx.save();
      ctx.setTransform(dprRef.current, 0, 0, dprRef.current, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.restore();
    };

    let animationFrame = 0;

    const render = (timestamp: number) => {
      if (!running) return;

      const width = canvas.width / dprRef.current;
      const height = canvas.height / dprRef.current;
      drawBackground(width, height);

      if (!lastFrameRef.current) lastFrameRef.current = timestamp;
      const deltaSeconds = clamp((timestamp - lastFrameRef.current) / 1000, 0, 0.033);
      lastFrameRef.current = timestamp;

      const geometry = geometryRef.current;
      const now = performance.now();

      for (const bodyItem of itemsRef.current) {
        if (bodyItem.sleeping) {
          bodyItem.vx = 0;
          bodyItem.vy = 0;
          bodyItem.angularVelocity = 0;
          continue;
        }
        const passedMouth = bodyItem.y > geometry.mouthY + bodyItem.radius * 1.4;
        bodyItem.vy += 360 * deltaSeconds;
        if (!passedMouth) {
          bodyItem.vy += 360 * 0.52 * deltaSeconds;
          bodyItem.vx *= Math.pow(0.986, deltaSeconds * 60);
          bodyItem.vx += Math.sin(now * 0.0018 + bodyItem.driftSeed) * bodyItem.airDriftStrength * deltaSeconds;
        }
        bodyItem.angularVelocity +=
          Math.sin(now * 0.002 + bodyItem.wobblePhase) * bodyItem.airTorqueStrength * bodyItem.spinDirection;
        bodyItem.vx *= Math.pow(0.976, deltaSeconds * 60);
        bodyItem.vy *= Math.pow(0.984, deltaSeconds * 60);
        bodyItem.angularVelocity *= Math.pow(0.965, deltaSeconds * 60);
        bodyItem.x += bodyItem.vx * deltaSeconds;
        bodyItem.y += bodyItem.vy * deltaSeconds;
        bodyItem.angle += bodyItem.angularVelocity * deltaSeconds;
        resolveWallCollision(bodyItem, geometry);
      }

      for (let iteration = 0; iteration < 7; iteration += 1) {
        for (let i = 0; i < itemsRef.current.length; i += 1) {
          resolveWallCollision(itemsRef.current[i], geometry);
          for (let j = i + 1; j < itemsRef.current.length; j += 1) {
            resolvePairCollision(itemsRef.current[i], itemsRef.current[j]);
          }
        }
      }

      for (const bodyItem of itemsRef.current) {
        const nearFloor = bodyItem.y + bodyItem.radius >= geometry.floorY - 1.5;
        const slowEnough =
          Math.abs(bodyItem.vx) < 3.2 &&
          Math.abs(bodyItem.vy) < 4.8 &&
          Math.abs(bodyItem.angularVelocity) < 0.02;
        if (nearFloor && slowEnough) {
          bodyItem.sleepFrames += 1;
          if (bodyItem.sleepFrames > 22) {
            bodyItem.sleeping = true;
            bodyItem.settled = true;
            bodyItem.vx = 0;
            bodyItem.vy = 0;
            bodyItem.angularVelocity = 0;
          }
        } else {
          bodyItem.sleepFrames = 0;
          if (Math.abs(bodyItem.vx) > 1 || Math.abs(bodyItem.vy) > 1 || Math.abs(bodyItem.angularVelocity) > 0.01) {
            bodyItem.settled = false;
          }
        }
      }

      const drawOrder = [...itemsRef.current].sort((a, b) => a.y - b.y || a.x - b.x);
      ctx.save();
      ctx.setTransform(dprRef.current, 0, 0, dprRef.current, 0, 0);
      for (const item of drawOrder) {
        const image = item.image;
        const size = item.radius * 2.24;
        const wobble = item.sleeping ? 0 : Math.sin(now * 0.0035 + item.wobblePhase) * 0.008;
        ctx.save();
        ctx.translate(item.x, item.y);
        ctx.rotate(item.angle + wobble);
        drawGiftBall(ctx, image, size);
        ctx.restore();
      }
      ctx.restore();

      animationFrame = window.requestAnimationFrame(render);
    };

    animationFrame = window.requestAnimationFrame(render);

    return () => {
      running = false;
      observer.disconnect();
      window.cancelAnimationFrame(animationFrame);
    };
  }, []);

  useEffect(() => {
    if (assetPool.length === 0) {
      itemsRef.current = [];
      clearPendingTimers();
      return;
    }

    const isInitialSeed = itemsRef.current.length === 0 && visibleCount > 0;
    const delta = isInitialSeed ? visibleCount : Math.max(0, visibleCount - prevVisibleCountRef.current);
    prevVisibleCountRef.current = visibleCount;

    if (visibleCount <= 0) {
      itemsRef.current = [];
      clearPendingTimers();
      return;
    }

    if (delta <= 0) {
      if (itemsRef.current.length > visibleCount) {
        itemsRef.current = itemsRef.current.slice(0, visibleCount);
      }
      return;
    }

    clearPendingTimers();
    const available = assetPool;

    for (let i = 0; i < delta; i += 1) {
      const delay = 90 + i * 75;
      const timer = window.setTimeout(async () => {
        const asset = available[(assetIndexRef.current + i) % available.length];
        await spawnGiftItem(asset.path);
      }, delay);
      pendingTimersRef.current.push(timer);
    }

    assetIndexRef.current = (assetIndexRef.current + delta) % Math.max(1, available.length);

    return () => clearPendingTimers();
  }, [assetPool, visibleCount, giftScale]);

  return (
    <div ref={hostRef} className={`gift-jar-overlay jar-style-${jarStyle}`}>
      <div className="jar-lid" />
      <div className="jar-body">
        <canvas ref={canvasRef} className="jar-canvas" />
      </div>
      {overflowCount > 0 && (
        <div className="jar-spill">
          {Array.from({ length: overflowCount }, (_, spillIndex) => {
            const spillAsset = assetPool[0];
            const spillSize = Math.round(clamp(22 * giftScale, 16, 42));
            const row = Math.floor(spillIndex / 10);
            const col = spillIndex % 10;
            const rowSpread = row * 4;
            const horizontalShift = (row % 2) * 3;
            return (
              <img
                key={`spill-${spillIndex}`}
                className="jar-spill-gift"
                src={spillAsset.url}
                alt=""
                style={{
                  left: `${6 + col * 8 + rowSpread + horizontalShift}%`,
                  bottom: `${-14 + row * 12}px`,
                  width: `${spillSize}px`,
                  height: `${spillSize}px`,
                  transform: `rotate(${(spillIndex * 19) % 32 - 16}deg) translateY(${row * 2}px)`,
                }}
              />
            );
          })}
        </div>
      )}
      {floorOverflowCount > 0 && (
        <div className="jar-spill jar-spill-floor">
          {Array.from({ length: floorOverflowCount }, (_, spillIndex) => {
            const spillAsset = assetPool[spillIndex % Math.max(1, assetPool.length)];
            const spillSize = Math.round(clamp(20 * giftScale, 15, 36));
            const row = Math.floor(spillIndex / 12);
            const col = spillIndex % 12;
            const left = 4 + col * 7.6 + (row % 2) * 2.2;
            const bottom = -2 + row * 10.5;
            const sway = (spillIndex % 2 === 0 ? -1 : 1) * (row % 3);
            return (
              <img
                key={`floor-spill-${spillIndex}`}
                className="jar-spill-gift jar-spill-gift-floor"
                src={spillAsset.url}
                alt=""
                style={{
                  left: `${left}%`,
                  bottom: `${bottom}px`,
                  width: `${spillSize}px`,
                  height: `${spillSize}px`,
                  transform: `translateX(${sway}px) rotate(${(spillIndex * 11) % 24 - 12}deg)`,
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
