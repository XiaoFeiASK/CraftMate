import { useState } from "react";
import { useControlLink } from "./lib/use-control-link.ts";
import { TitleBar } from "./components/layout/TitleBar.tsx";
import { Sidebar } from "./components/layout/Sidebar.tsx";
import { AgentWorkbench } from "./components/workbench/AgentWorkbench.tsx";
import { OperationsPage, type WorkspaceView } from "./components/operations/OperationsPage.tsx";
import { usePreferences } from "./lib/preferences.ts";

export function App(): React.JSX.Element {
  const {
    state,
    snapshot,
    mode,
    personaName,
    settings,
    integrations,
    integrationRevision,
    modelCatalog,
    modelCatalogPending,
    resetActivity,
    lastError,
    subtitles,
    ops,
    timeline,
    timelineTraceId,
    timelinePending,
    worldEvents,
    telemetry,
    sendComment,
    sendOperator,
    saveSettings,
    saveIntegrationSettings,
    fetchModels,
    speak,
    approveMemory,
    rejectMemory,
    forgetMemory,
    updateWorldMemory,
    forgetWorldMemory,
    forgetStrategyMemory,
    forgetRouteBlacklist,
    activatePersona,
    lookupTrace,
    setGoal,
    pauseGoal,
    resumeGoal,
    decideProposal,
  } = useControlLink();
  const { preferences, update, reset } = usePreferences();
  const [view, setView] = useState<WorkspaceView | null>(null);

  return (
    <div className="app">
      <TitleBar
        view={view}
        state={state}
        mode={mode}
        settings={settings}
        snapshot={snapshot}
        onSelect={setView}
      />
      <div className="app__workspace">
        <Sidebar
          view={view}
          state={state}
          mode={mode}
          personaName={personaName}
          settings={settings}
          sourceHealth={snapshot.sourceHealth}
          stats={snapshot.stats}
          voiceStatus={snapshot.voiceStatus}
          goal={snapshot.goal}
          onSelect={setView}
          onResetActivity={resetActivity}
        />
        {view === null ? (
          <AgentWorkbench
            state={state}
            snapshot={snapshot}
            telemetry={telemetry}
            worldEvents={worldEvents}
            personaName={personaName}
            disabled={state !== "open"}
            onComment={sendComment}
            onOperator={sendOperator}
            onDecideProposal={decideProposal}
            onLookupTrace={(traceId) => {
              lookupTrace(traceId);
              setView("replay");
            }}
          />
        ) : (
          <OperationsPage
            mode={view}
            state={state}
            showMode={mode}
            personaName={personaName}
            snapshot={snapshot}
            lastError={lastError}
            subtitles={subtitles}
            settings={settings}
            integrations={integrations}
            integrationRevision={integrationRevision}
            modelCatalog={modelCatalog}
            modelCatalogPending={modelCatalogPending}
            preferences={preferences}
            onSpeak={speak}
            onSaveSettings={saveSettings}
            onSaveIntegrationSettings={saveIntegrationSettings}
            onFetchModels={fetchModels}
            onPreferences={update}
            onResetPreferences={reset}
            ops={ops}
            timeline={timeline}
            timelinePending={timelinePending}
            onApproveMemory={approveMemory}
            onRejectMemory={rejectMemory}
            onForgetMemory={forgetMemory}
            onUpdateWorldMemory={updateWorldMemory}
            onForgetWorldMemory={forgetWorldMemory}
            onForgetStrategyMemory={forgetStrategyMemory}
            onForgetRouteBlacklist={forgetRouteBlacklist}
            onActivatePersona={activatePersona}
            onLookupTrace={lookupTrace}
            onSetGoal={setGoal}
            onPauseGoal={pauseGoal}
            onResumeGoal={resumeGoal}
          />
        )}
      </div>
    </div>
  );
}
