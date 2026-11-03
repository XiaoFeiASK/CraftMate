import { useState } from "react";
import { useControlLink } from "./lib/use-control-link.ts";
import { TitleBar } from "./components/layout/TitleBar.tsx";
import { Sidebar } from "./components/layout/Sidebar.tsx";
import { LiveHero } from "./components/scene/LiveHero.tsx";
import { OperationsDrawer, type DrawerMode } from "./components/operations/OperationsDrawer.tsx";
import { usePreferences } from "./lib/preferences.ts";

export function App(): React.JSX.Element {
  const {
    state,
    snapshot,
    mode,
    personaName,
    settings,
    sendComment,
    sendOperator,
    saveSettings,
    simulateBurst,
  } = useControlLink();
  const { preferences, update, reset } = usePreferences();
  const [drawer, setDrawer] = useState<DrawerMode | null>(null);

  return (
    <div className="app">
      <TitleBar
        view={drawer}
        state={state}
        mode={mode}
        settings={settings}
        onSelect={setDrawer}
      />
      <div className="app__workspace">
        <Sidebar
          drawer={drawer}
          state={state}
          mode={mode}
          personaName={personaName}
          settings={settings}
          sourceHealth={snapshot.sourceHealth}
          stats={snapshot.stats}
          onSelect={setDrawer}
        />
        <LiveHero reduceMotion={preferences.reduceMotion} />
      </div>

      {drawer ? (
        <OperationsDrawer
          mode={drawer}
          state={state}
          showMode={mode}
          personaName={personaName}
          snapshot={snapshot}
          settings={settings}
          preferences={preferences}
          onClose={() => setDrawer(null)}
          onComment={sendComment}
          onOperator={sendOperator}
          onBurst={simulateBurst}
          onSaveSettings={saveSettings}
          onPreferences={update}
          onResetPreferences={reset}
        />
      ) : null}
    </div>
  );
}
