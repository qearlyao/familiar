import { AuthGate } from "./components/AuthGate";
import { GalleryAudioDrafts } from "./GalleryAudioDrafts";
import { GalleryDemo } from "./GalleryDemo";
import { Playground } from "./Playground";

function App() {
  if (typeof window !== "undefined") {
    const demo = new URLSearchParams(window.location.search).get("demo");
    if (demo === "gallery") return <GalleryDemo />;
    if (demo === "audio") return <GalleryAudioDrafts />;
    if (demo !== null) return <Playground />;
  }
  return <AuthGate />;
}

export default App;
