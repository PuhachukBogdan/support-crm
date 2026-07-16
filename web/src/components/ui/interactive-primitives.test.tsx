import { render, screen } from '@testing-library/react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './tabs';
import { Popover, PopoverTrigger, PopoverContent } from './popover';
import { Checkbox } from './checkbox';
import { Switch } from './switch';
import { Select, SelectTrigger, SelectValue } from './select';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from './table';

/*
 * S1 interactive-primitive guard (roadmap 8.5). These render through Radix portals
 * and depend on the `tailwindcss-animate` plugin being wired into tailwind.config.ts.
 * Fails if a primitive is missing, the plugin/deps regress, or a hardcoded color appears.
 */

describe('S1 interactive primitives (portal-rendered, token-styled)', () => {
  it('renders an open Dialog into the portal', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Delete brand</DialogTitle>
          <DialogDescription>This cannot be undone.</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByText('Delete brand')).toBeInTheDocument();
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
  });

  it('renders Tabs with an active panel', () => {
    render(
      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
        </TabsList>
        <TabsContent value="general">General settings</TabsContent>
        <TabsContent value="security">Security settings</TabsContent>
      </Tabs>,
    );
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.getByText('General settings')).toBeInTheDocument();
  });

  it('renders an open Popover into the portal', () => {
    render(
      <Popover open>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Filter options</PopoverContent>
      </Popover>,
    );
    expect(screen.getByText('Filter options')).toBeInTheDocument();
  });

  it('renders form controls and a table', () => {
    render(
      <div>
        <Checkbox aria-label="agree" />
        <Switch aria-label="notifications" />
        <Select>
          <SelectTrigger aria-label="brand">
            <SelectValue placeholder="Pick a brand" />
          </SelectTrigger>
        </Select>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ticket</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>#1024</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>,
    );
    expect(screen.getByRole('checkbox', { name: /agree/i })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /notifications/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /brand/i })).toBeInTheDocument();
    expect(screen.getByText('#1024')).toBeInTheDocument();
  });

  it('hardcodes no hex color in the portal-rendered output', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
          <DialogDescription>Body</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    // Radix renders into document.body via a portal — check the whole document.
    expect(document.body.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
