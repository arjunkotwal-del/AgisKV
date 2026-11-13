import { useRef } from "react";
import {
  AmbientLight,
  BoxGeometry,
  CylinderGeometry,
  DirectionalLight,
  Group,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  PointLight,
  SphereGeometry,
  TorusGeometry,
} from "three";
import { ThreeCanvas } from "./ThreeCanvas";
import { makeSignSprite } from "./labelHelper";
import type { GuardrailAction } from "../../types/aegis";

interface GuardrailSieveProps {
  mode: GuardrailAction;
}

const MODE_HEX: Record<GuardrailAction, number> = {
  ALLOW: 0x10b981,
  REDACT: 0xf59e0b,
  BLOCK: 0xf43f5e,
};

function makeSieveFallbackSvg() {
  return (
    <svg viewBox="0 0 640 420" className="three-svg" aria-hidden="true">
      <rect width="640" height="420" rx="16" fill="#140a11" />
      <rect x="75" y="295" width="490" height="20" rx="6" fill="#1e293b" stroke="#475569" strokeWidth="1.5" />
      <rect x="135" y="145" width="76" height="145" rx="10" fill="none" stroke="#10b981" strokeWidth="5" />
      <circle cx="320" cy="215" r="52" fill="none" stroke="#38bdf8" strokeWidth="7" strokeDasharray="16 8" />
      <g fill="#22d3ee">
        <rect x="438" y="195" width="11" height="55" rx="3" />
        <rect x="456" y="165" width="11" height="85" rx="3" />
        <rect x="474" y="145" width="11" height="105" rx="3" />
        <rect x="492" y="175" width="11" height="75" rx="3" />
        <rect x="510" y="158" width="11" height="92" rx="3" />
      </g>
    </svg>
  );
}

export function GuardrailSieve3D(props: GuardrailSieveProps) {
  const propsRef = useRef(props);
  propsRef.current = props;

  return (
    <ThreeCanvas
      label="3D 3-gate prompt safety conveyor checking jailbreaks, payment cards, and secret keys"
      orbit={{ cameraPos: [0.05, 2.05, 6.25], fov: 42, autoRotate: true, autoRotateSpeed: 0.34 }}
      deps={[]}
      fallbackSvg={makeSieveFallbackSvg()}
      setup={(scene) => {
        scene.add(new AmbientLight(0xffffff, 0.78));
        const dir = new DirectionalLight(0xf8fafc, 1.65);
        dir.position.set(4, 6, 5);
        scene.add(dir);
        const pt = new PointLight(0x22d3ee, 1.35);
        pt.position.set(-3, 2.2, 2);
        scene.add(pt);

        const group = new Group();
        scene.add(group);

        // Conveyor deck
        const deck = new Mesh(
          new BoxGeometry(5.2, 0.2, 1.95),
          new MeshStandardMaterial({ color: 0x0f172a, metalness: 0.85, roughness: 0.25 })
        );
        deck.position.y = -0.92;
        group.add(deck);

        // Illuminated conveyor center rail
        const belt = new Mesh(
          new BoxGeometry(4.75, 0.04, 0.44),
          new MeshStandardMaterial({
            color: 0x1e293b,
            emissive: 0x0284c7,
            emissiveIntensity: 0.55,
          })
        );
        belt.position.y = -0.8;
        group.add(belt);

        // Input / Output signposts
        const inSign = makeSignSprite("PROMPT IN", { accent: "#38bdf8", scale: 0.78 });
        inSign.position.set(-2.08, 0.42, 0.55);
        group.add(inSign);

        const outSign = makeSignSprite("SAFE TO AI", { accent: "#10b981", scale: 0.78 });
        outSign.position.set(2.08, 0.42, 0.55);
        group.add(outSign);

        // Gate 1: Hack / Prompt-Injection Blocker
        const gate1Group = new Group();
        gate1Group.position.set(-1.3, -0.05, 0);
        group.add(gate1Group);

        const postGeo = new CylinderGeometry(0.055, 0.065, 1.55, 14);
        const postMat = new MeshStandardMaterial({ color: 0x475569, metalness: 0.8, roughness: 0.25 });
        for (const zOff of [-0.55, 0.55]) {
          const post = new Mesh(postGeo, postMat);
          post.position.set(0, 0, zOff);
          gate1Group.add(post);
        }
        const archMat = new MeshStandardMaterial({ color: 0x334155, metalness: 0.8, roughness: 0.22 });
        const archTop = new Mesh(new BoxGeometry(0.18, 0.14, 1.24), archMat);
        archTop.position.y = 0.78;
        gate1Group.add(archTop);

        const barrierMat = new MeshStandardMaterial({
          color: 0x10b981,
          emissive: 0x10b981,
          emissiveIntensity: 0.9,
          transparent: true,
          opacity: 0.2,
        });
        const barrier = new Mesh(new BoxGeometry(0.08, 1.32, 0.96), barrierMat);
        gate1Group.add(barrier);

        const g1Sign = makeSignSprite("1. BLOCK HACKS", { accent: "#fb7185", scale: 0.92 });
        g1Sign.position.set(0, 1.18, 0);
        gate1Group.add(g1Sign);

        // Gate 2: Credit Card Masker (Luhn mod-10 scanner hoop)
        const gate2RingMat = new MeshStandardMaterial({
          color: 0x38bdf8,
          emissive: 0x0284c7,
          emissiveIntensity: 1.0,
          metalness: 0.7,
          roughness: 0.2,
        });
        const gate2Ring = new Mesh(new TorusGeometry(0.56, 0.065, 14, 28), gate2RingMat);
        gate2Ring.rotation.y = Math.PI / 2;
        gate2Ring.position.set(0.0, -0.05, 0);
        group.add(gate2Ring);

        const g2Sign = makeSignSprite("2. HIDE CARDS", { accent: "#f59e0b", scale: 0.92 });
        g2Sign.position.set(0.0, 1.13, 0);
        group.add(g2Sign);

        // Gate 3: Secret Key Scanner (Entropy equalizer bars)
        const bars: Mesh[] = [];
        const barMat = new MeshStandardMaterial({
          color: 0x22d3ee,
          emissive: 0x0891b2,
          emissiveIntensity: 1.15,
        });
        for (let i = 0; i < 8; i++) {
          const bar = new Mesh(new BoxGeometry(0.08, 0.45, 0.08), barMat);
          const z = -0.38 + (i / 7) * 0.76;
          bar.position.set(1.28, -0.35, z);
          bars.push(bar);
          group.add(bar);
        }

        const g3Sign = makeSignSprite("3. HIDE KEYS", { accent: "#22d3ee", scale: 0.92 });
        g3Sign.position.set(1.28, 1.13, 0);
        group.add(g3Sign);

        // Animated Prompt Packet spheres riding left -> right through all 3 gates
        const packets = [0, 0.33, 0.66].map((offset) => {
          const mat = new MeshStandardMaterial({
            color: 0x10b981,
            emissive: 0x10b981,
            emissiveIntensity: 1.8,
          });
          const mesh = new Mesh(new SphereGeometry(0.16, 18, 18), mat);
          group.add(mesh);
          return { mesh, mat, offset };
        });

        let barrierClosed = 0;

        return {
          update(t, dt) {
            const { mode } = propsRef.current;
            const targetClosed = mode === "BLOCK" ? 1 : 0;
            barrierClosed = MathUtils.lerp(barrierClosed, targetClosed, Math.min(1, dt * 6));

            barrierMat.color.setHex(MODE_HEX[mode]);
            barrierMat.emissive.setHex(MODE_HEX[mode]);
            barrierMat.opacity = 0.14 + barrierClosed * 0.65;
            barrier.scale.y = mode === "BLOCK" ? 0.55 + barrierClosed * 0.45 : 0.35;

            gate2Ring.rotation.x = t * 1.4;
            gate2RingMat.emissiveIntensity = mode === "REDACT" ? 1.8 + Math.sin(t * 5) * 0.4 : 0.95;

            for (let i = 0; i < bars.length; i++) {
              const s = 0.4 + 0.85 * Math.abs(Math.sin(t * 3.2 + i * 0.55));
              bars[i].scale.y = s;
              bars[i].position.y = -0.78 + s * 0.24;
            }

            for (const pkt of packets) {
              const u = (t * 0.34 + pkt.offset) % 1;
              if (mode === "BLOCK") {
                // Bounce backward at Gate 1 (-1.3) to visually demonstrate blocking
                const x = u < 0.5 ? MathUtils.lerp(-2.3, -1.45, u * 2) : MathUtils.lerp(-1.45, -2.3, (u - 0.5) * 2);
                pkt.mesh.position.set(x, -0.46 + Math.sin(u * Math.PI * 2) * 0.08, 0);
                pkt.mat.color.setHex(0xf43f5e);
                pkt.mat.emissive.setHex(0xf43f5e);
              } else if (mode === "REDACT") {
                const x = MathUtils.lerp(-2.3, 2.3, u);
                pkt.mesh.position.set(x, -0.46, 0);
                const passedCardGate = x > 0.0;
                const hex = passedCardGate ? 0x38bdf8 : 0xf59e0b;
                pkt.mat.color.setHex(hex);
                pkt.mat.emissive.setHex(hex);
              } else {
                const x = MathUtils.lerp(-2.3, 2.3, u);
                pkt.mesh.position.set(x, -0.46, 0);
                pkt.mat.color.setHex(0x10b981);
                pkt.mat.emissive.setHex(0x10b981);
              }
            }
          },
        };
      }}
    />
  );
}
