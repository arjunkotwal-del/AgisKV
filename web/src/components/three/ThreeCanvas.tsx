import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  MathUtils,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Spherical,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Intersection,
  type Material,
  type Mesh,
  type Texture,
} from "three";

export interface ThreeSceneController {
  update: (elapsed: number, dt: number) => void;
  onClick?: (intersects: Intersection[]) => void;
  dispose?: () => void;
}

export interface ThreeOrbitConfig {
  cameraPos: [number, number, number];
  fov?: number;
  target?: [number, number, number];
  autoRotate?: boolean;
  autoRotateSpeed?: number;
  minPolar?: number;
  maxPolar?: number;
}

interface ThreeCanvasProps {
  label: string;
  orbit: ThreeOrbitConfig;
  setup: (scene: Scene, camera: PerspectiveCamera) => ThreeSceneController;
  deps: unknown[];
  fallbackSvg: ReactNode;
  className?: string;
}

function canRunWebGLShader(): boolean {
  if (typeof window === "undefined") return false;
  const testCanvas = document.createElement("canvas");
  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  try {
    gl =
      (testCanvas.getContext("webgl2") as WebGL2RenderingContext | null) ||
      (testCanvas.getContext("webgl") as WebGLRenderingContext | null);
  } catch {
    return false;
  }
  if (!gl) return false;
  try {
    const sh = gl.createShader(gl.VERTEX_SHADER);
    if (!sh) return false;
    gl.shaderSource(sh, "attribute vec3 p; void main(){ gl_Position = vec4(p, 1.0); }");
    gl.compileShader(sh);
    const ok = Boolean(gl.getShaderParameter(sh, gl.COMPILE_STATUS));
    gl.deleteShader(sh);
    const ext = gl.getExtension("WEBGL_lose_context");
    ext?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

export function ThreeCanvas({
  label,
  orbit,
  setup,
  deps,
  fallbackSvg,
  className = "",
}: ThreeCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [fallbackActive, setFallbackActive] = useState(false);
  const [prefersReduced, setPrefersReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [paused, setPaused] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const pausedRef = useRef(paused);
  const inViewRef = useRef(true);
  const startRafRef = useRef<(() => void) | null>(null);
  const controllerRef = useRef<ThreeSceneController | null>(null);

  useEffect(() => {
    pausedRef.current = paused;
    if (!paused) {
      startRafRef.current?.();
    }
  }, [paused]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (e: MediaQueryListEvent) => {
      setPrefersReduced(e.matches);
      setPaused(e.matches);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    if (!canRunWebGLShader()) {
      setFallbackActive(true);
      return;
    }

    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({
        canvas,
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
      });
      renderer.setClearColor(0x000000, 0);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.outputColorSpace = SRGBColorSpace;
    } catch {
      setFallbackActive(true);
      return;
    }

    const glCtx = renderer.getContext();
    if (!glCtx) {
      renderer.dispose();
      setFallbackActive(true);
      return;
    }

    const scene = new Scene();
    const width = Math.max(host.clientWidth || 640, 64);
    const height = Math.max(host.clientHeight || 420, 48);
    const camera = new PerspectiveCamera(orbit.fov ?? 42, width / height, 0.1, 100);
    const target = new Vector3(...(orbit.target ?? [0, 0, 0]));
    const initOffset = new Vector3(...orbit.cameraPos).sub(target);
    const spherical = new Spherical().setFromVector3(initOffset);

    const updateCamera = () => {
      const pos = new Vector3().setFromSpherical(spherical).add(target);
      camera.position.copy(pos);
      camera.lookAt(target);
    };
    updateCamera();
    renderer.setSize(width, height, false);

    let ctrl: ThreeSceneController;
    try {
      ctrl = setup(scene, camera);
      controllerRef.current = ctrl;
    } catch {
      renderer.dispose();
      setFallbackActive(true);
      return;
    }

    // Immediate first paint + verify shader compiled cleanly
    try {
      ctrl.update(0, 0);
      renderer.render(scene, camera);
      if (glCtx.isContextLost()) {
        setFallbackActive(true);
      }
    } catch {
      setFallbackActive(true);
    }

    const onContextLost = (ev: Event) => {
      ev.preventDefault();
      setFallbackActive(true);
    };
    canvas.addEventListener("webglcontextlost", onContextLost);

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const w = Math.max(entry.contentRect.width, 64);
      const h = Math.max(entry.contentRect.height, 48);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
      renderer.render(scene, camera);
    });
    ro.observe(host);

    const io = new IntersectionObserver(
      (entries) => {
        inViewRef.current = Boolean(entries[0]?.isIntersecting);
      },
      { rootMargin: "120px" }
    );
    io.observe(host);

    // Lightweight pointer orbit & raycast click
    let dragging = false;
    let dragDist = 0;
    let lastX = 0;
    let lastY = 0;
    const minPolar = orbit.minPolar ?? 0.35;
    const maxPolar = orbit.maxPolar ?? Math.PI * 0.48;
    const raycaster = new Raycaster();
    const ndc = new Vector2();

    const onPointerDown = (e: PointerEvent) => {
      dragging = true;
      dragDist = 0;
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      dragDist += Math.hypot(dx, dy);
      lastX = e.clientX;
      lastY = e.clientY;
      spherical.theta -= dx * 0.0065;
      spherical.phi = MathUtils.clamp(spherical.phi - dy * 0.005, minPolar, maxPolar);
      updateCamera();
      renderer.render(scene, camera);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      if (dragDist < 6 && ctrl.onClick) {
        const rect = canvas.getBoundingClientRect();
        ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(ndc, camera);
        const hits = raycaster.intersectObjects(scene.children, true);
        if (hits.length) ctrl.onClick(hits);
      }
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    let rafId = 0;
    let prevTime = performance.now();
    let elapsed = 0;

    const tick = (now: number) => {
      rafId = 0;
      const dt = Math.max(0, Math.min((now - prevTime) / 1000, 0.05));
      prevTime = now;

      if (!pausedRef.current && inViewRef.current) {
        elapsed += dt;
        if (orbit.autoRotate && !dragging) {
          spherical.theta += dt * (orbit.autoRotateSpeed ?? 0.42);
          updateCamera();
        }
        ctrl.update(elapsed, dt);
        renderer.render(scene, camera);
      }
      if (!pausedRef.current) {
        rafId = requestAnimationFrame(tick);
      }
    };

    const startRaf = () => {
      if (!pausedRef.current && rafId === 0) {
        prevTime = performance.now();
        rafId = requestAnimationFrame(tick);
      }
    };
    startRafRef.current = startRaf;

    ctrl.update(0, 0);
    renderer.render(scene, camera);
    startRaf();

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      io.disconnect();
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      ctrl.dispose?.();
      scene.traverse((obj) => {
        if ((obj as Mesh).geometry) (obj as Mesh).geometry.dispose();
        const mat = (obj as Mesh).material as Material | Material[] | undefined;
        const disposeMat = (m: Material) => {
          const textured = m as Material & { map?: Texture | null };
          if (textured.map) textured.map.dispose();
          m.dispose();
        };
        if (Array.isArray(mat)) mat.forEach(disposeMat);
        else if (mat) disposeMat(mat);
      });
      renderer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return (
    <div
      ref={hostRef}
      role="img"
      aria-label={label}
      className={`three-host ${className}`}
    >
      <canvas
        ref={canvasRef}
        className="three-canvas"
        aria-hidden="true"
        style={fallbackActive ? { opacity: 0, pointerEvents: "none" } : undefined}
      />
      {fallbackActive && <div className="three-fallback">{fallbackSvg}</div>}
      {!fallbackActive && (
        <button
          type="button"
          className={`loop-pause ${paused ? "is-paused" : ""}`}
          aria-label={paused ? `Play ${label}` : `Pause ${label}`}
          aria-pressed={paused}
          title={
            paused && prefersReduced
              ? "OS reduced motion is active — click to animate"
              : paused
                ? "Play 3D animation"
                : "Pause 3D animation"
          }
          onClick={() => setPaused((v) => !v)}
        >
          {paused ? (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5 3.2v9.6L12.6 8 5 3.2z" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4.5 3.5h2.5v9H4.5zm4.5 0h2.5v9H9z" />
            </svg>
          )}
        </button>
      )}
    </div>
  );
}
