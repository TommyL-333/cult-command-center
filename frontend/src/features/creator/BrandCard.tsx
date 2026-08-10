import { ExternalLink, FileText, Send, History, Sparkles } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusIndicator } from '@/components/ui/status-indicator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ProposalDialog } from './ProposalDialog';
import { ContractHistoryDialog } from './ContractHistoryDialog';
import type { BrandSummary, Contract } from '@/lib/creatorApi';

function BrandAvatar({ name }: { name: string | null }) {
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary/20 to-accent/20 text-sm font-semibold text-foreground">
      {(name || '?').charAt(0).toUpperCase()}
    </div>
  );
}

function VisitWebsiteButton({ website }: { website: string | null }) {
  const button = (
    <Button variant="outline" size="sm" disabled={!website} asChild={!!website}>
      {website
        ? <a href={website} target="_blank" rel="noreferrer"><ExternalLink />Visit Website</a>
        : <span><ExternalLink />Visit Website</span>}
    </Button>
  );
  if (website) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>No website on file for this brand yet</TooltipContent>
    </Tooltip>
  );
}

/**
 * One card component, three button configurations — matches the confirmed
 * spec exactly per tab rather than a single generic action list, since each
 * tab's buttons genuinely differ (not just relabeled).
 */
export function BrandCard({
  variant, brand, contract, contractCount, creatorId,
}: {
  variant: 'my' | 'new' | 'previous';
  brand: BrandSummary;
  contract?: Contract;
  contractCount?: number;
  creatorId: string | number;
}) {
  return (
    <Card className="transition-colors hover:border-border">
      <CardHeader className="flex flex-row items-center gap-3">
        <BrandAvatar name={brand.name} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold leading-tight">{brand.name || brand.id}</p>
          {variant === 'my' && <StatusIndicator state="active" label="Active contract" size="sm" className="mt-0.5" />}
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {variant === 'my' && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <span><Button size="sm" disabled><Sparkles />Create New Content</Button></span>
              </TooltipTrigger>
              <TooltipContent>Storista content flow — coming soon</TooltipContent>
            </Tooltip>
            {contract && (
              <ContractHistoryDialog
                creatorId={creatorId} brandId={brand.id} brandName={brand.name} title="Contract"
                trigger={<Button variant="outline" size="sm"><FileText />View Contract</Button>}
              />
            )}
            <VisitWebsiteButton website={brand.website} />
          </>
        )}
        {variant === 'new' && (
          <>
            <VisitWebsiteButton website={brand.website} />
            <ProposalDialog brandId={brand.id} brandName={brand.name} trigger={<Button size="sm"><Send />Make a Proposal</Button>} />
          </>
        )}
        {variant === 'previous' && (
          <>
            <ProposalDialog brandId={brand.id} brandName={brand.name} trigger={<Button size="sm"><Send />Make a Proposal</Button>} />
            <VisitWebsiteButton website={brand.website} />
            <ContractHistoryDialog
              creatorId={creatorId} brandId={brand.id} brandName={brand.name} title="Previous Contracts"
              trigger={<Button variant="outline" size="sm"><History />Previous Contracts{contractCount ? ` (${contractCount})` : ''}</Button>}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
