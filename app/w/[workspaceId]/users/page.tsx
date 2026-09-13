import { PageWrapper } from '@/components/page-wrapper';

export default async function WorkspaceUsers(
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  return <PageWrapper view="users" workspaceId={workspaceId} />;
}
