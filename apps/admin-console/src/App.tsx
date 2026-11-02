import { useState } from "react";
import { useControlLink } from "./lib/use-control-link.ts";
import { TitleBar } from "./components/layout/TitleBar.tsx";
import { Sidebar } from "./components/layout/Sidebar.tsx";
import { LiveHero } from "./components/scene/LiveHero.tsx";
import { OperationsDrawer, type DrawerMode } from "./components/operations/OperationsDrawer.tsx";

const TARGET = "盖一间带床和箱子的海崖小屋";

export function App(): React.JSX.Element {
  const { state, snapshot, mode, personaName, sendComment, sendOperator, simulateBurst } = useControlLink();
  const [drawer, setDrawer] = useState<DrawerMode | null>(null);

  return (
    <div className="app">
      <TitleBar view={drawer} onSelect={setDrawer} />
      <div className="app__workspace">
        <Sidebar
          drawer={drawer}
          state={state}
          mode={mode}
          personaName={personaName}
          sourceHealth={snapshot.sourceHealth}
          onSelect={setDrawer}
        />
        <LiveHero
          state={state}
          mode={mode}
          personaName={personaName}
          stats={snapshot.stats}
          target={TARGET}
          onOpenConsole={() => setDrawer("decisions")}
        />
      </div>

      {drawer ? (
        <OperationsDrawer
          mode={drawer}
          state={state}
          showMode={mode}
          personaName={personaName}
          snapshot={snapshot}
          onClose={() => setDrawer(null)}
          onComment={sendComment}
          onOperator={sendOperator}
          onBurst={simulateBurst}
        />
      ) : null}
    </div>
  );
}
