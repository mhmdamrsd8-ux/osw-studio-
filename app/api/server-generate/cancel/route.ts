import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { taskManager, eventBus } from '@/lib/server-generate/singleton';

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await taskManager.initialize();

  let taskId: string;
  try { ({ taskId } = await request.json()); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const task = taskManager.getTask(taskId);
  if (!task) {
    return NextResponse.json({ ok: true, alreadyDone: true });
  }

  if (task.sessionId !== session.userId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
    return NextResponse.json({ ok: true, alreadyDone: true });
  }

  // A task with a live loop is asked to stop and completes itself through the runner. One without
  // a loop, such as a task reloaded from the durable store after the process restarted, has nothing
  // that will ever complete it, so it is closed here and its clients told so.
  if (!task.orchestrator) {
    eventBus.emit(taskId, task.projectId, 'task_complete', { result: 'stopped' }, task.sessionId);
    await taskManager.completeTask(taskId, 'cancelled');
    return NextResponse.json({ ok: true, hadOrchestrator: false });
  }

  task.orchestrator.stop();
  task.status = 'stopping';
  await taskManager.updateTask(task);

  return NextResponse.json({ ok: true, hadOrchestrator: true });
}
