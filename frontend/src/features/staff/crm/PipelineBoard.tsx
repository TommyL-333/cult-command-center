import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from '@/components/ui/dialog';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState } from '@/features/shared/EmptyState';
import { getPipeline, updateOpportunityStage, addGrowthPartnerProspect, type Opportunity } from '@/lib/crmApi';

// Same display order + stage-id map as dashboard-server.js's SEGMENT_STAGE_NAMES,
// since the pipeline endpoint's `byStage` array is already grouped in this order —
// this is purely for a fallback client-side sort if the API ever omits an empty stage.
const STAGE_ORDER = ['Lead', 'Discovery Call', 'Proposal Sent', 'Contract Signed', 'Active', 'Long Term Nurture', 'Churned', 'Disqualified'];

function AddProspectDialog({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle');
  const [error, setError] = useState('');

  async function submit() {
    if (!name.trim()) { setError('Name is required'); return; }
    setStatus('saving');
    setError('');
    try {
      await addGrowthPartnerProspect({ name: name.trim(), email: email.trim() || undefined, company: company.trim() || undefined });
      setOpen(false);
      setName(''); setEmail(''); setCompany('');
      setStatus('idle');
      onAdded();
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : 'Failed to add prospect');
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">+ Add Prospect</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Add Growth Partner Prospect</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Full Name *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Smith" />
          </div>
          <div className="space-y-1.5">
            <Label>Company</Label>
            <Input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Acme DTC" />
          </div>
          <div className="space-y-1.5">
            <Label>Email</Label>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@acme.com" />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={status === 'saving'}>{status === 'saving' ? 'Adding…' : 'Add Prospect'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OpportunityCard({ opp, stages, onMoved }: { opp: Opportunity; stages: { name: string; stageId: string }[]; onMoved: () => void }) {
  const [moving, setMoving] = useState(false);

  async function move(stageId: string) {
    if (!stageId || stageId === opp.stageName) return;
    setMoving(true);
    try {
      await updateOpportunityStage('growth-partners', opp.id, stageId);
      onMoved();
    } finally {
      setMoving(false);
    }
  }

  return (
    <div className="rounded-md border bg-card p-3 text-sm">
      <p className="truncate font-medium">{opp.contact?.name || opp.name}</p>
      {opp.contact?.email && <p className="truncate text-xs text-muted-foreground">{opp.contact.email}</p>}
      {typeof opp.monetaryValue === 'number' && opp.monetaryValue > 0 && (
        <p className="mt-1 text-xs font-semibold text-primary">${opp.monetaryValue.toLocaleString()}</p>
      )}
      <Select value="" onValueChange={move} disabled={moving}>
        <SelectTrigger className="mt-2 h-7 text-xs"><SelectValue placeholder={moving ? 'Moving…' : 'Move to…'} /></SelectTrigger>
        <SelectContent>
          {stages.filter((s) => s.name !== opp.stageName && s.stageId).map((s) => (
            <SelectItem key={s.stageId} value={s.stageId}>{s.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * Growth Partners pipeline board — port of dashboard/segments.html's Kanban
 * view. Uses a "Move to…" select per card rather than drag-and-drop (no new
 * DnD dependency, same underlying PUT /api/pipeline/growth-partners/:id/stage
 * call the original's drag handler made). All data is real GHL pipeline data
 * via the existing, unmodified backend — routes/pipeline endpoints reused
 * as-is.
 */
export function PipelineBoard() {
  const queryClient = useQueryClient();
  const pipelineQuery = useQuery({ queryKey: ['staff', 'crm', 'pipeline', 'growth-partners'], queryFn: () => getPipeline('growth-partners') });

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ['staff', 'crm', 'pipeline', 'growth-partners'] });
  }

  if (pipelineQuery.isPending) return <p className="text-sm text-muted-foreground">Loading pipeline…</p>;
  if (pipelineQuery.isError) return <EmptyState title="Couldn't load the pipeline" description="Try refreshing the page." />;

  const data = pipelineQuery.data!;
  const stages = [...data.byStage].sort((a, b) => STAGE_ORDER.indexOf(a.name) - STAGE_ORDER.indexOf(b.name));
  const stageOptions = stages.map((s) => ({ name: s.name, stageId: s.stageId }));

  const activeCount = stages.find((s) => s.name === 'Active')?.opportunities.length || 0;
  const proposalCount = stages.find((s) => s.name === 'Proposal Sent')?.opportunities.length || 0;
  const totalMRR = (stages.find((s) => s.name === 'Active')?.opportunities || []).reduce((sum, o) => sum + (o.monetaryValue || 0), 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card><CardContent className="pt-6"><p className="text-2xl font-bold">{data.total}</p><p className="text-xs text-muted-foreground">In Pipeline</p></CardContent></Card>
        <Card><CardContent className="pt-6"><p className="text-2xl font-bold text-emerald-500">{activeCount}</p><p className="text-xs text-muted-foreground">Active Partners</p></CardContent></Card>
        <Card><CardContent className="pt-6"><p className="text-2xl font-bold text-primary">{totalMRR ? `$${totalMRR.toLocaleString()}` : '$—'}</p><p className="text-xs text-muted-foreground">Total Retainer MRR</p></CardContent></Card>
        <Card><CardContent className="pt-6"><p className="text-2xl font-bold text-amber-500">{proposalCount}</p><p className="text-xs text-muted-foreground">Proposals Sent</p></CardContent></Card>
      </div>

      <div className="flex items-center justify-end">
        <AddProspectDialog onAdded={refresh} />
      </div>

      <div className="grid gap-3 overflow-x-auto pb-2" style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(220px, 1fr))` }}>
        {stages.map((stage) => (
          <div key={stage.name} className="min-w-[220px] rounded-lg border bg-muted/20 p-2">
            <div className="mb-2 flex items-center justify-between px-1">
              <p className="text-xs font-semibold">{stage.name}</p>
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[0.65rem] text-muted-foreground">{stage.opportunities.length}</span>
            </div>
            <div className="space-y-2">
              {stage.opportunities.length === 0
                ? <p className="px-1 py-2 text-xs text-muted-foreground">Empty</p>
                : stage.opportunities.map((opp) => (
                  <OpportunityCard key={opp.id} opp={opp} stages={stageOptions} onMoved={refresh} />
                ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
