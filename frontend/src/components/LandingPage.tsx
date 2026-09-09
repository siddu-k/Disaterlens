import { useEffect, useRef } from 'react';
import {
  IconBolt,
  IconLocationPin,
  IconRoad,
  IconInsight,
  IconFolder,
  IconSatellite,
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

function BackdropGlobe() {
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
        const W = () => Math.max(1, mount.clientWidth || window.innerWidth);
        const H = () => Math.max(1, mount.clientHeight || window.innerHeight);

        scene = new THREE.Scene();
        camera = new THREE.PerspectiveCamera(45, W() / H(), 0.1, 2000);
        // Shift the frame so the globe sits on the right on desktop
        const applyOffset = () => {
          camera.aspect = W() / H();
          camera.clearViewOffset();
          if (W() > 900) camera.setViewOffset(W(), H(), -(W() * 0.2), 0, W(), H());
          camera.updateProjectionMatrix();
        };
        applyOffset();
        camera.position.set(0, 0, reduced ? 23 : 900);

        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setClearColor(0x000000, 0);
        renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
        renderer.setSize(W(), H());
        mount.appendChild(renderer.domElement);

        // Soft neutral lighting — no neon tint
        scene.add(new THREE.AmbientLight(0xdde3ee, 0.75));
        const key = new THREE.PointLight(0xffffff, 1.1);
        key.position.set(18, 12, 24);
        scene.add(key);

        const loader = new THREE.TextureLoader();
        loader.setCrossOrigin('anonymous');
        const earthTex = loader.load(EARTH_TEX);
        earthTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
        globe = new THREE.Mesh(
          new THREE.SphereGeometry(6, 96, 96),
          new THREE.MeshPhongMaterial({ map: earthTex, shininess: 8, specular: new THREE.Color(0x222222) })
        );
        scene.add(globe);

        const cloudTex = loader.load(CLOUDS_TEX);
        clouds = new THREE.Mesh(
          new THREE.SphereGeometry(6.07, 96, 96),
          new THREE.MeshPhongMaterial({ map: cloudTex, transparent: true, opacity: 0.32, depthWrite: false })
        );
        scene.add(clouds);

        const starCount = 1200;
        const pos = new Float32Array(starCount * 3);
        for (let i = 0; i < starCount * 3; i++) {
          pos[i] = (Math.random() - 0.5) * 1600;
        }
        const starGeo = new THREE.BufferGeometry();
        starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        stars = new THREE.Points(
          starGeo,
          new THREE.PointsMaterial({ size: 1.1, color: 0x9aa4b8, transparent: true, opacity: 0.55 })
        );
        scene.add(stars);

        resizeHandler = () => {
          if (!renderer || !mountRef.current) return;
          applyOffset();
          renderer.setSize(W(), H());
        };
        window.addEventListener('resize', resizeHandler);

        const targetZ = 23;
        const animate = () => {
          if (disposed) return;
          raf = requestAnimationFrame(animate);
          time += 0.005;
          if (!reduced) {
            clouds.rotation.y += 0.0011;
            globe.rotation.y += 0.00055;
            stars.rotation.y -= 0.00008;
          }
          if (camera.position.z > targetZ + 0.3 && !reduced) {
            camera.position.z += (targetZ - camera.position.z) * 0.03;
            camera.lookAt(0, 0, 0);
          } else {
            camera.position.z = targetZ;
            if (!reduced) {
              const a = time * 0.1;
              camera.position.x = 6 * Math.sin(a);
              camera.lookAt(0, 0, 0);
            } else {
              camera.lookAt(0, 0, 0);
            }
          }
          renderer.render(scene, camera);
        };
        animate();
      })
      .catch(() => {
        // CDN/texture failure: flat themed backdrop remains.
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
          if (Array.isArray(m)) {
            m.forEach((x: any) => {
              x.map?.dispose?.();
              x.dispose?.();
            });
          } else {
            m?.map?.dispose?.();
            m?.dispose?.();
          }
        });
      }
      renderer = scene = camera = globe = clouds = stars = null;
    };
  }, []);

  return <div ref={mountRef} className="dl-globe" aria-hidden="true" />;
}

const PLATFORM_FEATURES = [
  {
    icon: 'engines',
    title: 'Five hazard engines',
    text: 'Flood, earthquake, wildfire and landslide models in native units — depth, MMI, burn severity and susceptibility.',
  },
  {
    icon: 'livedata',
    title: 'Live geospatial data',
    text: 'Roads, buildings and facilities pulled per area from OpenStreetMap over 30m elevation terrain, spatially cached.',
  },
  {
    icon: 'impact',
    title: 'Street-level impact',
    text: 'Per-road closures with reasons, per-building damage states, exposed population and facilities at risk.',
  },
  {
    icon: 'routes',
    title: 'Evacuation routing',
    text: 'Safe paths computed on the open road network to the nearest operational shelter or hospital.',
  },
  {
    icon: 'ai',
    title: 'Grounded AI briefings',
    text: 'Natural-language scenarios in, evidence-bound analysis out. The model explains — physics decides.',
  },
  {
    icon: 'sat',
    title: 'Satellite vision & history',
    text: 'Object detection and change tracking over time, plus a full run history you can reopen and compare.',
  },
];

function FeatureIcon({ kind }: { kind: string }) {
  const size = 20;
  const color = '#8fa3bd';
  if (kind === 'engines') return <IconBolt size={size} color={color} />;
  if (kind === 'livedata') return <IconLocationPin size={size} color={color} />;
  if (kind === 'impact') return <IconRoad size={size} color={color} />;
  if (kind === 'routes') return <IconSatellite size={size} color={color} />;
  if (kind === 'ai') return <IconInsight size={size} color={color} />;
  return <IconFolder size={size} color={color} />;
}

export default function LandingPage({ onLaunch }: { onLaunch: () => void }) {
  // The app shell locks body scroll globally — release it while landing is mounted.
  useEffect(() => {
    document.documentElement.classList.add('lp-scroll');
    return () => document.documentElement.classList.remove('lp-scroll');
  }, []);

  return (
    <div className="dl-root">
      <BackdropGlobe />
      <div className="dl-scrim" aria-hidden="true" />

      <header className="dl-nav">
        <div className="dl-brand">
          <svg width="26" height="26" viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <path d="M16 3L4 9l12 6 12-6-12-6z" fill="#8fa3bd" />
            <path d="M4 15l12 6 12-6" stroke="#8fa3bd" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4 21l12 6 12-6" stroke="#5b6b82" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="dl-brand-name">TerraLab</span>
        </div>
        <nav className="dl-nav-links">
          <a href="#dl-how">How it works</a>
          <a href="#dl-features">Capabilities</a>
        </nav>
        <button className="dl-btn dl-btn--primary dl-btn--sm" onClick={onLaunch}>
          Open Application
        </button>
      </header>

      <main className="dl-hero">
        <div className="dl-hero-inner">
          <div className="dl-eyebrow">Real-World Impact Simulation & Research Platform</div>
          <h1 className="dl-title">TerraLab</h1>
          <p className="dl-tagline">
            Draw an area, investigate it with AI, simulate real-world scenarios, and generate
            evidence-based impact insights.
          </p>
          <div className="dl-cta-row">
            <button className="dl-btn dl-btn--primary" onClick={onLaunch}>
              Open Application
            </button>
            <a className="dl-btn dl-btn--ghost" href="#dl-how">
              How it works
            </a>
          </div>
        </div>
      </main>

      <section className="dl-section" id="dl-how">
        <div className="dl-section-inner">
          <div className="dl-tutorial-frame">
            <img
              className="dl-tutorial-img"
              alt="TerraLab tutorial — how to select an area, set a scenario, run and review"
              src="/tutorialimg.png"
              width={2170}
              height={725}
              loading="lazy"
            />
          </div>
        </div>
      </section>

      <section className="dl-section" id="dl-features">
        <div className="dl-section-inner">
          <h2>What the application does</h2>
          <p className="dl-section-sub">
            Draw an area, configure the physics, run the model, and act on the results.
          </p>
          <div className="dl-grid">
            {PLATFORM_FEATURES.map((f) => (
              <div className="dl-card" key={f.title}>
                <div className="dl-card-icon">
                  <FeatureIcon kind={f.icon} />
                </div>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="dl-footer">
        <span>TerraLab</span>
        <span className="dl-footer-note">Deterministic models · Authoritative sources</span>
      </footer>
    </div>
  );
}
