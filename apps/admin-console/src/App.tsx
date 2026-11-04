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
    integrations,
    lastError,
    subtitles,
    ops,
    timeline,
    timelinePending,
    worldEvents,
    sendComment,
    sendOperator,
    saveSettings,
    saveIntegrationSettings,
    speak,
    approveMemory,
    rejectMemory,
    forgetMemory,
    activatePersona,
    lookupTrace,
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
        snapshot={snapshot}
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
          voiceStatus={snapshot.voiceStatus}
          onSelect={setDrawer}
        />
        <LiveHero
          reduceMotion={preferences.reduceMotion}
          bridge={snapshot.bridge}
        />
      </div>

      {drawer ? (
        <OperationsDrawer
          mode={drawer}
          state={state}
          showMode={mode}
          personaName={personaName}
          snapshot={snapshot}
          lastError={lastError}
          subtitles={subtitles}
          settings={settings}
          integrations={integrations}
          preferences={preferences}
          onClose={() => setDrawer(null)}
          onComment={sendComment}
          onOperator={sendOperator}
          onSpeak={speak}
          onSaveSettings={saveSettings}
          onSaveIntegrationSettings={saveIntegrationSettings}
          onPreferences={update}
          onResetPreferences={reset}
          ops={ops}
          timeline={timeline}
          timelinePending={timelinePending}
          worldEvents={worldEvents}
          onApproveMemory={approveMemory}
          onRejectMemory={rejectMemory}
          onForgetMemory={forgetMemory}
          onActivatePersona={activatePersona}
          onLookupTrace={lookupTrace}
        />
      ) : null}
    </div>
  );
}
