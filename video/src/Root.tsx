import { Composition } from "remotion";
import { DexDemo } from "./DexDemo";

export const Root = () => (
  <Composition
    id="DexDemo"
    component={DexDemo}
    durationInFrames={1800}
    fps={30}
    width={1920}
    height={1080}
    defaultProps={{ clipPlaybackRate: 1 }}
  />
);
