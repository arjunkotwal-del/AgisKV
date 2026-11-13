import { useRef } from "react";
import {
  AmbientLight,
  BufferGeometry,
  DoubleSide,
  GridHelper,
  Group,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  PointLight,
  RingGeometry,
  SphereGeometry,
  Vector3,
} from "three";
import { ThreeCanvas } from "./ThreeCanvas";
import { makeSignSprite } from "./labelHelper";
import type { GraphNode, GraphSnapshot, HopStep } from "../../types/aegis";

interface HnswCrystalProps {
  graph: GraphSnapshot;
  hopTrace: HopStep[];
  selectedNodeIdx: number | null;
  onSelectNode: (node: GraphNode) => void;
  animateSearch: boolean;
}

const LAYER_HEIGHTS = [-1.2, 0.0, 1.2];
const LAYER_TITLES = [
  { text: "3. SAVED ANSWERS", accent: "#ff488b" },
  { text: "2. TOPIC GROUPS", accent: "#22d3ee" },
  { text: "1. FAST OVERVIEW", accent: "#f59e0b" },
];

function levelHex(lvl: number): number {
  if (lvl >= 2) return 0xf59e0b;
  if (lvl === 1) return 0x22d3ee;
  return 0xff488b;
}

function makeCrystalFallbackSvg() {
  return (
    <svg viewBox="0 0 640 420" className="three-svg" aria-hidden="true">
      <rect width="640" height="420" rx="16" fill="#140a11" />
      <polygon points="140,105 500,105 540,145 100,145" fill="none" stroke="#f59e0b" strokeWidth="1.5" />
      <polygon points="140,210 500,210 540,250 100,250" fill="none" stroke="#22d3ee" strokeWidth="1.5" />
      <polygon points="140,315 500,315 540,355 100,355" fill="none" stroke="#ff488b" strokeWidth="1.5" />
      <polyline points="240,125 320,230 395,335" fill="none" stroke="#facc15" strokeWidth="3" />
      <circle cx="240" cy="125" r="9" fill="#f59e0b" />
      <circle cx="320" cy="230" r="8" fill="#22d3ee" />
      <circle cx="395" cy="335" r="9" fill="#ff488b" />
      <circle cx="215" cy="335" r="6" fill="#38bdf8" />
      <circle cx="445" cy="230" r="6" fill="#22d3ee" />
    </svg>
  );
}

export function HnswCrystal3D(props: HnswCrystalProps) {
  const propsRef = useRef(props);
  propsRef.current = props;

  return (
    <ThreeCanvas
      label="3D 3-floor shortcut memory map hopping from fast overview to matching saved answers"
      orbit={{ cameraPos: [4.6, 2.9, 5.1], fov: 42, autoRotate: true, autoRotateSpeed: 0.38 }}
      deps={[props.graph]}
      fallbackSvg={makeCrystalFallbackSvg()}
      setup={(scene) => {
        scene.add(new AmbientLight(0xffffff, 0.78));
        const pCyan = new PointLight(0x22d3ee, 1.6);
        pCyan.position.set(5, 6, 4);
        scene.add(pCyan);
        const pPink = new PointLight(0xff488b, 1.25);
        pPink.position.set(-5, -3, -4);
        scene.add(pPink);

        const group = new Group();
        scene.add(group);

        // Layer planes, grids, and plain-English floor signposts
        for (let lvl = 0; lvl < LAYER_HEIGHTS.length; lvl++) {
          const y = LAYER_HEIGHTS[lvl];
          const g = new Group();
          g.position.y = y;
          const plane = new Mesh(
            new PlaneGeometry(5.4, 5.4),
            new MeshStandardMaterial({
              color: levelHex(lvl),
              transparent: true,
              opacity: 0.06,
              side: DoubleSide,
            })
          );
          plane.rotation.x = -Math.PI / 2;
          g.add(plane);
          const grid = new GridHelper(5.4, 8, levelHex(lvl), 0x1e293b);
          g.add(grid);

          const tierInfo = LAYER_TITLES[lvl];
          const sign = makeSignSprite(tierInfo.text, { accent: tierInfo.accent, scale: 1.05 });
          sign.position.set(-1.82, 0.28, 2.1);
          g.add(sign);

          group.add(g);
        }

        const nodePosByIdx = new Map<number, [number, number, number]>();
        for (const n of props.graph.nodes) {
          const lvl = Math.min(2, Math.max(0, n.level));
          nodePosByIdx.set(n.node_idx, [n.pos[0], LAYER_HEIGHTS[lvl], n.pos[2]]);
        }

        // Layer edges
        for (const edge of props.graph.edges) {
          const p1 = nodePosByIdx.get(edge.from);
          const p2 = nodePosByIdx.get(edge.to);
          if (!p1 || !p2) continue;
          const y = LAYER_HEIGHTS[Math.min(2, Math.max(0, edge.level))];
          const geom = new BufferGeometry().setFromPoints([
            new Vector3(p1[0], y, p1[2]),
            new Vector3(p2[0], y, p2[2]),
          ]);
          group.add(
            new Line(
              geom,
              new LineBasicMaterial({
                color: levelHex(edge.level),
                transparent: true,
                opacity: edge.level >= 1 ? 0.55 : 0.25,
              })
            )
          );
        }

        // Vertical hub drop lines
        for (const n of props.graph.nodes) {
          const p = nodePosByIdx.get(n.node_idx);
          if (!p || n.level === 0) continue;
          const geom = new BufferGeometry().setFromPoints([
            new Vector3(p[0], p[1], p[2]),
            new Vector3(p[0], LAYER_HEIGHTS[0], p[2]),
          ]);
          const line = new Line(
            geom,
            new LineDashedMaterial({
              color: 0x38bdf8,
              dashSize: 0.12,
              gapSize: 0.08,
              transparent: true,
              opacity: 0.35,
            })
          );
          line.computeLineDistances();
          group.add(line);
        }

        // Nodes
        const nodeMeshes = new Map<number, { mesh: Mesh; mat: MeshStandardMaterial; node: GraphNode }>();
        for (const n of props.graph.nodes) {
          const p = nodePosByIdx.get(n.node_idx);
          if (!p) continue;
          const lvl = Math.min(2, Math.max(0, n.level));
          const mat = new MeshStandardMaterial({
            color: levelHex(lvl),
            emissive: levelHex(lvl),
            emissiveIntensity: 1.2,
          });
          const mesh = new Mesh(new SphereGeometry(0.12 + lvl * 0.025, 20, 20), mat);
          mesh.position.set(p[0], p[1], p[2]);
          mesh.userData.node = n;
          group.add(mesh);
          nodeMeshes.set(n.node_idx, { mesh, mat, node: n });

          if (lvl > 0) {
            const proj = new Mesh(
              new SphereGeometry(0.07, 12, 12),
              new MeshStandardMaterial({ color: 0x38bdf8, emissive: 0x0284c7, emissiveIntensity: 0.6 })
            );
            proj.position.set(p[0], LAYER_HEIGHTS[0], p[2]);
            group.add(proj);
          }
        }

        // Active hop descent trace line + search beam + destination match halo
        const beamMesh = new Mesh(
          new SphereGeometry(0.14, 16, 16),
          new MeshStandardMaterial({ color: 0xfef08a, emissive: 0xfacc15, emissiveIntensity: 2.8 })
        );
        group.add(beamMesh);

        const matchRing = new Mesh(
          new RingGeometry(0.18, 0.28, 28),
          new MeshStandardMaterial({
            color: 0x22d3ee,
            emissive: 0x22d3ee,
            emissiveIntensity: 2.2,
            side: DoubleSide,
            transparent: true,
            opacity: 0.85,
          })
        );
        matchRing.rotation.x = -Math.PI / 2;
        group.add(matchRing);

        const matchSign = makeSignSprite("MATCH FOUND!", { accent: "#facc15", scale: 0.94 });
        group.add(matchSign);

        const defaultHopPath = [...props.graph.nodes]
          .sort((a, b) => b.level - a.level)
          .slice(0, 4)
          .map((n) => nodePosByIdx.get(n.node_idx) ?? ([0, 0, 0] as [number, number, number]));

        let traceLine: Line | null = null;
        let lastTraceKey = "";

        return {
          update(t) {
            const p = propsRef.current;

            for (const [idx, entry] of nodeMeshes) {
              const isSel = p.selectedNodeIdx === idx;
              const lvl = Math.min(2, Math.max(0, entry.node.level));
              entry.mat.color.setHex(isSel ? 0xffffff : levelHex(lvl));
              entry.mat.emissiveIntensity = isSel ? 2.6 : 1.2;
              entry.mesh.scale.setScalar(isSel ? 1.32 : 1.0);
            }

            const activePath =
              p.hopTrace.length >= 2
                ? p.hopTrace
                    .map((h) => {
                      const pos = nodePosByIdx.get(h.node_idx);
                      if (!pos) return null;
                      return [
                        pos[0],
                        LAYER_HEIGHTS[Math.min(2, Math.max(0, h.level))],
                        pos[2],
                      ] as [number, number, number];
                    })
                    .filter((pt): pt is [number, number, number] => pt !== null)
                : defaultHopPath;

            const traceKey = activePath.map((pt) => pt.join(",")).join("|");
            if (traceKey !== lastTraceKey) {
              lastTraceKey = traceKey;
              if (traceLine) {
                group.remove(traceLine);
                traceLine.geometry.dispose();
                (traceLine.material as LineBasicMaterial).dispose();
                traceLine = null;
              }
              if (activePath.length >= 2) {
                const geom = new BufferGeometry().setFromPoints(
                  activePath.map((pt) => new Vector3(pt[0], pt[1], pt[2]))
                );
                traceLine = new Line(
                  geom,
                  new LineBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.9 })
                );
                group.add(traceLine);
              }
            }

            if (activePath.length >= 2) {
              beamMesh.visible = true;
              const endPt = activePath[activePath.length - 1];
              matchRing.visible = true;
              matchSign.visible = true;
              matchRing.position.set(endPt[0], endPt[1] - 0.08, endPt[2]);
              matchRing.scale.setScalar(0.95 + Math.sin(t * 4) * 0.22);
              matchSign.position.set(endPt[0], endPt[1] + 0.48, endPt[2]);

              const speed = p.animateSearch ? 0.78 : 0.42;
              const rawCycle = (t * speed) % 1.0;
              const cycle = rawCycle < 0 ? rawCycle + 1.0 : rawCycle;
              const segTotal = activePath.length - 1;
              const scaled = cycle * segTotal;
              const idx = MathUtils.clamp(Math.floor(scaled), 0, segTotal - 1);
              const localT = MathUtils.clamp(scaled - idx, 0, 1);
              const a = activePath[idx];
              const b = activePath[idx + 1];
              if (a && b) {
                beamMesh.position.set(
                  MathUtils.lerp(a[0], b[0], localT),
                  MathUtils.lerp(a[1], b[1], localT),
                  MathUtils.lerp(a[2], b[2], localT)
                );
              }
            } else {
              beamMesh.visible = false;
              matchRing.visible = false;
              matchSign.visible = false;
            }
          },
          onClick(hits) {
            for (const h of hits) {
              const node = h.object.userData.node as GraphNode | undefined;
              if (node) {
                propsRef.current.onSelectNode(node);
                break;
              }
            }
          },
        };
      }}
    />
  );
}
