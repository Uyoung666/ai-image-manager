// Adapted from Skiper UI's free Canvas crowd and Zadvorsky's Open Peeps crowd.
// The sprite sheet has 15 columns and 7 rows of distinct characters.
import { gsap } from "gsap";

interface Peep {
  anchor: number;
  direction: number;
  frame: number;
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface CrowdScene {
  destroy: () => void;
  resize: () => void;
  setPlaying: (playing: boolean) => void;
}

export function createCrowdScene(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement
): CrowdScene | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  const frameWidth = image.naturalWidth / 15;
  const frameHeight = image.naturalHeight / 7;
  let peeps: Peep[] = [];
  let timelines: gsap.core.Timeline[] = [];
  let playing = false;
  let destroyed = false;
  let width = 0;
  let height = 0;
  let ratio = 1;

  const draw = () => {
    if (destroyed) {
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(ratio, ratio);
    for (const peep of peeps) {
      ctx.save();
      ctx.translate(peep.x, peep.y);
      ctx.scale(peep.direction, 1);
      ctx.drawImage(
        image,
        (peep.frame % 15) * frameWidth,
        Math.floor(peep.frame / 15) * frameHeight,
        frameWidth,
        frameHeight,
        -peep.width / 2,
        0,
        peep.width,
        peep.height
      );
      ctx.restore();
    }
    ctx.restore();
  };

  const resize = () => {
    if (destroyed) {
      return;
    }
    const nextWidth = canvas.clientWidth;
    const nextHeight = canvas.clientHeight;
    const nextRatio = Math.min(window.devicePixelRatio || 1, 2);
    const unchanged =
      nextWidth === width && nextHeight === height && ratio === nextRatio;
    if (!(nextWidth && nextHeight) || unchanged) {
      return;
    }
    width = nextWidth;
    height = nextHeight;
    ratio = nextRatio;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    for (const timeline of timelines) {
      timeline.kill();
    }
    timelines = [];
    const count = Math.min(32, Math.max(12, Math.round(width / 25)));
    peeps = Array.from({ length: count }, (_, index) => {
      const size = height * (0.43 + Math.random() * 0.2);
      const anchor = height - size + Math.random() * size * 0.3;
      return {
        frame: Math.floor(Math.random() * 105),
        width: (size * frameWidth) / frameHeight,
        height: size,
        x: 0,
        y: anchor,
        anchor,
        direction: index % 2 ? 1 : -1,
      };
    }).sort((a, b) => a.anchor - b.anchor);
    for (const peep of peeps) {
      const duration = 14 + Math.random() * 12;
      const start = peep.direction === 1 ? -peep.width : width + peep.width;
      const end = peep.direction === 1 ? width + peep.width : -peep.width;
      const walk = gsap.timeline({ paused: true, repeat: -1 });
      walk.fromTo(peep, { x: start }, { x: end, duration, ease: "none" }, 0);
      walk.progress(Math.random());
      const bob = gsap.timeline({ paused: true, repeat: -1, yoyo: true });
      bob.to(peep, {
        y: peep.anchor - 3,
        duration: 0.25 + Math.random() * 0.1,
        ease: "sine.inOut",
      });
      bob.progress(Math.random());
      walk.paused(!playing);
      bob.paused(!playing);
      timelines.push(walk, bob);
    }
    draw();
  };

  resize();
  canvas.dataset.crowdPlaying = "false";
  return {
    resize,
    setPlaying(value) {
      if (destroyed || value === playing) {
        return;
      }
      playing = value;
      canvas.dataset.crowdPlaying = String(value);
      for (const timeline of timelines) {
        if (playing) {
          timeline.resume();
        } else {
          timeline.pause();
        }
      }
      if (playing) {
        gsap.ticker.add(draw);
      } else {
        gsap.ticker.remove(draw);
        draw();
      }
    },
    destroy() {
      destroyed = true;
      gsap.ticker.remove(draw);
      for (const timeline of timelines) {
        timeline.kill();
      }
      canvas.dataset.crowdPlaying = "false";
      timelines = [];
      peeps = [];
    },
  };
}
