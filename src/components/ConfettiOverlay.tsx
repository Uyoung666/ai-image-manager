import { useCallback, useEffect, useRef } from "react";

interface Particle {
  color: string;
  life: number;
  maxLife: number;
  rotation: number;
  rotationSpeed: number;
  shape: "rect" | "circle" | "triangle";
  size: number;
  vx: number;
  vy: number;
  x: number;
  y: number;
}

const COLORS = [
  "#FF6B6B",
  "#4ECDC4",
  "#FFE66D",
  "#A78BFA",
  "#F472B6",
  "#60A5FA",
  "#34D399",
  "#FB923C",
  "#FACC15",
  "#22D3EE",
  "#F87171",
  "#C084FC",
];

interface ConfettiOverlayProps {
  active: boolean;
  onDone?: () => void;
  onMidpoint?: () => void;
}

export function ConfettiOverlay({
  active,
  onDone,
  onMidpoint,
}: ConfettiOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const rafRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
  const midpointFiredRef = useRef(false);

  const spawnParticles = useCallback((count: number, spreadFactor = 1) => {
    const particles: Particle[] = [];
    for (let i = 0; i < count; i++) {
      const shapeRand = Math.random();
      particles.push({
        x: Math.random() * window.innerWidth,
        y: -30 - Math.random() * 120,
        vx: (Math.random() - 0.5) * 12 * spreadFactor,
        vy: Math.random() * 3 + 2,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        size: Math.random() * 10 + 4,
        rotation: Math.random() * 360,
        rotationSpeed: (Math.random() - 0.5) * 12,
        life: 0,
        maxLife: 100 + Math.random() * 160,
        shape:
          shapeRand < 0.15 ? "triangle" : shapeRand < 0.55 ? "rect" : "circle",
      });
    }
    return particles;
  }, []);

  useEffect(() => {
    if (!active) {
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    midpointFiredRef.current = false;

    particlesRef.current = spawnParticles(150, 1.2);

    const wave2 = setTimeout(() => {
      particlesRef.current = [
        ...particlesRef.current,
        ...spawnParticles(120, 0.9),
      ];
    }, 300);

    const wave3 = setTimeout(() => {
      particlesRef.current = [
        ...particlesRef.current,
        ...spawnParticles(100, 0.7),
      ];
    }, 650);

    const wave4 = setTimeout(() => {
      particlesRef.current = [
        ...particlesRef.current,
        ...spawnParticles(60, 0.5),
      ];
    }, 1000);

    startTimeRef.current = performance.now();

    const animate = (now: number) => {
      const elapsed = now - startTimeRef.current;
      const duration = 5000;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (!midpointFiredRef.current && elapsed > 1500) {
        midpointFiredRef.current = true;
        onMidpoint?.();
      }

      const particles = particlesRef.current;
      let allDead = true;
      const gravity = 0.14;

      for (const p of particles) {
        p.life++;
        if (p.life >= p.maxLife) {
          continue;
        }
        allDead = false;

        p.x += p.vx;
        p.vy += gravity;
        p.y += p.vy;
        p.vx *= 0.985;
        p.rotation += p.rotationSpeed;

        const lifeRatio = p.life / p.maxLife;
        const alpha = lifeRatio < 0.65 ? 1 : 1 - (lifeRatio - 0.65) / 0.35;

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.fillStyle = p.color;

        if (p.shape === "triangle") {
          ctx.beginPath();
          ctx.moveTo(0, -p.size / 2);
          ctx.lineTo(-p.size * 0.45, p.size / 2);
          ctx.lineTo(p.size * 0.45, p.size / 2);
          ctx.closePath();
          ctx.fill();
        } else if (p.shape === "rect") {
          const h = p.size * 0.55;
          ctx.fillRect(-p.size / 2, -h / 2, p.size, h);
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.restore();
      }

      if (elapsed > duration - 1000) {
        canvas.style.opacity = String(
          Math.max(0, 1 - (elapsed - (duration - 1000)) / 1000)
        );
      }

      if (allDead && elapsed > 2500) {
        canvas.style.opacity = "0";
        onDone?.();
        return;
      }

      if (elapsed < duration) {
        rafRef.current = requestAnimationFrame(animate);
      } else {
        canvas.style.opacity = "0";
        onDone?.();
      }
    };

    rafRef.current = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(rafRef.current);
      clearTimeout(wave2);
      clearTimeout(wave3);
      clearTimeout(wave4);
      if (canvas) {
        canvas.style.opacity = "1";
      }
    };
  }, [active, spawnParticles, onDone, onMidpoint]);

  if (!active) {
    return null;
  }

  return (
    <canvas
      className="pointer-events-none fixed inset-0 z-[9999]"
      ref={canvasRef}
      style={{ opacity: 1 }}
    />
  );
}
