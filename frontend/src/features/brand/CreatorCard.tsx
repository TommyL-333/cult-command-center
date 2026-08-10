import { ExternalLink, FileText, Send, History } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusIndicator } from '@/components/ui/status-indicator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ProposalDialog } from '@/features/shared/ProposalDialog';
import { ContractHistoryDialog } from '@/features/shared/ContractHistoryDialog';
import type { Contract } from '@/lib/proposalsApi';
import type { CreatorSummary } from '@/lib/brandApi';

function CreatorAvatar({ name }: { name: string | null }) {
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary/20 to-accent/20 text-sm font-semibold text-foreground">
      {(name || '?').charAt(0).toUpperCase()}
    </div>
  );
}

function VisitTikTokButton({ handle }: { handle: string | null }) {
  const url = handle ? `https://www.tiktok.com/@${handle.replace(/^@/, '')}` : null;
  const button = (
    <Button variant="outline" size="sm" disabled={!url} asChild={!!url}>
      {url
        ? <a href={url} target="_blank" rel="noreferrer"><ExternalLink />Visit TikTok Profile</a>
        : <span><ExternalLink />Visit TikTok Profile</span>}
    </Button>
  );
  if (url) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>No TikTok handle on file for this creator yet</TooltipContent>
    </Tooltip>
  );
}

/**
 * Mirrors features/creator/BrandCard.tsx from the brand side. Button sets
 * per the confirmed spec: Current Affiliates gets View Contract + Visit
 * TikTok Profile only (no content button here — content gen is its own
 * standalone tab, not per-creator, unlike the creator portal's My Brands).
 */
export function CreatorCard({
  variant, creator, contract, contractCount, brandId,
}: {
  variant: 'current' | 'explore' | 'previous';
  creator: CreatorSummary;
  contract?: Contract;
  contractCount?: number;
  brandId: string;
}) {
  return (
    <Card className="transition-colors hover:border-border">
      <CardHeader className="flex flex-row items-center gap-3">
        <CreatorAvatar name={creator.name} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold leading-tight">{creator.name || creator.handle || creator.id}</p>
          {creator.handle && <p className="truncate text-xs text-muted-foreground">@{creator.handle}</p>}
          {variant === 'current' && <StatusIndicator state="active" label="Active affiliate" size="sm" className="mt-0.5" />}
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {variant === 'current' && (
          <>
            {contract && (
              <ContractHistoryDialog
                creatorId={creator.id} brandId={brandId} counterpartyName={creator.name || creator.handle} title="Contract"
                trigger={<Button variant="outline" size="sm"><FileText />View Contract</Button>}
              />
            )}
            <VisitTikTokButton handle={creator.handle} />
          </>
        )}
        {variant === 'explore' && (
          <>
            <VisitTikTokButton handle={creator.handle} />
            <ProposalDialog counterpartyId={creator.id} counterpartyName={creator.name || creator.handle} trigger={<Button size="sm"><Send />Send a Proposal</Button>} />
          </>
        )}
        {variant === 'previous' && (
          <>
            <ProposalDialog counterpartyId={creator.id} counterpartyName={creator.name || creator.handle} trigger={<Button size="sm"><Send />Send a Proposal</Button>} />
            <VisitTikTokButton handle={creator.handle} />
            <ContractHistoryDialog
              creatorId={creator.id} brandId={brandId} counterpartyName={creator.name || creator.handle} title="Previous Affiliates"
              trigger={<Button variant="outline" size="sm"><History />Previous Affiliates{contractCount ? ` (${contractCount})` : ''}</Button>}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
