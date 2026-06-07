import { AuthGate } from "./components/AuthGate";
import { Playground } from "./Playground";

function App() {
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo")) {
    return <Playground />;
  }
  return <AuthGate />;
}

export default App;
