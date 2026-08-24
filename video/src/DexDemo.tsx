import React from "react";
import {
  AbsoluteFill,
  interpolate,
  OffthreadVideo,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

export type DexDemoProps = { clipPlaybackRate: number };

const BLUE = "#2f6fff";

const Statement = ({ first, second, from, to }: { first: string; second: string; from: number; to: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const local = frame - from;
  const enter = spring({ frame: local, fps, config: { damping: 28, stiffness: 140, mass: 0.8 } });
  const exit = interpolate(frame, [to - 8, to], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{
      position: "absolute", left: 110, top: 320, width: 820,
      opacity: enter * exit,
      transform: `translateY(${20 * (1 - enter)}px) scale(${0.98 + enter * 0.02})`,
    }}>
      <div style={{ fontSize: 82, lineHeight: 1.02, letterSpacing: -4.4, fontWeight: 720, color: "#fff" }}>{first}</div>
      <div style={{ fontSize: 82, lineHeight: 1.02, letterSpacing: -4.4, fontWeight: 720, color: BLUE, marginTop: 8 }}>{second}</div>
    </div>
  );
};

const Demo = () => {
  const frame = useCurrentFrame();
  const phoneEnter = spring({ frame, fps: 30, config: { damping: 30, stiffness: 120 } });
  const statements = [
    [0, 230, "One text.", "A fresh Codex session."],
    [230, 500, "Dex watches the work.", "And the machine."],
    [500, 830, "Battery at 8%.", "Dex acts before it fails."],
    [830, 1260, "You answer once.", "The task moves to cloud."],
  ] as const;
  return (
    <AbsoluteFill style={{
      background: "#080a0f",
      color: "white",
      fontFamily: "Inter, Geist, SF Pro Display, Helvetica Neue, Arial, sans-serif",
      overflow: "hidden",
    }}>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(circle at 78% 45%, rgba(47,111,255,.16), transparent 38%)" }} />
      <div style={{ position: "absolute", left: 110, top: 78, display: "flex", alignItems: "center", gap: 14, fontSize: 26, fontWeight: 680 }}>
        <span style={{ width: 12, height: 12, borderRadius: 99, background: "#34c759" }} />
        DEX · LIVE
      </div>
      {statements.map(([from, to, first, second]) => <Statement key={first} from={from} to={to} first={first} second={second} />)}
      <div style={{ position: "absolute", left: 112, bottom: 86, font: "500 19px ui-monospace, SFMono-Regular, Menlo, monospace", color: "#8f96a5", letterSpacing: 1 }}>
        iMESSAGE → CODEX / LOCAL → CODEX / MODAL
      </div>
      <div style={{
        position: "absolute", right: 128, top: 44, width: 452, height: 980,
        padding: 9, borderRadius: 58, background: "#000", border: "1px solid #353944",
        boxShadow: "0 28px 90px rgba(0,0,0,.55)",
        opacity: phoneEnter, transform: `translateY(${20 * (1 - phoneEnter)}px)`,
      }}>
        <div style={{ width: "100%", height: "100%", borderRadius: 49, overflow: "hidden", background: "#000" }}>
          <OffthreadVideo src={staticFile("dex-demo.mov")} muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        </div>
      </div>
    </AbsoluteFill>
  );
};

const Continuity = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 30, stiffness: 120 } });
  return (
    <AbsoluteFill style={{ background: "#080a0f", color: "white", fontFamily: "Inter, Geist, SF Pro Display, Helvetica Neue, Arial, sans-serif" }}>
      <div style={{ position: "absolute", left: 110, top: 85, fontSize: 25, fontWeight: 680 }}>DEX · CONTINUITY</div>
      <div style={{ position: "absolute", left: 110, top: 325, opacity: enter, transform: `translateY(${20 * (1 - enter)}px)` }}>
        <div style={{ fontSize: 84, lineHeight: 1.02, letterSpacing: -4.5, fontWeight: 720 }}>The session changed.</div>
        <div style={{ fontSize: 84, lineHeight: 1.02, letterSpacing: -4.5, fontWeight: 720, color: BLUE, marginTop: 8 }}>The task didn’t.</div>
      </div>
      <div style={{ position: "absolute", left: 112, bottom: 120, display: "flex", alignItems: "center", gap: 26, font: "500 22px ui-monospace, SFMono-Regular, Menlo, monospace", color: "#a8afbc" }}>
        <span>code</span><span style={{ color: BLUE }}>—</span><span>memory</span><span style={{ color: BLUE }}>—</span><span>failed approaches</span><span style={{ color: BLUE }}>—</span><span>tests</span>
      </div>
    </AbsoluteFill>
  );
};

const End = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 14, 220, 239], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: "#f5f5f2", color: "#111", fontFamily: "Inter, Geist, SF Pro Display, Helvetica Neue, Arial, sans-serif", display: "grid", placeItems: "center", opacity }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 75, lineHeight: 1.06, letterSpacing: -4, fontWeight: 700 }}>The agents are disposable.<br />Dex isn’t.</div>
        <div style={{ marginTop: 48, fontSize: 24, color: "#5c5c59" }}>github.com/shahdadk/dex</div>
      </div>
    </AbsoluteFill>
  );
};

export const DexDemo = (_props: DexDemoProps) => (
  <AbsoluteFill style={{ background: "#080a0f" }}>
    <Sequence from={0} durationInFrames={1260}><Demo /></Sequence>
    <Sequence from={1260} durationInFrames={300}><Continuity /></Sequence>
    <Sequence from={1560} durationInFrames={240}><End /></Sequence>
  </AbsoluteFill>
);
