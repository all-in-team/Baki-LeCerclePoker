"use client";

import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";

// THE CORE — particle sphere. three.js is imported lazily inside the effect so
// it only ever loads on the dashboard, client-side.
// Points sit on the sphere SURFACE; a custom shader scales size/alpha with view
// depth so the front of the globe reads bright and the back fades — a sphere,
// not a flat cloud. Pauses when the tab is hidden or off-viewport.
// prefers-reduced-motion: renders a single static frame.
export default function CoreSphere({ style }: { style?: CSSProperties }) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;

    (async () => {
      const THREE = await import("three");
      const mount = mountRef.current;
      if (disposed || !mount) return;

      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const isMobile = window.innerWidth < 768;
      const COUNT = isMobile ? 800 : 2400;
      const GOLD_RATIO = 0.05;
      const CAM_Z = 2.4;

      const w = mount.clientWidth || 280;
      const h = mount.clientHeight || 280;

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(48, w / h, 0.1, 50);
      camera.position.z = CAM_Z;

      // No WebGL (old GPU, remote desktop, headless) → no sphere, page stays intact
      let renderer: import("three").WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: "low-power" });
      } catch {
        return;
      }
      renderer.setSize(w, h);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.domElement.style.display = "block";
      mount.appendChild(renderer.domElement);

      const group = new THREE.Group();
      scene.add(group);

      // Fibonacci distribution strictly ON the surface (±1% jitter max)
      const emerald = new THREE.Color("#10B981");
      const cyan = new THREE.Color("#22D3EE");
      const gold = new THREE.Color("#F5C518");
      const pos: number[] = [];
      const col: number[] = [];
      const goldFlag: number[] = [];
      const phi = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < COUNT; i++) {
        const y = 1 - (i / (COUNT - 1)) * 2;
        const r = Math.sqrt(1 - y * y);
        const theta = phi * i;
        const jitter = 0.995 + Math.random() * 0.01;
        pos.push(Math.cos(theta) * r * jitter, y * jitter, Math.sin(theta) * r * jitter);
        const isGold = Math.random() < GOLD_RATIO;
        const c = isGold ? gold : emerald.clone().lerp(cyan, Math.random() * 0.6);
        col.push(c.r, c.g, c.b);
        goldFlag.push(isGold ? 1 : 0);
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute("aColor", new THREE.Float32BufferAttribute(col, 3));
      geo.setAttribute("aGold", new THREE.Float32BufferAttribute(goldFlag, 1));

      const mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uSize: { value: (isMobile ? 30 : 38) * Math.min(window.devicePixelRatio, 2) },
          uCamZ: { value: CAM_Z },
          uTwinkle: { value: 1 },
        },
        vertexShader: /* glsl */ `
          attribute vec3 aColor;
          attribute float aGold;
          uniform float uSize;
          uniform float uCamZ;
          varying vec3 vColor;
          varying float vGold;
          varying float vDepth;
          void main() {
            vColor = aColor;
            vGold = aGold;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            // sphere center is at view z = -uCamZ; points span ±1 around it
            vDepth = clamp((mv.z + uCamZ) * 0.5 + 0.5, 0.0, 1.0);
            gl_PointSize = uSize * (0.35 + 0.75 * vDepth) / -mv.z;
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uTwinkle;
          varying vec3 vColor;
          varying float vGold;
          varying float vDepth;
          void main() {
            float d = length(gl_PointCoord - 0.5);
            if (d > 0.5) discard;
            float soft = smoothstep(0.5, 0.12, d);
            float alpha = (0.12 + 0.88 * vDepth) * soft;
            if (vGold > 0.5) alpha *= uTwinkle;
            gl_FragColor = vec4(vColor, alpha);
          }
        `,
      });
      group.add(new THREE.Points(geo, mat));

      // Faint wireframe shell for the luminous-globe look
      const wireGeo = new THREE.IcosahedronGeometry(0.99, 1);
      const wireMat = new THREE.MeshBasicMaterial({
        color: emerald, wireframe: true, transparent: true, opacity: 0.045, depthWrite: false,
      });
      group.add(new THREE.Mesh(wireGeo, wireMat));

      group.rotation.x = 0.28;

      let raf = 0;
      let running = false;
      let tabVisible = !document.hidden;
      let inView = true;
      const clock = new THREE.Clock();

      const frame = () => {
        const t = clock.getElapsedTime();
        group.rotation.y = t * ((Math.PI * 2) / 55);           // visible slow spin, ~55s/turn
        const s = 1 + 0.02 * Math.sin((t * Math.PI * 2) / 8);   // ±2% breath over 8s
        group.scale.setScalar(s);
        mat.uniforms.uTwinkle.value = 0.55 + 0.45 * Math.sin(t * 2.1);
        renderer.render(scene, camera);
      };

      const loop = () => {
        frame();
        raf = requestAnimationFrame(loop);
      };
      const updateRunning = () => {
        const should = !reduced && tabVisible && inView;
        if (should && !running) { running = true; raf = requestAnimationFrame(loop); }
        if (!should && running) { running = false; cancelAnimationFrame(raf); }
      };

      const onVis = () => { tabVisible = !document.hidden; updateRunning(); };
      document.addEventListener("visibilitychange", onVis);
      const io = new IntersectionObserver(([e]) => { inView = e.isIntersecting; updateRunning(); });
      io.observe(mount);

      const onResize = () => {
        const nw = mount.clientWidth || 280;
        const nh = mount.clientHeight || 280;
        camera.aspect = nw / nh;
        camera.updateProjectionMatrix();
        renderer.setSize(nw, nh);
        if (!running) frame();
      };
      window.addEventListener("resize", onResize);

      if (reduced) {
        group.rotation.y = 0.6;
        frame(); // single static frame
      } else {
        updateRunning();
      }

      cleanup = () => {
        cancelAnimationFrame(raf);
        document.removeEventListener("visibilitychange", onVis);
        window.removeEventListener("resize", onResize);
        io.disconnect();
        geo.dispose(); wireGeo.dispose();
        mat.dispose(); wireMat.dispose();
        renderer.dispose();
        if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      };
    })();

    return () => { disposed = true; cleanup?.(); };
  }, []);

  return <div ref={mountRef} aria-hidden style={{ width: "100%", height: "100%", ...style }} />;
}
