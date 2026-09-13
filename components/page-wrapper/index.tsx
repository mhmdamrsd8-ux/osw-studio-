'use client';

import React, { useState, useCallback, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Project } from '@/lib/vfs/types';
import { useWorkspaceStore } from '@/lib/stores/workspace';
import { PageLayout } from '@/components/page-layout';
import { ContentArea } from '@/components/views/content-area';
import { Workspace } from '@/components/workspace';
import { GuidedTourProvider } from '@/components/guided-tour/context';
import { GuidedTourOverlay } from '@/components/guided-tour/overlay';
import { AboutModal } from '@/components/about-modal';
import { GenerationShelf } from '@/components/generation-shelf';
import { vfs } from '@/lib/vfs';
import { toast } from 'sonner';
import { track } from '@/lib/telemetry';
import { TelemetryBootstrap } from '@/components/telemetry-bootstrap';
import { useProviderAutoAssign } from '@/lib/hooks/use-provider-auto-assign';
import { useModelConfigSignal } from '@/lib/hooks/use-model-config-signal';
import { Spinner } from '@/components/ui/spinner';
import { useStudioView } from '@/components/view-mode-provider';

type View = 'dashboard' | 'projects' | 'templates' | 'skills' | 'interviews' | 'deployments' | 'users' | 'workspaces' | 'mail' | 'docs' | 'settings';

interface PageWrapperProps {
  view: View;
  workspaceId?: string;
  settingsTab?: string;
  autoCreateProject?: boolean;
  /** Set by the quick-edit route: open this project straight into the fullscreen dock. */
  quickEditProjectId?: string;
}

/**
 * What Back says, and it has to name the page the workspace will actually return to.
 *
 * `?project=` works on any of these routes, so the shell it opened over is the one the parameter was
 * added to: from Deployments the URL stays on Deployments and Back lands there, and a label reading
 * "Back to projects" would be describing somewhere else.
 */
const VIEW_LABELS: Record<string, string> = {
  dashboard: 'dashboard',
  projects: 'projects',
  deployments: 'deployments',
  templates: 'templates',
  skills: 'skills',
  interviews: 'interviews',
  docs: 'docs',
  settings: 'settings',
  users: 'users',
  workspaces: 'workspaces',
};

function getViewRoute(view: string, workspaceId?: string): string {
  const base = workspaceId ? `/w/${workspaceId}` : '/admin';
  const routes: Record<string, string> = {
    dashboard: `${base}/dashboard`,
    projects: `${base}/projects`,
    deployments: `${base}/deployments`,
    settings: `${base}/settings`,
    skills: `${base}/skills`,
    interviews: `${base}/interviews`,
    templates: `${base}/templates`,
    docs: `${base}/docs`,
    mail: `${base}/mail`,
    // System-wide routes (always /admin/)
    users: '/admin/users',
    workspaces: '/admin/workspaces',
  };
  return routes[view] || `${base}/projects`;
}

function PageWrapperInner({ view, workspaceId, settingsTab, autoCreateProject, quickEditProjectId }: PageWrapperProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Quick edit names its project in the path rather than a search param, but everything downstream,
  // the restore, the spinner, the sidebar suppression, is the same, so it joins here.
  const quickEdit = !!quickEditProjectId;
  const studioView = useStudioView();
  const projectParam = quickEditProjectId ?? searchParams.get('project');

  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  /**
   * True while a `?project=` link is still resolving.
   *
   * Without it the list for `view` renders first and is replaced a moment later, so a link straight
   * to a project flashes the projects page on the way in. Initialised from the param so the very
   * first render already knows a project is coming.
   */
  const [restoringProject, setRestoringProject] = useState(() => !!projectParam);
  // Which page the preview should open on, when whoever opened the project cared. Cleared on every
  // open so a page carried in from one comment does not stick to the next project opened.
  const [initialPreviewPath, setInitialPreviewPath] = useState<string | undefined>(undefined);
  const [showAboutModal, setShowAboutModal] = useState(false);

  // Global model auto-assign on provider connect. Mounted here (always-present root) so the
  // Connections UI works both inside and outside a workspace (dashboard -> Settings -> Connections).
  useProviderAutoAssign();

  // Reactive model-config signal + one-time model migration. Mounted here (always-present root)
  // so ANY ChatPanel (workspace, describe-mode, project-manager) reacts to model picks.
  useModelConfigSignal();

  useEffect(() => {
    useWorkspaceStore.getState().reattachServerTasks();
  }, []);

  // The route decides the surface; the agent's mode is the person's own setting and stays put.
  useEffect(() => {
    if (!quickEdit) return;
    useWorkspaceStore.getState().setQuickEdit(true);
    return () => { useWorkspaceStore.getState().setQuickEdit(false); };
  }, [quickEdit]);

  // Track pageview on view/project changes
  useEffect(() => {
    const path = selectedProject ? 'workspace' : view;
    track('pageview', { path });
  }, [view, selectedProject]);

  const handleNavigate = useCallback((targetView: string) => {
    const route = getViewRoute(targetView, workspaceId);
    router.push(route);
  }, [router, workspaceId]);

  /**
   * The open project lives in `?project=<id>`, so a reload or a shared link returns to it and Back
   * leaves it. pushState rather than router.push: this is the same route either way, and a Next
   * navigation would remount the whole shell to change one search param.
   */
  const writeProjectParam = useCallback((id: string) => {
    // The quick-edit route already carries the project in its path; adding the parameter as well
    // would leave two ids in one URL that could disagree.
    if (quickEdit) return;
    const url = new URL(window.location.href);
    url.searchParams.set('project', id);
    window.history.pushState({}, '', url.toString());
  }, [quickEdit]);

  const clearProjectParam = useCallback(() => {
    if (quickEdit) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('project');
    window.history.replaceState({}, '', url.toString());
  }, [quickEdit]);

  const handleProjectOpen = useCallback((project: Project, previewPath?: string) => {
    // In the simple view a project opens into quick edit, which is the whole point of that view:
    // the person it is for has no use for a four-panel editor. Every entry point, the projects
    // list, the dashboard's recent link and the sidebar, comes through here, so this is the only
    // place that has to know.
    if (!studioView && workspaceId) {
      track('project_open');
      router.push(`/w/${workspaceId}/quick/${project.id}`);
      return;
    }
    setSelectedProject(project);
    setInitialPreviewPath(previewPath);
    writeProjectParam(project.id);
    track('project_open');
  }, [writeProjectParam, studioView, workspaceId, router]);

  const handleProjectClose = useCallback(() => {
    if (quickEdit) {
      router.push(getViewRoute('projects', workspaceId));
      return;
    }
    setSelectedProject(null);
    clearProjectParam();
  }, [clearProjectParam, quickEdit, router, workspaceId]);

  /**
   * Restore the project named in the URL, and honour Back: when the param goes away, close.
   *
   * An id that no longer resolves clears the param rather than leaving a URL that reopens nothing on
   * every reload.
   */
  useEffect(() => {
    let cancelled = false;

    if (!projectParam) {
      if (selectedProject) setSelectedProject(null);
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
      } catch {
        // An id from another workspace is not in this workspace's store, so the lookup throws
        // rather than returning null.
        if (!cancelled) clearProjectParam();
      } finally {
        if (!cancelled) setRestoringProject(false);
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectParam]);

  const handleShelfNavigate = useCallback(async (info: { id: string; name: string }) => {
    try {
      const project = await vfs.getProject(info.id);
      if (project) handleProjectOpen(project);
    } catch {
      toast.error('Could not open project');
    }
  }, [handleProjectOpen]);

  const content = restoringProject && !selectedProject ? (
    <div className="h-full flex items-center justify-center">
      <Spinner size={48} color="#f97316" className="mx-auto" />
    </div>
  ) : selectedProject ? (
    <Workspace
      project={selectedProject}
      onBack={handleProjectClose}
      backLabel={quickEdit ? 'Back to projects' : `Back to ${VIEW_LABELS[view] ?? 'projects'}`}
      workspaceId={workspaceId}
      initialPreviewPath={initialPreviewPath}
    />
  ) : (
    <ContentArea
      view={view}
      workspaceId={workspaceId}
      onProjectSelect={handleProjectOpen}
      settingsTab={settingsTab}
      onNavigate={handleNavigate}
      autoCreateProject={autoCreateProject}
    />
  );

  return (
    <>
      <PageLayout
        currentView={view}
        workspaceId={workspaceId}
        onNavigate={handleNavigate}
        onProjectSelect={handleProjectOpen}
        onOpenAbout={() => setShowAboutModal(true)}
        showSidebar={!selectedProject && !restoringProject}
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

export function PageWrapper({ view, workspaceId, settingsTab, autoCreateProject, quickEditProjectId }: PageWrapperProps) {
  return (
    <GuidedTourProvider>
      {/* useSearchParams needs a boundary, and only the projects route provided one. */}
      <Suspense>
        <PageWrapperInner view={view} workspaceId={workspaceId} settingsTab={settingsTab} autoCreateProject={autoCreateProject} quickEditProjectId={quickEditProjectId} />
      </Suspense>
    </GuidedTourProvider>
  );
}
