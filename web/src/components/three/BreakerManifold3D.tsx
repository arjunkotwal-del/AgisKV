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
} from "three";
import { ThreeCanvas } from "./ThreeCanvas";
import { makeSignSprite } from "./labelHelper";
import type { CircuitState } from "../../types/aegis";

interface BreakerManifoldProps {
  circuitState: CircuitState;
  tokensRatio: number;
}

function makeBreakerFallbackSvg() {
  return (
    <svg viewBox="0 0 640 420" className="three-svg" aria-hidden="true">
      <rect width="640" height="420" rx="16" fill="#140a11" />
      <rect x="75" y="295" width="490" height="24" rx="6" fill="#1e293b" stroke="#475569" strokeWidth="1.5" />
      <rect x="110" y="135" width="84" height="160" rx="12" fill="#0f172a" stroke="#38bdf8" strokeWidth="2" />
      <rect x="120" y="185" width="64" height="100" rx="8" fill="#22d3ee" fillOpacity="0.85" />
      <line x1="255" y1="260" x2="455" y2="210" stroke="#10b981" strokeWidth="9" strokeLinecap="round" />
      <line x1="255" y1="260" x2="455" y2="305" stroke="#f59e0b" strokeWidth="7" strokeDasharray="8 6" />
      <rect x="455" y="192" width="48" height="36" rx="6" fill="#10b981" />
      <rect x="455" y="286" width="48" height="36" rx="6" fill="#f59e0b" />
    </svg>
  );
}

export function BreakerManifold3D(props: BreakerManifoldProps) {
  const propsRef = useRef(props);
  propsRef.current = props;

  return (
    <ThreeCanvas
      label="3D speed-limit tank and automatic AI failover track switch"
      orbit={{ cameraPos: [3.35, 2.5, 5.15], fov: 42, autoRotate: true, autoRotateSpeed: 0.36 }}
      deps={[]}
      fallbackSvg={makeBreakerFallbackSvg()}
      setup={(scene) => {
        scene.add(new AmbientLight(0xffffff, 0.78));
        const dir = new DirectionalLight(0xf8fafc, 1.7);
        dir.position.set(5, 6, 4);
        scene.add(dir);
        const p1 = new PointLight(0x22d3ee, 1.35);
        p1.position.set(-3, 2, 2);
        scene.add(p1);
        const p2 = new PointLight(0xf59e0b, 1.25);
        p2.position.set(3, 1.5, -2);
        scene.add(p2);

        const group = new Group();
        scene.add(group);

        // Base platform
        const base = new Mesh(
          new BoxGeometry(5.0, 0.24, 2.8),
          new MeshStandardMaterial({ color: 0x0f172a, metalness: 0.85, roughness: 0.28 })
        );
        base.position.y = -0.95;
        group.add(base);

        // Speed Limit Token Tank (Left)
        const tankGroup = new Group();
        tankGroup.position.set(-1.62, -0.08, 0);
        group.add(tankGroup);

        const glassShell = new Mesh(
          new CylinderGeometry(0.54, 0.54, 1.48, 28),
          new MeshStandardMaterial({
            color: 0x94a3b8,
            transparent: true,
            opacity: 0.22,
            roughness: 0.08,
            metalness: 0.1,
          })
        );
        tankGroup.add(glassShell);

        const liquidMat = new MeshStandardMaterial({
          color: 0x22d3ee,
          emissive: 0x0891b2,
          emissiveIntensity: 1.05,
        });
        const liquid = new Mesh(new CylinderGeometry(0.45, 0.45, 1.32, 24), liquidMat);
        tankGroup.add(liquid);

        const tankSign = makeSignSprite("SPEED LIMIT", { accent: "#22d3ee", scale: 0.88 });
        tankSign.position.set(0, 1.15, 0);
        tankGroup.add(tankSign);

        // Entry rail from tank -> switch pivot (-0.35, -0.78, 0)
        const railMat = new MeshStandardMaterial({ color: 0x334155, metalness: 0.85, roughness: 0.25 });
        const feedRail = new Mesh(new BoxGeometry(1.1, 0.08, 0.26), railMat);
        feedRail.position.set(-0.92, -0.78, 0);
        group.add(feedRail);

        // Y-Fork Tracks leading to Main AI (z = -0.92) vs Backup AI (z = +0.92)
        const mainTrackMat = new MeshStandardMaterial({
          color: 0x10b981,
          emissive: 0x059669,
          emissiveIntensity: 0.8,
        });
        const mainTrack = new Mesh(new BoxGeometry(1.9, 0.06, 0.2), mainTrackMat);
        mainTrack.position.set(0.68, -0.78, -0.48);
        mainTrack.rotation.y = 0.46;
        group.add(mainTrack);

        const backupTrackMat = new MeshStandardMaterial({
          color: 0xf59e0b,
          emissive: 0xd97706,
          emissiveIntensity: 0.45,
        });
        const backupTrack = new Mesh(new BoxGeometry(1.9, 0.06, 0.2), backupTrackMat);
        backupTrack.position.set(0.68, -0.78, 0.48);
        backupTrack.rotation.y = -0.46;
        group.add(backupTrack);

        // Rotating Track Switch Gate in center
        const switchPost = new Mesh(
          new CylinderGeometry(0.14, 0.18, 0.45, 16),
          new MeshStandardMaterial({ color: 0x64748b, metalness: 0.85, roughness: 0.22 })
        );
        switchPost.position.set(-0.28, -0.62, 0);
        group.add(switchPost);

        const switchPivot = new Group();
        switchPivot.position.set(-0.28, -0.58, 0);
        group.add(switchPivot);

        const armMat = new MeshStandardMaterial({
          color: 0x38bdf8,
          emissive: 0x0284c7,
          emissiveIntensity: 1.0,
        });
        const switchArm = new Mesh(new BoxGeometry(1.0, 0.1, 0.14), armMat);
        switchArm.position.set(0.45, 0.06, 0);
        switchPivot.add(switchArm);

        const switchSign = makeSignSprite("AUTO SWITCH", { accent: "#f8fafc", scale: 0.82 });
        switchSign.position.set(-0.3, 0.72, -0.1);
        group.add(switchSign);

        // Main AI Endpoint Pad (Top/Back fork)
        const mainPadMat = new MeshStandardMaterial({
          color: 0x10b981,
          emissive: 0x10b981,
          emissiveIntensity: 1.25,
        });
        const mainPad = new Mesh(new BoxGeometry(0.64, 0.34, 0.64), mainPadMat);
        mainPad.position.set(1.62, -0.64, -0.92);
        group.add(mainPad);

        const mainSign = makeSignSprite("MAIN AI (GPT-4o)", { accent: "#10b981", scale: 0.84 });
        mainSign.position.set(1.72, 0.44, -0.96);
        group.add(mainSign);

        // Backup AI Endpoint Pad (Front/Bottom fork)
        const backupPadMat = new MeshStandardMaterial({
          color: 0xf59e0b,
          emissive: 0xf59e0b,
          emissiveIntensity: 0.4,
        });
        const backupPad = new Mesh(new BoxGeometry(0.64, 0.34, 0.64), backupPadMat);
        backupPad.position.set(1.62, -0.64, 0.92);
        group.add(backupPad);

        const backupSign = makeSignSprite("BACKUP AI (Mini)", { accent: "#f59e0b", scale: 0.84 });
        backupSign.position.set(1.72, -0.05, 1.3);
        group.add(backupSign);

        // Animated request spheres flowing cleanly down active fork
        const packets = [0, 0.5].map((offset) => {
          const mat = new MeshStandardMaterial({
            color: 0x38bdf8,
            emissive: 0x38bdf8,
            emissiveIntensity: 2.0,
          });
          const mesh = new Mesh(new SphereGeometry(0.14, 16, 16), mat);
          group.add(mesh);
          return { mesh, mat, offset };
        });

        let armAngle = 0.42;

        return {
          update(t, dt) {
            const { circuitState, tokensRatio } = propsRef.current;
            const useBackup = circuitState === "OPEN";
            const halfOpen = circuitState === "HALF_OPEN";
            const targetAngle = useBackup ? -0.42 : halfOpen ? 0 : 0.42;
            armAngle = MathUtils.lerp(armAngle, targetAngle, Math.min(1, dt * 6));
            switchPivot.rotation.y = armAngle;

            // Animate gentle speed tank level pulse + real ratio
            const level = MathUtils.clamp(tokensRatio + Math.sin(t * 2.1) * 0.04, 0.1, 1.0);
            liquid.scale.y = level;
            liquid.position.y = -0.66 + level * 0.66;

            if (useBackup) {
              mainPadMat.color.setHex(0xf43f5e);
              mainPadMat.emissive.setHex(0xf43f5e);
              mainPadMat.emissiveIntensity = 0.7;
              mainTrackMat.emissiveIntensity = 0.15;
              backupPadMat.emissiveIntensity = 1.65;
              backupTrackMat.emissiveIntensity = 1.25;
              armMat.color.setHex(0xf59e0b);
              armMat.emissive.setHex(0xf59e0b);
            } else {
              mainPadMat.color.setHex(0x10b981);
              mainPadMat.emissive.setHex(0x10b981);
              mainPadMat.emissiveIntensity = 1.35;
              mainTrackMat.emissiveIntensity = 1.0;
              backupPadMat.emissiveIntensity = 0.3;
              backupTrackMat.emissiveIntensity = 0.25;
              armMat.color.setHex(0x10b981);
              armMat.emissive.setHex(0x059669);
            }

            const endZ = useBackup ? 0.82 : -0.82;
            const pktHex = useBackup ? 0xf59e0b : 0x38bdf8;
            for (const pkt of packets) {
              const u = (t * 0.45 + pkt.offset) % 1;
              if (u < 0.4) {
                const sub = u / 0.4;
                pkt.mesh.position.set(MathUtils.lerp(-1.45, -0.28, sub), -0.58, 0);
              } else {
                const sub = (u - 0.4) / 0.6;
                pkt.mesh.position.set(MathUtils.lerp(-0.28, 1.62, sub), -0.58, MathUtils.lerp(0, endZ, sub));
              }
              pkt.mat.color.setHex(pktHex);
              pkt.mat.emissive.setHex(pktHex);
            }
          },
        };
      }}
    />
  );
}
