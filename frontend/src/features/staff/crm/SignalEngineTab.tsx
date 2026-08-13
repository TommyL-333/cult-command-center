import { useEffect, useMemo, useState } from 'react';
import { Search, Trash2, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from '@/components/ui/dialog';
import { EmptyState } from '@/features/shared/EmptyState';
import {
  seLoad, seSaveAll, seCalcHeat, seHeatColor, newProspect, nextChannel, buildOutreachPrompt,
  SIGNAL_KEYS, SIGNAL_LABELS, SIGNAL_PLACEHOLDERS, SE_PHASES, TOTAL_TOUCHES,
  type Prospect, type Direction, type SignalKey,
} from '@/lib/signalEngine';

const heatVariant = (heat: number): 'default' | 'secondary' | 'destructive' | 'outline' =>
  heat >= 70 ? 'default' : heat >= 40 ? 'secondary' : heat > 0 ? 'outline' : 'outline';

function AddProspectDialog({ onAdded }: { onAdded: (p: Prospect) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [role, setRole] = useState('');
  const [email, setEmail] = useState('');
  const [source, setSource] = useState('Apollo');
  const [error, setError] = useState('');

  function submit() {
    if (!name.trim()) { setError('Name is required'); return; }
    const p = newProspect({ name: name.trim(), company: company.trim(), role: role.trim(), email: email.trim(), source });
    seSaveAll([...seLoad(), p]);
    onAdded(p);
    setOpen(false);
    setName(''); setCompany(''); setRole(''); setEmail(''); setSource('Apollo'); setError('');
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">+ Add Prospect</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Add Prospect</DialogTitle></DialogHeader>
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
            <Label>Role / Title</Label>
            <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Founder" />
          </div>
          <div className="space-y-1.5">
            <Label>Email</Label>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@acme.com" />
          </div>
          <div className="space-y-1.5">
            <Label>Source</Label>
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {['Apollo', 'LinkedIn', 'Referral', 'Inbound', 'Manual'].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button onClick={submit}>Add Prospect</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SignalSlider({ signalKey, value, note, onChange }: {
  signalKey: SignalKey; value: number; note: string; onChange: (value: number, note: string) => void;
}) {
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">{SIGNAL_LABELS[signalKey]}</Label>
        <span className="text-xs font-semibold">{value}</span>
      </div>
      <input
        type="range" min={0} max={100} value={value}
        onChange={(e) => onChange(Number(e.target.value), note)}
        className="w-full accent-primary"
      />
      <Textarea
        value={note} onChange={(e) => onChange(value, e.target.value)}
        placeholder={SIGNAL_PLACEHOLDERS[signalKey]}
        className="mt-1 h-10 resize-none text-xs"
      />
    </div>
  );
}

const DIRECTIONS: { value: Direction; label: string; className: string }[] = [
  { value: 'rising', label: '↑ Rising', className: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30' },
  { value: 'flat', label: '→ Flat', className: 'bg-muted text-muted-foreground border-border' },
  { value: 'declining', label: '↓ Declining', className: 'bg-red-500/10 text-red-500 border-red-500/25' },
];

function ProspectDetail({ prospect, onClose, onChanged, onDeleted }: {
  prospect: Prospect; onClose: () => void; onChanged: () => void; onDeleted: () => void;
}) {
  const [signals, setSignals] = useState(prospect.signals);
  const [notes, setNotes] = useState(prospect.notes);
  const [direction, setDirection] = useState<Direction>(prospect.direction);
  const [saved, setSaved] = useState(false);
  const [channel, setChannel] = useState('LINKEDIN_DM');
  const [touchNumber, setTouchNumber] = useState((prospect.touches.filter(Boolean).length) + 1);
  const [senderName, setSenderName] = useState('');
  const [senderCompany, setSenderCompany] = useState('');
  const [prompt, setPrompt] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setSignals(prospect.signals);
    setNotes(prospect.notes);
    setDirection(prospect.direction);
    setTouchNumber(prospect.touches.filter(Boolean).length + 1);
    setPrompt('');
  }, [prospect.id]);

  const heat = useMemo(() => seCalcHeat(signals), [signals]);
  const heatLabel = heat >= 70 ? 'Hot — work immediately' : heat >= 40 ? 'Warm — queue within 48h' : heat > 0 ? 'Cold — monitor, re-score later' : 'No signals scored yet';

  function save() {
    const all = seLoad();
    const p = all.find((x) => x.id === prospect.id);
    if (!p) return;
    p.signals = signals;
    p.notes = notes;
    p.direction = direction;
    seSaveAll(all);
    onChanged();
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  function toggleTouch(idx: number, checked: boolean) {
    const all = seLoad();
    const p = all.find((x) => x.id === prospect.id);
    if (!p) return;
    if (!p.touches) p.touches = [];
    p.touches[idx] = checked;
    seSaveAll(all);
    onChanged();
    setTouchNumber(p.touches.filter(Boolean).length + 1);
  }

  function buildPrompt() {
    const text = buildOutreachPrompt(prospect, { channel, touchNumber, senderName: senderName || 'Tommy Lynch', senderCompany: senderCompany || 'Cult Content' });
    setPrompt(text);
  }

  function copyPrompt() {
    if (!prompt) { buildPrompt(); return; }
    navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  let globalIdx = 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-base">{prospect.name}</CardTitle>
          <p className="text-xs text-muted-foreground">{[prospect.role, prospect.company, prospect.email].filter(Boolean).join(' · ')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onClose}><X className="size-3.5" />Close</Button>
          <Button variant="outline" size="sm" onClick={() => { if (confirm('Delete this prospect?')) onDeleted(); }}>
            <Trash2 className="size-3.5" />Delete
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {/* Signal scores */}
          <div className="rounded-lg border p-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-primary">Signal Scores (0–100)</p>
            {SIGNAL_KEYS.map((k) => (
              <SignalSlider
                key={k} signalKey={k} value={signals[k]} note={notes[k]}
                onChange={(value, note) => { setSignals((s) => ({ ...s, [k]: value })); setNotes((n) => ({ ...n, [k]: note })); }}
              />
            ))}
          </div>

          <div className="flex flex-col gap-4">
            {/* Heat score */}
            <div className="rounded-lg border p-4 text-center">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-primary">Heat Score</p>
              <div className="mb-1 text-5xl font-black" style={{ color: heat ? seHeatColor(heat) : undefined }}>{heat || '—'}</div>
              <div className="my-2 h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full transition-all" style={{ width: `${heat}%`, background: seHeatColor(heat) }} />
              </div>
              <p className="mb-3 text-xs text-muted-foreground">Direction</p>
              <div className="flex justify-center gap-2">
                {DIRECTIONS.map((d) => (
                  <button
                    key={d.value} type="button" onClick={() => setDirection(d.value)}
                    className={`rounded-md border px-2.5 py-1 text-xs font-semibold transition-opacity ${d.className}`}
                    style={{ opacity: direction === d.value ? 1 : 0.4 }}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
              <p className="mt-3 text-xs text-muted-foreground">{heatLabel}</p>
              <Button size="sm" className="mt-3 w-full" onClick={save}>{saved ? 'Saved ✓' : 'Save Scores'}</Button>
            </div>

            {/* Message generator */}
            <div className="flex-1 rounded-lg border p-4">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-primary">Message Generator</p>
              <div className="mb-2 grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs text-muted-foreground">Channel</Label>
                  <Select value={channel} onValueChange={setChannel}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="LINKEDIN_DM">LinkedIn DM</SelectItem>
                      <SelectItem value="EMAIL">Email</SelectItem>
                      <SelectItem value="LINKEDIN_COMMENT">LinkedIn Comment</SelectItem>
                      <SelectItem value="SMS">SMS</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Touch #</Label>
                  <Input type="number" min={1} max={25} value={touchNumber} onChange={(e) => setTouchNumber(Number(e.target.value))} className="h-8 text-xs" />
                </div>
              </div>
              <div className="mb-2 grid grid-cols-2 gap-2">
                <Input placeholder="Sender name (Tommy Lynch)" value={senderName} onChange={(e) => setSenderName(e.target.value)} className="h-8 text-xs" />
                <Input placeholder="Sender company (Cult Content)" value={senderCompany} onChange={(e) => setSenderCompany(e.target.value)} className="h-8 text-xs" />
              </div>
              {prompt && (
                <pre className="mb-2 max-h-52 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/50 p-3 font-mono text-xs text-muted-foreground">{prompt}</pre>
              )}
              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="flex-1" onClick={buildPrompt}>Build Prompt</Button>
                <Button size="sm" className="flex-1" onClick={copyPrompt}>{copied ? 'Copied ✓' : 'Copy to Clipboard'}</Button>
              </div>
            </div>
          </div>
        </div>

        {/* 25-touch sequence tracker */}
        <div className="rounded-lg border p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-primary">25-Touch Sequence</p>
            <p className="text-xs text-muted-foreground">Check off touches as they're sent</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {SE_PHASES.map((phase) => {
              const startIdx = globalIdx;
              const items = phase.touches.map((t, ti) => {
                const idx = startIdx + ti;
                const done = !!prospect.touches[idx];
                return (
                  <label key={idx} className={`flex items-center gap-1.5 py-0.5 text-xs ${done ? 'text-emerald-500' : 'text-muted-foreground'}`}>
                    <input type="checkbox" checked={done} onChange={(e) => toggleTouch(idx, e.target.checked)} className="accent-emerald-500" />
                    Day {t.day} — {t.ch}
                  </label>
                );
              });
              globalIdx += phase.touches.length;
              const phDone = phase.touches.filter((_, ti) => prospect.touches[startIdx + ti]).length;
              return (
                <div key={phase.label} className="rounded-md border bg-muted/30 p-3">
                  <p className="mb-2 text-[0.65rem] font-semibold uppercase tracking-wide text-primary">{phase.label}</p>
                  <p className="mb-2 text-xs text-muted-foreground">{phDone}/{phase.touches.length} sent</p>
                  {items}
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Signal Engine — port of dashboard/segments.html's client-side prospect
 * scoring tool. Entirely localStorage-backed in the original (no backend),
 * so this port needs none either — see lib/signalEngine.ts.
 */
export function SignalEngineTab() {
  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [search, setSearch] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);

  function refresh() { setProspects(seLoad()); }
  useEffect(refresh, []);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    const list = q ? prospects.filter((p) => p.name.toLowerCase().includes(q) || p.company.toLowerCase().includes(q)) : prospects;
    return [...list].sort((a, b) => seCalcHeat(b.signals) - seCalcHeat(a.signals));
  }, [prospects, search]);

  const stats = useMemo(() => {
    const hot = prospects.filter((p) => seCalcHeat(p.signals) >= 70).length;
    const warm = prospects.filter((p) => { const h = seCalcHeat(p.signals); return h >= 40 && h < 70; }).length;
    const touches = prospects.reduce((t, p) => t + (p.touches || []).filter(Boolean).length, 0);
    return { total: prospects.length, hot, warm, touches };
  }, [prospects]);

  const active = prospects.find((p) => p.id === activeId) || null;

  function deleteActive() {
    if (!activeId) return;
    seSaveAll(seLoad().filter((p) => p.id !== activeId));
    setActiveId(null);
    refresh();
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card><CardContent className="pt-6"><p className="text-2xl font-bold">{stats.total}</p><p className="text-xs text-muted-foreground">Total Prospects</p></CardContent></Card>
        <Card><CardContent className="pt-6"><p className="text-2xl font-bold text-emerald-500">{stats.hot}</p><p className="text-xs text-muted-foreground">Hot (≥70)</p></CardContent></Card>
        <Card><CardContent className="pt-6"><p className="text-2xl font-bold text-amber-500">{stats.warm}</p><p className="text-xs text-muted-foreground">Warm (40–69)</p></CardContent></Card>
        <Card><CardContent className="pt-6"><p className="text-2xl font-bold">{stats.touches}</p><p className="text-xs text-muted-foreground">Touches Logged (of {TOTAL_TOUCHES}/prospect)</p></CardContent></Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Prospect List</CardTitle>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search prospects…" className="h-8 w-48 pl-7 text-xs" />
            </div>
            <AddProspectDialog onAdded={(p) => { refresh(); setActiveId(p.id); }} />
          </div>
        </CardHeader>
        <CardContent>
          {filtered.length === 0 ? (
            <EmptyState title="No prospects yet" description="Add one above." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="pb-2 font-medium">Name</th>
                    <th className="pb-2 font-medium">Company</th>
                    <th className="pb-2 font-medium">Role</th>
                    <th className="pb-2 font-medium">Heat</th>
                    <th className="pb-2 font-medium">Direction</th>
                    <th className="pb-2 font-medium">Touches</th>
                    <th className="pb-2 font-medium">Next Channel</th>
                    <th className="pb-2 font-medium">Status</th>
                    <th className="pb-2" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p) => {
                    const heat = seCalcHeat(p.signals);
                    const touchCount = (p.touches || []).filter(Boolean).length;
                    const dirIcon = p.direction === 'rising' ? '↑' : p.direction === 'declining' ? '↓' : '→';
                    return (
                      <tr key={p.id} className="cursor-pointer border-b last:border-0 hover:bg-muted/40" onClick={() => setActiveId(p.id)}>
                        <td className="py-2 font-medium">{p.name}</td>
                        <td className="py-2 text-muted-foreground">{p.company || '—'}</td>
                        <td className="py-2 text-muted-foreground">{p.role || '—'}</td>
                        <td className="py-2 font-bold" style={{ color: heat ? seHeatColor(heat) : undefined }}>{heat || '—'}</td>
                        <td className="py-2">{dirIcon} {p.direction}</td>
                        <td className="py-2 text-muted-foreground">{touchCount}/{TOTAL_TOUCHES}</td>
                        <td className="py-2 text-xs text-muted-foreground">{touchCount < TOTAL_TOUCHES ? nextChannel(touchCount) : 'Complete'}</td>
                        <td className="py-2"><Badge variant={heatVariant(heat)}>{heat >= 70 ? 'Hot' : heat >= 40 ? 'Warm' : heat > 0 ? 'Cold' : 'Unscored'}</Badge></td>
                        <td className="py-2 text-right"><Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); setActiveId(p.id); }}>Score →</Button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {active && (
        <ProspectDetail
          prospect={active}
          onClose={() => setActiveId(null)}
          onChanged={refresh}
          onDeleted={deleteActive}
        />
      )}
    </div>
  );
}
