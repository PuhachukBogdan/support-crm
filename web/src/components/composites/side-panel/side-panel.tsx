'use client';

import type { ReactNode } from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';

export type SidePanelProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  side?: 'right' | 'left';
  children?: ReactNode;
};

/**
 * Drawer/side panel. Screens use this to present detail beside the list; it renders as an
 * overlay Sheet and does NOT modify the S3 shell (the shell's context-panel slot is the
 * inline alternative for persistent panels).
 */
export function SidePanel({ open, onClose, title, description, side = 'right', children }: SidePanelProps) {
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent side={side}>
        {(title || description) && (
          <SheetHeader>
            {title && <SheetTitle>{title}</SheetTitle>}
            {description && <SheetDescription>{description}</SheetDescription>}
          </SheetHeader>
        )}
        {children}
      </SheetContent>
    </Sheet>
  );
}
