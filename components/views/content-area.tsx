'use client';

import React from 'react';
import { Project } from '@/lib/vfs/types';
import { logger } from '@/lib/utils';
import { ProjectsView } from './projects-view';
import { TemplatesView } from './templates-view';
import { SkillsView } from './skills-view';
import { InterviewsView } from './interviews-view';
import { DeploymentsView } from './deployments-view';
import { UsersView } from './users-view';
import { WorkspacesView } from './workspaces-view';
import { SettingsView } from './settings-view';
import { DocsView } from './docs-view';
import { DashboardView } from './dashboard-view';

interface ContentAreaProps {
  view: string;
  workspaceId?: string;
  /** `previewPath` opens the workspace preview on that page rather than the entry point. */
  onProjectSelect: (project: Project, previewPath?: string) => void;
  settingsTab?: string;
  onNavigate?: (view: string) => void;
  onStartTour?: () => void;
  autoCreateProject?: boolean;
}

export function ContentArea({
  view,
  workspaceId,
  onProjectSelect,
  settingsTab,
  onNavigate,
  onStartTour,
  autoCreateProject,
}: ContentAreaProps) {
  // Handler to select a project by ID (for dashboard recent projects click)
  const handleProjectSelectById = async (projectId: string) => {
    try {
      const { vfs } = await import('@/lib/vfs');
      await vfs.init();
      const project = await vfs.getProject(projectId);
      if (project) {
        onProjectSelect(project);
      } else {
        logger.warn('[ContentArea] Project not found:', projectId);
      }
    } catch (err) {
      logger.error('[ContentArea] Failed to load project:', err);
    }
  };

  switch (view) {
    case 'dashboard':
      return (
        <DashboardView
          workspaceId={workspaceId}
          onNavigate={onNavigate}
          onProjectSelect={handleProjectSelectById}
          onStartTour={onStartTour}
        />
      );
    case 'projects':
      return <ProjectsView onProjectSelect={onProjectSelect} autoCreate={autoCreateProject} workspaceId={workspaceId} />;
    case 'deployments':
      return <DeploymentsView onProjectSelect={onProjectSelect} workspaceId={workspaceId} />;
    case 'users':
      return <UsersView workspaceId={workspaceId} />;
    case 'workspaces':
      return <WorkspacesView />;
    case 'templates':
      return <TemplatesView onProjectSelect={(project) => handleProjectSelectById(project.id)} onNavigate={onNavigate} />;
    case 'skills':
      return <SkillsView />;
    case 'interviews':
      return <InterviewsView />;
    case 'docs':
      return <DocsView />;
    case 'settings':
      return <SettingsView tab={settingsTab} workspaceId={workspaceId} />;
    default:
      return <ProjectsView onProjectSelect={onProjectSelect} />;
  }
}
