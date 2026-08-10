import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ProposalDialog } from './ProposalDialog';
import { ContractHistoryDialog } from './ContractHistoryDialog';
import type { BrandSummary, Contract } from '@/lib/creatorApi';

function VisitWebsiteButton({ website }: { website: string | null }) {
  return (
    <Button variant="outline" size="sm" disabled={!website} asChild={!!website}>
      {website ? <a href={website} target="_blank" rel="noreferrer">Visit Website</a> : <span>Visit Website</span>}
    </Button>
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
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{brand.name || brand.id}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {variant === 'my' && (
          <>
            <Button size="sm" disabled title="Storista content flow — coming soon">Create New Content</Button>
            {contract && (
              <ContractHistoryDialog
                creatorId={creatorId} brandId={brand.id} brandName={brand.name} title="Contract"
                trigger={<Button variant="outline" size="sm">View Contract</Button>}
              />
            )}
            <VisitWebsiteButton website={brand.website} />
          </>
        )}
        {variant === 'new' && (
          <>
            <VisitWebsiteButton website={brand.website} />
            <ProposalDialog brandId={brand.id} brandName={brand.name} trigger={<Button size="sm">Make a Proposal</Button>} />
          </>
        )}
        {variant === 'previous' && (
          <>
            <ProposalDialog brandId={brand.id} brandName={brand.name} trigger={<Button size="sm">Make a Proposal</Button>} />
            <VisitWebsiteButton website={brand.website} />
            <ContractHistoryDialog
              creatorId={creatorId} brandId={brand.id} brandName={brand.name} title="Previous Contracts"
              trigger={<Button variant="outline" size="sm">Previous Contracts{contractCount ? ` (${contractCount})` : ''}</Button>}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
