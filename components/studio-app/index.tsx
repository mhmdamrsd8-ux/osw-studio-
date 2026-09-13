'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Project } from '@/lib/vfs/types';
import { vfs } from '@/lib/vfs';
import { Workspace } from '@/components/workspace';
import { useWorkspaceStore } from '@/lib/stores/workspace';
import { ViewModeProvider, useStudioView } from '@/components/view-mode-provider';
import { STUDIO_ONLY_VIEWS } from '@/components/sidebar';
import { GuidedTourProvider, useGuidedTour } from '@/components/guided-tour/context';
import { GuidedTourOverlay } from '@/components/guided-tour/overlay';
import { PageLayout } from '@/components/page-layout';
import { ContentArea } from '@/components/views/content-area';
import { AboutModal } from '@/components/about-modal';
import { oauthHandleRedirectIfPresent } from '@/lib/auth/hf-auth';
import { configManager } from '@/lib/config/storage';
import { activateProviderAsGlobalDefault } from '@/lib/llm/models/global-auto-assign';
import { shouldAutoAssignAgent } from '@/lib/llm/models/project-assignment';
import { toast } from 'sonner';
import { track } from '@/lib/telemetry';
import { TelemetryBootstrap } from '@/components/telemetry-bootstrap';
import { GenerationShelf } from '@/components/generation-shelf';
import { shouldAutoCreateFirstProject } from '@/lib/first-run';
import { useProviderAutoAssign } from '@/lib/hooks/use-provider-auto-assign';
import { useModelConfigSignal } from '@/lib/hooks/use-model-config-signal';
import { createProjectFromTemplate } from '@/lib/vfs/templates/utils';
import { BAREBONES_PROJECT_TEMPLATE } from '@/lib/vfs/templates/barebones';
import { Spinner } from '@/components/ui/spinner';

// Module-level guard: prevents double token exchange when React strict mode
// re-runs the effect, or if the component remounts before URL cleanup.
let oauthExchangeInFlight = false;

// Module-level guard: the first-run auto-create check runs at most once per page load,
// even if React strict mode re-runs the effect or the component remounts.
let firstRunCheckDone = false;

function StudioInner() {
  const searchParams = useSearchParams();
  const docParam = searchParams.get('doc');
  const projectParam = searchParams.get('project');

  const studioView = useStudioView();
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  /** True while a `?project=` link resolves, so the view it landed on does not render first. */
  const [restoringProject, setRestoringProject] = useState(() => !!projectParam);
  const [currentView, setCurrentView] = useState<'dashboard' | 'projects' | 'deployments' | 'templates' | 'skills' | 'interviews' | 'docs' | 'settings'>('dashboard');
  const [autoCreateProject, setAutoCreateProject] = useState(false);
  const [showAboutModal, setShowAboutModal] = useState(false);
  const { state, setActiveProjectId, start: startTour } = useGuidedTour();

  const settingsParam = searchParams.get('settings');

  // Global model auto-assign on provider connect. Mounted here (always-present root) so the
  // Connections UI works both inside and outside a workspace (dashboard -> Settings -> Connections).
  useProviderAutoAssign();

  // Reactive model-config signal + one-time model migration. Mounted here (always-present root)
  // so ANY ChatPanel (workspace, describe-mode, project-manager) reacts to model picks.
  useModelConfigSignal();

  function writeProjectParam(id: string) {
    const url = new URL(window.location.href);
    url.searchParams.set('project', id);
    window.history.pushState({}, '', url.toString());
  }
  function clearProjectParam() {
    const url = new URL(window.location.href);
    url.searchParams.delete('project');
    window.history.replaceState({}, '', url.toString());
  }

  // Sync URL params with view state
  useEffect(() => {
    if (docParam) {
      // If ?doc= param exists, show docs view
      setCurrentView('docs');
    } else if (settingsParam) {
      // If ?settings= param exists, show settings view
      setCurrentView('settings');
    }
  }, [docParam, settingsParam]);

  // Flush pending syncs on tab/window close
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') return;
    const handler = () => vfs.flushAllSyncTimeouts();
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  // Track pageview on view changes
  useEffect(() => {
    const path = selectedProject ? 'workspace' : currentView;
    track('pageview', { path });
  }, [currentView, selectedProject]);

  // Handle HF OAuth redirect at the app level (settings panel may not be mounted)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('code') || oauthExchangeInFlight) return;
    oauthExchangeInFlight = true;

    (async () => {
      let returnProjectId: string | null = null;
      try {
        const oauthResult = await oauthHandleRedirectIfPresent();
        if (oauthResult) {
          // Use the HF username (preferred_username), NOT the display name (`name`): it's the
          // namespace for repo/Space creation (e.g. "otst", not "Ot St"). Falling back to the
          // display name builds an invalid namespace and 403s on createRepo.
          const username = oauthResult.userInfo?.preferred_username
            || oauthResult.userInfo?.sub;
          configManager.setHFAuth({
            access_token: oauthResult.accessToken,
            username: username || undefined,
            scopes: oauthResult.scope,
          });
          toast.success(`Connected to HuggingFace${username ? ` as ${username}` : ''}`);
          track('connection_added', { provider: 'huggingface' });
          window.dispatchEvent(new CustomEvent('apiKeyUpdated', {
            detail: { provider: 'huggingface', hasKey: true }
          }));

          // The redirect returned us to the app root (no ?project=), so restore the project that
          // was open when the user kicked off OAuth, from the stash set by the sign-in button.
          // Read once here; the finally block clears the stash regardless of success/failure.
          returnProjectId = sessionStorage.getItem('hf_oauth_return_project')
            || new URLSearchParams(window.location.search).get('project');
          // Auto-select the HF Recommended template globally only if no working model exists yet.
          // Do not clobber an existing user's choice when they merely re-auth HuggingFace. This is
          // global (not per-project), so it applies even without a returnProjectId to restore.
          if (shouldAutoAssignAgent()) {
            await activateProviderAsGlobalDefault('huggingface');
          }
          if (returnProjectId) {
            await vfs.init(); // vfs.getProject throws if VFS uninitialized
            const project = await vfs.getProject(returnProjectId).catch(() => null);
            if (project) {
              setSelectedProject(project);
              // Use replaceState (not writeProjectParam's pushState) so the spent ?code= landing
              // entry is replaced by ?project=, keeping the Back button clean after OAuth. The
              // finally block then strips the OAuth params, leaving /?project=id in one entry.
              const restoredUrl = new URL(window.location.href);
              restoredUrl.searchParams.set('project', project.id);
              window.history.replaceState({}, '', restoredUrl.toString());
            }
          }
        }
      } catch (err) {
        console.warn('[HF OAuth] Redirect handling failed:', err);
      } finally {
        // Clear the project stash once, whether restore succeeded or threw, so a failed restore
        // cannot leak the id into a later OAuth return in the same tab.
        if (returnProjectId !== null) sessionStorage.removeItem('hf_oauth_return_project');
        // Clean only OAuth params from URL, preserve everything else (e.g. ?project=, ?doc=)
        const url = new URL(window.location.href);
        for (const p of ['code', 'state', 'error', 'error_description', 'error_uri', 'iss']) url.searchParams.delete(p);
        window.history.replaceState({}, '', url.toString());
      }
    })();
  }, []);

  // First-run: drop a brand-new visitor (zero projects) straight into a workspace with an
  // auto-created starter project, instead of the empty dashboard. Skipped when a URL param
  // points at an existing destination (?project=, ?code= OAuth return, ?doc=, ?settings=),
  // so this never fights the restore or OAuth effects. Runs at most once per page load.
  // Note: StudioApp only renders in SPA/browser/HF mode (see app/page.tsx), so no server-mode
  // guard is needed here by construction.
  useEffect(() => {
    if (firstRunCheckDone) return;
    firstRunCheckDone = true; // deliberately NOT reset on failure: a transient error should
                              // not cause a retry loop within a page load; a full reload recovers.
    (async () => {
      let createdId: string | null = null;
      try {
        await vfs.init();
        const projects = await vfs.listProjects();
        if (!shouldAutoCreateFirstProject({ search: window.location.search, projectCount: projects.length })) return;
        const project = await vfs.createProject('My First Site', '');
        createdId = project.id;
        project.settings = { ...(project.settings ?? {}), runtime: 'static' };
        await vfs.updateProject(project);
        await createProjectFromTemplate(vfs, project.id, BAREBONES_PROJECT_TEMPLATE);
        // template reported as 'blank' deliberately: quick-create's 'blank' path also applies
        // BAREBONES_PROJECT_TEMPLATE and reports 'blank', so telemetry stays continuous.
        track('project_create', { method: 'first_run_auto', runtime: 'static', template: 'blank' });
        setSelectedProject(project);
        // writeProjectParam uses history.pushState, which intentionally does NOT re-trigger
        // Next's useSearchParams, so the restore effect below does not re-run and fight this
        // freshly-set project. (A future refactor to router.replace WOULD re-run it, so keep pushState.)
        writeProjectParam(project.id);
      } catch (err) {
        console.warn('[FirstRun] auto-create failed, falling back to dashboard:', err);
        // Roll back a half-created project so a reload retries instead of being permanently
        // suppressed by listProjects().length === 1. Best-effort; ignore delete failures.
        if (createdId) { try { await vfs.deleteProject(createdId); } catch {} }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restore the open project from ?project=<id> on load (survives reload and OAuth).
  // Also honors browser Back: when the param goes to null, close the workspace.
  useEffect(() => {
    let cancelled = false;
    if (!projectParam) {
      if (selectedProject) setSelectedProject(null); // honor browser Back
      setRestoringProject(false);
      return;
    }
    if (selectedProject?.id === projectParam) {
      setRestoringProject(false);
      return;
    }
    setRestoringProject(true);
    (async () => {
      try {
        await vfs.init();
        const project = await vfs.getProject(projectParam);
        if (cancelled) return;
        if (project) setSelectedProject(project);
        else clearProjectParam();
      } catch { if (!cancelled) clearProjectParam(); }
      finally { if (!cancelled) setRestoringProject(false); }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectParam]);

  const stepId = state.currentStep?.id;
  const isTourRunning = state.status === 'running';

  useEffect(() => {
    if (selectedProject) {
      setActiveProjectId(selectedProject.id);
    } else {
      setActiveProjectId(null);
    }
  }, [selectedProject, setActiveProjectId]);

  /**
   * Switching to the simple view while on a page it does not offer.
   *
   * The menu loses Templates, Skills and Interviews, so staying put would leave someone on a view
   * with no way back to it. Read from the menu's own table rather than restated here, so a view
   * that changes hands does not have to be remembered in two places.
   */
  useEffect(() => {
    if (studioView) return;
    if (STUDIO_ONLY_VIEWS.includes(currentView)) setCurrentView('dashboard');
  }, [studioView, currentView]);

  /**
   * In the simple view a project opens into quick edit, as it does in server mode.
   *
   * Server mode gets there by route (`/w/{id}/quick/{projectId}`), which this tree has none of, so
   * the surface is set alongside the selection instead, and cleared on the way out. The agent's
   * mode is untouched: quick edit edits the way `code` does, and whatever the person last picked is
   * still what they come back to.
   */
  useEffect(() => {
    if (studioView || !selectedProject) return;
    useWorkspaceStore.getState().setQuickEdit(true);
    return () => { useWorkspaceStore.getState().setQuickEdit(false); };
  }, [studioView, selectedProject]);

  useEffect(() => {
    const handleTourNavigateHome = () => {
      setSelectedProject(null);
      clearProjectParam();
    };
    window.addEventListener('tour-navigate-home', handleTourNavigateHome);
    return () => {
      window.removeEventListener('tour-navigate-home', handleTourNavigateHome);
    };
  }, []);

  // Handle navigation from markdown links (?nav=projects, etc.)
  useEffect(() => {
    const handleNavToView = (e: CustomEvent<{ view: string }>) => {
      setCurrentView(e.detail.view as typeof currentView);
      setSelectedProject(null);
      clearProjectParam();
    };

    window.addEventListener('nav-to-view', handleNavToView as EventListener);
    return () => {
      window.removeEventListener('nav-to-view', handleNavToView as EventListener);
    };
  }, []);

  useEffect(() => {
    if (!isTourRunning) {
      return;
    }
    if (!stepId) {
      return;
    }

    if (
      stepId === 'welcome' ||
      stepId === 'projects-overview' ||
      stepId === 'create-project' ||
      stepId === 'project-controls' ||
      stepId === 'edit-project'
    ) {
      if (selectedProject) {
        setSelectedProject(null);
      }
      return;
    }

    if (
      stepId === 'workspace-overview' ||
      stepId === 'workspace-edit' ||
      stepId === 'workspace-checkpoint' ||
      stepId === 'provider-settings' ||
      stepId === 'wrap-up'
    ) {
      if (!selectedProject) {
        // Use the tour demo project if available, otherwise fall back to first project
        const tourProject = state.tourDemoProjectId
          ? state.projectList.find(p => p.id === state.tourDemoProjectId)
          : state.projectList[0];

        if (tourProject) {
          setSelectedProject(tourProject);
        }
      }
    }
  }, [isTourRunning, stepId, selectedProject, state.projectList, state.tourDemoProjectId]);

  const handleNavigate = useCallback((view: string) => {
    if (view === 'projects:create') {
      setCurrentView('projects');
      setAutoCreateProject(true);
    } else {
      setCurrentView(view as typeof currentView);
      setAutoCreateProject(false);
    }
  }, []);

  const handleStartTour = useCallback(() => {
    // Make sure we're on the projects page and no project is selected
    setSelectedProject(null);
    setCurrentView('projects');
    // Start the tour
    if (startTour) {
      startTour();
    }
  }, [startTour]);

  const handleProjectOpen = useCallback((project: Project) => {
    setSelectedProject(project);
    writeProjectParam(project.id);
    track('project_open');
  }, []);

  const handleShelfNavigate = useCallback(async (info: { id: string; name: string }) => {
    try {
      const project = await vfs.getProject(info.id);
      if (project) {
        handleProjectOpen(project);
      }
    } catch {
      toast.error('Could not open project');
    }
  }, [handleProjectOpen]);

  const content = useMemo(() => {
    if (restoringProject && !selectedProject) {
      return (
        <div className="h-full flex items-center justify-center">
          <Spinner size={48} color="#f97316" className="mx-auto" />
        </div>
      );
    }
    if (selectedProject) {
      return (
        <Workspace
          project={selectedProject}
          onBack={() => { setSelectedProject(null); clearProjectParam(); }}
          backLabel={`Back to ${currentView}`}
        />
      );
    }
    return (
      <ContentArea
        view={currentView}
        onProjectSelect={(project) => {
          handleProjectOpen(project);
          setAutoCreateProject(false);
        }}
        onNavigate={handleNavigate}
        onStartTour={handleStartTour}
        autoCreateProject={autoCreateProject}
      />
    );
  }, [restoringProject, selectedProject, currentView, handleNavigate, handleStartTour, autoCreateProject, handleProjectOpen]);

  return (
    <>
      <PageLayout
        currentView={currentView}
        onNavigate={(view: string) => setCurrentView(view as typeof currentView)}
        onProjectSelect={handleProjectOpen}
        onStartTour={handleStartTour}
        onOpenAbout={() => setShowAboutModal(true)}
        showSidebar={!selectedProject}
      >
        {content}
      </PageLayout>
      <GuidedTourOverlay location="global" />
      <AboutModal
        open={showAboutModal}
        onOpenChange={setShowAboutModal}
      />
      <TelemetryBootstrap />
      <GenerationShelf
        selectedProject={selectedProject}
        onNavigateToProject={handleShelfNavigate}
      />
    </>
  );
}

export function StudioApp() {
  return (
    // Browser mode's equivalent of the workspace layout's provider. Without one the chrome reads
    // the context default and shows the studio however this device is set. `initialStudioView` is null
    // because there is no server render to seed it from; the provider reads storage instead.
    <ViewModeProvider initialStudioView={null}>
      <GuidedTourProvider>
        <React.Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-[#0a0a0a]"><p className="text-zinc-400">Loading...</p></div>}>
          <StudioInner />
        </React.Suspense>
      </GuidedTourProvider>
    </ViewModeProvider>
  );
}
