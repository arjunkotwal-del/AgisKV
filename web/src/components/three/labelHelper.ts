import { CanvasTexture, LinearFilter, Sprite, SpriteMaterial, SRGBColorSpace } from "three";

export interface SignSpriteOptions {
  accent?: string;
  subtitle?: string;
  scale?: number;
}

/** Create a crisp in-scene 3D floating nameplate sprite that faces the camera. */
export function makeSignSprite(title: string, opts: SignSpriteOptions = {}): Sprite {
  const accent = opts.accent ?? "#38bdf8";
  const subtitle = opts.subtitle;
  const scale = opts.scale ?? 1.0;

  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = subtitle ? 128 : 96;
  const ctx = canvas.getContext("2d");

  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const pad = 8;
    const w = canvas.width - pad * 2;
    const h = canvas.height - pad * 2;
    const r = 24;

    ctx.beginPath();
    ctx.moveTo(pad + r, pad);
    ctx.lineTo(pad + w - r, pad);
    ctx.quadraticCurveTo(pad + w, pad, pad + w, pad + r);
    ctx.lineTo(pad + w, pad + h - r);
    ctx.quadraticCurveTo(pad + w, pad + h, pad + w - r, pad + h);
    ctx.lineTo(pad + r, pad + h);
    ctx.quadraticCurveTo(pad, pad + h, pad, pad + h - r);
    ctx.lineTo(pad, pad + r);
    ctx.quadraticCurveTo(pad, pad, pad + r, pad);
    ctx.closePath();

    ctx.fillStyle = "rgba(8, 11, 20, 0.98)";
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = accent;
    ctx.stroke();

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#f8fafc";
    ctx.font = "700 36px Manrope, system-ui, -apple-system, sans-serif";
    ctx.fillText(title, canvas.width / 2, subtitle ? 44 : canvas.height / 2);

    if (subtitle) {
      ctx.fillStyle = accent;
      ctx.font = "600 23px 'JetBrains Mono', ui-monospace, monospace";
      ctx.fillText(subtitle, canvas.width / 2, 86);
    }
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;

  const mat = new SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
  const sprite = new Sprite(mat);
  sprite.renderOrder = 20;
  const aspect = canvas.width / canvas.height;
  sprite.scale.set(1.35 * scale, (1.35 / aspect) * scale, 1);
  return sprite;
}
