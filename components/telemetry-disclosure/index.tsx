'use client';

import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown } from 'lucide-react';
import { setTelemetryOptIn, track } from '@/lib/telemetry';
import { getDisclosureLines } from '@/lib/telemetry/events';

interface TelemetryDisclosureProps {
  open: boolean;
  onDismiss: () => void;
}

// Bump when the collected-events list changes, so the Details badge signals
// there is something new to review.
const DISCLOSURE_UPDATED = 'September 2026';

export function TelemetryDisclosure({ open, onDismiss }: TelemetryDisclosureProps) {
  // Which "what will be collected" category is expanded; only one at a time.
  const [openCategory, setOpenCategory] = useState<string | null>(null);

  const handleDisable = () => {
    setTelemetryOptIn(false);
    onDismiss();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onDismiss(); }}>
      <DialogContent
        className="sm:max-w-md max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto]"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Anonymous Usage Analytics</DialogTitle>
          <DialogDescription>
            Open Source Web Studio collects anonymous usage analytics to help improve the app
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm text-muted-foreground leading-relaxed overflow-y-auto min-h-0 -mx-1 px-1">
          <p className="text-sm">
            Built with{' '}
            <a
              href="https://github.com/o-stahl/osw-analytics"
              target="_blank"
              rel="noopener noreferrer"
              className="bg-orange-500/20 text-orange-400 hover:text-orange-300 px-1 py-0.5 rounded no-underline"
            >
              osw-analytics
            </a>
            , an open-source approach to analytics.
          </p>

          <Collapsible>
            <div className="rounded-lg bg-muted/50">
              <CollapsibleTrigger className="flex items-center gap-1.5 w-full p-3 text-xs text-foreground hover:text-foreground transition-colors group">
                <ChevronDown className="h-3.5 w-3.5 transition-transform duration-200 group-data-[state=open]:rotate-180" />
                Details
                <span className="ml-auto rounded bg-orange-500/20 px-1.5 py-0.5 text-[10px] font-medium text-orange-400">
                  Updated {DISCLOSURE_UPDATED}
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="px-4 pb-4 space-y-3 text-sm text-muted-foreground">
                  <div>
                    <p className="font-bold text-foreground mb-1.5">What will <span className="text-orange-400 uppercase">not</span> be collected:</p>
                    <ul className="list-disc pl-5 space-y-0.5">
                      <li>Your prompts or messages</li>
                      <li>Code, file names, or file contents</li>
                      <li>API keys or credentials</li>
                      <li>Inference completions</li>
                      <li>Error messages</li>
                      <li>Anything that could identify you</li>
                    </ul>
                  </div>

                  <div>
                    <p className="font-bold text-foreground mb-1.5">What will be collected:</p>
                    <div className="divide-y divide-border/60 rounded-md border border-border/60">
                      {getDisclosureLines().map(group => (
                        <Collapsible
                          key={group.label}
                          open={openCategory === group.label}
                          onOpenChange={(o) => setOpenCategory(o ? group.label : null)}
                        >
                          <CollapsibleTrigger className="flex items-center gap-1.5 w-full px-2.5 py-2 text-xs font-medium text-foreground/80 hover:text-foreground transition-colors group">
                            <ChevronDown className="h-3 w-3 shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-180" />
                            <span>{group.label}</span>
                            <span className="ml-auto text-muted-foreground">{group.lines.length}</span>
                          </CollapsibleTrigger>
                          <CollapsibleContent>
                            <ul className="list-disc pl-7 pr-3 pb-2 space-y-0.5">
                              {group.lines.map(line => <li key={line}>{line}</li>)}
                            </ul>
                          </CollapsibleContent>
                        </Collapsible>
                      ))}
                    </div>
                    <p className="mt-2">A randomly generated ID stored in your browser is used to count unique visitors.</p>
                  </div>
                </div>
              </CollapsibleContent>
            </div>
          </Collapsible>
        </div>

        <DialogFooter className="flex items-center justify-between sm:justify-between gap-2">
          <button
            type="button"
            className="text-xs text-muted-foreground underline hover:text-foreground"
            onClick={handleDisable}
          >
            Disable analytics
          </button>
          <Button onClick={() => { track('telemetry_accepted'); onDismiss(); }}>
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
