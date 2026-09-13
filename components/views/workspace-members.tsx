'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Section, SectionBody, SectionHeader } from '@/components/ui/section';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import { InfoTip } from '@/components/ui/info-tip';
import { toast } from 'sonner';
import { logger } from '@/lib/utils';
import { emitViewChanged } from '@/lib/view-mode-event';

/**
 * The workspace tier of the users page.
 *
 * An owner administers the people in their own workspace without instance admin rights, which is
 * what an agency needs to put a client in the workspace holding that client's site. Everything here
 * is scoped to one workspace: the accounts are visible only through their membership of it, and
 * removing someone revokes that membership rather than touching the account.
 */

interface Member {
  userId: string;
  email: string;
  displayName: string | null;
  role: 'owner' | 'editor' | 'viewer';
  studioView: number;
  createdAt: string;
}

const VIEW_HELP =
  'The studio is the full four-panel editor. The simple view is projects and deployments only, and ' +
  'a project opens straight into quick edit. It changes what is shown, not what the person is ' +
  'allowed to do, and they can switch it themselves.';

export function WorkspaceMembers({
  workspaceId,
  onMembershipChange,
}: {
  workspaceId: string;
  /** Lets the instance list above refresh when adding a member also creates an account. */
  onMembershipChange?: () => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ email: '', password: '', displayName: '', studioView: false });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/w/${workspaceId}/users`);
      if (!res.ok) throw new Error('Failed to load members');
      const data = await res.json();
      setMembers(data.members ?? []);
    } catch (error) {
      logger.error('[members] load failed:', error);
      toast.error('Could not load members');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { load(); }, [load]);

  const addMember = async () => {
    const email = form.email.trim();
    if (!email) {
      toast.error('Enter an email address');
      return;
    }
    setAdding(true);
    try {
      const res = await fetch(`/api/w/${workspaceId}/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password: form.password,
          displayName: form.displayName,
          studioView: form.studioView,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to add member');

      toast.success(data.created ? `Created an account for ${email}` : `Added ${email}`);
      setShowAdd(false);
      setForm({ email: '', password: '', displayName: '', studioView: false });
      await load();
      onMembershipChange?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to add member');
    } finally {
      setAdding(false);
    }
  };

  const patchMember = async (userId: string, body: Record<string, unknown>, failure: string) => {
    setBusyUserId(userId);
    try {
      const res = await fetch(`/api/w/${workspaceId}/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || failure);
      await load();
      // Harmless when it was someone else's row: the sidebar re-reads its own account either way.
      emitViewChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : failure);
    } finally {
      setBusyUserId(null);
    }
  };

  const removeMember = async (member: Member) => {
    setBusyUserId(member.userId);
    try {
      const res = await fetch(`/api/w/${workspaceId}/users/${member.userId}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to remove member');
      toast.success(`Removed ${member.email}`);
      await load();
      onMembershipChange?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove member');
    } finally {
      setBusyUserId(null);
    }
  };

  return (
    <>
      <Section>
        <SectionHeader icon={Users} title="Members of this workspace">
          <Button size="xs" variant="outline" onClick={() => setShowAdd(true)}>
            <Plus className="w-3 h-3 mr-1" />
            Add member
          </Button>
        </SectionHeader>
        <SectionBody className="p-0">
          {loading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading members…
            </div>
          ) : members.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No members yet.</p>
          ) : (
            <div className="divide-y divide-border">
              {members.map((member) => {
                const busy = busyUserId === member.userId;
                return (
                  <div key={member.userId} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium truncate">
                          {member.displayName || member.email}
                        </span>
                        {member.role === 'owner' && (
                          <Badge className="text-[11px] px-[7px] py-[1px] h-auto rounded-full bg-primary/15 text-primary border-primary/40">
                            Owner
                          </Badge>
                        )}
                      </div>
                      {member.displayName && (
                        <span className="block text-[11px] text-muted-foreground truncate">
                          {member.email}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <Select
                        value={member.studioView === 1 ? 'studio' : 'simple'}
                        onValueChange={(value) =>
                          patchMember(member.userId, { studioView: value === 'studio' }, 'Failed to change the view')
                        }
                      >
                        <SelectTrigger size="sm" className="w-[104px]" aria-label={`View for ${member.email}`}>
                          <span className="text-xs">{member.studioView === 1 ? 'Studio' : 'Simple'}</span>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="studio">Studio</SelectItem>
                          <SelectItem value="simple">Simple</SelectItem>
                        </SelectContent>
                      </Select>

                      <Select
                        value={member.role}
                        onValueChange={(value) =>
                          patchMember(member.userId, { role: value }, 'Failed to change the role')
                        }
                      >
                        <SelectTrigger size="sm" className="w-[92px]" aria-label={`Role for ${member.email}`}>
                          <span className="text-xs capitalize">{member.role}</span>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="editor">Editor</SelectItem>
                          <SelectItem value="owner">Owner</SelectItem>
                        </SelectContent>
                      </Select>

                      <Button
                        variant="ghost" size="sm" className="px-2"
                        aria-label={`Remove ${member.email}`}
                        disabled={busy}
                        onClick={() => removeMember(member)}
                      >
                        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </SectionBody>
      </Section>

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add a member</DialogTitle>
            <DialogDescription>
              They get full run of this workspace. If the email has no account yet, one is created
              with the password you set.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label htmlFor="member-email">Email</Label>
              <Input
                id="member-email"
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="client@example.com"
                className="mt-2"
                disabled={adding}
              />
            </div>

            <div>
              <Label htmlFor="member-name">Display name</Label>
              <Input
                id="member-name"
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                placeholder="Optional"
                className="mt-2"
                disabled={adding}
              />
            </div>

            <div>
              <Label htmlFor="member-password">Password</Label>
              <Input
                id="member-password"
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder="Only needed for a new account"
                className="mt-2"
                disabled={adding}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Leave empty to add someone who already has an account.
              </p>
            </div>

            <div className="flex items-center gap-2 border-t border-border/60 pt-3">
              <Label htmlFor="member-studio-view" className="text-sm font-normal cursor-pointer">
                Open the full studio
              </Label>
              <InfoTip>{VIEW_HELP}</InfoTip>
              <Switch
                id="member-studio-view"
                className="ml-auto"
                checked={form.studioView}
                onCheckedChange={(studioView) => setForm({ ...form, studioView })}
                disabled={adding}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setShowAdd(false)} disabled={adding}>
              Cancel
            </Button>
            <Button size="sm" onClick={addMember} disabled={adding || !form.email.trim()}>
              {adding ? (<><Loader2 className="w-3 h-3 animate-spin mr-1" />Adding…</>) : 'Add member'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
