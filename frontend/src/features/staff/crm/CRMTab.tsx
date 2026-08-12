import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PipelineBoard } from './PipelineBoard';
import { SignalEngineTab } from './SignalEngineTab';

/**
 * CRM / Sales — React port of dashboard/segments.html, first increment
 * (Growth Partners pipeline + Signal Engine). The AI proposal/contract/
 * invoice generator (Fireflies -> AI extraction -> economics -> GHL send)
 * is a separate, larger follow-up increment — not included here yet.
 * segments.html itself stays up (now auth-gated, see the earlier security
 * fix) as the fallback for that workflow until it lands.
 */
export function CRMTab() {
  const [seg, setSeg] = useState('growth-partners');
  return (
    <Tabs value={seg} onValueChange={setSeg}>
      <TabsList>
        <TabsTrigger value="growth-partners">🚀 Growth Partners</TabsTrigger>
        <TabsTrigger value="signal-engine">⚡ Signal Engine</TabsTrigger>
      </TabsList>
      <TabsContent value="growth-partners" className="pt-2">
        <PipelineBoard />
      </TabsContent>
      <TabsContent value="signal-engine" className="pt-2">
        <SignalEngineTab />
      </TabsContent>
    </Tabs>
  );
}
