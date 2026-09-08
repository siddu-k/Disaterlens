import { useEffect, useRef } from 'react';
import {
  IconFlood,
  IconCyclone,
  IconHeatwave,
  IconEarthquake,
  IconLandslide,
  IconLocationPin,
  IconInsight,
  IconRoad,
  IconHospital,
} from './Icons';

declare global {
  // three.js is lazy-loaded from CDN (see loadThree) so WebGL never enters our bundle.
  interface Window {
    THREE?: any;
  }
}

const THREE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
const EARTH_TEX =
  'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/planets/earth_atmos_2048.jpg';
const CLOUDS_TEX =
  'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/planets/earth_clouds_1024.png';

function loadThree(): Promise<any> {
  if (window.THREE) return Promise.resolve(window.THREE);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-three-cdn]');
    if (existing) {
      existing.addEventListener('load', () => resolve(window.THREE));
      existing.addEventListener('error', () => reject(new Error('three.js CDN failed')));
      return;
    }
    const s = document.createElement('script');
    s.src = THREE_CDN;
    s.async = true;
    s.setAttribute('data-three-cdn', '1');
    s.onload = () => resolve(window.THREE);
    s.onerror = () => reject(new Error('three.js CDN failed'));
    document.head.appendChild(s);
  });
}

function GlobeCanvas() {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let raf = 0;
    let renderer: any = null;
    let scene: any = null;
    let camera: any = null;
    let globe: any = null;
    let clouds: any = null;
    let stars: any = null;
    let resizeHandler: (() => void) | null = null;
    let time = Math.random() * 10;

    loadThree()
      .then((THREE) => {
        if (disposed) return;
        const mount = mountRef.current;
        if (!mount) return;
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const w = Math.max(1, mount.clientWidth);
        const h = Math.max(1, mount.clientHeight);

        scene = new THREE.Scene();
        camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 2000);
        camera.position.set(0, 0, reduced ? 20 : 150);

        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setClearColor(0x000000, 0);
        renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        renderer.setSize(w, h);
        renderer.domElement.className = 'lp-globe-canvas';
        renderer.domElement.setAttribute('aria-hidden', 'true');
        mount.appendChild(renderer.domElement);

        // Theme-matched lighting: cool key + indigo rim
        scene.add(new THREE.AmbientLight(0xffffff, 0.62));
        const key = new THREE.PointLight(0x9fd8ff, 1.6);
        key.position.set(22, 14, 26);
        scene.add(key);
        const rim = new THREE.PointLight(0x818cf8, 0.75);
        rim.position.set(-26, -8, -14);
        scene.add(rim);

        const loader = new THREE.TextureLoader();
        loader.setCrossOrigin('anonymous');
        const earthTex = loader.load(EARTH_TEX);
        earthTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
        globe = new THREE.Mesh(
          new THREE.SphereGeometry(5, 96, 96),
          new THREE.MeshPhongMaterial({ map: earthTex, shininess: 18, specular: new THREE.Color(0x2a3a55) })
        );
        scene.add(globe);

        const cloudTex = loader.load(CLOUDS_TEX);
        clouds = new THREE.Mesh(
          new THREE.SphereGeometry(5.07, 96, 96),
          new THREE.MeshPhongMaterial({ map: cloudTex, transparent: true, opacity: 0.38, depthWrite: false })
        );
        scene.add(clouds);

        // Cyan atmosphere halo shell
        const halo = new THREE.Mesh(
          new THREE.SphereGeometry(5.5, 64, 64),
          new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.07, side: THREE.BackSide, depthWrite: false })
        );
        scene.add(halo);

        // Starfield
        const starCount = 900;
        const pos = new Float32Array(starCount * 3);
        for (let i = 0; i < starCount; i++) {
          const r = 60 + Math.random() * 170;
          const th = Math.random() * Math.PI * 2;
          const ph = Math.acos(2 * Math.random() - 1);
          pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
          pos[i * 3 + 1] = r * Math.cos(ph);
          pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
        }
        const starGeo = new THREE.BufferGeometry();
        starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        stars = new THREE.Points(
          starGeo,
          new THREE.PointsMaterial({ size: 0.55, color: 0xcfe9ff, transparent: true, opacity: 0.85, sizeAttenuation: true })
        );
        scene.add(stars);

        resizeHandler = () => {
          if (!renderer || !mountRef.current) return;
          const mw = Math.max(1, mountRef.current.clientWidth);
          const mh = Math.max(1, mountRef.current.clientHeight);
          camera.aspect = mw / mh;
          camera.updateProjectionMatrix();
          renderer.setSize(mw, mh);
        };
        window.addEventListener('resize', resizeHandler);

        // Mouse control: drag to orbit, wheel to zoom (contained to the hero box)
        let uYaw = 0;
        let uYawC = 0;
        let uPitch = 0;
        let uPitchC = 0;
        let dist = 20;
        let distC = 20;
        let dragging = false;
        let lx = 0;
        let ly = 0;
        const cvs = renderer.domElement as HTMLCanvasElement;
        cvs.style.cursor = 'grab';
        cvs.addEventListener('pointerdown', (e: PointerEvent) => {
          dragging = true;
          lx = e.clientX;
          ly = e.clientY;
          try {
            cvs.setPointerCapture(e.pointerId);
          } catch {}
          cvs.style.cursor = 'grabbing';
        });
        cvs.addEventListener('pointermove', (e: PointerEvent) => {
          if (!dragging) return;
          uYaw += (e.clientX - lx) * 0.005;
          uPitch += (e.clientY - ly) * 0.003;
          uPitch = Math.max(-0.6, Math.min(0.6, uPitch));
          lx = e.clientX;
          ly = e.clientY;
        });
        const endDrag = () => {
          dragging = false;
          cvs.style.cursor = 'grab';
        };
        cvs.addEventListener('pointerup', endDrag);
        cvs.addEventListener('pointercancel', endDrag);
        cvs.addEventListener(
          'wheel',
          (e: WheelEvent) => {
            e.preventDefault();
            dist = Math.max(12, Math.min(34, dist * Math.exp(e.deltaY * 0.001)));
          },
          { passive: false }
        );
        let introComplete = reduced;
        const animate = () => {
          if (disposed) return;
          raf = requestAnimationFrame(animate);
          time += 0.005;
          if (!reduced) {
            clouds.rotation.y += 0.00045;
            globe.rotation.y += 0.00016;
            stars.rotation.y -= 0.00012;
          }
          // Damped user control + cinematic drift
          uYawC += (uYaw - uYawC) * 0.08;
          uPitchC += (uPitch - uPitchC) * 0.08;
          distC += (dist - distC) * 0.12;
          if (!introComplete) {
            // Dramatic fly-in, then settle into a slow orbit
            camera.position.z += (distC - camera.position.z) * 0.035;
            camera.position.x += (0 - camera.position.x) * 0.035;
            camera.lookAt(0, 0, 0);
            if (Math.abs(camera.position.z - distC) < 0.4) {
              introComplete = true;
            }
          } else {
            const a = (reduced ? 2.2 : time * 0.14 + 2.2) + uYawC;
            camera.position.x = distC * Math.sin(a);
            camera.position.z = distC * Math.cos(a);
            camera.position.y = uPitchC * distC;
            camera.lookAt(0, 0, 0);
          }
          renderer.render(scene, camera);
        };
        animate();
      })
      .catch(() => {
        // CDN/texture failure: the themed CSS backdrop + labels remain as fallback.
      });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      if (resizeHandler) window.removeEventListener('resize', resizeHandler);
      if (renderer) {
        renderer.dispose();
        const el = renderer.domElement;
        if (el && el.parentNode) el.parentNode.removeChild(el);
      }
      if (scene) {
        scene.traverse((o: any) => {
          o.geometry?.dispose?.();
          const m = o.material;
          if (Array.isArray(m)) m.forEach((x: any) => {
            x.map?.dispose?.();
            x.dispose?.();
          });
          else {
            m?.map?.dispose?.();
            m?.dispose?.();
          }
        });
      }
      renderer = scene = camera = globe = clouds = stars = null;
    };
  }, []);

  return <div ref={mountRef} className="lp-globe-mount" aria-hidden="true" />;
}

const HAZARDS = [
  { icon: 'flood', title: 'Flood', text: '2D hydrodynamic spread over real DEM terrain with street-level road submersion.' },
  { icon: 'cyclone', title: 'Cyclone', text: 'Holland-vortex winds, dynamic tracks and hydrostatic storm surge.' },
  { icon: 'wildfire', title: 'Wildfire', text: 'Rothermel spread with wind alignment, fuel moisture and ignition control.' },
  { icon: 'earthquake', title: 'Earthquake', text: 'GMPE ground motion converted to MMI with structure fragility.' },
  { icon: 'landslide', title: 'Landslide', text: 'Infinite-slope stability with rainfall-triggered susceptibility.' },
];

function HazardIcon({ kind, size = 20 }: { kind: string; size?: number }) {
  if (kind === 'flood') return <IconFlood size={size} color="#38bdf8" />;
  if (kind === 'cyclone') return <IconCyclone size={size} color="#c084fc" />;
  if (kind === 'wildfire') return <IconHeatwave size={size} color="#fb923c" />;
  if (kind === 'earthquake') return <IconEarthquake size={size} color="#f87171" />;
  return <IconLandslide size={size} color="#facc15" />;
}

export default function LandingPage({ onLaunch }: { onLaunch: () => void }) {
  return (
    <div className="lp-root">
      <div className="lp-bg-grid" aria-hidden="true" />
      <header className="lp-nav">
        <div className="lp-brand">
          <svg width="30" height="30" viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <path d="M16 3L4 9l12 6 12-6-12-6z" fill="#38bdf8" />
            <path d="M4 15l12 6 12-6" stroke="#38bdf8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4 21l12 6 12-6" stroke="#0284c7" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="lp-brand-name">DisasterLens</span>
        </div>
        <nav className="lp-nav-links">
          <a href="#hazards">Hazards</a>
          <a href="#platform">Platform</a>
          <a href="#ai-pipeline">AI Pipeline</a>
          <a href="#workflow">Workflow</a>
        </nav>
        <button className="lp-btn lp-btn--primary lp-btn--sm" onClick={onLaunch}>
          Launch App
        </button>
      </header>

      <section className="lp-hero">
        <div className="lp-hero-copy">
          <div className="lp-eyebrow">
            <span className="lp-pulse-dot" />
            Real Data. Real Impact.
          </div>
          <h1 className="lp-title">
            See disaster
            <br />
            <span className="lp-title-accent">before it strikes.</span>
          </h1>
          <p className="lp-sub">
            DisasterLens fuses live OpenStreetMap infrastructure, 30m elevation terrain and
            physics-first hazard engines — then briefs you with grounded AI analysis, street by street.
          </p>
          <div className="lp-cta-row">
            <button className="lp-btn lp-btn--primary" onClick={onLaunch}>
              Launch Command Center
            </button>
            <a className="lp-btn lp-btn--ghost" href="#workflow">
              How it works
            </a>
          </div>
          <div className="lp-stats">
            <div className="lp-stat">
              <strong>5</strong>
              <span>hazard engines</span>
            </div>
            <div className="lp-stat">
              <strong>Live</strong>
              <span>OSM + 30m DEM</span>
            </div>
            <div className="lp-stat">
              <strong>Street</strong>
              <span>level impact</span>
            </div>
            <div className="lp-stat">
              <strong>AI</strong>
              <span>grounded briefings</span>
            </div>
          </div>
        </div>
        <div className="lp-hero-visual">
          <GlobeCanvas />
          <div className="lp-orbit-label lp-orbit-label--a">Live OSM feed</div>
          <div className="lp-orbit-label lp-orbit-label--b">Copernicus DEM</div>
          <div className="lp-globe-hint">Drag to rotate • Scroll to zoom</div>
        </div>
      </section>

      <section className="lp-section" id="hazards">
        <div className="lp-section-head">
          <div className="lp-section-kicker">Multi-hazard engine</div>
          <h2>Five disasters. One physics core.</h2>
          <p>Each engine speaks its native units — meters of water, MMI shaking, burn severity, wind, susceptibility.</p>
        </div>
        <div className="lp-hazard-grid">
          {HAZARDS.map((h) => (
            <div className="lp-card lp-hazard-card" key={h.title}>
              <div className="lp-hazard-icon">
                <HazardIcon kind={h.icon} />
              </div>
              <h3>{h.title}</h3>
              <p>{h.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="lp-section" id="platform">
        <div className="lp-section-head">
          <div className="lp-section-kicker">Platform</div>
          <h2>From raw map to decision.</h2>
        </div>
        <div className="lp-feature-grid">
          <div className="lp-card">
            <div className="lp-feature-icon"><IconLocationPin size={20} color="#38bdf8" /></div>
            <h3>Live geospatial fusion</h3>
            <p>Roads, buildings, hospitals and shelters pulled live per area, cached spatially, flagged when modeled.</p>
          </div>
          <div className="lp-card">
            <div className="lp-feature-icon"><IconRoad size={20} color="#34d399" /></div>
            <h3>Street-level impact</h3>
            <p>Per-road closures with reasons, per-building damage states, evacuation routing on the open network.</p>
          </div>
          <div className="lp-card">
            <div className="lp-feature-icon"><IconHospital size={20} color="#f43f5e" /></div>
            <h3>Critical facilities</h3>
            <p>Hospitals, shelters and stations assessed individually — functionality, smoke risk, flood exposure.</p>
          </div>
          <div className="lp-card">
            <div className="lp-feature-icon"><IconInsight size={20} color="#fbbf24" /></div>
            <h3>Grounded AI analyst</h3>
            <p>Natural-language scenarios in, evidence-bound briefings out. The model explains — physics decides.</p>
          </div>
        </div>
      </section>

      <section className="lp-section" id="ai-pipeline">
        <div className="lp-section-head">
          <div className="lp-section-kicker">AI predictive pipeline</div>
          <h2>How the machine reasons.</h2>
          <p>
            Physics always runs first and produces hard numbers. The Gemini analyst only ever reads
            those numbers — it parses your words into parameters on the way in, and explains evidence
            on the way out. It can never invent a flood.
          </p>
        </div>
        <div className="lp-pipe-wrap">
          <svg className="lp-pipe-svg" viewBox="0 0 1040 210" role="img" aria-label="AI predictive pipeline: intake, physics, fusion, analyst, brief">
            <defs>
              <marker id="lp-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="#38bdf8" />
              </marker>
            </defs>
            {[
              { x: 20, c: '#38bdf8', t: '1 · INTAKE', s1: 'Live Data Intake', s2: 'OSM · DEM · scenario' },
              { x: 224, c: '#818cf8', t: '2 · PHYSICS', s1: 'Physics Engines', s2: '5 hazards · native units' },
              { x: 428, c: '#34d399', t: '3 · FUSION', s1: 'Impact Fusion', s2: 'roads · buildings · people' },
              { x: 632, c: '#fbbf24', t: '4 · ANALYST', s1: 'AI Analyst (Gemini)', s2: 'grounded on impact JSON' },
              { x: 836, c: '#f87171', t: '5 · BRIEF', s1: 'Decision Brief', s2: 'severity · actions · routes' },
            ].map((n) => (
              <g key={n.t}>
                <rect x={n.x} y={45} width={184} height={120} rx={12} fill="rgba(13, 23, 48, 0.85)" stroke={n.c} strokeWidth={1.5} />
                <text x={n.x + 14} y={72} fill={n.c} fontSize={11} fontWeight={800} letterSpacing={1}>{n.t}</text>
                <text x={n.x + 14} y={98} fill="#f1f5f9" fontSize={14} fontWeight={700}>{n.s1}</text>
                <text x={n.x + 14} y={120} fill="#94a3b8" fontSize={11.5}>{n.s2}</text>
                <text x={n.x + 14} y={142} fill="#64748b" fontSize={11.5}>deterministic ↓</text>
              </g>
            ))}
            {[204, 408, 612, 816].map((x) => (
              <line key={x} x1={x} y1={105} x2={x + 20} y2={105} stroke="#38bdf8" strokeWidth={2} className="lp-flow" markerEnd="url(#lp-arrow)" />
            ))}
          </svg>
        </div>
        <details className="lp-mermaid">
          <summary>View as Mermaid source (paste into mermaid.live)</summary>
          <pre>{`flowchart LR
    A["Live Data Intake<br/>OSM + DEM + scenario"] --> B["Physics Engines<br/>flood · cyclone · quake · fire · slide"]
    B --> C["Impact Fusion<br/>roads · buildings · people"]
    C --> D["AI Analyst (Gemini)<br/>grounded on impact JSON"]
    D --> E["Decision Brief<br/>severity · actions · routes"]`}</pre>
        </details>
      </section>

      <section className="lp-section" id="workflow">
        <div className="lp-section-head">
          <div className="lp-section-kicker">Workflow</div>
          <h2>Sixty seconds to insight.</h2>
        </div>
        <div className="lp-steps">
          <div className="lp-step">
            <div className="lp-step-num">01</div>
            <h3>Draw your area</h3>
            <p>Box any neighborhood. Live map and terrain load instantly with a size guard for reliability.</p>
          </div>
          <div className="lp-step">
            <div className="lp-step-num">02</div>
            <h3>Dial the physics</h3>
            <p>Rainfall, magnitude, wind vectors, ignition point — per-hazard parameters with live validation.</p>
          </div>
          <div className="lp-step">
            <div className="lp-step-num">03</div>
            <h3>Simulate and act</h3>
            <p>Animate the timeline, inspect any street or structure, read the AI briefing, export the story.</p>
          </div>
        </div>
        <div className="lp-cta-center">
          <button className="lp-btn lp-btn--primary lp-btn--lg" onClick={onLaunch}>
            Open DisasterLens
          </button>
        </div>
      </section>

      <footer className="lp-footer">
        <span>DisasterLens — Real Data. Real Impact.</span>
        <span className="lp-footer-note">Deterministic models · Authoritative sources · Human decisions</span>
      </footer>
    </div>
  );
}
