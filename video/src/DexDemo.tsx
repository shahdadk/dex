import React from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  OffthreadVideo,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

export type DexDemoProps = { clipPlaybackRate: number };

const C = {
  ink: "#F6F7FB",
  muted: "#9DA8BA",
  bg: "#07090E",
  panel: "#111621",
  line: "#263143",
  blue: "#5D8CFF",
  cyan: "#47D7C7",
  amber: "#FFB454",
};

const fade = (frame: number, start: number, end: number) =>
  interpolate(frame, [start, start + 18, end - 18, end], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

const Badge = ({ children, color = C.cyan }: { children: React.ReactNode; color?: string }) => (
  <div style={{
    display: "inline-flex", alignItems: "center", gap: 12, padding: "11px 18px",
    border: `1px solid ${color}55`, borderRadius: 999, color, background: `${color}12`,
    fontSize: 22, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase",
  }}><span style={{ width: 9, height: 9, borderRadius: 9, background: color, boxShadow: `0 0 18px ${color}` }} />{children}</div>
);

const Brand = () => (
  <div style={{ position: "absolute", top: 54, left: 66, display: "flex", alignItems: "center", gap: 16 }}>
    <div style={{ width: 46, height: 46, borderRadius: 14, display: "grid", placeItems: "center", background: C.ink, color: C.bg, fontWeight: 950, fontSize: 27 }}>D</div>
    <div style={{ color: C.ink, fontSize: 29, fontWeight: 800, letterSpacing: -0.8 }}>Dex</div>
  </div>
);

const Intro = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 18, stiffness: 95 } });
  return <AbsoluteFill style={{ background: C.bg, color: C.ink, fontFamily: "Inter, SF Pro Display, system-ui" }}>
    <Brand />
    <div style={{ position: "absolute", inset: 0, background: "radial-gradient(circle at 72% 35%, #17305A88 0, transparent 38%)" }} />
    <div style={{ margin: "auto 170px", transform: `translateY(${(1 - enter) * 50}px)`, opacity: enter }}>
      <Badge>your persistent developer</Badge>
      <div style={{ fontSize: 106, lineHeight: .96, letterSpacing: -6, fontWeight: 900, marginTop: 35, maxWidth: 1250 }}>
        Text Dex<br /><span style={{ color: C.blue }}>Get software built</span>
      </div>
      <div style={{ color: C.muted, fontSize: 34, marginTop: 38 }}>One message in. Disposable agents underneath. Durable outcomes out.</div>
    </div>
  </AbsoluteFill>;
};

const LiveClip = ({ clipPlaybackRate }: DexDemoProps) => {
  const frame = useCurrentFrame();
  const appear = spring({ frame, fps: 30, config: { damping: 18, stiffness: 110 } });
  const steps = [
    ["01", "Text Dex", "one short request", C.blue],
    ["02", "Codex starts", "fresh local worker", C.cyan],
    ["03", "Dex notices", "battery at 8%", C.amber],
    ["04", "Cloud handoff", "task identity survives", C.blue],
  ] as const;
  return <AbsoluteFill style={{ background: C.bg, color: C.ink, fontFamily: "Inter, SF Pro Display, system-ui" }}>
    <Brand />
    <div style={{ position: "absolute", top: 150, left: 110, width: 700 }}>
      <Badge color={C.blue}>live product</Badge>
      <div style={{ fontSize: 70, lineHeight: 1.02, letterSpacing: -3.5, fontWeight: 880, marginTop: 28 }}>The phone is<br />the dashboard</div>
      <div style={{ display: "grid", gap: 18, marginTop: 48 }}>
        {steps.map(([num, title, detail, color], i) => {
          const active = frame > 80 + i * 180;
          return <div key={num} style={{ display: "grid", gridTemplateColumns: "56px 1fr", gap: 18, opacity: active ? 1 : .28, transform: `translateX(${active ? 0 : -16}px)` }}>
            <div style={{ width: 48, height: 48, borderRadius: 15, display: "grid", placeItems: "center", border: `1px solid ${color}66`, color, fontWeight: 800 }}>{num}</div>
            <div><div style={{ fontSize: 28, fontWeight: 780 }}>{title}</div><div style={{ fontSize: 21, color: C.muted, marginTop: 3 }}>{detail}</div></div>
          </div>;
        })}
      </div>
    </div>
    <div style={{
      position: "absolute", right: 150, top: 90, width: 535, height: 900,
      borderRadius: 66, padding: 18, background: "#020307", border: "2px solid #394153",
      boxShadow: "0 50px 130px #000, 0 0 80px #335CA733", transform: `scale(${.92 + appear * .08})`, opacity: appear,
    }}>
      <div style={{ width: "100%", height: "100%", borderRadius: 48, overflow: "hidden", background: "#000" }}>
        <OffthreadVideo src={staticFile("dex-demo.mov")} playbackRate={clipPlaybackRate} muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
    </div>
  </AbsoluteFill>;
};

const Handoff = () => {
  const frame = useCurrentFrame();
  const progress = interpolate(frame, [45, 280], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) });
  const nodes = [
    { x: 180, title: "Codex", sub: "local Mac", color: C.cyan },
    { x: 760, title: "Dex", sub: "code + memory + failures", color: C.blue },
    { x: 1340, title: "Codex", sub: "Modal cloud", color: C.amber },
  ];
  return <AbsoluteFill style={{ background: C.bg, color: C.ink, fontFamily: "Inter, SF Pro Display, system-ui" }}>
    <Brand />
    <div style={{ position: "absolute", top: 150, width: "100%", textAlign: "center" }}>
      <Badge>semantic continuity</Badge>
      <div style={{ fontSize: 68, fontWeight: 880, letterSpacing: -3, marginTop: 28 }}>The worker changes. The task doesn't.</div>
    </div>
    <div style={{ position: "absolute", top: 540, left: 320, width: 1280, height: 4, background: C.line }}>
      <div style={{ width: `${progress * 100}%`, height: 4, background: `linear-gradient(90deg, ${C.cyan}, ${C.blue}, ${C.amber})`, boxShadow: `0 0 25px ${C.blue}` }} />
    </div>
    {nodes.map((node, i) => {
      const visible = progress >= i / 2 || i === 0;
      return <div key={node.title + node.sub} style={{ position: "absolute", left: node.x, top: 445, width: 400, textAlign: "center", opacity: visible ? 1 : .22, transform: `scale(${visible ? 1 : .9})` }}>
        <div style={{ margin: "auto", width: 130, height: 130, borderRadius: 38, display: "grid", placeItems: "center", background: C.panel, border: `2px solid ${node.color}`, boxShadow: visible ? `0 0 55px ${node.color}33` : "none", fontSize: 42, fontWeight: 900 }}>{i === 1 ? "D" : "<>"}</div>
        <div style={{ fontSize: 34, fontWeight: 820, marginTop: 24 }}>{node.title}</div>
        <div style={{ color: C.muted, fontSize: 21, marginTop: 8 }}>{node.sub}</div>
      </div>;
    })}
  </AbsoluteFill>;
};

const Outro = () => {
  const frame = useCurrentFrame();
  const scale = spring({ frame, fps: 30, config: { damping: 20, stiffness: 90 } });
  return <AbsoluteFill style={{ background: C.bg, color: C.ink, fontFamily: "Inter, SF Pro Display, system-ui", display: "grid", placeItems: "center" }}>
    <div style={{ textAlign: "center", transform: `scale(${.94 + scale * .06})`, opacity: scale }}>
      <div style={{ color: C.muted, fontSize: 36, marginBottom: 25 }}>The agents are disposable</div>
      <div style={{ fontSize: 104, fontWeight: 920, letterSpacing: -6 }}>Dex isn't</div>
      <div style={{ marginTop: 50, color: C.blue, fontSize: 28, fontWeight: 700 }}>github.com/shahdadk/dex</div>
    </div>
  </AbsoluteFill>;
};

export const DexDemo = ({ clipPlaybackRate }: DexDemoProps) => {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{ background: C.bg }}>
    <Sequence from={0} durationInFrames={300}><div style={{ width: "100%", height: "100%", opacity: fade(frame, 0, 300) }}><Intro /></div></Sequence>
    <Sequence from={300} durationInFrames={900}><LiveClip clipPlaybackRate={clipPlaybackRate} /></Sequence>
    <Sequence from={1200} durationInFrames={360}><Handoff /></Sequence>
    <Sequence from={1560} durationInFrames={240}><Outro /></Sequence>
  </AbsoluteFill>;
};
