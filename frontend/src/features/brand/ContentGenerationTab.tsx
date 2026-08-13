import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles, Send } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from '@/components/ui/dialog';
import { EmptyState } from '@/features/shared/EmptyState';
import {
  getCredits, getProducts, getGenerations, startGeneration, getBufferChannels,
  scheduleGenerationToBuffer, type Generation,
} from '@/lib/brandApi';

const statusVariant: Record<Generation['status'], 'default' | 'secondary' | 'destructive'> = {
  pending: 'secondary',
  processing: 'secondary',
  succeeded: 'default',
  failed: 'destructive',
};

function BufferPostDialog({ generation }: { generation: Generation }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [text, setText] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');

  const channelsQuery = useQuery({ queryKey: ['brand', 'buffer-channels'], queryFn: getBufferChannels, enabled: open });

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function submit() {
    setStatus('sending');
    setError('');
    try {
      await scheduleGenerationToBuffer({ generationId: generation.id, channelIds: [...selected], text: text.trim() || undefined });
      setStatus('sent');
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : 'Failed to post to Buffer');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setStatus('idle'); setSelected(new Set()); setText(''); } }}>
      <DialogTrigger asChild>
        <Button size="sm"><Send />Post to…</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Post generation #{generation.id} via Buffer</DialogTitle>
        </DialogHeader>
        {status === 'sent' ? (
          <p className="text-sm text-muted-foreground">Sent to Buffer for the selected channels.</p>
        ) : (
          <div className="space-y-4">
            {channelsQuery.isPending && <p className="text-sm text-muted-foreground">Loading channels…</p>}
            {channelsQuery.isError && <p className="text-sm text-destructive">Couldn't load Buffer channels.</p>}
            {channelsQuery.data && channelsQuery.data.channels.length === 0 && (
              <p className="text-sm text-muted-foreground">No Buffer channels connected yet.</p>
            )}
            <div className="flex flex-wrap gap-2">
              {channelsQuery.data?.channels.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggle(c.id)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    selected.has(c.id) ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-foreground/30'
                  }`}
                >
                  {c.service}: {c.name}
                </button>
              ))}
            </div>
            <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Caption for this post…" />
            {status === 'error' && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}
        <DialogFooter>
          {status === 'sent' ? (
            <Button onClick={() => setOpen(false)}>Close</Button>
          ) : (
            <Button onClick={submit} disabled={status === 'sending' || selected.size === 0}>
              {status === 'sending' ? 'Posting…' : `Post to ${selected.size || ''} channel${selected.size === 1 ? '' : 's'}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GenerationCard({ generation }: { generation: Generation }) {
  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-medium">Generation #{generation.id}</span>
        <Badge variant={statusVariant[generation.status]}>{generation.status}</Badge>
      </div>
      {generation.video_url && (
        <video src={generation.video_url} controls className="mt-2 max-h-64 rounded-md" />
      )}
      <p className="mt-1 text-xs text-muted-foreground">{new Date(generation.created_at).toLocaleString()}</p>
      {generation.status === 'succeeded' && generation.video_url && (
        <div className="mt-2"><BufferPostDialog generation={generation} /></div>
      )}
    </div>
  );
}

/**
 * Content Generation tab (brand-side): pick a product, describe the video,
 * generate via Seedance (routes/content-studio-gen.js — video only, per the
 * live endpoint, api/v3/bytedance/seedance-v1-lite-t2v-480p; there is no
 * image-generation path today despite the original plan leaving that open),
 * review, then "Post to…" via the existing Buffer integration. Standalone
 * tab, not per-creator — matches the confirmed spec.
 */
export function ContentGenerationTab() {
  const queryClient = useQueryClient();
  const creditsQuery = useQuery({ queryKey: ['brand', 'credits'], queryFn: getCredits });
  const productsQuery = useQuery({ queryKey: ['brand', 'products'], queryFn: getProducts });
  const generationsQuery = useQuery({
    queryKey: ['brand', 'generations'],
    queryFn: getGenerations,
    refetchInterval: (q) => (q.state.data?.generations.some((g) => g.status === 'pending' || g.status === 'processing') ? 4000 : false),
  });

  const [productId, setProductId] = useState<string>('');
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function generate() {
    if (!prompt.trim()) return;
    setSubmitting(true);
    setError('');
    setMessage('');
    try {
      const result = await startGeneration({ product_id: productId || null, prompt: prompt.trim() });
      setMessage(result.message || 'Generation started.');
      setPrompt('');
      queryClient.invalidateQueries({ queryKey: ['brand', 'generations'] });
      queryClient.invalidateQueries({ queryKey: ['brand', 'credits'] });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start generation');
    } finally {
      setSubmitting(false);
    }
  }

  const credits = creditsQuery.data;
  const products = productsQuery.data?.products || [];
  const generations = generationsQuery.data?.generations || [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base"><Sparkles className="size-4 text-primary" />New Content</CardTitle>
          {credits && (
            <span className="text-xs text-muted-foreground">
              {credits.balance_display} credit balance · {credits.generation_live ? `$${(credits.charge_per_generation_cents / 100).toFixed(2)} per video` : 'engine not yet configured — queued, not charged'}
            </span>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Product (optional)</label>
            <Select value={productId} onValueChange={setProductId}>
              <SelectTrigger><SelectValue placeholder="No specific product" /></SelectTrigger>
              <SelectContent>
                {products.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Describe the video</label>
            <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="A quick unboxing shot with upbeat music…" />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {message && <p className="text-sm text-muted-foreground">{message}</p>}
          <Button onClick={generate} disabled={submitting || !prompt.trim()}>
            {submitting ? 'Starting…' : 'Generate'}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Your generations</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {generations.length === 0
            ? <EmptyState title="No generations yet" description="Start one above to see it here." />
            : generations.map((g) => <GenerationCard key={g.id} generation={g} />)}
        </CardContent>
      </Card>
    </div>
  );
}
