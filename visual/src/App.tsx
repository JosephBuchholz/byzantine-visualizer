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
          <Panel defaultSize="25%" minSize="20%" className="bg-side-panel">
            <p className="text-text m-2 font-primary">Some controls over here</p>
            <p className="text-secondary m-2 font-primary">Some controls over here</p>
            <p className="text-accent m-2 font-primary">Some controls over here</p>
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
