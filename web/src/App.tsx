import { Chat } from "./components/Chat";
import { Playground } from "./Playground";

function App() {
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo")) {
    return <Playground />;
  }
  return <Chat />;
}

export default App;
