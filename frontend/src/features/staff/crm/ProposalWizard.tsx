import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, X, Sparkles } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  getFirefliesMeetings, getFirefliesTranscript, syncFirefliesMeetings, extractProposalMetrics, generateProposal,
  getPipeline, updateOpportunityStage, publishProposal,
  type FirefliesMeeting, type ExtractedMetrics, type GeneratedProposal, type Opportunity,
} from '@/lib/crmApi';
import { computeMetrics, type MetricsInput } from '@/lib/proposalEngine';
import { buildStandaloneProposalDocument } from '@/lib/proposalHtml';

type Source = 'shopify' | 'transcript' | 'ai' | 'user' | 'missing';
interface ReviewField { value: number | null; source: Source; }
interface ReviewState {
  price: ReviewField; promo: ReviewField; cogs: ReviewField; shipping: ReviewField;
  affcomm: ReviewField; samples: ReviewField; retainers: ReviewField; views: ReviewField;
}
const REVIEW_LABELS: Record<keyof ReviewState, string> = {
  price: 'List Price ($)', promo: 'Promo Discount %', cogs: 'COGS / unit ($)', shipping: 'Shipping / unit ($)',
  affcomm: 'Aff. Commission %', samples: 'Monthly Samples', retainers: 'Aff. Retainers ($)', views: 'Avg Views/creator/mo',
};
const SOURCE_LABEL: Record<Source, string> = { shopify: '🛍 shopify', transcript: '💬 transcript', ai: '🤖 estimated', user: '✏️ edited', missing: '⚠ needed' };
const SOURCE_COLOR: Record<Source, string> = { shopify: '#10b981', transcript: '#3b82f6', ai: '#8b5cf6', user: '#0d9488', missing: '#ef4444' };

function fieldsFromExtraction(d: ExtractedMetrics): ReviewState {
  const s = d.sources || {};
  const m = d.metrics || {};
  const rf = (key: keyof ExtractedMetrics['metrics'], srcKey: string): ReviewField => {
    const val = m[key];
    const src = (s[srcKey] as Source) || (val != null ? 'ai' : 'missing');
    return { value: val ?? null, source: src };
  };
  return {
    price: rf('listPrice', 'listPrice'),
    promo: rf('promoPct', 'promoPct'),
    cogs: rf('cogsPerUnit', 'cogsPerUnit'),
    shipping: rf('shippingPerUnit', 'shippingPerUnit'),
    affcomm: rf('affiliateCommPct', 'affiliateCommPct'),
    samples: rf('monthlySamples', 'monthlySamples'),
    retainers: rf('affiliateRetainers', 'affiliateRetainers'),
    views: rf('avgViews', 'avgViews'),
  };
}

function toMetricsInput(review: ReviewState, pricing: { retainer: number; gmv: number }, costPerVideo: number): MetricsInput {
  return {
    listPrice: review.price.value || 0,
    promoPct: review.promo.value || 0,
    shippingPerUnit: review.shipping.value,
    cogsPerUnit: review.cogs.value || 0,
    affiliateCommPct: review.affcomm.value || 25,
    adspendPct: 0,
    monthlySamples: review.samples.value || 75,
    manualCreators: 0,
    videosPerCreator: 6,
    avgViews: review.views.value || 8000,
    ctrPct: 3,
    cvrPct: 2,
    affiliateRetainers: review.retainers.value || 1000,
    costPerVideo: costPerVideo || 75,
    teamFee: pricing.retainer,
    revSharePct: pricing.gmv,
  };
}

function ReviewInput({ id, field, onChange }: {
  id: keyof ReviewState; field: ReviewField; onChange: (key: keyof ReviewState, value: number | null) => void;
}) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5">
      <Label className="flex-1 text-xs text-muted-foreground">{REVIEW_LABELS[id]}</Label>
      <Input
        type="number" value={field.value ?? ''} onChange={(e) => onChange(id, e.target.value === '' ? null : Number(e.target.value))}
        className={`h-7 w-20 text-right text-xs ${field.source === 'missing' ? 'border-destructive' : ''}`}
      />
      <span className="w-14 shrink-0 text-right text-[0.58rem] font-semibold" style={{ color: SOURCE_COLOR[field.source] }}>{SOURCE_LABEL[field.source]}</span>
    </div>
  );
}

/**
 * AI Proposal Generator wizard — port of dashboard/segments.html's Step 1
 * (Fireflies meeting picker) -> Step 2 (metrics review/edit) -> generate ->
 * Step 3 (preview, edit, mark sent, publish). Same two backend calls
 * (POST /api/ai/extract-metrics, POST /api/ai/propose), same review-field
 * source badges, same unit-economics gate logic.
 */
export function ProposalWizard() {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<1 | 2>(1);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [ffSearch, setFfSearch] = useState('');
  const [selectedMeetings, setSelectedMeetings] = useState<{ mt: FirefliesMeeting; transcript: string }[]>([]);
  const [extraContext, setExtraContext] = useState('');
  const [showExtraContext, setShowExtraContext] = useState(false);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState('');

  const [extraction, setExtraction] = useState<ExtractedMetrics | null>(null);
  const [review, setReview] = useState<ReviewState | null>(null);
  const [retainer, setRetainer] = useState(3000);
  const [gmv, setGmv] = useState(6.5);
  const [costPerVideo, setCostPerVideo] = useState(75);
  const [generating, setGenerating] = useState(false);

  const [proposal, setProposal] = useState<GeneratedProposal | null>(null);
  const [proposalMetricsInput, setProposalMetricsInput] = useState<MetricsInput | null>(null);
  const [linkOppId, setLinkOppId] = useState('');

  const ffQuery = useQuery({ queryKey: ['staff', 'crm', 'fireflies-meetings'], queryFn: getFirefliesMeetings, enabled: pickerOpen });
  const pipelineQuery = useQuery({ queryKey: ['staff', 'crm', 'pipeline', 'growth-partners'], queryFn: () => getPipeline('growth-partners') });
  const opps: Opportunity[] = pipelineQuery.data?.opportunities || [];

  const fullContext = useMemo(() => {
    const transcript = selectedMeetings.map((s) => s.transcript).join('\n\n---\n\n');
    return [transcript, extraContext.trim()].filter(Boolean).join('\n\n');
  }, [selectedMeetings, extraContext]);

  async function pickMeeting(mt: FirefliesMeeting) {
    if (selectedMeetings.some((s) => s.mt.id === mt.id)) { setPickerOpen(false); return; }
    setPickerOpen(false);
    setLoadingTranscript(true);
    const attendees = (mt.participants || []).filter((e) => !e.includes('cultcontent')).join(', ');
    const date = mt.date ? new Date(mt.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    const header = [`Meeting: ${mt.title} (${date})`, attendees ? `With: ${attendees}` : '', ''].filter(Boolean).join('\n');
    let transcript = '';
    try {
      const d = await getFirefliesTranscript(mt.id);
      const parts = [header];
      if (d.transcript) parts.push(d.transcript);
      if (d.summary?.short_summary) parts.push(`\n--- Summary ---\n${d.summary.short_summary}`);
      if (d.summary?.action_items) parts.push(`\n--- Action Items ---\n${d.summary.action_items}`);
      transcript = parts.join('\n').trim();
    } catch {
      const summary = mt.summary?.short_summary || '';
      const actions = mt.summary?.action_items || '';
      transcript = [header, summary, actions ? `\nAction items:\n${actions}` : ''].filter(Boolean).join('\n').trim();
    }
    setSelectedMeetings((prev) => [...prev, { mt, transcript }]);
    setLoadingTranscript(false);
  }

  function removeMeeting(i: number) {
    setSelectedMeetings((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function analyze() {
    if (!fullContext) { setError('Select a meeting or add context first.'); return; }
    setAnalyzing(true);
    setError('');
    try {
      const d = await extractProposalMetrics(fullContext);
      setExtraction(d);
      setReview(fieldsFromExtraction(d));
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to analyze meeting');
    } finally {
      setAnalyzing(false);
    }
  }

  function updateReviewField(key: keyof ReviewState, value: number | null) {
    setReview((r) => (r ? { ...r, [key]: { value, source: 'user' } } : r));
  }

  const liveMetrics = review ? computeMetrics(toMetricsInput(review, { retainer, gmv }, costPerVideo)) : null;

  const blockers: string[] = [];
  const warnings: string[] = [];
  if (review) {
    if (!review.price.value) blockers.push('List price is required');
    if (!review.cogs.value) blockers.push('COGS / unit required — enter your product cost');
    if (review.shipping.value == null) warnings.push('Shipping cost not set — will default to $6/unit in projections');
    if (liveMetrics && review.price.value && review.cogs.value && liveMetrics.grossMarginPct < 0) {
      blockers.push(`Negative gross margin (${(liveMetrics.grossMarginPct * 100).toFixed(1)}%) — selling price too low to cover variable costs`);
    }
  }
  const isNegative = !!(liveMetrics && review?.price.value && review?.cogs.value && liveMetrics.grossMarginPct < 0);

  async function confirmAndGenerate() {
    if (!review) return;
    setGenerating(true);
    setError('');
    try {
      const confirmedMetrics = {
        listPrice: review.price.value || null,
        promoPct: review.promo.value || 0,
        shippingPerUnit: review.shipping.value ?? 6,
        cogsPerUnit: review.cogs.value || null,
        affiliateCommPct: review.affcomm.value || 25,
        monthlySamples: review.samples.value || 75,
        affiliateRetainers: review.retainers.value || 1000,
        avgViews: review.views.value || null,
      };
      const { proposal: gen } = await generateProposal({
        context: fullContext,
        retainer: `$${retainer.toLocaleString()}/mo`,
        gmv: `${gmv.toFixed(1)}%`,
        confirmedMetrics,
      });
      const metricsInput = toMetricsInput(review, { retainer, gmv }, costPerVideo);
      setProposal(gen);
      setProposalMetricsInput(metricsInput);
      // Auto-select a contact by exact email match from the context, same as the original.
      const emailMatch = fullContext.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      if (emailMatch) {
        const match = opps.find((o) => (o.contact.email || '').toLowerCase() === emailMatch[0].toLowerCase());
        if (match) setLinkOppId(match.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate proposal');
    } finally {
      setGenerating(false);
    }
  }

  function reset() {
    setStep(1);
    setSelectedMeetings([]);
    setExtraContext('');
    setShowExtraContext(false);
    setExtraction(null);
    setReview(null);
    setError('');
    setProposal(null);
    setProposalMetricsInput(null);
    setLinkOppId('');
  }

  async function markSent() {
    if (!linkOppId) { setError('Select a contact to link this proposal to'); return; }
    await updateOpportunityStage('growth-partners', linkOppId, '7e6bf560-11d6-442a-b64f-3bf12f136d5a');
    queryClient.invalidateQueries({ queryKey: ['staff', 'crm', 'pipeline', 'growth-partners'] });
  }

  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Sparkles className="size-4 text-primary" />Proposal Generator</CardTitle></CardHeader>
      <CardContent>
        {step === 1 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">Select a Fireflies meeting — metrics auto-extracted</p>
              <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
                <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)}>🎙 Load meeting</Button>
                <DialogContent>
                  <DialogHeader><DialogTitle>Select a meeting</DialogTitle></DialogHeader>
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input value={ffSearch} onChange={(e) => setFfSearch(e.target.value)} placeholder="Search meetings…" className="pl-7" />
                  </div>
                  <div className="max-h-72 space-y-1 overflow-y-auto">
                    {ffQuery.isPending && <p className="p-2 text-sm text-muted-foreground">Loading…</p>}
                    {ffQuery.data && !ffQuery.data.connected && (
                      <p className="p-2 text-sm text-muted-foreground">Fireflies not connected — add FIREFLIES_API_KEY to the environment.</p>
                    )}
                    {ffQuery.data?.connected && (ffQuery.data.meetings || [])
                      .filter((mt) => !ffSearch || mt.title.toLowerCase().includes(ffSearch.toLowerCase()) || (mt.participants || []).some((p) => p.toLowerCase().includes(ffSearch.toLowerCase())))
                      .map((mt) => (
                        <button key={mt.id} type="button" onClick={() => pickMeeting(mt)} className="block w-full rounded-md p-2 text-left text-sm hover:bg-muted">
                          <p className="font-medium">{mt.title}</p>
                          <p className="text-xs text-muted-foreground">{mt.date ? new Date(mt.date).toLocaleDateString() : ''}</p>
                        </button>
                      ))}
                  </div>
                  <Button variant="ghost" size="sm" onClick={async () => { await syncFirefliesMeetings(); queryClient.invalidateQueries({ queryKey: ['staff', 'crm', 'fireflies-meetings'] }); }}>🔥 Sync more history</Button>
                </DialogContent>
              </Dialog>
            </div>

            {loadingTranscript && <p className="text-xs text-muted-foreground">⏳ Loading transcript…</p>}
            {selectedMeetings.length > 0 && (
              <div className="space-y-1.5">
                {selectedMeetings.map((s, i) => (
                  <div key={s.mt.id} className="flex items-center justify-between rounded-md border p-2 text-sm">
                    <div><p className="font-medium">{s.mt.title}</p></div>
                    <button onClick={() => removeMeeting(i)} className="text-muted-foreground hover:text-destructive"><X className="size-3.5" /></button>
                  </div>
                ))}
              </div>
            )}

            <div>
              <button onClick={() => setShowExtraContext((v) => !v)} className="text-xs text-muted-foreground underline">
                {showExtraContext ? '− Hide context' : '+ Add context or notes'}
              </button>
              {showExtraContext && (
                <Textarea value={extraContext} onChange={(e) => setExtraContext(e.target.value)} placeholder="Optional: paste additional brand context, pricing info, or notes here…" className="mt-1.5" />
              )}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button className="w-full" onClick={analyze} disabled={analyzing || !fullContext}>
              {analyzing ? '⏳ Analyzing…' : `📊 Analyze & Extract Metrics${selectedMeetings.length > 1 ? ` (${selectedMeetings.length} meetings)` : ''}`}
            </Button>
          </div>
        )}

        {step === 2 && extraction && review && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Button variant="ghost" size="sm" onClick={() => setStep(1)}>← Back</Button>
              <div className="text-center">
                <p className="text-sm font-bold">{extraction.brandName}</p>
                {extraction.heroProduct && <p className="text-xs text-muted-foreground">Hero: {extraction.heroProduct}</p>}
              </div>
              <div className="w-16" />
            </div>

            {extraction.shopifyData && (
              <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-500">
                🛍 Shopify data from {extraction.shopifyData.domain} ({extraction.shopifyData.products.length} products)
              </p>
            )}

            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <p className="mb-1.5 text-[0.6rem] font-semibold uppercase tracking-wide text-primary">💰 Pricing</p>
                <ReviewInput id="price" field={review.price} onChange={updateReviewField} />
                <ReviewInput id="promo" field={review.promo} onChange={updateReviewField} />
                {liveMetrics && <p className="mt-1 text-right text-xs font-bold text-primary">Selling: ${liveMetrics.sellingPrice.toFixed(2)}</p>}
              </div>
              <div>
                <p className="mb-1.5 text-[0.6rem] font-semibold uppercase tracking-wide text-primary">📦 Unit Costs</p>
                <ReviewInput id="cogs" field={review.cogs} onChange={updateReviewField} />
                <ReviewInput id="shipping" field={review.shipping} onChange={updateReviewField} />
                <ReviewInput id="affcomm" field={review.affcomm} onChange={updateReviewField} />
              </div>
              <div>
                <p className="mb-1.5 text-[0.6rem] font-semibold uppercase tracking-wide text-primary">👥 Channel</p>
                <ReviewInput id="samples" field={review.samples} onChange={updateReviewField} />
                <ReviewInput id="retainers" field={review.retainers} onChange={updateReviewField} />
                <ReviewInput id="views" field={review.views} onChange={updateReviewField} />
                <div className="flex items-center gap-1.5">
                  <Label className="flex-1 text-xs text-muted-foreground">Cost/retainer video ($)</Label>
                  <Input type="number" value={costPerVideo} onChange={(e) => setCostPerVideo(Number(e.target.value))} className="h-7 w-20 text-right text-xs" />
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3 rounded-md border p-2">
              <div className="flex flex-1 items-center gap-1.5">
                <Label className="text-xs text-muted-foreground">Retainer $/mo</Label>
                <Input type="number" value={retainer} onChange={(e) => setRetainer(Number(e.target.value))} className="h-7 w-24 text-xs" />
              </div>
              <div className="flex flex-1 items-center gap-1.5">
                <Label className="text-xs text-muted-foreground">GMV %</Label>
                <Input type="number" step="0.1" value={gmv} onChange={(e) => setGmv(Number(e.target.value))} className="h-7 w-20 text-xs" />
              </div>
            </div>

            {liveMetrics && review.price.value ? (
              <div className="rounded-md border bg-muted/30 p-3 text-xs">
                <p className="mb-1.5 text-[0.6rem] font-semibold uppercase tracking-wide text-primary">Unit Economics</p>
                <div className="flex justify-between"><span>Selling price</span><span className="font-semibold">${liveMetrics.sellingPrice.toFixed(2)}</span></div>
                <div className="flex justify-between text-muted-foreground"><span>− Shipping / unit</span><span>{review.shipping.value != null ? `-$${liveMetrics.shipping.toFixed(2)}` : '⚠ needed'}</span></div>
                <div className="flex justify-between text-muted-foreground"><span>− COGS / unit</span><span>{review.cogs.value ? `-$${liveMetrics.cogs.toFixed(2)}` : '⚠ required'}</span></div>
                <div className="flex justify-between text-muted-foreground"><span>− Aff. commission ({Math.round(liveMetrics.affCommPct * 100)}%)</span><span>-${liveMetrics.affComm.toFixed(2)}</span></div>
                <div className="flex justify-between text-muted-foreground"><span>− TikTok fee (6%)</span><span>-${liveMetrics.tikTokFee.toFixed(2)}</span></div>
                <div className={`mt-1 flex justify-between border-t pt-1 font-bold ${liveMetrics.grossMarginPct >= 0.2 ? 'text-emerald-500' : liveMetrics.grossMarginPct >= 0.05 ? 'text-amber-500' : 'text-red-500'}`}>
                  <span>Gross profit / order</span>
                  <span>{review.cogs.value ? `$${liveMetrics.grossProfitPerOrder.toFixed(2)} (${(liveMetrics.grossMarginPct * 100).toFixed(1)}%)` : '—'}</span>
                </div>
              </div>
            ) : (
              <p className="text-center text-xs text-muted-foreground">Enter list price to see unit economics</p>
            )}

            <div className="space-y-1.5">
              {blockers.map((b) => <p key={b} className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">⛔ {b}</p>)}
              {warnings.map((w) => <p key={w} className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-500">⚠ {w}</p>)}
              {!blockers.length && review.price.value && review.cogs.value && liveMetrics && (
                liveMetrics.grossMarginPct >= 0.2
                  ? <p className="rounded-md border border-emerald-600/40 bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-400">✅ Unit economics look healthy — ready to generate</p>
                  : <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-400">⚠ Thin margins — proposal will include AOV optimization recommendations</p>
              )}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button className="w-full" onClick={confirmAndGenerate} disabled={blockers.length > 0 || generating}>
              {generating ? '⏳ Generating proposal…' : isNegative ? '⛔ Fix economics above to generate' : '✅ Confirm & Generate Proposal'}
            </Button>
          </div>
        )}
      </CardContent>

      {proposal && proposalMetricsInput && (
        <ProposalPreviewModal
          proposal={proposal}
          metricsInput={proposalMetricsInput}
          opps={opps}
          linkOppId={linkOppId}
          onLinkOppChange={setLinkOppId}
          onMarkSent={markSent}
          onClose={reset}
        />
      )}
    </Card>
  );
}

function ProposalPreviewModal({ proposal, metricsInput, opps, linkOppId, onLinkOppChange, onMarkSent, onClose }: {
  proposal: GeneratedProposal; metricsInput: MetricsInput; opps: Opportunity[];
  linkOppId: string; onLinkOppChange: (id: string) => void; onMarkSent: () => Promise<void>; onClose: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [shareUrl, setShareUrl] = useState('');
  const [publishError, setPublishError] = useState('');

  const docHtml = useMemo(() => buildStandaloneProposalDocument(proposal, metricsInput, null), [proposal, metricsInput]);

  async function handleMarkSent() {
    setSending(true);
    try { await onMarkSent(); setSent(true); } finally { setSending(false); }
  }

  async function handlePublish() {
    setPublishing(true);
    setPublishError('');
    try {
      const { url } = await publishProposal(docHtml);
      setShareUrl(url);
    } catch (e) {
      setPublishError(e instanceof Error ? e.message : 'Failed to publish proposal');
    } finally {
      setPublishing(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-hidden p-0">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <p className="text-sm font-semibold">Cult Content × {proposal.brandName}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={linkOppId} onValueChange={onLinkOppChange}>
              <SelectTrigger className="h-8 w-44 text-xs"><SelectValue placeholder="Link to contact…" /></SelectTrigger>
              <SelectContent>
                {opps.map((o) => <SelectItem key={o.id} value={o.id}>{o.contact.name || o.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={handleMarkSent} disabled={sending || !linkOppId}>{sent ? '✓ Marked Sent' : sending ? '⏳…' : '→ Mark Sent'}</Button>
            <Button variant="outline" size="sm" onClick={handlePublish} disabled={publishing}>{publishing ? '⏳ Generating…' : '📄 Publish & Get Link'}</Button>
          </div>
        </div>
        {publishError && <p className="px-4 pt-2 text-sm text-destructive">{publishError}</p>}
        {shareUrl && (
          <div className="mx-4 mt-2 flex items-center gap-2 rounded-md border bg-muted/30 p-2 text-xs">
            <input readOnly value={shareUrl} className="flex-1 bg-transparent font-mono outline-none" />
            <Button size="sm" variant="ghost" onClick={() => navigator.clipboard.writeText(shareUrl)}>Copy</Button>
            <Button size="sm" variant="ghost" onClick={() => window.open(shareUrl, '_blank')}>Open ↗</Button>
          </div>
        )}
        <iframe title="Proposal preview" srcDoc={docHtml} className="h-[75vh] w-full border-0" />
      </DialogContent>
    </Dialog>
  );
}
