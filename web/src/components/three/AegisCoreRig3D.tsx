import { useRef } from "react";
import {
  AmbientLight,
  BoxGeometry,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
  PointLight,
  SphereGeometry,
  TorusGeometry,
  type Object3D,
} from "three";
import { ThreeCanvas } from "./ThreeCanvas";
import { makeSignSprite } from "./labelHelper";
import type { GuardrailAction } from "../../types/aegis";

export interface AegisRigProps {
  explodeAmount: number;
  selectedBlade: number;
  onSelectBlade?: (idx: number) => void;
  primaryOpen: boolean;
  guardrailStatus: GuardrailAction;
  activeRoute: string;
  bucketFill: number;
  packetPulseKey: number;
  showLabels?: boolean;
}

const GUARDRAIL_HEX: Record<GuardrailAction, string> = {
  ALLOW: "#22d3ee",
  REDACT: "#f59e0b",
  BLOCK: "#f43f5e",
};

function makeRigFallbackSvg() {
  return (
    <svg viewBox="0 0 640 420" className="three-svg" aria-hidden="true">
      <rect width="640" height="420" rx="16" fill="#140a11" />
      <g stroke="#475569" strokeWidth="3">
        <line x1="170" y1="54" x2="170" y2="368" />
        <line x1="470" y1="54" x2="470" y2="368" />
      </g>
      <line x1="252" y1="54" x2="252" y2="368" stroke="#22d3ee" strokeWidth="2.5" strokeDasharray="6 4" />
      <line x1="388" y1="54" x2="388" y2="368" stroke="#10b981" strokeWidth="2.5" strokeDasharray="6 4" />
      <rect x="150" y="64" width="340" height="54" rx="10" fill="#1e293b" stroke="#22d3ee" strokeWidth="2" />
      <circle cx="320" cy="91" r="14" fill="none" stroke="#ff488b" strokeWidth="3" />
      <rect x="150" y="144" width="340" height="58" rx="10" fill="#1e3a8a" stroke="#38bdf8" strokeWidth="2" />
      <g fill="#22d3ee">
        <rect x="210" y="159" width="22" height="28" rx="4" />
        <rect x="248" y="159" width="22" height="28" rx="4" />
        <rect x="286" y="159" width="22" height="28" rx="4" />
        <rect x="324" y="159" width="22" height="28" rx="4" />
        <rect x="362" y="159" width="22" height="28" rx="4" />
        <rect x="400" y="159" width="22" height="28" rx="4" />
      </g>
      <rect x="150" y="228" width="340" height="54" rx="10" fill="#1e293b" stroke="#f59e0b" strokeWidth="2" />
      <rect x="210" y="242" width="44" height="26" rx="6" fill="#10b981" />
      <line x1="320" y1="255" x2="412" y2="245" stroke="#f59e0b" strokeWidth="5" strokeLinecap="round" />
      <rect x="150" y="308" width="340" height="54" rx="10" fill="#064e3b" stroke="#10b981" strokeWidth="2" />
      <polygon points="320,321 334,335 320,349 306,335" fill="#34d399" />
    </svg>
  );
}

export function AegisCoreRig3D(props: AegisRigProps) {
  const propsRef = useRef(props);
  propsRef.current = props;
  const showLabels = props.showLabels ?? true;

  return (
    <ThreeCanvas
      label="Interactive 4-floor 3D gateway tower showing safety check, smart memory, backup switch, and fast reply"
      className="three-host--hero"
      orbit={{ cameraPos: [5.1, 2.25, 5.75], fov: 42, autoRotate: true, autoRotateSpeed: 0.46 }}
      deps={[showLabels]}
      fallbackSvg={makeRigFallbackSvg()}
      setup={(scene) => {
        scene.add(new HemisphereLight(0xe0f2fe, 0x0f172a, 0.95));
        scene.add(new AmbientLight(0xffffff, 0.78));
        const dir = new DirectionalLight(0xf0f9ff, 2.2);
        dir.position.set(6, 8, 5);
        scene.add(dir);
        const rimCyan = new PointLight(0x22d3ee, 1.9);
        rimCyan.position.set(-4, 2, -3);
        scene.add(rimCyan);
        const rimPink = new PointLight(0xff488b, 1.45);
        rimPink.position.set(4, -2, 3);
        scene.add(rimPink);

        const root = new Group();
        scene.add(root);

        // Four corner guide pillars
        const pillarMat = new MeshStandardMaterial({ color: 0x64748b, metalness: 0.85, roughness: 0.24 });
        const pillars: Mesh[] = [];
        const basePillarGeo = new CylinderGeometry(0.045, 0.045, 1, 16);
        for (const [x, , z] of [
          [-1.35, 0, -1.05],
          [1.35, 0, -1.05],
          [-1.35, 0, 1.05],
          [1.35, 0, 1.05],
        ]) {
          const m = new Mesh(basePillarGeo, pillarMat);
          m.position.set(x, 0, z);
          root.add(m);
          pillars.push(m);
        }

        // Front request & response pipes
        const conduitGeo = new CylinderGeometry(0.03, 0.03, 1, 12);
        const leftConduit = new Mesh(
          conduitGeo,
          new MeshStandardMaterial({ color: 0x22d3ee, emissive: 0x0891b2, emissiveIntensity: 1.2 })
        );
        leftConduit.position.set(-0.75, 0, 0.94);
        root.add(leftConduit);

        const rightConduitMat = new MeshStandardMaterial({
          color: 0x10b981,
          emissive: 0x059669,
          emissiveIntensity: 1.2,
        });
        const rightConduit = new Mesh(conduitGeo, rightConduitMat);
        rightConduit.position.set(0.75, 0, 0.94);
        root.add(rightConduit);

        // Bright glowing "Question Packet" moving down the 4 floors
        const packetMat = new MeshStandardMaterial({
          color: 0x22d3ee,
          emissive: 0x22d3ee,
          emissiveIntensity: 2.8,
        });
        const packetMesh = new Mesh(new SphereGeometry(1, 20, 20), packetMat);
        packetMesh.position.set(0, 1.6, 0.96);
        root.add(packetMesh);

        // Click targets for selecting a floor
        const clickMeshes: Object3D[] = [];
        const tagBlade = (obj: Object3D, bladeIdx: number) => {
          obj.userData.bladeIdx = bladeIdx;
          clickMeshes.push(obj);
        };

        // Floor 0 (Top): 1. Safety Check
        const blade0 = new Group();
        blade0.position.set(0, 1.55, 0);
        root.add(blade0);
        const blade0BaseMat = new MeshStandardMaterial({ color: 0x1e293b, metalness: 0.72, roughness: 0.28 });
        const blade0Base = new Mesh(new BoxGeometry(2.9, 0.28, 2.3), blade0BaseMat);
        tagBlade(blade0Base, 0);
        blade0.add(blade0Base);

        const rimMat = new MeshStandardMaterial({
          color: 0x22d3ee,
          emissive: 0x22d3ee,
          emissiveIntensity: 0.9,
          transparent: true,
          opacity: 0.5,
        });
        const blade0Rim = new Mesh(new BoxGeometry(2.7, 0.03, 2.1), rimMat);
        blade0Rim.position.y = 0.15;
        blade0.add(blade0Rim);

        const ringAMat = new MeshStandardMaterial({
          color: 0xff488b,
          emissive: 0xff488b,
          emissiveIntensity: 1.5,
        });
        const ringA = new Mesh(new TorusGeometry(0.72, 0.035, 16, 48), ringAMat);
        ringA.position.y = 0.25;
        ringA.rotation.x = Math.PI / 2;
        blade0.add(ringA);

        const ringB = new Mesh(
          new TorusGeometry(0.48, 0.025, 16, 40),
          new MeshStandardMaterial({ color: 0xe2e8f0, metalness: 0.9, roughness: 0.16 })
        );
        ringB.position.y = 0.25;
        ringB.rotation.x = Math.PI / 2;
        blade0.add(ringB);

        const laserMat = new MeshStandardMaterial({
          color: 0x22d3ee,
          emissive: 0x22d3ee,
          emissiveIntensity: 2.3,
        });
        const laserBar = new Mesh(new BoxGeometry(2.2, 0.028, 0.035), laserMat);
        laserBar.position.y = 0.24;
        blade0.add(laserBar);

        if (showLabels) {
          const s0 = makeSignSprite("1. SAFETY CHECK", { accent: "#ff488b", scale: 0.85 });
          s0.position.set(1.88, 0.22, 0.72);
          blade0.add(s0);
        }

        // Floor 1: 2. Smart Memory Cache
        const blade1 = new Group();
        blade1.position.set(0, 0.55, 0);
        root.add(blade1);
        const blade1BaseMat = new MeshStandardMaterial({ color: 0x1e293b, metalness: 0.74, roughness: 0.25 });
        const blade1Base = new Mesh(new BoxGeometry(2.9, 0.24, 2.3), blade1BaseMat);
        tagBlade(blade1Base, 1);
        blade1.add(blade1Base);

        const shardColGeo = new BoxGeometry(0.24, 0.34, 0.24);
        const shardCapGeo = new BoxGeometry(0.26, 0.03, 0.26);
        const capMat = new MeshStandardMaterial({ color: 0xe2e8f0, metalness: 0.9, roughness: 0.15 });
        const shardMats: MeshStandardMaterial[] = [];
        for (let r = 0; r < 4; r++) {
          for (let c = 0; c < 4; c++) {
            const idx = r * 4 + c;
            const sMat = new MeshStandardMaterial({
              color: 0x0ea5e9,
              emissive: idx % 3 === 0 ? 0x22d3ee : 0x0284c7,
              emissiveIntensity: 0.85,
              metalness: 0.6,
              roughness: 0.2,
            });
            shardMats.push(sMat);
            const col = new Mesh(shardColGeo, sMat);
            col.position.set((c - 1.5) * 0.42, 0.3, (r - 1.5) * 0.42);
            tagBlade(col, 1);
            blade1.add(col);
            const cap = new Mesh(shardCapGeo, capMat);
            cap.position.set((c - 1.5) * 0.42, 0.49, (r - 1.5) * 0.42);
            blade1.add(cap);
          }
        }
        const enclosure = new Mesh(
          new BoxGeometry(2.15, 0.42, 1.9),
          new MeshStandardMaterial({
            color: 0xbae6fd,
            transparent: true,
            opacity: 0.12,
            roughness: 0.12,
            metalness: 0.1,
          })
        );
        enclosure.position.y = 0.34;
        blade1.add(enclosure);

        if (showLabels) {
          const s1 = makeSignSprite("2. SMART MEMORY", { accent: "#22d3ee", scale: 0.85 });
          s1.position.set(1.88, 0.22, 0.72);
          blade1.add(s1);
        }

        // Floor 2: 3. Speed Tank & Backup Switch
        const blade2 = new Group();
        blade2.position.set(0, -0.45, 0);
        root.add(blade2);
        const blade2BaseMat = new MeshStandardMaterial({ color: 0x1e293b, metalness: 0.72, roughness: 0.26 });
        const blade2Base = new Mesh(new BoxGeometry(2.9, 0.24, 2.3), blade2BaseMat);
        tagBlade(blade2Base, 2);
        blade2.add(blade2Base);

        const bucketGroup = new Group();
        bucketGroup.position.set(-0.78, 0.34, 0);
        blade2.add(bucketGroup);
        bucketGroup.add(
          new Mesh(
            new CylinderGeometry(0.32, 0.32, 0.52, 24),
            new MeshStandardMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.24, roughness: 0.12 })
          )
        );
        const bucketFluid = new Mesh(
          new CylinderGeometry(0.27, 0.27, 0.44, 24),
          new MeshStandardMaterial({ color: 0x10b981, emissive: 0x059669, emissiveIntensity: 1.35 })
        );
        bucketGroup.add(bucketFluid);
        const bucketCap = new Mesh(
          new CylinderGeometry(0.35, 0.35, 0.05, 24),
          new MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.9, roughness: 0.2 })
        );
        bucketCap.position.y = 0.28;
        bucketGroup.add(bucketCap);

        const relayGroup = new Group();
        relayGroup.position.set(0.45, 0.25, 0);
        blade2.add(relayGroup);
        const leftPost = new Mesh(
          new BoxGeometry(0.16, 0.2, 0.22),
          new MeshStandardMaterial({ color: 0xd97706, metalness: 0.9, roughness: 0.2 })
        );
        leftPost.position.set(-0.38, 0.04, 0);
        relayGroup.add(leftPost);

        const jawMat = new MeshStandardMaterial({
          color: 0x10b981,
          emissive: 0x10b981,
          emissiveIntensity: 1.4,
        });
        const rightJaw = new Mesh(new BoxGeometry(0.16, 0.2, 0.22), jawMat);
        rightJaw.position.set(0.44, 0.04, 0);
        relayGroup.add(rightJaw);

        const relayArmPivot = new Group();
        relayArmPivot.position.set(-0.36, 0.15, 0);
        relayGroup.add(relayArmPivot);
        const knifeBlade = new Mesh(
          new BoxGeometry(0.84, 0.06, 0.1),
          new MeshStandardMaterial({ color: 0xf59e0b, metalness: 0.95, roughness: 0.18 })
        );
        knifeBlade.position.set(0.4, 0.02, 0);
        relayArmPivot.add(knifeBlade);

        if (showLabels) {
          const s2 = makeSignSprite("3. BACKUP SWITCH", { accent: "#f59e0b", scale: 0.85 });
          s2.position.set(1.88, 0.22, 0.72);
          blade2.add(s2);
        }

        // Floor 3 (Bottom): 4. Fast Reply & Logs
        const blade3 = new Group();
        blade3.position.set(0, -1.45, 0);
        root.add(blade3);
        const blade3BaseMat = new MeshStandardMaterial({ color: 0x1e293b, metalness: 0.75, roughness: 0.22 });
        const blade3Base = new Mesh(new BoxGeometry(3.0, 0.28, 2.4), blade3BaseMat);
        tagBlade(blade3Base, 3);
        blade3.add(blade3Base);

        const gyroA = new Mesh(
          new TorusGeometry(0.62, 0.03, 16, 48),
          new MeshStandardMaterial({ color: 0x10b981, emissive: 0x10b981, emissiveIntensity: 1.35 })
        );
        gyroA.position.y = 0.28;
        gyroA.rotation.x = Math.PI / 3;
        blade3.add(gyroA);

        const gyroB = new Mesh(
          new OctahedronGeometry(0.24, 0),
          new MeshStandardMaterial({ color: 0x34d399, emissive: 0x10b981, emissiveIntensity: 1.75, metalness: 0.5 })
        );
        gyroB.position.y = 0.28;
        blade3.add(gyroB);

        if (showLabels) {
          const s3 = makeSignSprite("4. FAST REPLY", { accent: "#10b981", scale: 0.85 });
          s3.position.set(1.88, 0.22, 0.72);
          blade3.add(s3);
        }

        let lastPulseKey = -1;
        let pulseTimer = 0;

        return {
          update(t, dt) {
            const p = propsRef.current;
            if (p.packetPulseKey !== lastPulseKey) {
              lastPulseKey = p.packetPulseKey;
              pulseTimer = 1.0;
            }
            if (pulseTimer > 0) {
              pulseTimer = Math.max(0, pulseTimer - dt * 0.55);
            }

            root.position.y = Math.sin(t * 1.1) * 0.07;

            const spread = p.explodeAmount * 1.05;
            blade0.position.y = MathUtils.lerp(blade0.position.y, 1.55 + spread * 1.5, 0.12);
            blade1.position.y = MathUtils.lerp(blade1.position.y, 0.55 + spread * 0.5, 0.12);
            blade2.position.y = MathUtils.lerp(blade2.position.y, -0.45 - spread * 0.5, 0.12);
            blade3.position.y = MathUtils.lerp(blade3.position.y, -1.45 - spread * 1.5, 0.12);

            const pScale = 4.4 + p.explodeAmount * 2.8;
            for (const m of pillars) m.scale.y = pScale;
            leftConduit.scale.y = 4.2 + p.explodeAmount * 2.5;
            rightConduit.scale.y = 4.2 + p.explodeAmount * 2.5;

            blade0BaseMat.color.setHex(p.selectedBlade === 0 ? 0x283952 : 0x1e293b);
            blade1BaseMat.color.setHex(p.selectedBlade === 1 ? 0x1e3a8a : 0x1e293b);
            blade2BaseMat.color.setHex(p.selectedBlade === 2 ? 0x283952 : 0x1e293b);
            blade3BaseMat.color.setHex(p.selectedBlade === 3 ? 0x065f46 : 0x1e293b);

            const gCol = GUARDRAIL_HEX[p.guardrailStatus];
            rimMat.color.set(gCol);
            rimMat.emissive.set(gCol);
            laserMat.color.set(gCol);
            laserMat.emissive.set(gCol);

            for (const sMat of shardMats) {
              sMat.emissiveIntensity = p.activeRoute === "hnsw_semantic_cache" ? 1.85 : 0.78;
            }

            rightConduitMat.color.setHex(p.primaryOpen ? 0xf59e0b : 0x10b981);
            rightConduitMat.emissive.setHex(p.primaryOpen ? 0xd97706 : 0x059669);
            jawMat.color.setHex(p.primaryOpen ? 0xf43f5e : 0x10b981);
            jawMat.emissive.setHex(p.primaryOpen ? 0xf43f5e : 0x10b981);

            ringA.rotation.z = t * 0.7;
            ringB.rotation.z = -t * 1.1;
            laserBar.position.z = Math.sin(t * 2.8) * 0.78;

            relayArmPivot.rotation.z = MathUtils.lerp(
              relayArmPivot.rotation.z,
              p.primaryOpen ? 0.68 : 0.0,
              0.14
            );

            const targetScale = Math.max(0.08, Math.min(1, p.bucketFill));
            bucketFluid.scale.y = MathUtils.lerp(bucketFluid.scale.y, targetScale, 0.12);
            bucketFluid.position.y = -0.22 + (bucketFluid.scale.y * 0.44) / 2;

            gyroA.rotation.y = t * 0.85;
            gyroB.rotation.x = t * 0.65;
            gyroB.rotation.z = t * 0.4;

            const pktHex =
              p.activeRoute === "guardrail_blocked"
                ? 0xf43f5e
                : p.activeRoute === "fallback"
                ? 0xf59e0b
                : 0x22d3ee;
            packetMat.color.setHex(pktHex);
            packetMat.emissive.setHex(pktHex);

            const cycle = pulseTimer > 0 ? 1.0 - pulseTimer : (t * 0.36) % 1.0;
            let y = 2.1 - cycle * 3.8;
            let x = 0;
            if (p.activeRoute === "guardrail_blocked" && cycle > 0.25) {
              y = 1.65;
              x = Math.sin(t * 24) * 0.08;
            } else if (p.activeRoute === "hnsw_semantic_cache" && cycle > 0.48) {
              const bounce = (cycle - 0.48) / 0.52;
              y = 0.55 + bounce * 1.5;
              x = 0.75 * Math.sin(bounce * Math.PI);
            } else if (p.activeRoute === "fallback" && cycle > 0.58) {
              x = 0.72;
            }
            packetMesh.position.set(x, y, 0.96);
            packetMesh.scale.setScalar(0.14 + Math.sin(t * 8) * 0.02);
          },
          onClick(hits) {
            for (const h of hits) {
              const idx = h.object.userData.bladeIdx;
              if (typeof idx === "number") {
                propsRef.current.onSelectBlade?.(idx);
                break;
              }
            }
          },
        };
      }}
    />
  );
}
