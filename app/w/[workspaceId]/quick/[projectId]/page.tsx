import { PageWrapper } from '@/components/page-wrapper';

/**
 * Quick edit for one project.
 *
 * Its own URL rather than a parameter on the projects route, so the simple view has a link that is
 * not the studio and a person can be sent straight to the thing they are meant to change.
 */
export default async function QuickEdit(
  { params }: { params: Promise<{ workspaceId: string; projectId: string }> }
) {
  const { workspaceId, projectId } = await params;
  return <PageWrapper view="projects" workspaceId={workspaceId} quickEditProjectId={projectId} />;
}
