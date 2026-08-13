import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PipelineBoard } from './PipelineBoard';
import { SignalEngineTab } from './SignalEngineTab';
import { ProfitabilityCalculator } from './ProfitabilityCalculator';
import { ProposalWizard } from './ProposalWizard';
import { ContractInvoicing } from './ContractInvoicing';

/**
 * CRM / Sales — React port of dashboard/segments.html. Growth Partners tab
 * order matches the original page: Proposal Generator, Contract +
 * Invoicing, Profitability Calculator, then the Pipeline board. Still
 * deferred: the Shopify Prospector. segments.html itself stays up (now
 * auth-gated, see the earlier security fix) as the fallback for that until
 * it lands.
 */
export function CRMTab() {
  const [seg, setSeg] = useState('growth-partners');
  return (
    <Tabs value={seg} onValueChange={setSeg}>
      <TabsList>
        <TabsTrigger value="growth-partners">🚀 Growth Partners</TabsTrigger>
        <TabsTrigger value="signal-engine">⚡ Signal Engine</TabsTrigger>
      </TabsList>
      <TabsContent value="growth-partners" className="space-y-4 pt-2">
        <ProposalWizard />
        <ContractInvoicing />
        <ProfitabilityCalculator />
        <PipelineBoard />
      </TabsContent>
      <TabsContent value="signal-engine" className="pt-2">
        <SignalEngineTab />
      </TabsContent>
    </Tabs>
  );
}
