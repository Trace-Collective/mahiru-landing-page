import { useEffect, useMemo, useRef, useState } from "react";

const DEFAULT_ASPECT_RATIO = 2492 / 828;
const SECTION_WINDOWS = {
  hero: { start: 0, end: 0.33 },
  stats: { start: 0.32, end: 0.62 },
  systems: { start: 0.58, end: 1.02 },
};

const HUD_STOPS = [
  { label: "Hero", progress: 0.12 },
  { label: "Stats", progress: 0.46 },
  { label: "Systems", progress: 0.8 },
];

const METRICS = [
  { label: "WR", value: 67, decimals: 0, suffix: "%" },
  { label: "PF", value: 3.17, decimals: 2, suffix: "" },
  { label: "Sortino", value: 1.2, decimals: 2, suffix: "" },
  { label: "Backtest", value: 90, decimals: 0, suffix: "-Day" },
];

const HERO_BADGES = [
  "4H Decision Engine",
  "Adaptive Regime",
  "Perp Futures Agent",
];

const STRATEGY_CARDS = [
  {
    eyebrow: "Trending",
    threshold: "ADX > 22",
    title: "Breakout Signal",
    note: "Expansion capture on clean directional pressure.",
  },
  {
    eyebrow: "Ranging",
    threshold: "ADX < 22",
    title: "Mean Reversion",
    note: "Range fade when momentum cools and liquidity resets.",
  },
];

const ROADMAP_PHASES = [
  {
    phase: "Phase 01",
    title: "Social X",
    note: "Presence layer",
  },
  {
    phase: "Phase 02",
    title: "Web Platform",
    note: "Execution surface",
  },
  {
    phase: "Phase 03",
    title: "Buyback Mechanism",
    note: "Token sink",
  },
];

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function smoothstep(edge0, edge1, value) {
  const amount = clamp((value - edge0) / (edge1 - edge0 || 1), 0, 1);
  return amount * amount * (3 - 2 * amount);
}

function getPanelVisibility(progress, { start, end }) {
  const normalized = clamp((progress - start) / (end - start), 0, 1);
  const enter = start <= 0.001 ? 1 : smoothstep(0, 0.22, normalized);
  const exit = end >= 1 ? 1 : 1 - smoothstep(0.78, 1, normalized);
  return clamp(Math.min(enter, exit), 0, 1);
}

function getActiveSection(progress) {
  const scores = Object.entries(SECTION_WINDOWS).map(([key, range]) => ({
    key,
    visibility: getPanelVisibility(progress, range),
  }));

  scores.sort((left, right) => right.visibility - left.visibility);
  return scores[0].visibility > 0.16 ? scores[0].key : "hero";
}

function formatMetric(value, decimals, suffix) {
  if (decimals > 0) {
    return `${value.toFixed(decimals)}${suffix}`;
  }

  return `${Math.round(value)}${suffix}`;
}

function StatCounter({ label, value, decimals, suffix, started }) {
  const [displayValue, setDisplayValue] = useState(0);

  useEffect(() => {
    if (!started) {
      return undefined;
    }

    let frame = 0;
    const duration = 1600;
    const startTime = performance.now();

    const animate = (timestamp) => {
      const elapsed = timestamp - startTime;
      const progress = clamp(elapsed / duration, 0, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplayValue(value * eased);

      if (progress < 1) {
        frame = window.requestAnimationFrame(animate);
      }
    };

    frame = window.requestAnimationFrame(animate);

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [started, value]);

  return (
    <div className="metric-card">
      <span className="metric-label">{label}</span>
      <strong className="metric-value">
        {formatMetric(displayValue, decimals, suffix)}
      </strong>
    </div>
  );
}

function App() {
  const sceneRef = useRef(null);
  const videoRef = useRef(null);
  const measureRef = useRef(() => {});
  const animationFrameRef = useRef(0);
  const aspectRatioRef = useRef(DEFAULT_ASPECT_RATIO);

  const [sceneState, setSceneState] = useState({
    progress: 0,
    panX: 0,
    activeSection: "hero",
    countersStarted: false,
    videoReady: false,
  });
  const [mediaAspect, setMediaAspect] = useState(DEFAULT_ASPECT_RATIO);

  useEffect(() => {
    const sceneNode = sceneRef.current;
    if (!sceneNode) {
      return undefined;
    }

    const measureScene = () => {
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const sceneTop = sceneNode.getBoundingClientRect().top + window.scrollY;
      const scrollRange = Math.max(sceneNode.offsetHeight - viewportHeight, 1);
      const scrolled = clamp(window.scrollY - sceneTop, 0, scrollRange);
      const progress = clamp(scrolled / scrollRange, 0, 1);
      const renderedWidth = Math.max(
        viewportWidth,
        viewportHeight * aspectRatioRef.current,
      );
      const overflowX = Math.max(0, renderedWidth - viewportWidth);
      const panX = overflowX * progress;
      const activeSection = getActiveSection(progress);

      setSceneState((current) => {
        if (
          Math.abs(current.progress - progress) < 0.0008 &&
          Math.abs(current.panX - panX) < 0.5 &&
          current.activeSection === activeSection
        ) {
          return current;
        }

        return {
          ...current,
          progress,
          panX,
          activeSection,
        };
      });
    };

    const requestMeasure = () => {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = window.requestAnimationFrame(measureScene);
    };

    measureRef.current = requestMeasure;
    requestMeasure();

    const handleScroll = () => {
      requestMeasure();
    };

    const resizeObserver = new ResizeObserver(() => {
      requestMeasure();
    });

    resizeObserver.observe(sceneNode);
    window.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", requestMeasure);

    return () => {
      window.cancelAnimationFrame(animationFrameRef.current);
      resizeObserver.disconnect();
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", requestMeasure);
    };
  }, []);

  useEffect(() => {
    const videoNode = videoRef.current;
    if (!videoNode) {
      return undefined;
    }

    const markReady = () => {
      if (videoNode.readyState < 2) {
        return;
      }

      setSceneState((current) => (
        current.videoReady
          ? current
          : {
              ...current,
              videoReady: true,
            }
      ));
      measureRef.current();
    };

    const attemptPlayback = () => {
      const playResult = videoNode.play();
      if (playResult && typeof playResult.catch === "function") {
        playResult.catch(() => {});
      }
    };

    markReady();
    attemptPlayback();

    videoNode.addEventListener("loadeddata", markReady);
    videoNode.addEventListener("canplay", markReady);
    videoNode.addEventListener("playing", markReady);

    const timer = window.setInterval(markReady, 600);

    return () => {
      window.clearInterval(timer);
      videoNode.removeEventListener("loadeddata", markReady);
      videoNode.removeEventListener("canplay", markReady);
      videoNode.removeEventListener("playing", markReady);
    };
  }, []);

  useEffect(() => {
    if (
      sceneState.activeSection === "stats" &&
      !sceneState.countersStarted
    ) {
      setSceneState((current) => ({
        ...current,
        countersStarted: true,
      }));
    }
  }, [sceneState.activeSection, sceneState.countersStarted]);

  const heroVisibility = useMemo(
    () => getPanelVisibility(sceneState.progress, SECTION_WINDOWS.hero),
    [sceneState.progress],
  );
  const statsVisibility = useMemo(
    () => getPanelVisibility(sceneState.progress, SECTION_WINDOWS.stats),
    [sceneState.progress],
  );
  const systemsVisibility = useMemo(
    () => getPanelVisibility(sceneState.progress, SECTION_WINDOWS.systems),
    [sceneState.progress],
  );

  const onVideoMetadata = (event) => {
    const ratio =
      event.currentTarget.videoWidth / event.currentTarget.videoHeight ||
      DEFAULT_ASPECT_RATIO;
    aspectRatioRef.current = ratio;
    setMediaAspect(ratio);
    measureRef.current();
  };

  const onVideoReady = () => {
    setSceneState((current) => (
      current.videoReady
        ? current
        : {
            ...current,
            videoReady: true,
          }
    ));
    measureRef.current();
  };

  const onVideoError = () => {
    setSceneState((current) => ({
      ...current,
      videoReady: false,
    }));
  };

  return (
    <main className="page-shell">
      <section className="experience" ref={sceneRef}>
        <div className="sticky-scene">
          <div
            className={`ambient-fallback ${sceneState.videoReady ? "is-muted" : ""}`}
            aria-hidden="true"
          />
          <div
            className="media-track"
            style={{
              transform: `translate3d(-${sceneState.panX}px, 0, 0)`,
              "--media-aspect": mediaAspect,
            }}
          >
            <video
              ref={videoRef}
              className={`room-video ${sceneState.videoReady ? "is-ready" : ""}`}
              src="/media/dg-mahiru-room-loop.mp4"
              autoPlay
              loop
              muted
              playsInline
              preload="auto"
              onLoadedMetadata={onVideoMetadata}
              onLoadedData={onVideoReady}
              onCanPlay={onVideoReady}
              onError={onVideoError}
            />
          </div>
          <div className="scene-gradient" aria-hidden="true" />
          <div className="scene-vignette" aria-hidden="true" />
          <div className="scene-noise" aria-hidden="true" />

          <header className="scene-chrome">
            <div className="chrome-brand">
              <span className="chrome-kicker">Panoramic Sequence</span>
              <strong>DGMAHIRU Command Room</strong>
            </div>
            <div className="chrome-progress" aria-label="Scene progress">
              {HUD_STOPS.map((stop) => (
                <div
                  className={`progress-stop ${
                    sceneState.progress >= stop.progress ? "is-passed" : ""
                  }`}
                  key={stop.label}
                >
                  <span>{stop.label}</span>
                </div>
              ))}
            </div>
          </header>

          <div className="scroll-hint">
            <span className="hint-label">Scroll to traverse the room</span>
            <span className="hint-value">
              {Math.round(sceneState.progress * 100)}%
            </span>
          </div>

          <div className="overlay-layer">
            <section
              className="floating-panel hero-panel"
              style={{
                opacity: heroVisibility,
                transform: `translate3d(0, ${28 - heroVisibility * 28}px, 0) scale(${
                  0.94 + heroVisibility * 0.06
                })`,
                filter: `blur(${(1 - heroVisibility) * 14}px)`,
              }}
            >
              <div className="panel-header">
                <span className="panel-tag">City Window / Entry Sequence</span>
                <span className="panel-chip">Neon Entry</span>
              </div>
              <div className="hero-stack">
                <h1>$DGMAHIRU</h1>
                <p className="hero-copy">
                  Autonomous Perpetual Futures Trading Agent
                </p>
              </div>
              <div className="hero-badges" aria-hidden="true">
                {HERO_BADGES.map((badge) => (
                  <span className="hero-note" key={badge}>
                    {badge}
                  </span>
                ))}
              </div>
              <div className="hero-actions">
                <button
                  type="button"
                  className="cta-button"
                  aria-disabled="true"
                >
                  View Leaderboard
                </button>
                <span className="cta-meta">Link pending</span>
              </div>
            </section>

            <section
              className="floating-panel stats-panel"
              style={{
                opacity: statsVisibility,
                transform: `translate3d(-50%, ${
                  36 - statsVisibility * 36
                }px, 0) scale(${0.92 + statsVisibility * 0.08})`,
                filter: `blur(${(1 - statsVisibility) * 16}px)`,
              }}
            >
              <div className="panel-header">
                <span className="panel-tag">Trading Desk / 90-Day Snapshot</span>
                <span className="panel-chip">Desk Metrics</span>
              </div>
              <div className="stats-copy">
                <h2>Backtest Signals</h2>
                <p>
                  Compact leaderboard metrics surfaced at the desk while the
                  camera settles into the center lane.
                </p>
              </div>
              <div className="stats-grid">
                {METRICS.map((metric) => (
                  <StatCounter
                    key={metric.label}
                    started={sceneState.countersStarted}
                    {...metric}
                  />
                ))}
              </div>
            </section>

            <section
              className="floating-panel systems-panel"
              style={{
                opacity: systemsVisibility,
                transform: `translate3d(0, ${
                  42 - systemsVisibility * 42
                }px, 0) scale(${0.94 + systemsVisibility * 0.06})`,
                filter: `blur(${(1 - systemsVisibility) * 18}px)`,
              }}
            >
              <div className="panel-header">
                <span className="panel-tag">Strategy Matrix / Bookshelf Timeline</span>
                <span className="panel-chip">Final Pass</span>
              </div>
              <div className="systems-header">
                <div>
                  <h2>How It Works</h2>
                  <p>
                    Trending markets route to breakout logic, ranging markets
                    route to mean reversion, and the same module keeps the
                    rollout visible in the bookshelf zone.
                  </p>
                </div>
              </div>

              <div className="strategy-cards">
                {STRATEGY_CARDS.map((card) => (
                  <article className="logic-card" key={card.title}>
                    <span className="logic-eyebrow">{card.eyebrow}</span>
                    <strong>{card.threshold}</strong>
                    <span className="logic-title">{card.title}</span>
                    <p>{card.note}</p>
                  </article>
                ))}
              </div>

              <div className="roadmap-block">
                <div className="roadmap-head">
                  <h3>Roadmap</h3>
                  <span className="roadmap-kicker">3-Phase Rollout</span>
                </div>
                <div className="roadmap-line" aria-hidden="true" />
                <div className="roadmap-grid">
                  {ROADMAP_PHASES.map((phase) => (
                    <article className="roadmap-item" key={phase.title}>
                      <span className="phase-index">{phase.phase}</span>
                      <strong>{phase.title}</strong>
                      <p>{phase.note}</p>
                    </article>
                  ))}
                </div>
              </div>
            </section>
          </div>
        </div>
      </section>
    </main>
  );
}

export default App;
