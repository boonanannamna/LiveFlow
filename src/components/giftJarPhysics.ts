export type JarGeometry = ReturnType<typeof createJarGeometry>;

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

export function createJarGeometry(width: number, height: number) {
  const w = Math.max(120, width || 200);
  const h = Math.max(180, height || 260);

  const mouthY = h * 0.11;
  const shoulderY = h * 0.24;
  const floorY = h * 0.93;
  const mouthHalf = w * 0.31;
  const shoulderHalf = w * 0.42;
  const bodyHalf = w * 0.46;

  return {
    width: w,
    height: h,
    mouthY,
    shoulderY,
    floorY,
    mouthHalf,
    shoulderHalf,
    bodyHalf,
    leftWall(y: number) {
      if (y <= mouthY) {
        return w * 0.5 - mouthHalf;
      }

      if (y <= shoulderY) {
        const shoulderT = clamp((y - mouthY) / Math.max(1, shoulderY - mouthY), 0, 1);
        return lerp(w * 0.5 - mouthHalf, w * 0.5 - shoulderHalf, shoulderT);
      }

      const bodyT = clamp((y - shoulderY) / Math.max(1, floorY - shoulderY), 0, 1);
      return lerp(w * 0.5 - shoulderHalf, w * 0.5 - bodyHalf, bodyT);
    },
    rightWall(y: number) {
      if (y <= mouthY) {
        return w * 0.5 + mouthHalf;
      }

      if (y <= shoulderY) {
        const shoulderT = clamp((y - mouthY) / Math.max(1, shoulderY - mouthY), 0, 1);
        return lerp(w * 0.5 + mouthHalf, w * 0.5 + shoulderHalf, shoulderT);
      }

      const bodyT = clamp((y - shoulderY) / Math.max(1, floorY - shoulderY), 0, 1);
      return lerp(w * 0.5 + shoulderHalf, w * 0.5 + bodyHalf, bodyT);
    },
    mouthLeft() {
      return w * 0.5 - mouthHalf;
    },
    mouthRight() {
      return w * 0.5 + mouthHalf;
    },
  };
}

export function resolveWallCollision(
  body: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    radius: number;
    restitution?: number;
    wallFriction?: number;
    angularVelocity: number;
  },
  geometry: JarGeometry
) {
  const left = geometry.leftWall(body.y);
  const right = geometry.rightWall(body.y);
  const floor = geometry.floorY;
  const restitution = clamp(body.restitution ?? 0.03, 0.012, 0.09);
  const wallFriction = clamp(body.wallFriction ?? 0.975, 0.9, 0.998);
  let hit = false;

  if (body.x - body.radius < left) {
    body.x = left + body.radius;
    if (body.vx < 0) body.vx = Math.abs(body.vx) * restitution;
    body.vy *= wallFriction;
    body.angularVelocity *= 0.9;
    body.angularVelocity += (Math.random() - 0.5) * 0.04;
    hit = true;
  }

  if (body.x + body.radius > right) {
    body.x = right - body.radius;
    if (body.vx > 0) body.vx = -Math.abs(body.vx) * restitution;
    body.vy *= wallFriction;
    body.angularVelocity *= 0.9;
    body.angularVelocity += (Math.random() - 0.5) * 0.04;
    hit = true;
  }

  if (body.y + body.radius > floor) {
    body.y = floor - body.radius;
    if (body.vy > 0) {
      if (Math.abs(body.vy) < 42) {
        body.vy = 0;
      } else {
        body.vy = -Math.abs(body.vy) * restitution;
      }

      body.vx *= 0.9;
      body.angularVelocity *= 0.88;

      if (Math.abs(body.vx) < 1.6) body.vx = 0;
      if (Math.abs(body.angularVelocity) < 0.025) body.angularVelocity = 0;
      hit = true;
    }
  }

  return hit;
}

export function resolvePairCollision(
  a: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    radius: number;
    mass?: number;
    restitution?: number;
    friction?: number;
    angularVelocity: number;
    sleeping?: boolean;
    settled?: boolean;
    sleepFrames?: number;
  },
  b: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    radius: number;
    mass?: number;
    restitution?: number;
    friction?: number;
    angularVelocity: number;
    sleeping?: boolean;
    settled?: boolean;
    sleepFrames?: number;
  }
) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distanceSquared = dx * dx + dy * dy;
  const minDistance = a.radius + b.radius;

  if (distanceSquared === 0) {
    const offset = minDistance * 0.15;
    a.x -= offset;
    b.x += offset;
    a.vx -= 4;
    b.vx += 4;
    return true;
  }

  if (distanceSquared >= minDistance * minDistance) return false;

  const distance = Math.sqrt(distanceSquared);
  const nx = dx / distance;
  const ny = dy / distance;
  const overlap = minDistance - distance;
  const massA = Math.max(0.1, a.mass || 1);
  const massB = Math.max(0.1, b.mass || 1);
  const sleepBoostA = a.sleeping || a.settled ? 1.8 : 1;
  const sleepBoostB = b.sleeping || b.settled ? 1.8 : 1;
  const invMassA = 1 / (massA * sleepBoostA);
  const invMassB = 1 / (massB * sleepBoostB);
  const invMassTotal = invMassA + invMassB;
  if (invMassTotal <= 0) return true;

  const correctionPercent = 0.52;
  const slop = 0.06;
  const correction =
    (Math.max(overlap - slop, 0) / invMassTotal) * correctionPercent;

  a.x -= nx * correction * invMassA;
  a.y -= ny * correction * invMassA;
  b.x += nx * correction * invMassB;
  b.y += ny * correction * invMassB;

  const rvx = b.vx - a.vx;
  const rvy = b.vy - a.vy;
  const velAlongNormal = rvx * nx + rvy * ny;
  if (velAlongNormal > 0) return true;

  const restitution = clamp(Math.min(a.restitution ?? 0.03, b.restitution ?? 0.03), 0.012, 0.08);
  const impulseMagnitude = -(1 + restitution) * velAlongNormal / invMassTotal;
  const impulseX = impulseMagnitude * nx;
  const impulseY = impulseMagnitude * ny;

  a.vx -= impulseX * invMassA;
  a.vy -= impulseY * invMassA;
  b.vx += impulseX * invMassB;
  b.vy += impulseY * invMassB;

  const tangentX = -ny;
  const tangentY = nx;
  const tangentVelocity = rvx * tangentX + rvy * tangentY;
  const friction = clamp(Math.min(a.friction ?? 0.97, b.friction ?? 0.97), 0.88, 0.995);
  let frictionImpulse = -tangentVelocity / invMassTotal;
  const maxFriction = impulseMagnitude * friction * 0.46;
  frictionImpulse = clamp(frictionImpulse, -maxFriction, maxFriction);
  const frictionX = frictionImpulse * tangentX;
  const frictionY = frictionImpulse * tangentY;

  a.vx -= frictionX * invMassA;
  a.vy -= frictionY * invMassA;
  b.vx += frictionX * invMassB;
  b.vy += frictionY * invMassB;

  const spin = tangentVelocity * 0.0012;
  a.angularVelocity -= spin;
  b.angularVelocity += spin;
  a.angularVelocity *= 0.94;
  b.angularVelocity *= 0.94;

  const impulseStrength = Math.abs(impulseMagnitude);
  if (impulseStrength > 0.8 || overlap > minDistance * 0.08) {
    a.sleeping = false;
    b.sleeping = false;
    a.settled = false;
    b.settled = false;
    a.sleepFrames = 0;
    b.sleepFrames = 0;
  }

  return true;
}
