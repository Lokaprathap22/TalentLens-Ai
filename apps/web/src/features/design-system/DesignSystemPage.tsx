import { ArrowLeft, CheckCircle2, Info, Sparkles, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

import {
  Avatar,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  SearchField,
  Select,
  Skeleton,
  StatusBadge,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Tooltip,
  buttonStyles,
} from '../../components/ui/index.js';
import { PageHeader } from '../../layouts/PageHeader.js';

export function DesignSystemPage(): React.JSX.Element {
  const [search, setSearch] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Design system"
        breadcrumbs={[{ label: 'Dashboard', to: '/dashboard' }, { label: 'Design system' }]}
        description="Tokenized UI foundation, semantic status mapping, and accessible primitives for TalentLens AI (M9.1)."
        actions={
          <Link to="/dashboard" className={buttonStyles('secondary', 'sm')}>
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to dashboard
          </Link>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card labelledBy="ds-buttons">
          <CardHeader
            title="Buttons & icon actions"
            titleId="ds-buttons"
            description="Primary, secondary, ghost, and danger variants across sizes"
          />
          <CardBody className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary">Primary action</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="danger" icon={Trash2}>
                Destructive
              </Button>
              <Button variant="primary" loading>
                Saving…
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary">
                Small (32px)
              </Button>
              <Button size="md" variant="secondary">
                Medium (36px)
              </Button>
              <Button size="lg" variant="secondary">
                Large (40px)
              </Button>
              <Tooltip content="Accessible icon button">
                <IconButton icon={Info} label="More information" />
              </Tooltip>
              <Avatar name="Priya Raman" size="md" />
              <Avatar name="Alex Chen" size="md" />
            </div>
          </CardBody>
        </Card>

        <Card labelledBy="ds-badges">
          <CardHeader
            title="Domain status badges"
            titleId="ds-badges"
            description="Deterministic mapping for assessment, consent, submission, and interview states"
          />
          <CardBody className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <StatusBadge kind="assessment" status="COMPLETE" />
              <StatusBadge kind="assessment" status="INSUFFICIENT_EVIDENCE" />
              <StatusBadge kind="assessment" status="NEEDS_REVIEW" />
              <StatusBadge kind="assessment" status="FAILED" />
              <StatusBadge kind="assessment" status="NOT_ASSESSED" />
            </div>
            <div className="flex flex-wrap gap-2">
              <StatusBadge kind="consent" status="ACTIVE" />
              <StatusBadge kind="consent" status="PENDING" />
              <StatusBadge kind="consent" status="WITHDRAWN" />
              <StatusBadge kind="interview" status="ACCEPTED" />
              <StatusBadge kind="interview" status="PROPOSED" />
              <Badge tone="accent" icon={Sparkles}>
                Accent badge
              </Badge>
            </div>
          </CardBody>
        </Card>

        <Card labelledBy="ds-forms">
          <CardHeader
            title="Form controls & search"
            titleId="ds-forms"
            description="Labelled inputs, validation messaging, and keyboard-clearable search"
          />
          <CardBody className="space-y-4">
            <SearchField
              label="Search candidates"
              placeholder="Search by code or role…"
              value={search}
              onValueChange={setSearch}
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Requisition title" hint="Shown to recruiters and assigned clients">
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid || undefined}
                    defaultValue="Senior Backend Engineer"
                  />
                )}
              </Field>
              <Field label="Scorecard status">
                {({ id, describedBy, invalid }) => (
                  <Select
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid || undefined}
                    defaultValue="OPEN"
                  >
                    <option value="OPEN">Open</option>
                    <option value="PAUSED">Paused</option>
                  </Select>
                )}
              </Field>
            </div>
          </CardBody>
        </Card>

        <Card labelledBy="ds-overlays">
          <CardHeader
            title="Tabs, dialogs & states"
            titleId="ds-overlays"
            description="WAI-ARIA keyboard tabs, native modal dialogs, and empty/error states"
          />
          <CardBody className="space-y-4">
            <Tabs defaultValue="states">
              <TabList label="Design system preview tabs">
                <Tab value="states" count={2}>
                  Empty &amp; error
                </Tab>
                <Tab value="skeletons">Loading skeleton</Tab>
              </TabList>
              <TabPanel value="states" className="pt-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <EmptyState
                    icon={CheckCircle2}
                    title="Queue caught up"
                    description="All verified assessments have been reviewed."
                    className="rounded-md border border-border py-6"
                  />
                  <ErrorState
                    title="Service unreachable"
                    description="Retry once connectivity is restored."
                    className="rounded-md border border-border py-6"
                  />
                </div>
              </TabPanel>
              <TabPanel value="skeletons" className="space-y-2 pt-3">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </TabPanel>
            </Tabs>

            <div className="flex flex-wrap gap-2 pt-2">
              <Button variant="secondary" size="sm" onClick={() => setDialogOpen(true)}>
                Open modal dialog
              </Button>
              <Button variant="danger" size="sm" onClick={() => setConfirmOpen(true)}>
                Open confirm dialog
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title="Sample modal dialog"
        description="Built on the native HTML <dialog> element with focus restoration."
        footer={
          <Button variant="primary" onClick={() => setDialogOpen(false)}>
            Done
          </Button>
        }
      >
        <p className="text-sm text-fg-muted">
          Press <kbd className="rounded border border-border px-1.5 py-0.5 text-xs">Esc</kbd> or
          click the backdrop to dismiss.
        </p>
      </Dialog>

      <ConfirmDialog
        open={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => setConfirmOpen(false)}
        title="Withdraw candidate submission?"
        description="Withdrawing removes this candidate from the client portal shortlist immediately."
        confirmLabel="Withdraw submission"
        destructive
      />
    </div>
  );
}
