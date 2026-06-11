"use client";

import { useEffect, useRef } from "react";

// The two figurines (baki + hugo) on a slow turntable inside the hero focal slot.
// three.js + the GLBs load lazily, only once the slot first enters the viewport.
// Fallbacks: no WebGL or load failure → slot silently keeps its ground glow;
// prefers-reduced-motion → static models, no rotation/float.
export default function FigurineDuo() {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let disposed = false;
    let started = false;
    let cleanup: (() => void) | undefined;

    // shared run-state, wired up once the scene is live
    const state = { tabVisible: !document.hidden, inView: true, update: () => {} };

    const start = async () => {
      if (started || disposed) return;
      started = true;

      const [THREE, { GLTFLoader }, { RoomEnvironment }] = await Promise.all([
        import("three"),
        import("three/examples/jsm/loaders/GLTFLoader.js"),
        import("three/examples/jsm/environments/RoomEnvironment.js"),
      ]);
      if (disposed) return;

      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      // probe WebGL support first — THREE's constructor logs console errors
      // before throwing, and the fallback must stay silent
      const probe = document.createElement("canvas");
      const gl = probe.getContext("webgl2") ?? probe.getContext("webgl");
      if (!gl) return; // no WebGL → glow disc only
      gl.getExtension("WEBGL_lose_context")?.loseContext();

      let renderer: import("three").WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
      } catch {
        return; // no WebGL → glow disc only
      }
      const w = mount.clientWidth || 280;
      const h = mount.clientHeight || 260;
      renderer.setSize(w, h);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.3; // tuned at the render harness (1.4 blew side faces)
      renderer.domElement.style.display = "block";

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(38, w / h, 0.1, 50);
      camera.position.set(0, 0.55, 4.9); // far enough that the turntable swing never clips the frame
      camera.lookAt(0, 0.1, 0);

      // studio: environment map makes the TRELLIS PBR materials pop
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose();

      // warm sky/ground + key + gold rim + soft frontal fill to open the faces
      scene.add(new THREE.HemisphereLight(0xfff4e0, 0x202028, 0.9));
      const key = new THREE.DirectionalLight(0xffffff, 1.6);
      key.position.set(2, 3, 4);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0xf0b90b, 2.2);
      rim.position.set(-1.2, 3.2, -3);
      scene.add(rim);
      const fill = new THREE.DirectionalLight(0xffffff, 0.5);
      fill.position.copy(camera.position);
      scene.add(fill);

      const group = new THREE.Group();
      scene.add(group);

      const loader = new GLTFLoader();
      const loadGlb = (url: string) =>
        new Promise<import("three/examples/jsm/loaders/GLTFLoader.js").GLTF>((resolve, reject) =>
          loader.load(url, resolve, undefined, reject));

      const loaded = await Promise.all([loadGlb("/models/baki.glb"), loadGlb("/models/hugo.glb")])
        .catch((err) => {
          // visual fallback stays silent, but the failure must be diagnosable
          console.warn("[FigurineDuo] model load failed:", err?.message ?? err);
          return null;
        });
      if (!loaded || disposed) {
        renderer.dispose();
        return; // model fetch/parse failed (or unmounted) → glow disc only
      }
      const [baki, hugo] = loaded;

      // normalize each model to the same height, feet on the ground line,
      // side by side and slightly back-to-back
      const TARGET_H = 2.0; // +~15% vs original 1.8 — they were getting lost in the slot
      const place = (gltf: { scene: import("three").Group }, x: number, rotY: number) => {
        const obj = gltf.scene;
        const pre = new THREE.Box3().setFromObject(obj);
        const size = pre.getSize(new THREE.Vector3());
        obj.scale.setScalar(TARGET_H / (size.y || 1));
        obj.rotation.y = rotY;
        const box = new THREE.Box3().setFromObject(obj);
        const center = box.getCenter(new THREE.Vector3());
        obj.position.x = x - center.x;
        obj.position.z = -center.z;
        obj.position.y = -box.min.y - TARGET_H / 2; // group vertically centered around 0
        group.add(obj);
      };
      place(baki, -0.75, THREE.MathUtils.degToRad(20));
      place(hugo, 0.75, THREE.MathUtils.degToRad(-20));

      mount.appendChild(renderer.domElement);

      let raf = 0;
      let running = false;
      const clock = new THREE.Clock();

      const frame = () => {
        const t = clock.getElapsedTime();
        group.rotation.y = t * ((Math.PI * 2) / 14);             // turntable, 14s/turn
        group.position.y = Math.sin((t * Math.PI * 2) / 6) * 0.033; // float ≈ ±3px
        renderer.render(scene, camera);
      };
      const loop = () => { frame(); raf = requestAnimationFrame(loop); };

      state.update = () => {
        const should = !reduced && state.tabVisible && state.inView;
        if (should && !running) { running = true; raf = requestAnimationFrame(loop); }
        if (!should && running) { running = false; cancelAnimationFrame(raf); }
      };

      const onResize = () => {
        const nw = mount.clientWidth || 280;
        const nh = mount.clientHeight || 260;
        camera.aspect = nw / nh;
        camera.updateProjectionMatrix();
        renderer.setSize(nw, nh);
        if (!running) frame();
      };
      window.addEventListener("resize", onResize);

      if (reduced) {
        frame(); // static pose
      } else {
        state.update();
      }

      cleanup = () => {
        cancelAnimationFrame(raf);
        window.removeEventListener("resize", onResize);
        scene.traverse(o => {
          const mesh = o as import("three").Mesh;
          if (mesh.geometry) mesh.geometry.dispose();
          const m = mesh.material as import("three").Material | import("three").Material[] | undefined;
          if (Array.isArray(m)) m.forEach(x => x.dispose());
          else m?.dispose();
        });
        renderer.dispose();
        if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      };
    };

    const onVis = () => { state.tabVisible = !document.hidden; state.update(); };
    document.addEventListener("visibilitychange", onVis);
    const io = new IntersectionObserver(([e]) => {
      state.inView = e.isIntersecting;
      if (e.isIntersecting) start();
      state.update();
    }, { rootMargin: "120px" });
    io.observe(mount);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVis);
      io.disconnect();
      cleanup?.();
    };
  }, []);

  return (
    <div aria-hidden style={{ position: "absolute", inset: 0 }}>
      {/* emerald halo + reinforced gold ground glow — silhouettes detach from the obsidian */}
      <div style={{
        position: "absolute", inset: 0,
        background:
          "radial-gradient(ellipse 56% 62% at 50% 52%, rgba(16,185,129,0.11), transparent 70%), " +
          "radial-gradient(ellipse 62% 20% at 50% 88%, rgba(240,185,11,0.10), transparent 72%)",
      }} />
      <div ref={mountRef} style={{ position: "absolute", inset: 0 }} />
    </div>
  );
}
