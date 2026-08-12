import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PipelineBoard } from './PipelineBoard';
import { SignalEngineTab } from './SignalEngineTab';
import { ProfitabilityCalculator } from './ProfitabilityCalculator';

/**
 * CRM / Sales — React port of dashboard/segments.html. Growth Partners tab
 * currently covers the pipeline board + the standalone TikTok Profitability
 * Calculator (same relative position as the original page — the calculator
 * sits above the pipeline). Still-deferred, larger follow-up: the AI
 * proposal/contract/invoice wizard (Fireflies -> AI extraction ->
 * economics -> GHL send) and the Shopify Prospector. segments.html itself
 * stays up (now auth-gated, see the earlier security fix) as the fallback
 * for those workflows until they land.
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
        <ProfitabilityCalculator />
        <PipelineBoard />
      </TabsContent>
      <TabsContent value="signal-engine" className="pt-2">
        <SignalEngineTab />
      </TabsContent>
    </Tabs>
  );
}
