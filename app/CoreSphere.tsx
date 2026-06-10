"use client";

import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";

// THE CORE — particle sphere. three.js is imported lazily inside the effect so
// it only ever loads on the dashboard, client-side.
// Pauses when the tab is hidden or the canvas leaves the viewport.
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
      const COUNT = isMobile ? 800 : 2600;
      const GOLD_RATIO = 0.05;

      const w = mount.clientWidth || 320;
      const h = mount.clientHeight || 320;

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 50);
      camera.position.z = 3.1;

      // No WebGL (old GPU, remote desktop, headless) → no sphere, page stays intact
      let renderer: import("three").WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
      } catch {
        return;
      }
      renderer.setSize(w, h);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.domElement.style.display = "block";
      mount.appendChild(renderer.domElement);

      const group = new THREE.Group();
      scene.add(group);

      // Fibonacci-distributed points with slight radius jitter → organic shell
      const emerald = new THREE.Color("#10B981");
      const cyan = new THREE.Color("#22D3EE");
      const mainPos: number[] = [];
      const mainCol: number[] = [];
      const goldPos: number[] = [];
      const phi = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < COUNT; i++) {
        const y = 1 - (i / (COUNT - 1)) * 2;
        const r = Math.sqrt(1 - y * y);
        const theta = phi * i;
        const jitter = 0.97 + Math.random() * 0.07;
        const x = Math.cos(theta) * r * jitter;
        const z = Math.sin(theta) * r * jitter;
        if (Math.random() < GOLD_RATIO) {
          goldPos.push(x, y * jitter, z);
        } else {
          const c = emerald.clone().lerp(cyan, Math.random() * 0.65);
          mainPos.push(x, y * jitter, z);
          mainCol.push(c.r, c.g, c.b);
        }
      }

      const mainGeo = new THREE.BufferGeometry();
      mainGeo.setAttribute("position", new THREE.Float32BufferAttribute(mainPos, 3));
      mainGeo.setAttribute("color", new THREE.Float32BufferAttribute(mainCol, 3));
      const mainMat = new THREE.PointsMaterial({
        size: 0.022, vertexColors: true, transparent: true, opacity: 0.8,
        depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
      });
      group.add(new THREE.Points(mainGeo, mainMat));

      const goldGeo = new THREE.BufferGeometry();
      goldGeo.setAttribute("position", new THREE.Float32BufferAttribute(goldPos, 3));
      const goldMat = new THREE.PointsMaterial({
        size: 0.034, color: new THREE.Color("#F5C518"), transparent: true, opacity: 0.9,
        depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
      });
      group.add(new THREE.Points(goldGeo, goldMat));

      // Faint wireframe shell for the luminous-globe look
      const wireGeo = new THREE.IcosahedronGeometry(0.99, 1);
      const wireMat = new THREE.MeshBasicMaterial({
        color: emerald, wireframe: true, transparent: true, opacity: 0.05, depthWrite: false,
      });
      group.add(new THREE.Mesh(wireGeo, wireMat));

      group.rotation.x = 0.25;

      let raf = 0;
      let running = false;
      let tabVisible = !document.hidden;
      let inView = true;
      const clock = new THREE.Clock();

      const frame = () => {
        const t = clock.getElapsedTime();
        group.rotation.y = t * ((Math.PI * 2) / 80);          // ~80s per turn
        const s = 1 + 0.02 * Math.sin((t * Math.PI * 2) / 8);  // ±2% breath over 8s
        group.scale.setScalar(s);
        goldMat.opacity = 0.55 + 0.4 * Math.sin(t * 2.1);      // gold twinkle
        renderer.render(scene, camera);
      };

      const loop = () => {
        frame();
        raf = requestAnimationFrame(loop);
      };
      const updateRunning = () => {
        const should = !reduced && tabVisible && inView;
        if (should && !running) { running = true; clock.start(); raf = requestAnimationFrame(loop); }
        if (!should && running) { running = false; cancelAnimationFrame(raf); }
      };

      const onVis = () => { tabVisible = !document.hidden; updateRunning(); };
      document.addEventListener("visibilitychange", onVis);
      const io = new IntersectionObserver(([e]) => { inView = e.isIntersecting; updateRunning(); });
      io.observe(mount);

      const onResize = () => {
        const nw = mount.clientWidth || 320;
        const nh = mount.clientHeight || 320;
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
        mainGeo.dispose(); goldGeo.dispose(); wireGeo.dispose();
        mainMat.dispose(); goldMat.dispose(); wireMat.dispose();
        renderer.dispose();
        if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      };
    })();

    return () => { disposed = true; cleanup?.(); };
  }, []);

  return <div ref={mountRef} aria-hidden style={{ width: "100%", height: "100%", ...style }} />;
}
