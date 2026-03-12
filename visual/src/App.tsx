import { Group, Panel, Separator } from "react-resizable-panels";
import Canvas from "./components/Canvas";
import Header from "./components/Header";
import ThemeProvider from "./contexts/ThemeProvider";

export default function App() {
  return (
    <ThemeProvider>
      <Header></Header>
      <div>
        <Group>
          <Panel defaultSize="50%" minSize="25%" className="bg-side-panel">
            <p className="text-text m-2">Some controls over here</p>
          </Panel>

          <Separator />

          <Panel minSize="25%" className="bg-background">
            <Canvas></Canvas>
          </Panel>
        </Group>
      </div>
    </ThemeProvider>
  );
}
