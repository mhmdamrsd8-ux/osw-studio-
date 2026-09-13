import { PageWrapper } from '@/components/page-wrapper';
import { requireStudioView } from '@/lib/auth/studio-view-guard';

export default async function WorkspaceSkills(
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  // Not offered by the simple view's menu, so not reachable by typing the URL either.
  await requireStudioView(workspaceId);
  return <PageWrapper view="skills" workspaceId={workspaceId} />;
}
